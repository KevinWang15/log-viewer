// Core API: everything that works on any LogSource, whatever its kind.
// Sources, parser, filters, rules, entries, bookmarks, locate, search,
// correlation, export, report and minimap.

import { compilePattern, LEVEL_NAMES, LogFormat } from '../parser';
import { textTester } from '../sources';
import type { Criteria } from '../source-api';
import { RuleActions, RuleEntry, RuleLimitError } from '../store';
import type { ModuleContext, ViewerModule } from '../module';

export function ruleInfo(rule: RuleEntry) {
  return {
    id: rule.id,
    name: rule.name,
    criteria: rule.criteria,
    actions: rule.actions,
    matchCount: rule.matchCount,
    webhookErrors: rule.webhookErrors,
  };
}

// Highlight colors are hex only: #rgb, #rgba, #rrggbb or #rrggbbaa.
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;
const MAX_WEBHOOK_URL_LENGTH = 2048;
const MAX_RULE_NAME_LENGTH = 200;

// Validates the POST body; returns either the parsed pieces or a 400 message.
function ruleInput(body: unknown): { name?: string; criteria: Criteria; actions: RuleActions } | { error: string } {
  const raw = (body ?? {}) as Record<string, unknown>;
  const criteria = (raw.criteria ?? {}) as Criteria;
  if (typeof criteria !== 'object' || criteria === null || Array.isArray(criteria)) {
    return { error: 'criteria must be an object' };
  }
  const rawActions = (raw.actions ?? {}) as Record<string, unknown>;
  if (typeof rawActions !== 'object' || rawActions === null || Array.isArray(rawActions)) {
    return { error: 'actions must be an object' };
  }
  const actions: RuleActions = {};
  if (rawActions.highlight !== undefined) {
    const highlight = String(rawActions.highlight);
    if (!HEX_COLOR.test(highlight)) return { error: 'highlight must be a hex color like #fff2c8' };
    actions.highlight = highlight;
  }
  if (rawActions.bookmark !== undefined) actions.bookmark = !!rawActions.bookmark;
  if (rawActions.webhook !== undefined) {
    const webhook = String(rawActions.webhook);
    if (webhook.length > MAX_WEBHOOK_URL_LENGTH) {
      return { error: `webhook URL exceeds ${MAX_WEBHOOK_URL_LENGTH} characters` };
    }
    let parsed: URL;
    try {
      parsed = new URL(webhook);
    } catch {
      return { error: 'webhook must be a valid URL' };
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return { error: 'webhook must be an http(s) URL' };
    }
    actions.webhook = webhook;
  }
  const name =
    typeof raw.name === 'string' && raw.name.trim() ? raw.name.trim().slice(0, MAX_RULE_NAME_LENGTH) : undefined;
  return { name, criteria, actions };
}

// Key discovery order. Structured stream entries keep only the mapped fields
// (time/level/thread/logger/message), so discovery is a regex scan of the
// entry text for `key=value`, `key: value` or JSON `"key":"value"` shapes,
// tried in this order; an explicit `key=` query picks that key only.
const CORRELATE_KEYS = [
  'requestId',
  'request_id',
  'request-id',
  'traceId',
  'trace_id',
  'correlationId',
  'correlation_id',
  'sessionId',
  'session_id',
  'spanId',
  'flowId',
  'jobId',
];
const CORRELATE_MAX_SCAN = 2_000_000;
const CORRELATE_MAX_INDICES = 10_000;

function extractCorrelation(raw: string, key?: string): { key: string; value: string } | null {
  for (const k of key ? [key] : CORRELATE_KEYS) {
    const re = new RegExp(
      `(?<![\\w-])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*[:=]\\s*["']?([\\w.-]+)`,
      'i'
    );
    const m = re.exec(raw);
    if (m) return { key: k, value: m[1] };
  }
  return null;
}

export function coreModule(ctx: ModuleContext): ViewerModule {
  const { router: app, store, wrap, sourceInfo, sourceOr404, allow } = ctx;

  app.get(
    '/api/logs',
    wrap(async (req, res) => {
      // Lists only the sources the caller may read (custom authorizers can
      // scope readers to some sources).
      const visible = [];
      for (const src of store.sources.values()) {
        if ((await ctx.check(req, 'read', { source: src })) === true) visible.push(sourceInfo(src));
      }
      res.json({ sources: visible });
    })
  );

  app.get('/api/logs/:id', (req, res) => {
    const src = sourceOr404(req, res);
    if (src) res.json(sourceInfo(src));
  });

  app.delete(
    '/api/logs/:id',
    wrap(async (req, res) => {
      const src = store.sources.get(req.params.id);
      if (src && !(await allow(req, res, 'configure', { source: src }))) return;
      await store.removeSource(req.params.id);
      res.json({ ok: true });
    })
  );

  // ---- Custom parser (user-defined conversion pattern) -----------------------

  // Sets or clears a per-source log4j-style pattern. Setting re-indexes the
  // source with the compiled format; deleting restores auto-detection. Only
  // sources that implement setFormat support it.
  const parserUnsupported = (kind: string) =>
    kind === 'merged' ? 'custom parser is not supported for merged views' : `custom parser is not supported for ${kind} sources`;

  app.post(
    '/api/logs/:id/parser',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      if (!src.setFormat) {
        res.status(400).json({ error: parserUnsupported(src.kind) });
        return;
      }
      if (!(await allow(req, res, 'configure', { source: src }))) return;
      const pattern = req.body?.pattern;
      if (typeof pattern !== 'string') {
        res.status(400).json({ error: 'pattern is required' });
        return;
      }
      let format: LogFormat;
      try {
        format = compilePattern(pattern);
      } catch (err) {
        res.status(400).json({ error: (err as Error).message });
        return;
      }
      await src.setFormat(format, pattern);
      res.json(sourceInfo(src));
    })
  );

  app.delete(
    '/api/logs/:id/parser',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      if (!src.setFormat) {
        res.status(400).json({ error: parserUnsupported(src.kind) });
        return;
      }
      if (!(await allow(req, res, 'configure', { source: src }))) return;
      await src.setFormat(null);
      res.json(sourceInfo(src));
    })
  );

  // ---- Filters ---------------------------------------------------------------

  app.post(
    '/api/logs/:id/filters',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      if (!(await allow(req, res, 'view-state', { source: src }))) return;
      const criteria: Criteria = req.body?.criteria ?? req.body ?? {};
      let f;
      try {
        f = await store.createFilter(src, criteria);
      } catch (e) {
        if (e instanceof SyntaxError) {
          res.status(400).json({ error: 'invalid regex: ' + e.message });
          return;
        }
        throw e;
      }
      res.json({ filterId: f.id, count: f.indices.length, stats: f.stats });
    })
  );

  app.delete(
    '/api/logs/:id/filters/:fid',
    wrap(async (req, res) => {
      if (!(await allow(req, res, 'view-state', { source: store.sources.get(req.params.id) }))) return;
      store.removeFilter(req.params.fid);
      res.json({ ok: true });
    })
  );

  // ---- Rules (match criteria → highlight/bookmark/webhook actions) -----------

  app.post(
    '/api/logs/:id/rules',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      if (!(await allow(req, res, 'configure', { source: src }))) return;
      const parsed = ruleInput(req.body);
      if ('error' in parsed) {
        res.status(400).json({ error: parsed.error });
        return;
      }
      try {
        const rule = await store.createRule(src, parsed.criteria, parsed.actions, parsed.name);
        res.json(ruleInfo(rule));
      } catch (err) {
        if (err instanceof RuleLimitError) {
          res.status(err.status).json({ error: err.message, code: err.code });
          return;
        }
        throw err;
      }
    })
  );

  app.get('/api/logs/:id/rules', (req, res) => {
    const src = sourceOr404(req, res);
    if (src) res.json({ rules: store.rulesFor(src.id).map(ruleInfo) });
  });

  app.delete(
    '/api/logs/:id/rules/:rid',
    wrap(async (req, res) => {
      const src = store.sources.get(req.params.id);
      if (src && !(await allow(req, res, 'configure', { source: src }))) return;
      store.removeRule(req.params.rid);
      res.json({ ok: true });
    })
  );

  // ---- Entries (virtual scrolling windows) -----------------------------------

  app.get(
    '/api/logs/:id/entries',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      const start = Math.max(0, Number(req.query.start) || 0);
      const count = Math.min(1000, Math.max(1, Number(req.query.count) || 100));
      const fid = req.query.filter ? String(req.query.filter) : null;
      const f = fid ? store.filters.get(fid) : null;
      if (fid && (!f || f.sourceId !== src.id)) {
        res.status(404).json({ error: 'unknown filter ' + fid });
        return;
      }
      let idxs: number[];
      if (f) {
        idxs = f.indices.slice(start, start + count);
      } else {
        idxs = [];
        const end = Math.min(src.count, start + count);
        for (let i = start; i < end; i++) idxs.push(i);
      }
      const entries = await src.getEntries(idxs);
      // Elapsed time against the previous entry in the current view (filter
      // aware). The window's first row compares against the view entry just
      // above it, so paging into the middle of a view stays correct.
      let prevT = 0;
      if (start > 0 && start <= (f ? f.indices.length : src.count)) {
        prevT = src.timeAt(f ? f.indices[start - 1] : start - 1) || 0;
      }
      for (const e of entries) {
        e.elapsed = prevT && e.t ? e.t - prevT : null;
        prevT = e.t;
      }
      res.json({ start, entries });
    })
  );

  // ---- Bookmarks -------------------------------------------------------------

  app.get('/api/logs/:id/bookmarks', (req, res) => {
    res.json({ indices: [...store.bookmarksFor(req.params.id)].sort((a, b) => a - b) });
  });

  app.put(
    '/api/logs/:id/bookmarks',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      if (!(await allow(req, res, 'view-state', { source: src }))) return;
      const idx = Number(req.body?.index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= src.count) {
        res.status(400).json({ error: 'invalid index' });
        return;
      }
      const on = req.body?.on !== undefined ? !!req.body.on : !store.bookmarksFor(src.id).has(idx);
      const total = store.setBookmark(src.id, idx, on);
      res.json({ index: idx, on, total });
    })
  );

  // ---- Locate (keep position across filter changes) --------------------------

  app.get('/api/logs/:id/locate', (req, res) => {
    const src = sourceOr404(req, res);
    if (!src) return;
    const i = Number(req.query.i);
    if (!Number.isInteger(i) || i < 0) {
      res.status(400).json({ error: 'i must be a non-negative integer' });
      return;
    }
    const f = req.query.filter ? store.filters.get(String(req.query.filter)) : null;
    if (req.query.filter && (!f || f.sourceId !== src.id)) {
      res.status(404).json({ error: 'unknown filter ' + String(req.query.filter) });
      return;
    }
    res.json(store.locate(src, f, i) ?? { vi: null, exact: false });
  });

  // Next/previous bookmark relative to a view position (honors active filter).
  app.get('/api/logs/:id/bookmarks/next', (req, res) => {
    const src = sourceOr404(req, res);
    if (!src) return;
    const set = store.bookmarksFor(src.id);
    const dir = req.query.dir === 'prev' ? -1 : 1;
    const from = Number(req.query.from ?? -1);
    const f = req.query.filter ? store.filters.get(String(req.query.filter)) : null;
    const n = f ? f.indices.length : src.count;
    for (let vi = from + dir; vi >= 0 && vi < n; vi += dir) {
      if (set.has(f ? f.indices[vi] : vi)) {
        res.json({ vi });
        return;
      }
    }
    res.json({ vi: null });
  });

  // ---- Search (find next/prev without filtering) -----------------------------

  app.get(
    '/api/logs/:id/search',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      const q = String(req.query.q || '');
      if (!q) {
        res.json({ vi: null });
        return;
      }
      let test: (raw: string) => boolean;
      try {
        test = textTester(q, req.query.regex === '1', req.query.cs === '1');
      } catch (err) {
        res.status(400).json({ error: 'invalid regex: ' + (err as Error).message });
        return;
      }
      const dir = req.query.dir === 'prev' ? -1 : 1;
      const from = Number(req.query.from ?? -1);
      const f = req.query.filter ? store.filters.get(String(req.query.filter)) : null;
      const n = f ? f.indices.length : src.count;
      const MAX_SCAN = 2_000_000;
      const startVi = from + dir;
      if (f) {
        // A filtered view is sparse in the source; scan it in entry batches.
        const BATCH = 500;
        let vi = startVi;
        let scanned = 0;
        while (vi >= 0 && vi < n && scanned < MAX_SCAN) {
          const batchVi: number[] = [];
          for (let k = 0; k < BATCH && vi >= 0 && vi < n; k++, vi += dir) batchVi.push(vi);
          const es = await src.getEntries(batchVi.map((v) => f.indices[v]));
          for (let k = 0; k < es.length; k++) {
            if (test(es[k].raw)) {
              res.json({ vi: batchVi[k] });
              return;
            }
          }
          scanned += batchVi.length;
        }
        res.json({ vi: null, capped: scanned >= MAX_SCAN });
        return;
      }
      if (startVi < 0 || startVi >= n) {
        res.json({ vi: null, capped: false });
        return;
      }
      // Unfiltered views are contiguous: scan via block reads. Forward stops at
      // the first match; backward walks entry chunks, keeping the last
      // (nearest) match per chunk.
      let vi: number | null = null;
      let scanned = 0;
      if (dir === 1) {
        await src.scanTexts(
          (i, raw) => {
            if (scanned >= MAX_SCAN) return false;
            scanned++;
            if (test(raw)) {
              vi = i;
              return false;
            }
          },
          startVi,
          n
        );
      } else {
        const CHUNK = 500;
        let hi = startVi + 1;
        while (hi > 0 && scanned < MAX_SCAN && vi === null) {
          const lo = Math.max(0, hi - CHUNK);
          let last = -1;
          await src.scanTexts(
            (i, raw) => {
              if (test(raw)) last = i;
            },
            lo,
            hi
          );
          scanned += hi - lo;
          if (last >= 0) vi = last;
          hi = lo;
        }
      }
      if (vi !== null) {
        res.json({ vi });
        return;
      }
      res.json({ vi: null, capped: scanned >= MAX_SCAN });
    })
  );

  // ---- Correlation (find every entry of a request/session) -------------------

  app.get(
    '/api/logs/:id/correlate',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      const i = Number(req.query.i);
      if (!Number.isInteger(i) || i < 0 || i >= src.count) {
        res.status(400).json({ error: 'invalid index' });
        return;
      }
      const key = typeof req.query.key === 'string' && req.query.key ? req.query.key : undefined;
      const [entry] = await src.getEntries([i]);
      const hit = extractCorrelation(entry.raw, key);
      if (!hit) {
        res.status(422).json({ error: 'no correlation id found' });
        return;
      }
      // Correlation ids are high-entropy, so a plain substring match on the
      // extracted value (same case-insensitive test as text filters) is the
      // right semantics. Correlation ignores filters and always scans the
      // whole source; merged sources scan in merged-view indices.
      const test = textTester(hit.value);
      const indices: number[] = [];
      let count = 0;
      let scanned = 0;
      let truncated = false;
      await src.scanTexts((j, raw) => {
        if (scanned >= CORRELATE_MAX_SCAN) {
          truncated = true;
          return false;
        }
        scanned++;
        if (test(raw)) {
          count++;
          if (indices.length < CORRELATE_MAX_INDICES) indices.push(j);
          else truncated = true;
        }
      });
      res.json({ key: hit.key, value: hit.value, count, indices, truncated: truncated || undefined });
    })
  );

  // ---- Export current view as plain text --------------------------------------

  app.get(
    '/api/logs/:id/export',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      const f = req.query.filter ? store.filters.get(String(req.query.filter)) : null;
      const n = Math.min(f ? f.indices.length : src.count, 2_000_000);
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.setHeader('content-disposition', `attachment; filename="${src.name.replace(/[^\w.-]+/g, '_')}-view.log"`);
      const BATCH = 1000;
      for (let s = 0; s < n; s += BATCH) {
        const idxs: number[] = [];
        for (let i = s; i < Math.min(n, s + BATCH); i++) idxs.push(f ? f.indices[i] : i);
        const es = await src.getEntries(idxs);
        for (const e of es) res.write(e.raw + '\n');
      }
      res.end();
    })
  );

  // ---- Report: time histogram + top loggers/threads/messages ------------------

  app.get(
    '/api/logs/:id/report',
    wrap(async (req, res) => {
      const src = sourceOr404(req, res);
      if (!src) return;
      const f = req.query.filter ? store.filters.get(String(req.query.filter)) : null;
      const buckets = Math.min(200, Math.max(10, Number(req.query.buckets) || 60));
      const report = await store.reportFor(src, f, buckets);
      if (req.query.format === 'csv') {
        // One row per bucket: bucket start (ISO) + per-level counts.
        const header = 'bucket_start,' + LEVEL_NAMES.map((n) => n.toLowerCase()).join(',');
        const rows = report.buckets.map((b) => [new Date(b.t).toISOString(), ...b.counts].join(','));
        res.setHeader('content-type', 'text/csv; charset=utf-8');
        res.send([header, ...rows].join('\n') + '\n');
        return;
      }
      res.json(report);
    })
  );

  // ---- Minimap (navigation strip) ---------------------------------------------

  app.get('/api/logs/:id/minimap', (req, res) => {
    const src = sourceOr404(req, res);
    if (!src) return;
    const buckets = Math.min(2000, Math.max(10, Number(req.query.buckets) || 400));
    const fid = req.query.filter ? String(req.query.filter) : null;
    const f = fid ? store.filters.get(fid) : null;
    res.json(store.minimapFor(src, f, buckets));
  });

  return { name: 'core' };
}
