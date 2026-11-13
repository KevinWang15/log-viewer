"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Store = exports.MAX_TEMPLATE_LENGTH = exports.WEBHOOK_SAMPLE_ENTRIES = exports.MAX_RULES_PER_SOURCE = exports.RuleLimitError = exports.StoreCapacityError = void 0;
exports.messageTemplate = messageTemplate;
const sources_1 = require("./sources");
const config_1 = require("./config");
class StoreCapacityError extends Error {
    maxStreams;
    status = 503;
    code = 'stream_capacity_reached';
    constructor(maxStreams) {
        super(`stream capacity reached (${maxStreams}); delete or wait for an idle stream before creating another`);
        this.maxStreams = maxStreams;
    }
}
exports.StoreCapacityError = StoreCapacityError;
class RuleLimitError extends Error {
    maxRules;
    status = 400;
    code = 'rule_limit_reached';
    constructor(maxRules) {
        super(`rule limit reached (${maxRules} per source); delete a rule before creating another`);
        this.maxRules = maxRules;
    }
}
exports.RuleLimitError = RuleLimitError;
exports.MAX_RULES_PER_SOURCE = 20;
exports.WEBHOOK_SAMPLE_ENTRIES = 5;
const WEBHOOK_TIMEOUT_MS = 5_000;
exports.MAX_TEMPLATE_LENGTH = 200;
const TEMPLATE_UUID = /[0-9a-fA-F]{8}(?:-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}/g;
const TEMPLATE_QUOTED = /"[^"\n]*"|'[^'\n]*'/g;
const TEMPLATE_HEX = /\b[0-9a-fA-F]{8,}\b/g;
const TEMPLATE_DIGITS = /\d+/g;
// Collapses the variable parts of a message (uuids, quoted values, hex tokens,
// numbers) so repeated log statements group into one template.
function messageTemplate(msg) {
    const t = msg
        .replace(TEMPLATE_UUID, '?')
        .replace(TEMPLATE_QUOTED, '?')
        .replace(TEMPLATE_HEX, '?')
        .replace(TEMPLATE_DIGITS, '?');
    return t.length > exports.MAX_TEMPLATE_LENGTH ? t.slice(0, exports.MAX_TEMPLATE_LENGTH - 1) + '…' : t;
}
class Store {
    maxStreams;
    spooler;
    sources = new Map();
    filters = new Map();
    rules = new Map();
    bookmarks = new Map(); // source id -> global entry indices
    broadcast = () => { };
    // Injectable so tests can stub webhook delivery; the default is a
    // fire-and-forget POST with a hard timeout and no retries.
    webhookSender = (url, payload) => fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    fidSeq = 1;
    ridSeq = 1;
    byPath = new Map(); // file path(+range) -> source id
    origins = new Map(); // source id -> origin ('watch' for auto-opened files)
    // Content versions for the minimap/report caches: the epoch bumps on reset
    // (indices may be rebased), the bookmark version on bookmark changes.
    // Appends only ever extend a source, so cached aggregates are folded forward.
    epochs = new Map();
    bmVersions = new Map();
    minimapCache = new Map(); // src|filter|buckets
    reportCache = new Map(); // src|filter|buckets
    // Serializes reportFor per cache key: message folding awaits entry reads, and
    // two interleaved calls would otherwise fold the same tail rows twice.
    reportQueues = new Map();
    constructor(maxStreams = config_1.STREAM_LIMITS.maxSources, spooler) {
        this.maxStreams = maxStreams;
        this.spooler = spooler;
    }
    get streamCount() {
        let count = 0;
        for (const source of this.sources.values())
            if (source instanceof sources_1.StreamSource)
                count++;
        return count;
    }
    get streamBytes() {
        let bytes = 0;
        for (const source of this.sources.values())
            if (source instanceof sources_1.StreamSource)
                bytes += source.bytes;
        return bytes;
    }
    bookmarksFor(id) {
        let s = this.bookmarks.get(id);
        if (!s) {
            s = new Set();
            this.bookmarks.set(id, s);
        }
        return s;
    }
    sourceEpoch(id) {
        return this.epochs.get(id) ?? 0;
    }
    bookmarkVersion(id) {
        return this.bmVersions.get(id) ?? 0;
    }
    setBookmark(id, idx, on) {
        const set = this.bookmarksFor(id);
        if (on)
            set.add(idx);
        else
            set.delete(idx);
        this.bmVersions.set(id, this.bookmarkVersion(id) + 1);
        return set.size;
    }
    dropViewCaches(srcId, fid) {
        for (const cache of [this.minimapCache, this.reportCache]) {
            for (const key of [...cache.keys()]) {
                const [sid, f] = key.split('|');
                if (sid === srcId && (fid === undefined || f === fid))
                    cache.delete(key);
            }
        }
        for (const key of [...this.reportQueues.keys()]) {
            const [sid, f] = key.split('|');
            if (sid === srcId && (fid === undefined || f === fid))
                this.reportQueues.delete(key);
        }
    }
    // Minimap buckets cover view-index ranges [b*n/B, (b+1)*n/B), so any append
    // shifts every boundary — the result is cached but recomputed whenever the
    // row count, epoch, or bookmarks change (an idle tail polls hit the cache).
    minimapFor(src, f, buckets) {
        const n = f ? f.indices.length : src.count;
        const stamp = `${this.sourceEpoch(src.id)}:${n}:${this.bookmarkVersion(src.id)}`;
        const key = `${src.id}|${f?.id ?? ''}|${buckets}`;
        const hit = this.minimapCache.get(key);
        if (hit && hit.stamp === stamp)
            return hit.body;
        const out = new Array(buckets).fill(-1);
        const bm = new Array(buckets).fill(false);
        const bmSet = this.bookmarksFor(src.id);
        if (n > 0) {
            for (let b = 0; b < buckets; b++) {
                const s = Math.floor((b * n) / buckets);
                const e = Math.max(s + 1, Math.floor(((b + 1) * n) / buckets));
                let mx = -1;
                for (let k = s; k < Math.min(e, n); k++) {
                    const gi = f ? f.indices[k] : k;
                    const lv = src.levelAt(gi);
                    if (lv > mx)
                        mx = lv;
                    if (bmSet.size && bmSet.has(gi))
                        bm[b] = true;
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
    reportFor(src, f, buckets) {
        const key = `${src.id}|${f?.id ?? ''}|${buckets}`;
        const prev = this.reportQueues.get(key) ?? Promise.resolve();
        const next = prev.then(() => this.computeReport(src, f, buckets, key));
        this.reportQueues.set(key, next.catch(() => { }));
        return next;
    }
    async computeReport(src, f, buckets, key) {
        const n = f ? f.indices.length : src.count;
        const epoch = this.sourceEpoch(src.id);
        const at = (k) => (f ? f.indices[k] : k);
        const empty = () => ({
            epoch,
            n: 0,
            tmin: Infinity,
            tmax: -Infinity,
            hist: Array.from({ length: buckets }, () => [0, 0, 0, 0, 0, 0]),
            loggerCounts: new Map(),
            threadCounts: new Map(),
            msgTemplates: new Map(),
        });
        let c = this.reportCache.get(key);
        if (!c || c.epoch !== epoch)
            c = empty();
        // Time range of the rows not yet folded into the cache.
        let tailMin = Infinity;
        let tailMax = -Infinity;
        for (let k = c.n; k < n; k++) {
            const t = src.timeAt(at(k));
            if (t) {
                if (t < tailMin)
                    tailMin = t;
                if (t > tailMax)
                    tailMax = t;
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
                    if (t < c.tmin)
                        c.tmin = t;
                    if (t > c.tmax)
                        c.tmax = t;
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
            if (lg)
                c.loggerCounts.set(lg, (c.loggerCounts.get(lg) || 0) + 1);
            const th = src.threadAt(gi);
            if (th)
                c.threadCounts.set(th, (c.threadCounts.get(th) || 0) + 1);
        }
        // Message templates need the parsed message, which is not indexed: read
        // the not-yet-folded rows in coalesced batches.
        const MSG_BATCH = 1000;
        for (let s = foldFrom; s < n; s += MSG_BATCH) {
            const idxs = [];
            for (let k = s; k < Math.min(n, s + MSG_BATCH); k++)
                idxs.push(at(k));
            const entries = await src.getEntries(idxs);
            for (const e of entries) {
                const template = messageTemplate(e.msg);
                const rec = c.msgTemplates.get(template);
                if (rec)
                    rec.count++;
                else {
                    c.msgTemplates.set(template, {
                        count: 1,
                        example: e.msg.length > exports.MAX_TEMPLATE_LENGTH ? e.msg.slice(0, exports.MAX_TEMPLATE_LENGTH - 1) + '…' : e.msg,
                    });
                }
            }
        }
        c.n = n;
        this.reportCache.set(key, c);
        const top = (m) => [...m.entries()]
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
    addSource(src, filePath) {
        this.sources.set(src.id, src);
        if (filePath)
            this.byPath.set(filePath, src.id);
        src.on('append', (ev) => {
            this.handleAppend(src, ev).catch((err) => console.error('append handling failed:', err));
        });
        src.on('reset', () => {
            this.handleReset(src).catch((err) => console.error('reset handling failed:', err));
        });
    }
    sourceForPath(filePath) {
        const id = this.byPath.get(filePath);
        return id ? this.sources.get(id) : undefined;
    }
    // How a source was opened; currently only the directory monitor sets this.
    setOrigin(id, origin) {
        this.origins.set(id, origin);
    }
    originFor(id) {
        return this.origins.get(id);
    }
    getStream(channel, touch = true) {
        const src = this.sources.get('s:' + channel);
        if (!(src instanceof sources_1.StreamSource))
            return undefined;
        if (touch)
            src.touch();
        return src;
    }
    getOrCreateStream(channel) {
        const existing = this.getStream(channel);
        if (existing)
            return existing;
        if (this.maxStreams > 0 && this.streamCount >= this.maxStreams)
            throw new StoreCapacityError(this.maxStreams);
        const src = new sources_1.StreamSource('s:' + channel, channel);
        this.spooler?.attach(src);
        this.addSource(src);
        return src;
    }
    async removeIdleStreams(idleForMs, now = Date.now()) {
        if (idleForMs <= 0)
            return 0;
        const expired = [];
        for (const src of this.sources.values()) {
            if (src instanceof sources_1.StreamSource && now - src.lastActivityAt >= idleForMs)
                expired.push(src.id);
        }
        for (const id of expired)
            await this.removeSource(id);
        return expired.length;
    }
    async createFilter(src, criteria) {
        const indices = await src.evalCriteria(criteria);
        const f = {
            id: 'F' + this.fidSeq++,
            sourceId: src.id,
            criteria,
            indices,
            stats: src.statsOf(indices),
        };
        this.filters.set(f.id, f);
        return f;
    }
    removeFilter(fid) {
        const f = this.filters.get(fid);
        this.filters.delete(fid);
        if (f)
            this.dropViewCaches(f.sourceId, fid);
    }
    // Creating a rule scans the existing entries once (like creating a filter):
    // the match count covers them and the bookmark action applies to them.
    // Webhooks deliberately do NOT fire for this creation-time scan.
    async createRule(src, criteria, actions, name) {
        if (this.rulesFor(src.id).length >= exports.MAX_RULES_PER_SOURCE)
            throw new RuleLimitError(exports.MAX_RULES_PER_SOURCE);
        const indices = await src.evalCriteria(criteria);
        const rule = {
            id: 'R' + this.ridSeq++,
            sourceId: src.id,
            name,
            criteria,
            actions,
            matchCount: indices.length,
            webhookErrors: 0,
        };
        this.rules.set(rule.id, rule);
        if (actions.bookmark)
            for (const i of indices)
                this.setBookmark(src.id, i, true);
        return rule;
    }
    removeRule(rid) {
        // Bookmarks created by the rule are kept: they are plain bookmarks once set.
        this.rules.delete(rid);
    }
    rulesFor(sourceId) {
        return [...this.rules.values()].filter((r) => r.sourceId === sourceId);
    }
    // dropSpool=false keeps the stream's spool file on disk (graceful shutdown);
    // explicit deletes and idle expiry use the default and remove it.
    async removeSource(id, opts) {
        const src = this.sources.get(id);
        if (!src)
            return;
        // Merged views depending on this source must go first.
        for (const other of [...this.sources.values()]) {
            if (other instanceof sources_1.MergedSource && other.childIds.includes(id))
                await this.removeSource(other.id);
        }
        this.sources.delete(id);
        this.bookmarks.delete(id);
        this.epochs.delete(id);
        this.bmVersions.delete(id);
        this.dropViewCaches(id);
        for (const [fid, f] of this.filters)
            if (f.sourceId === id)
                this.filters.delete(fid);
        for (const [rid, r] of this.rules)
            if (r.sourceId === id)
                this.rules.delete(rid);
        for (const [p, sid] of this.byPath)
            if (sid === id)
                this.byPath.delete(p);
        this.origins.delete(id);
        await src.close();
        if (opts?.dropSpool !== false && src instanceof sources_1.StreamSource)
            await this.spooler?.remove(src.name);
    }
    // Incremental rule matching, mirroring the filter path above: small batches
    // carry parsed entries and match in memory, large ones re-evaluate just the
    // appended range. Webhook delivery is fire-and-forget; a slow or failing
    // endpoint never delays the append path.
    async applyRules(src, ev) {
        for (const r of this.rules.values()) {
            if (r.sourceId !== src.id)
                continue;
            let matched = [];
            if (ev.entries && ev.entries.length === ev.added) {
                const match = (0, sources_1.matcherFor)(r.criteria);
                matched = ev.entries.filter(match);
            }
            else if (ev.added > 0) {
                const indices = await src.evalCriteria(r.criteria, ev.startIdx, ev.startIdx + ev.added);
                if (indices.length)
                    matched = await src.getEntries(indices);
            }
            if (!matched.length)
                continue;
            r.matchCount += matched.length;
            if (r.actions.bookmark)
                for (const e of matched)
                    this.setBookmark(src.id, e.i, true);
            if (r.actions.webhook)
                this.fireWebhook(r, src, matched);
        }
    }
    fireWebhook(rule, src, matched) {
        const url = rule.actions.webhook;
        if (!url)
            return;
        const payload = {
            ruleId: rule.id,
            ruleName: rule.name,
            source: src.id,
            sourceName: src.name,
            matched: matched.length,
            // Entry text is already capped at ingestion; the sample carries at most
            // WEBHOOK_SAMPLE_ENTRIES entries in the compact grid shape.
            sample: matched.slice(0, exports.WEBHOOK_SAMPLE_ENTRIES).map((e) => ({ i: e.i, t: e.t, lv: e.lv, th: e.th, lg: e.lg, msg: e.msg })),
        };
        void this.webhookSender(url, payload).catch(() => {
            // Delivery errors are swallowed and counted on the rule.
            rule.webhookErrors++;
        });
    }
    async handleAppend(src, ev) {
        const filterUpdates = {};
        for (const f of this.filters.values()) {
            if (f.sourceId !== src.id)
                continue;
            if (ev.entries && ev.entries.length === ev.added) {
                const match = (0, sources_1.matcherFor)(f.criteria);
                for (const e of ev.entries) {
                    if (match(e)) {
                        f.indices.push(e.i);
                        f.stats[e.lv]++;
                    }
                }
            }
            else if (ev.added > 0) {
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
    async handleReset(src) {
        // Resets can rebase source indices (file truncation or stream retention),
        // so old bookmark positions are no longer meaningful.
        this.bookmarks.delete(src.id);
        this.epochs.set(src.id, this.sourceEpoch(src.id) + 1);
        const filterUpdates = {};
        for (const f of this.filters.values()) {
            if (f.sourceId !== src.id)
                continue;
            f.indices = await src.evalCriteria(f.criteria);
            f.stats = src.statsOf(f.indices);
            filterUpdates[f.id] = { count: f.indices.length, stats: f.stats };
        }
        // A reset rebases indices, so recompute rule counts from scratch; webhook
        // and bookmark actions do not re-fire (bookmarks were just dropped above).
        for (const r of this.rules.values()) {
            if (r.sourceId !== src.id)
                continue;
            r.matchCount = (await src.evalCriteria(r.criteria)).length;
        }
        this.broadcast({ type: 'reset', id: src.id, count: src.count, stats: src.stats, filters: filterUpdates });
    }
}
exports.Store = Store;
