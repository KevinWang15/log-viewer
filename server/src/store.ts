import { AppendEvent, BaseSource, Criteria, EntryOut, matcherFor, MergedSource, StreamSource } from './sources';
import { STREAM_LIMITS } from './config';
import { StreamSpooler } from './spool';

export class StoreCapacityError extends Error {
  readonly status = 503;
  readonly code = 'stream_capacity_reached';

  constructor(readonly maxStreams: number) {
    super(`stream capacity reached (${maxStreams}); delete or wait for an idle stream before creating another`);
  }
}

export class RuleLimitError extends Error {
  readonly status = 400;
  readonly code = 'rule_limit_reached';

  constructor(readonly maxRules: number) {
    super(`rule limit reached (${maxRules} per source); delete a rule before creating another`);
  }
}

export interface FilterEntry {
  id: string;
  sourceId: string;
  criteria: Criteria;
  indices: number[];
  stats: number[];
}

// A rule: "when an entry matches criteria, do actions". Matches are counted
// over the whole source (existing entries are scanned at creation); bookmark
// and highlight actions are effective immediately, while webhooks fire only
// for entries appended after creation (no retroactive webhook storm).
export interface RuleActions {
  highlight?: string; // CSS color, validated by the HTTP layer
  bookmark?: boolean;
  webhook?: string; // http(s) URL, validated by the HTTP layer
}

export interface RuleEntry {
  id: string;
  sourceId: string;
  name?: string;
  criteria: Criteria;
  actions: RuleActions;
  matchCount: number;
  webhookErrors: number;
}

export const MAX_RULES_PER_SOURCE = 20;
export const WEBHOOK_SAMPLE_ENTRIES = 5;
const WEBHOOK_TIMEOUT_MS = 5_000;

interface MinimapCacheEntry {
  // epoch:matched-count:bookmark-version — everything the result depends on.
  stamp: string;
  body: { buckets: number[]; bookmarks: boolean[]; count: number };
}

interface ReportCacheEntry {
  epoch: number;
  n: number; // view rows folded into the aggregates below
  tmin: number;
  tmax: number;
  hist: number[][]; // per-bucket per-level counts
  loggerCounts: Map<string, number>;
  threadCounts: Map<string, number>;
  msgTemplates: Map<string, { count: number; example: string }>;
}

export const MAX_TEMPLATE_LENGTH = 200;
const TEMPLATE_UUID = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g;
const TEMPLATE_QUOTED = /"[^"\n]*"|'[^'\n]*'/g;
const TEMPLATE_HEX = /\b[0-9a-fA-F]{8,}\b/g;
const TEMPLATE_DIGITS = /\d+/g;

// One pass instead of four: alternation order keeps the old precedence
// (uuid, then quoted, then hex, then digits) at each position.
const TEMPLATE_ANY = new RegExp(
  [TEMPLATE_UUID, TEMPLATE_QUOTED, TEMPLATE_HEX, TEMPLATE_DIGITS].map((r) => r.source).join('|'),
  'g'
);

// Collapses the variable parts of a message (uuids, quoted values, hex tokens,
// numbers) so repeated log statements group into one template.
export function messageTemplate(msg: string): string {
  const t = msg.replace(TEMPLATE_ANY, '?');
  return t.length > MAX_TEMPLATE_LENGTH ? t.slice(0, MAX_TEMPLATE_LENGTH - 1) + '…' : t;
}

export class Store {
  sources = new Map<string, BaseSource>();
  filters = new Map<string, FilterEntry>();
  rules = new Map<string, RuleEntry>();
  bookmarks = new Map<string, Set<number>>(); // source id -> global entry indices
  broadcast: (msg: Record<string, unknown>) => void = () => {};
  // Injectable so tests can stub webhook delivery; the default is a
  // fire-and-forget POST with a hard timeout and no retries.
  webhookSender: (url: string, payload: Record<string, unknown>) => Promise<unknown> = (url, payload) =>
    fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
  private fidSeq = 1;
  private ridSeq = 1;
  private byPath = new Map<string, string>(); // file path(+range) -> source id
  private origins = new Map<string, string>(); // source id -> origin ('watch' for auto-opened files)
  // Content versions for the minimap/report caches: the epoch bumps on reset
  // (indices may be rebased), the bookmark version on bookmark changes.
  // Appends only ever extend a source, so cached aggregates are folded forward.
  private epochs = new Map<string, number>();
  private bmVersions = new Map<string, number>();
  private minimapCache = new Map<string, MinimapCacheEntry>(); // src|filter|buckets
  private reportCache = new Map<string, ReportCacheEntry>(); // src|filter|buckets
  // Serializes reportFor per cache key: message folding awaits entry reads, and
  // two interleaved calls would otherwise fold the same tail rows twice.
  private reportQueues = new Map<string, Promise<unknown>>();

  constructor(private readonly maxStreams = STREAM_LIMITS.maxSources, private readonly spooler?: StreamSpooler) {}

  get streamCount(): number {
    let count = 0;
    for (const source of this.sources.values()) if (source instanceof StreamSource) count++;
    return count;
  }

  get streamBytes(): number {
    let bytes = 0;
    for (const source of this.sources.values()) if (source instanceof StreamSource) bytes += source.bytes;
    return bytes;
  }

  bookmarksFor(id: string): Set<number> {
    let s = this.bookmarks.get(id);
    if (!s) {
      s = new Set();
      this.bookmarks.set(id, s);
    }
    return s;
  }

  private sourceEpoch(id: string): number {
    return this.epochs.get(id) ?? 0;
  }

  private bookmarkVersion(id: string): number {
    return this.bmVersions.get(id) ?? 0;
  }

  setBookmark(id: string, idx: number, on: boolean): number {
    const set = this.bookmarksFor(id);
    if (on) set.add(idx);
    else set.delete(idx);
    this.bmVersions.set(id, this.bookmarkVersion(id) + 1);
    return set.size;
  }

  private dropViewCaches(srcId: string, fid?: string) {
    for (const cache of [this.minimapCache, this.reportCache]) {
      for (const key of [...cache.keys()]) {
        const [sid, f] = key.split('|');
        if (sid === srcId && (fid === undefined || f === fid)) cache.delete(key);
      }
    }
    for (const key of [...this.reportQueues.keys()]) {
      const [sid, f] = key.split('|');
      if (sid === srcId && (fid === undefined || f === fid)) this.reportQueues.delete(key);
    }
  }

  // Minimap buckets cover view-index ranges [b*n/B, (b+1)*n/B), so any append
  // shifts every boundary — the result is cached but recomputed whenever the
  // row count, epoch, or bookmarks change (an idle tail polls hit the cache).
  minimapFor(src: BaseSource, f: FilterEntry | null | undefined, buckets: number) {
    const n = f ? f.indices.length : src.count;
    const stamp = `${this.sourceEpoch(src.id)}:${n}:${this.bookmarkVersion(src.id)}`;
    const key = `${src.id}|${f?.id ?? ''}|${buckets}`;
    const hit = this.minimapCache.get(key);
    if (hit && hit.stamp === stamp) return hit.body;
    const out = new Array<number>(buckets).fill(-1);
    const bm = new Array<boolean>(buckets).fill(false);
    const bmSet = this.bookmarksFor(src.id);
    if (n > 0) {
      for (let b = 0; b < buckets; b++) {
        const s = Math.floor((b * n) / buckets);
        const e = Math.max(s + 1, Math.floor(((b + 1) * n) / buckets));
        let mx = -1;
        for (let k = s; k < Math.min(e, n); k++) {
          const gi = f ? f.indices[k] : k;
          const lv = src.levelAt(gi);
          if (lv > mx) mx = lv;
          if (bmSet.size && bmSet.has(gi)) bm[b] = true;
        }
        out[b] = mx;
      }
    }
    const body = { buckets: out, bookmarks: bm, count: n };
    this.minimapCache.set(key, { stamp, body });
    return body;
  }

  // Report aggregates are folded forward on append: new rows join the cached
  // histogram/top counters as long as they don't extend the time range (which
  // would move every bucket boundary and forces a full recompute).
  reportFor(src: BaseSource, f: FilterEntry | null | undefined, buckets: number) {
    const key = `${src.id}|${f?.id ?? ''}|${buckets}`;
    const prev = this.reportQueues.get(key) ?? Promise.resolve();
    const next = prev.then(() => this.computeReport(src, f, buckets, key));
    this.reportQueues.set(
      key,
      next.catch(() => {})
    );
    return next;
  }

  private async computeReport(src: BaseSource, f: FilterEntry | null | undefined, buckets: number, key: string) {
    const n = f ? f.indices.length : src.count;
    const epoch = this.sourceEpoch(src.id);
    const at = (k: number) => (f ? f.indices[k] : k);
    const empty = (): ReportCacheEntry => ({
      epoch,
      n: 0,
      tmin: Infinity,
      tmax: -Infinity,
      hist: Array.from({ length: buckets }, () => [0, 0, 0, 0, 0, 0]),
      loggerCounts: new Map<string, number>(),
      threadCounts: new Map<string, number>(),
      msgTemplates: new Map<string, { count: number; example: string }>(),
    });
    let c = this.reportCache.get(key);
    if (!c || c.epoch !== epoch) c = empty();
    // Time range of the rows not yet folded into the cache.
    let tailMin = Infinity;
    let tailMax = -Infinity;
    for (let k = c.n; k < n; k++) {
      const t = src.timeAt(at(k));
      if (t) {
        if (t < tailMin) tailMin = t;
        if (t > tailMax) tailMax = t;
      }
    }
    if (c.n > 0 && Number.isFinite(tailMin) && (!Number.isFinite(c.tmin) || tailMin < c.tmin || tailMax > c.tmax)) {
      c = empty();
    }
    if (c.n === 0) {
      // Full (re)compute: the first pass fixes the bucket time range.
      for (let k = 0; k < n; k++) {
        const t = src.timeAt(at(k));
        if (t) {
          if (t < c.tmin) c.tmin = t;
          if (t > c.tmax) c.tmax = t;
        }
      }
    }
    // Keep the raw (possibly infinite) range in the cache — the normalized
    // 0/1 fallback is only for the response and would break range tracking.
    const tmin = Number.isFinite(c.tmin) ? c.tmin : 0;
    const tmax = Number.isFinite(c.tmax) ? c.tmax : 1;
    const span = Math.max(1, tmax - tmin);
    const foldFrom = c.n;
    for (let k = foldFrom; k < n; k++) {
      const gi = at(k);
      const t = src.timeAt(gi);
      const b = t ? Math.min(buckets - 1, Math.floor(((t - tmin) / span) * buckets)) : 0;
      c.hist[b][src.levelAt(gi)]++;
      const lg = src.loggerAt(gi);
      if (lg) c.loggerCounts.set(lg, (c.loggerCounts.get(lg) || 0) + 1);
      const th = src.threadAt(gi);
      if (th) c.threadCounts.set(th, (c.threadCounts.get(th) || 0) + 1);
    }
    // Message templates need the parsed message, which is not indexed: read
    // the not-yet-folded rows in coalesced batches.
    const MSG_BATCH = 4096;
    for (let s = foldFrom; s < n; s += MSG_BATCH) {
      const idxs: number[] = [];
      for (let k = s; k < Math.min(n, s + MSG_BATCH); k++) idxs.push(at(k));
      for (const msg of await src.getMessages(idxs)) {
        const template = messageTemplate(msg);
        const rec = c.msgTemplates.get(template);
        if (rec) rec.count++;
        else {
          c.msgTemplates.set(template, {
            count: 1,
            example: msg.length > MAX_TEMPLATE_LENGTH ? msg.slice(0, MAX_TEMPLATE_LENGTH - 1) + '…' : msg,
          });
        }
      }
    }
    c.n = n;
    this.reportCache.set(key, c);
    const top = (m: Map<string, number>) =>
      [...m.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([name, count]) => ({ name, count }));
    return {
      from: tmin,
      to: tmax,
      total: n,
      buckets: c.hist.map((counts, b) => ({ t: tmin + (span * b) / buckets, counts: [...counts] })),
      series: [0, 1, 2, 3, 4, 5].map((lv) => c.hist.map((counts) => counts[lv])),
      topLoggers: top(c.loggerCounts),
      topThreads: top(c.threadCounts),
      topMessages: [...c.msgTemplates.entries()]
        .sort((a, b) => b[1].count - a[1].count)
        .slice(0, 10)
        .map(([template, rec]) => ({ template, count: rec.count, example: rec.example })),
    };
  }

  addSource(src: BaseSource, filePath?: string) {
    this.sources.set(src.id, src);
    if (filePath) this.byPath.set(filePath, src.id);
    src.on('append', (ev: AppendEvent) => {
      this.handleAppend(src, ev).catch((err) => console.error('append handling failed:', err));
    });
    src.on('reset', () => {
      this.handleReset(src).catch((err) => console.error('reset handling failed:', err));
    });
  }

  sourceForPath(filePath: string): BaseSource | undefined {
    const id = this.byPath.get(filePath);
    return id ? this.sources.get(id) : undefined;
  }

  // How a source was opened; currently only the directory monitor sets this.
  setOrigin(id: string, origin: string) {
    this.origins.set(id, origin);
  }

  originFor(id: string): string | undefined {
    return this.origins.get(id);
  }

  getStream(channel: string, touch = true): StreamSource | undefined {
    const src = this.sources.get('s:' + channel);
    if (!(src instanceof StreamSource)) return undefined;
    if (touch) src.touch();
    return src;
  }

  getOrCreateStream(channel: string): StreamSource {
    const existing = this.getStream(channel);
    if (existing) return existing;
    if (this.maxStreams > 0 && this.streamCount >= this.maxStreams) throw new StoreCapacityError(this.maxStreams);
    const src = new StreamSource('s:' + channel, channel);
    this.spooler?.attach(src);
    this.addSource(src);
    return src;
  }

  async removeIdleStreams(idleForMs: number, now = Date.now()): Promise<number> {
    if (idleForMs <= 0) return 0;
    const expired: string[] = [];
    for (const src of this.sources.values()) {
      if (src instanceof StreamSource && now - src.lastActivityAt >= idleForMs) expired.push(src.id);
    }
    for (const id of expired) await this.removeSource(id);
    return expired.length;
  }

  // Maps a global entry index to a view index, so a client can keep its place
  // when the filter changes. Exact when the entry is in the view; otherwise the
  // neighbour (previous or next kept entry) with the closer timestamp, falling
  // back to the next one when timestamps are missing. Filter indices are
  // ascending, so this is a binary search.
  locate(src: BaseSource, f: FilterEntry | null | undefined, i: number): { vi: number; exact: boolean } | null {
    const n = f ? f.indices.length : src.count;
    if (n === 0) return null;
    if (!f) {
      const vi = Math.max(0, Math.min(n - 1, i));
      return { vi, exact: vi === i };
    }
    const idx = f.indices;
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (idx[mid] < i) lo = mid + 1;
      else hi = mid;
    }
    if (lo < n && idx[lo] === i) return { vi: lo, exact: true };
    if (lo === 0) return { vi: 0, exact: false };
    if (lo === n) return { vi: n - 1, exact: false };
    const t = src.timeAt(Math.max(0, Math.min(src.count - 1, i)));
    const tPrev = src.timeAt(idx[lo - 1]);
    const tNext = src.timeAt(idx[lo]);
    if (![t, tPrev, tNext].every((x) => Number.isFinite(x) && x > 0)) return { vi: lo, exact: false };
    return { vi: t - tPrev < tNext - t ? lo - 1 : lo, exact: false };
  }

  async createFilter(src: BaseSource, criteria: Criteria): Promise<FilterEntry> {
    const indices = await src.evalCriteria(criteria);
    const f: FilterEntry = {
      id: 'F' + this.fidSeq++,
      sourceId: src.id,
      criteria,
      indices,
      stats: src.statsOf(indices),
    };
    this.filters.set(f.id, f);
    return f;
  }

  removeFilter(fid: string) {
    const f = this.filters.get(fid);
    this.filters.delete(fid);
    if (f) this.dropViewCaches(f.sourceId, fid);
  }

  // Creating a rule scans the existing entries once (like creating a filter):
  // the match count covers them and the bookmark action applies to them.
  // Webhooks deliberately do NOT fire for this creation-time scan.
  async createRule(src: BaseSource, criteria: Criteria, actions: RuleActions, name?: string): Promise<RuleEntry> {
    if (this.rulesFor(src.id).length >= MAX_RULES_PER_SOURCE) throw new RuleLimitError(MAX_RULES_PER_SOURCE);
    const indices = await src.evalCriteria(criteria);
    const rule: RuleEntry = {
      id: 'R' + this.ridSeq++,
      sourceId: src.id,
      name,
      criteria,
      actions,
      matchCount: indices.length,
      webhookErrors: 0,
    };
    this.rules.set(rule.id, rule);
    if (actions.bookmark) for (const i of indices) this.setBookmark(src.id, i, true);
    return rule;
  }

  removeRule(rid: string) {
    // Bookmarks created by the rule are kept: they are plain bookmarks once set.
    this.rules.delete(rid);
  }

  rulesFor(sourceId: string): RuleEntry[] {
    return [...this.rules.values()].filter((r) => r.sourceId === sourceId);
  }

  // dropSpool=false keeps the stream's spool file on disk (graceful shutdown);
  // explicit deletes and idle expiry use the default and remove it.
  async removeSource(id: string, opts?: { dropSpool?: boolean }) {
    const src = this.sources.get(id);
    if (!src) return;
    // Merged views depending on this source must go first.
    for (const other of [...this.sources.values()]) {
      if (other instanceof MergedSource && other.childIds.includes(id)) await this.removeSource(other.id);
    }
    this.sources.delete(id);
    this.bookmarks.delete(id);
    this.epochs.delete(id);
    this.bmVersions.delete(id);
    this.dropViewCaches(id);
    for (const [fid, f] of this.filters) if (f.sourceId === id) this.filters.delete(fid);
    for (const [rid, r] of this.rules) if (r.sourceId === id) this.rules.delete(rid);
    for (const [p, sid] of this.byPath) if (sid === id) this.byPath.delete(p);
    this.origins.delete(id);
    await src.close();
    if (opts?.dropSpool !== false && src instanceof StreamSource) await this.spooler?.remove(src.name);
  }

  // Incremental rule matching, mirroring the filter path above: small batches
  // carry parsed entries and match in memory, large ones re-evaluate just the
  // appended range. Webhook delivery is fire-and-forget; a slow or failing
  // endpoint never delays the append path.
  private async applyRules(src: BaseSource, ev: AppendEvent) {
    for (const r of this.rules.values()) {
      if (r.sourceId !== src.id) continue;
      let matched: EntryOut[] = [];
      if (ev.entries && ev.entries.length === ev.added) {
        const match = matcherFor(r.criteria);
        matched = ev.entries.filter(match);
      } else if (ev.added > 0) {
        const indices = await src.evalCriteria(r.criteria, ev.startIdx, ev.startIdx + ev.added);
        if (indices.length) matched = await src.getEntries(indices);
      }
      if (!matched.length) continue;
      r.matchCount += matched.length;
      if (r.actions.bookmark) for (const e of matched) this.setBookmark(src.id, e.i, true);
      if (r.actions.webhook) this.fireWebhook(r, src, matched);
    }
  }

  private fireWebhook(rule: RuleEntry, src: BaseSource, matched: EntryOut[]) {
    const url = rule.actions.webhook;
    if (!url) return;
    const payload = {
      ruleId: rule.id,
      ruleName: rule.name,
      source: src.id,
      sourceName: src.name,
      matched: matched.length,
      // Entry text is already capped at ingestion; the sample carries at most
      // WEBHOOK_SAMPLE_ENTRIES entries in the compact grid shape.
      sample: matched.slice(0, WEBHOOK_SAMPLE_ENTRIES).map((e) => ({ i: e.i, t: e.t, lv: e.lv, th: e.th, lg: e.lg, msg: e.msg })),
    };
    void this.webhookSender(url, payload).catch(() => {
      // Delivery errors are swallowed and counted on the rule.
      rule.webhookErrors++;
    });
  }

  private async handleAppend(src: BaseSource, ev: AppendEvent) {
    const filterUpdates: Record<string, { count: number; stats: number[] }> = {};
    for (const f of this.filters.values()) {
      if (f.sourceId !== src.id) continue;
      if (ev.entries && ev.entries.length === ev.added) {
        const match = matcherFor(f.criteria);
        for (const e of ev.entries) {
          if (match(e)) {
            f.indices.push(e.i);
            f.stats[e.lv]++;
          }
        }
      } else if (ev.added > 0) {
        // Large batches carry no per-entry payloads: evaluate only the
        // appended range (text criteria block-read just the new bytes).
        const matched = await src.evalCriteria(f.criteria, ev.startIdx, ev.startIdx + ev.added);
        for (const i of matched) {
          f.indices.push(i);
          f.stats[src.levelAt(i)]++;
        }
      }
      filterUpdates[f.id] = { count: f.indices.length, stats: f.stats };
    }
    await this.applyRules(src, ev);
    this.broadcast({
      type: 'append',
      id: src.id,
      count: src.count,
      stats: src.stats,
      added: ev.added,
      filters: filterUpdates,
    });
  }

  private async handleReset(src: BaseSource) {
    // Resets can rebase source indices (file truncation or stream retention),
    // so old bookmark positions are no longer meaningful.
    this.bookmarks.delete(src.id);
    this.epochs.set(src.id, this.sourceEpoch(src.id) + 1);
    const filterUpdates: Record<string, { count: number; stats: number[] }> = {};
    for (const f of this.filters.values()) {
      if (f.sourceId !== src.id) continue;
      f.indices = await src.evalCriteria(f.criteria);
      f.stats = src.statsOf(f.indices);
      filterUpdates[f.id] = { count: f.indices.length, stats: f.stats };
    }
    // A reset rebases indices, so recompute rule counts from scratch; webhook
    // and bookmark actions do not re-fire (bookmarks were just dropped above).
    for (const r of this.rules.values()) {
      if (r.sourceId !== src.id) continue;
      r.matchCount = (await src.evalCriteria(r.criteria)).length;
    }
    this.broadcast({ type: 'reset', id: src.id, count: src.count, stats: src.stats, filters: filterUpdates });
  }
}
