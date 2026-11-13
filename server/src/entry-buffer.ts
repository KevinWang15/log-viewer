// In-memory entry index shared by sources that hold their entries in memory
// (streams, remote mirrors, provider mirrors). Owns the retained entries, the
// distinct thread/logger lists (refcounted, so eviction untracks
// incrementally), per-level stats, byte accounting and retention.
//
// Indices are dense 0..count-1 from the oldest retained entry. Evicting from
// the front rebases every index, so callers must emit a `reset` whenever
// enforceRetention() reports that it dropped anything.

import type { EntryOut } from './source-api';

export interface RetentionPolicy {
  maxEntries: number; // 0 = unbounded
  maxBytes: number; // 0 = unbounded
  // true: once a limit is crossed, evict down to ~90% so the next appends
  // don't evict again immediately. false: keep exactly the newest maxEntries.
  headroom: boolean;
}

export interface AuxiliaryBytes {
  // Extra bytes the owner counts against maxBytes (e.g. detection samples).
  bytes(): number;
  // Releases them; called before real entries are evicted for a byte limit.
  release(): void;
}

export class EntryBuffer {
  private entries: Array<EntryOut | undefined> = [];
  private entryBytes: number[] = [];
  private entryRawBytes: number[] = [];
  private head = 0;
  private retained = 0;
  private threadSet = new Set<string>();
  private loggerSet = new Set<string>();
  private threadCounts = new Map<string, number>();
  private loggerCounts = new Map<string, number>();
  threads: string[] = [];
  loggers: string[] = [];

  // `stats` is the owner's per-level counter array, updated in place.
  constructor(
    readonly stats: number[],
    readonly policy: RetentionPolicy,
    private readonly label = 'entry'
  ) {}

  get count() {
    return this.entries.length - this.head;
  }

  // Approximate retained bytes (raw text plus per-entry overhead).
  get bytes() {
    return this.retained;
  }

  at(i: number): EntryOut {
    const entry = this.entries[this.head + i];
    if (!entry) throw new RangeError(`${this.label} index out of range: ${i}`);
    return entry;
  }

  push(e: EntryOut) {
    this.entries.push(e);
    const rawBytes = Buffer.byteLength(e.raw);
    this.entryRawBytes.push(rawBytes);
    // The fixed allowance covers numbers, object fields and allocator overhead.
    const bytes = 64 + rawBytes + Buffer.byteLength(e.msg) + Buffer.byteLength(e.th) + Buffer.byteLength(e.lg);
    this.entryBytes.push(bytes);
    this.retained += bytes;
    this.track(e);
  }

  // Raw byte length of the newest entry, for continuation-line appends.
  lastRawBytes(): number {
    return this.entryRawBytes[this.entries.length - 1] ?? 0;
  }

  last(): EntryOut | undefined {
    return this.entries[this.entries.length - 1];
  }

  // Replaces the newest entry's raw text (continuation lines tailed in).
  setLastRaw(raw: string, rawBytes: number) {
    const physical = this.entries.length - 1;
    const e = this.entries[physical];
    if (!e) return;
    const delta = rawBytes - this.entryRawBytes[physical];
    e.raw = raw;
    this.entryRawBytes[physical] = rawBytes;
    this.entryBytes[physical] += delta;
    this.retained += delta;
  }

  replaceAll(entries: EntryOut[]) {
    this.clear();
    for (const e of entries) this.push(e);
  }

  clear() {
    this.entries = [];
    this.entryBytes = [];
    this.entryRawBytes = [];
    this.head = 0;
    this.retained = 0;
    this.resetTracking();
  }

  // Full re-scan of thread/logger/level tracking; only needed after entry
  // metadata was rewritten in place (re-parsing). Eviction untracks
  // incrementally.
  retrack() {
    this.resetTracking();
    for (let i = 0; i < this.count; i++) this.track(this.at(i));
  }

  // Evicts the oldest entries once a limit is crossed. Returns true when
  // anything was dropped: indices were rebased and the owner must emit a reset.
  enforceRetention(aux?: AuxiliaryBytes): boolean {
    const { maxEntries, maxBytes, headroom } = this.policy;
    const total = () => this.retained + (aux ? aux.bytes() : 0);
    const countExceeded = maxEntries > 0 && this.count > maxEntries;
    const bytesExceeded = maxBytes > 0 && total() > maxBytes;
    if (!countExceeded && !bytesExceeded) return false;

    const target = (limit: number) => (headroom ? retentionTarget(limit) : limit);
    const countTarget = countExceeded ? target(maxEntries) : maxEntries || Infinity;
    const bytesTarget = bytesExceeded ? target(maxBytes) : maxBytes || Infinity;
    if (bytesExceeded) aux?.release();
    while (this.count > 0 && (this.count > countTarget || total() > bytesTarget)) {
      const evicted = this.entries[this.head];
      if (evicted) this.untrack(evicted);
      this.retained -= this.entryBytes[this.head] || 0;
      this.entries[this.head] = undefined;
      this.entryBytes[this.head] = 0;
      this.entryRawBytes[this.head] = 0;
      this.head++;
    }
    this.compactIfUseful();
    return true;
  }

  private resetTracking() {
    this.threadSet.clear();
    this.loggerSet.clear();
    this.threadCounts.clear();
    this.loggerCounts.clear();
    this.threads = [];
    this.loggers = [];
    this.stats.fill(0);
  }

  private track(e: EntryOut) {
    this.threadCounts.set(e.th, (this.threadCounts.get(e.th) ?? 0) + 1);
    if (!this.threadSet.has(e.th)) {
      this.threadSet.add(e.th);
      this.threads.push(e.th);
    }
    this.loggerCounts.set(e.lg, (this.loggerCounts.get(e.lg) ?? 0) + 1);
    if (!this.loggerSet.has(e.lg)) {
      this.loggerSet.add(e.lg);
      this.loggers.push(e.lg);
    }
    this.stats[e.lv]++;
  }

  private untrackMeta(v: string, set: Set<string>, counts: Map<string, number>, list: string[]) {
    const n = (counts.get(v) ?? 1) - 1;
    if (n > 0) {
      counts.set(v, n);
      return;
    }
    counts.delete(v);
    set.delete(v);
    const i = list.indexOf(v);
    if (i !== -1) list.splice(i, 1);
  }

  private untrack(e: EntryOut) {
    this.stats[e.lv]--;
    this.untrackMeta(e.th, this.threadSet, this.threadCounts, this.threads);
    this.untrackMeta(e.lg, this.loggerSet, this.loggerCounts, this.loggers);
  }

  // Dropped slots are cleared at eviction; occasional compaction only removes
  // the cheap empty prefix.
  private compactIfUseful() {
    if (this.head < 4096 || this.head * 2 < this.entries.length) return;
    this.entries = this.entries.slice(this.head);
    this.entryBytes = this.entryBytes.slice(this.head);
    this.entryRawBytes = this.entryRawBytes.slice(this.head);
    this.head = 0;
  }
}

// ~10% headroom below a limit, at least one entry/byte.
function retentionTarget(limit: number): number {
  if (limit < 10) return limit;
  return limit - Math.max(1, Math.ceil(limit / 10));
}
