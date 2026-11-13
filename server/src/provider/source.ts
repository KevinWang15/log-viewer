// ProviderSource: a LogSource that mirrors one log of a LogProvider.
//
// Loads the newest records (tail, or by paging list), then follows: watch()
// when the provider has it, otherwise polling list(after). Every reconnect
// first catches up with list(), so watch is only a wake-up hint. Records are
// coalesced into batches before they become 'append' events. A provider
// 'reset' event or a CursorExpiredError reloads the mirror ('reset'); so does
// retention eviction once maxEntries/maxBytes is exceeded.

import { DEFAULTS } from '../config';
import { EntryBuffer } from '../entry-buffer';
import { levelFromString, parseTimestamp } from '../parser';
import { BaseSource, MAX_ENTRY_BYTES, MAX_METADATA_BYTES, truncateUtf8 } from '../sources';
import type { AppendEvent, EntryOut } from '../source-api';
import {
  Cursor,
  CursorExpiredError,
  LogDescriptor,
  LogHandle,
  LogProvider,
  LogRecord,
  PROVIDER_API_VERSION,
  ProviderError,
} from './spi';

export interface ProviderSourceOptions {
  maxEntries?: number; // newest records kept; 0 = unbounded (not recommended)
  maxBytes?: number; // 0 = unbounded
  pollIntervalMs?: number; // when the provider has no watch()
  pageLimit?: number; // list() page size
  batchMs?: number; // watch batching window
  batchMax?: number; // flush a watch batch at this many records
  backoffMinMs?: number;
  backoffMaxMs?: number;
  logger?: Pick<Console, 'warn' | 'error'>;
}

export type ProviderSourceState = 'loading' | 'live' | 'polling' | 'reconnecting' | 'failed' | 'closed';

export function providerSourceId(providerId: string, logId: string) {
  return `p:${providerId}:${logId}`;
}

// Converts a provider record to an entry; null for records without a cursor
// or message (dropped and counted).
export function recordToEntry(r: LogRecord): EntryOut | null {
  if (!r || (typeof r.cursor !== 'string' && typeof r.cursor !== 'number') || r.cursor === '') return null;
  if (typeof r.message !== 'string') return null;
  let t = 0;
  if (typeof r.time === 'number' && Number.isFinite(r.time)) t = r.time;
  else if (r.time instanceof Date) t = r.time.getTime() || 0;
  else if (typeof r.time === 'string') t = parseTimestamp(r.time) || Date.parse(r.time) || 0;
  let lv = 2;
  if (typeof r.level === 'number' && Number.isFinite(r.level)) lv = Math.max(0, Math.min(5, Math.trunc(r.level)));
  else if (typeof r.level === 'string') lv = levelFromString(r.level);
  const raw = truncateUtf8(typeof r.raw === 'string' ? r.raw : r.message, MAX_ENTRY_BYTES);
  const nl = r.message.indexOf('\n');
  return {
    i: 0,
    t,
    lv,
    th: truncateUtf8(typeof r.thread === 'string' ? r.thread : '', MAX_METADATA_BYTES, ''),
    lg: truncateUtf8(typeof r.logger === 'string' ? r.logger : '', MAX_METADATA_BYTES, ''),
    msg: truncateUtf8(nl === -1 ? r.message : r.message.slice(0, nl), MAX_ENTRY_BYTES, ''),
    raw,
  };
}

function statusOf(err: unknown, fallback: number): number {
  const s = (err as { status?: unknown })?.status;
  return typeof s === 'number' && s >= 400 && s < 600 ? s : fallback;
}

export class ProviderSource extends BaseSource {
  readonly kind = 'provider' as const;
  readonly id: string;
  readonly name: string;
  private buf: EntryBuffer;
  private cursor: Cursor | null = null;
  private stateValue: ProviderSourceState = 'loading';
  private lastErrorValue: string | undefined;
  private droppedRecords = 0;
  private readonly ac = new AbortController();
  private pending: EntryOut[] = [];
  private pendingCursor: Cursor | null = null;
  private flushTimer: NodeJS.Timeout | null = null;
  private sleepTimer: { timer: NodeJS.Timeout; resolve: () => void } | null = null;
  private loop: Promise<void> | null = null;
  private readonly opts: Required<Omit<ProviderSourceOptions, 'logger'>>;
  private readonly logger: Pick<Console, 'warn' | 'error'>;

  private constructor(
    readonly provider: LogProvider,
    readonly log: LogDescriptor,
    private readonly handle: LogHandle,
    opts: ProviderSourceOptions
  ) {
    super();
    this.id = providerSourceId(provider.id, log.id);
    this.name = log.name || log.id;
    this.opts = {
      maxEntries: opts.maxEntries ?? DEFAULTS.providerMaxEntries,
      maxBytes: opts.maxBytes ?? DEFAULTS.providerMaxBytes,
      pollIntervalMs: opts.pollIntervalMs ?? DEFAULTS.providerPollIntervalMs,
      pageLimit: opts.pageLimit ?? 1000,
      batchMs: opts.batchMs ?? 100,
      batchMax: opts.batchMax ?? 1000,
      backoffMinMs: opts.backoffMinMs ?? 1000,
      backoffMaxMs: opts.backoffMaxMs ?? 30_000,
    };
    this.logger = opts.logger ?? console;
    // Exact cap: keep precisely the newest maxEntries, like a tail window.
    this.buf = new EntryBuffer(
      this.stats,
      { maxEntries: this.opts.maxEntries, maxBytes: this.opts.maxBytes, headroom: false },
      'provider entry'
    );
  }

  // Opens the log and performs the initial load (errors reject with an HTTP
  // `status`), then follows it in the background.
  static async open(provider: LogProvider, log: LogDescriptor, opts: ProviderSourceOptions = {}): Promise<ProviderSource> {
    if (provider.apiVersion !== PROVIDER_API_VERSION) {
      throw new ProviderError(`provider ${provider.id} implements API version ${String(provider.apiVersion)}, expected ${PROVIDER_API_VERSION}`, {
        status: 500,
        retryable: false,
      });
    }
    const ac = new AbortController();
    let handle: LogHandle;
    try {
      handle = await provider.open(log.id, { signal: ac.signal });
    } catch (err) {
      throw new ProviderError(`cannot open ${log.id}: ${(err as Error).message}`, { status: statusOf(err, 502), cause: err });
    }
    const src = new ProviderSource(provider, log, handle, opts);
    src.ac.signal.addEventListener('abort', () => ac.abort());
    try {
      await src.reload(false);
    } catch (err) {
      await src.close();
      throw new ProviderError(`cannot load ${log.id}: ${(err as Error).message}`, { status: statusOf(err, 502), cause: err });
    }
    // Loaded and about to follow: report the follow mode right away.
    src.stateValue = handle.watch ? 'live' : 'polling';
    src.loop = src.run();
    return src;
  }

  get state(): ProviderSourceState {
    return this.stateValue;
  }
  get lastError(): string | undefined {
    return this.lastErrorValue;
  }
  get dropped(): number {
    return this.droppedRecords;
  }

  get count() {
    return this.buf.count;
  }
  get formatName() {
    return 'provider';
  }
  get threadList() {
    return this.buf.threads;
  }
  get loggerList() {
    return this.buf.loggers;
  }
  levelAt(i: number) {
    return this.buf.at(i).lv;
  }
  threadAt(i: number) {
    return this.buf.at(i).th;
  }
  loggerAt(i: number) {
    return this.buf.at(i).lg;
  }
  timeAt(i: number) {
    return this.buf.at(i).t;
  }

  describe() {
    return {
      provider: { id: this.provider.id, name: this.provider.name, log: this.log.id },
      description: this.log.description,
      labels: this.log.labels,
      state: this.stateValue,
      connected: this.stateValue === 'live' || this.stateValue === 'polling',
      lastError: this.lastErrorValue,
    };
  }

  async getEntries(idxs: number[]): Promise<EntryOut[]> {
    const out: EntryOut[] = [];
    for (const i of idxs) if (i >= 0 && i < this.count) out.push({ ...this.buf.at(i), i });
    return out;
  }

  async scanTexts(cb: (i: number, raw: string) => boolean | void, from = 0, to = this.count): Promise<void> {
    const end = Math.min(to, this.count);
    for (let i = Math.max(0, from); i < end; i++) if (cb(i, this.buf.at(i).raw) === false) return;
  }

  async close() {
    if (this.stateValue === 'closed') return;
    this.stateValue = 'closed';
    this.ac.abort();
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.wake();
    // Bounded: a provider call that ignores the abort signal can't block close.
    let bound: NodeJS.Timeout | undefined;
    await Promise.race([this.loop?.catch(() => {}), new Promise((r) => (bound = setTimeout(r, 1000)))]);
    clearTimeout(bound);
    await this.handle.close?.().catch(() => {});
    this.buf.clear();
  }

  private get closed() {
    return this.stateValue === 'closed';
  }

  private toEntries(records: LogRecord[]): { entries: EntryOut[]; last: Cursor | null } {
    const entries: EntryOut[] = [];
    let last: Cursor | null = null;
    for (const r of records) {
      const e = recordToEntry(r);
      if (!e) {
        this.droppedRecords++;
        continue;
      }
      entries.push(e);
      last = String(r.cursor);
    }
    return { entries, last };
  }

  // Replaces the mirror with the newest records. Emits 'reset' unless this is
  // the initial load (nobody is subscribed yet).
  private async reload(emit = true) {
    this.pending = [];
    this.pendingCursor = null;
    const { signal } = this.ac;
    const max = this.opts.maxEntries;
    let entries: EntryOut[] = [];
    let last: Cursor | null = null;
    if (this.handle.tail && max > 0) {
      const page = await this.handle.tail({ limit: max, signal });
      ({ entries, last } = this.toEntries(page.records ?? []));
    } else {
      // No tail(): page from the start and keep the newest `max`.
      let after: Cursor | null = null;
      for (;;) {
        const page = await this.handle.list({ after, limit: this.opts.pageLimit, signal });
        const conv = this.toEntries(page.records ?? []);
        if (conv.entries.length) entries.push(...conv.entries);
        if (max > 0 && entries.length > max * 2) entries = entries.slice(entries.length - max);
        if (conv.last !== null) after = conv.last;
        const more = page.more ?? (page.records?.length ?? 0) >= this.opts.pageLimit;
        if (!more || (page.records?.length ?? 0) === 0) break;
      }
      last = after;
    }
    if (this.closed) return;
    this.buf.replaceAll(entries);
    this.buf.enforceRetention();
    this.cursor = last;
    if (emit) this.emit('reset');
  }

  // Appends converted entries as one batch.
  private append(entries: EntryOut[], last: Cursor | null) {
    if (last !== null) this.cursor = last;
    if (!entries.length || this.closed) return;
    const startIdx = this.count;
    for (const e of entries) this.buf.push(e);
    if (this.buf.enforceRetention()) {
      this.emit('reset');
      return;
    }
    this.emit('append', {
      startIdx,
      added: entries.length,
      entries: entries.map((e, k) => ({ ...e, i: startIdx + k })),
    } satisfies AppendEvent);
  }

  private flushPending() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    const entries = this.pending;
    const last = this.pendingCursor;
    this.pending = [];
    this.pendingCursor = null;
    this.append(entries, last);
  }

  private queueRecords(records: LogRecord[]) {
    const { entries, last } = this.toEntries(records);
    if (last !== null) this.pendingCursor = last;
    this.pending.push(...entries);
    if (this.pending.length >= this.opts.batchMax) this.flushPending();
    else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flushPending(), this.opts.batchMs);
      this.flushTimer.unref();
    }
  }

  // list(after) until caught up.
  private async catchUp() {
    this.flushPending();
    const { signal } = this.ac;
    for (;;) {
      const page = await this.handle.list({ after: this.cursor, limit: this.opts.pageLimit, signal });
      if (this.closed) return;
      const { entries, last } = this.toEntries(page.records ?? []);
      this.append(entries, last);
      const n = page.records?.length ?? 0;
      const more = page.more ?? n >= this.opts.pageLimit;
      if (!more || n === 0) return;
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      if (this.closed) return resolve();
      const timer = setTimeout(() => {
        this.sleepTimer = null;
        resolve();
      }, ms);
      timer.unref();
      this.sleepTimer = { timer, resolve };
    });
  }

  private wake() {
    if (!this.sleepTimer) return;
    clearTimeout(this.sleepTimer.timer);
    const { resolve } = this.sleepTimer;
    this.sleepTimer = null;
    resolve();
  }

  private async run() {
    let delay = this.opts.backoffMinMs;
    let needReload = false;
    while (!this.closed) {
      // Yield to the event loop each round, so a provider whose calls resolve
      // without I/O can't starve timers.
      await new Promise((r) => setImmediate(r));
      try {
        if (needReload) {
          await this.reload(true);
          needReload = false;
        }
        await this.catchUp();
        if (this.closed) return;
        if (this.handle.watch) {
          this.stateValue = 'live';
          this.lastErrorValue = undefined;
          delay = this.opts.backoffMinMs;
          const startedAt = Date.now();
          let delivered = 0;
          // Iterated by hand so close() can stop a watch that ignores the signal.
          const it = this.handle.watch({ after: this.cursor, signal: this.ac.signal })[Symbol.asyncIterator]();
          const aborted = new Promise<IteratorResult<never>>((resolve) => {
            if (this.ac.signal.aborted) resolve({ done: true, value: undefined as never });
            else this.ac.signal.addEventListener('abort', () => resolve({ done: true, value: undefined as never }), { once: true });
          });
          try {
            for (;;) {
              const r = await Promise.race([it.next(), aborted]);
              if (r.done || this.closed) break;
              const ev = r.value;
              if (ev.type === 'records') {
                delivered += ev.records?.length ?? 0;
                this.queueRecords(ev.records ?? []);
              }
              else if (ev.type === 'reset') {
                needReload = true;
                break;
              }
            }
          } finally {
            void Promise.resolve(it.return?.()).catch(() => {});
          }
          if (this.closed) return;
          this.flushPending();
          // The watch ended: catch up and watch again. Back off when it ended
          // quickly without delivering records (heartbeats don't count), so a
          // broken watch can't spin; long-poll style watches that deliver
          // records and end are resumed immediately.
          if (!needReload && !this.closed && delivered === 0 && Date.now() - startedAt < 1000) {
            await this.sleep(delay);
            delay = Math.min(delay * 2, this.opts.backoffMaxMs);
          }
        } else {
          this.stateValue = 'polling';
          this.lastErrorValue = undefined;
          delay = this.opts.backoffMinMs;
          await this.sleep(this.opts.pollIntervalMs);
        }
      } catch (err) {
        if (this.closed) return;
        this.flushPending();
        if (err instanceof CursorExpiredError) {
          needReload = true;
          continue;
        }
        this.lastErrorValue = (err as Error)?.message ?? String(err);
        if (err instanceof ProviderError && !err.retryable) {
          this.stateValue = 'failed';
          this.logger.error(`provider log ${this.id} failed:`, this.lastErrorValue);
          return;
        }
        this.stateValue = 'reconnecting';
        // Jittered exponential backoff; the mirror stays readable meanwhile.
        await this.sleep(delay / 2 + Math.random() * (delay / 2));
        delay = Math.min(delay * 2, this.opts.backoffMaxMs);
      }
    }
  }
}
