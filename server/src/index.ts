import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import * as http from 'node:http';
import * as path from 'node:path';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import { WebSocketServer, WebSocket } from 'ws';
import { STREAM_LIMITS, STREAM_TOKENS, SPOOL_DIR, VIEW_KEY, WATCH_GLOBS, WATCH_INTERVAL_MS } from './config';
import { BaseSource, Criteria, FileLogSource, isGzipFile, MergedSource, RemoteSource, StreamSource, textTester } from './sources';
import { compilePattern, LEVEL_NAMES, LogFormat } from './parser';
import { Store, RuleActions, RuleEntry, RuleLimitError, StoreCapacityError } from './store';
import { StreamSpooler } from './spool';
import { WsBroadcaster } from './broadcast';
import { ensureSampleLogs } from './sample';
import { startDemoStream } from './demo';
import { makeFileOpener, startDirectoryWatch } from './watch';

const PORT = Number(process.env.PORT || 5178);
const ROOT = path.resolve(process.env.LOG_ROOT || os.homedir());
const SAMPLES_DIR = path.resolve(process.cwd(), 'sample-logs');

const STREAM_KEY = process.env.STREAM_KEY || '';
const CORS_ORIGINS = (process.env.CORS_ORIGIN || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const ENABLE_DEMO = !/^(?:0|false|no)$/i.test(process.env.ENABLE_DEMO || 'true');
const ENABLE_SAMPLES = !/^(?:0|false|no)$/i.test(process.env.ENABLE_SAMPLES || 'true');
const SERVICE_VERSION = process.env.APP_VERSION || '0.1.0';

const spooler = SPOOL_DIR ? new StreamSpooler(path.resolve(SPOOL_DIR)) : null;
const store = new Store(STREAM_LIMITS.maxSources, spooler ?? undefined);
let fileSeq = 1;
let mergeSeq = 1;
let remoteSeq = 1;

function isAllowedPath(p: string): boolean {
  return p === ROOT || p.startsWith(ROOT + path.sep) || p === SAMPLES_DIR || p.startsWith(SAMPLES_DIR + path.sep);
}

function ruleInfo(rule: RuleEntry) {
  return {
    id: rule.id,
    name: rule.name,
    criteria: rule.criteria,
    actions: rule.actions,
    matchCount: rule.matchCount,
    webhookErrors: rule.webhookErrors,
  };
}

function sourceInfo(src: BaseSource) {
  return {
    id: src.id,
    kind: src.kind,
    name: src.name,
    path: src instanceof FileLogSource ? src.path : undefined,
    count: src.count,
    stats: src.stats,
    threads: src.threadList,
    loggers: src.loggerList,
    format: src.formatName,
    pattern: src instanceof FileLogSource || src instanceof StreamSource ? src.customPattern : undefined,
    gzipped: src instanceof FileLogSource && src.gzipped ? true : undefined,
    remote: src instanceof RemoteSource ? { url: src.remoteUrl, source: src.remoteSourceId } : undefined,
    connected: src instanceof RemoteSource ? src.connected : undefined,
    origin: store.originFor(src.id),
    bytes: src instanceof StreamSource ? src.bytes : undefined,
    lastActivityAt: src instanceof StreamSource ? src.lastActivityAt : undefined,
    rules: store.rulesFor(src.id).map(ruleInfo),
  };
}

function streamAck(src: StreamSource) {
  return { ok: true, id: src.id, count: src.count, stats: src.stats, bytes: src.bytes };
}

const app = express();
if (CORS_ORIGINS.length) {
  app.use(
    cors({
      origin(origin, callback) {
        if (!origin || CORS_ORIGINS.includes('*') || CORS_ORIGINS.includes(origin)) callback(null, true);
        else {
          const err = new Error('origin is not allowed by CORS policy') as Error & { status: number };
          err.status = 403;
          callback(err);
        }
      },
    })
  );
} else if (process.env.NODE_ENV !== 'production') {
  app.use(cors());
}
app.use(express.json({ limit: STREAM_LIMITS.maxPayloadBytes }));

// When VIEW_KEY is set, read endpoints require an x-view-key header or a
// viewKey query parameter; the master x-stream-key also satisfies this.
app.use('/api', (req, res, next) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (viewAuthorized(req, res)) next();
});

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown>) => (req: Request, res: Response, next: NextFunction) => {
    fn(req, res).catch(next);
  };

function mutationKeyAllowed(key: string | undefined, channel: string): boolean {
  if (!STREAM_KEY && STREAM_TOKENS.length === 0) return true;
  if (STREAM_KEY && key === STREAM_KEY) return true;
  if (!key) return false;
  return STREAM_TOKENS.some(
    (scoped) =>
      scoped.token === key && (scoped.prefix === '' || scoped.prefix === '*' || channel.startsWith(scoped.prefix))
  );
}

function streamMutationAuthorized(req: Request, res: Response, channel: string): boolean {
  if (mutationKeyAllowed(req.get('x-stream-key'), channel)) return true;
  res.status(401).json({ error: 'invalid or missing x-stream-key header' });
  return false;
}

function viewAuthorized(req: Request, res: Response): boolean {
  if (!VIEW_KEY) return true;
  if (req.get('x-view-key') === VIEW_KEY || req.query.viewKey === VIEW_KEY) return true;
  if (STREAM_KEY && req.get('x-stream-key') === STREAM_KEY) return true;
  res.status(401).json({ error: 'invalid or missing x-view-key header' });
  return false;
}

function validChannel(req: Request, res: Response): string | null {
  const channel = req.params.channel;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(channel)) {
    res.status(400).json({ error: 'channel must be 1-128 URL-safe characters' });
    return null;
  }
  return channel;
}

function markLegacyStreamRoute(res: Response, successor: string) {
  res.setHeader('deprecation', 'true');
  res.setHeader('link', `<${successor}>; rel="successor-version"`);
}

// ---- File browsing -------------------------------------------------------

app.get(
  '/api/browse',
  wrap(async (req, res) => {
    const p = path.resolve(String(req.query.path || SAMPLES_DIR));
    if (!isAllowedPath(p)) {
      res.status(403).json({ error: `path outside allowed root (${ROOT})` });
      return;
    }
    let dirents;
    try {
      dirents = await fsp.readdir(p, { withFileTypes: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT' || (e as NodeJS.ErrnoException).code === 'ENOTDIR') {
        res.status(404).json({ error: 'path not found: ' + p });
        return;
      }
      throw e;
    }
    const dirs: Array<{ name: string }> = [];
    const files: Array<{ name: string; size: number; mtime: number }> = [];
    for (const d of dirents) {
      if (d.name.startsWith('.')) continue;
      try {
        if (d.isDirectory()) dirs.push({ name: d.name });
        else if (d.isFile()) {
          const st = await fsp.stat(path.join(p, d.name));
          files.push({ name: d.name, size: st.size, mtime: st.mtimeMs });
        }
      } catch {
        /* permission errors: skip */
      }
    }
    dirs.sort((a, b) => a.name.localeCompare(b.name));
    files.sort((a, b) => a.name.localeCompare(b.name));
    res.json({ path: p, parent: path.dirname(p), root: ROOT, samples: SAMPLES_DIR, dirs, files });
  })
);

// ---- Log sources ---------------------------------------------------------

app.get(
  '/api/stat',
  wrap(async (req, res) => {
    const p = path.resolve(String(req.query.path || ''));
    if (!isAllowedPath(p)) {
      res.status(403).json({ error: `path outside allowed root (${ROOT})` });
      return;
    }
    let st;
    try {
      st = await fsp.stat(p);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
        res.status(404).json({ error: 'path not found: ' + p });
        return;
      }
      throw e;
    }
    res.json({ path: p, size: st.size, mtime: st.mtimeMs, isFile: st.isFile() });
  })
);

app.post(
  '/api/logs/open',
  wrap(async (req, res) => {
    const filePath = path.resolve(String(req.body?.path || ''));
    if (!filePath) {
      res.status(400).json({ error: 'path is required' });
      return;
    }
    if (!isAllowedPath(filePath)) {
      res.status(403).json({ error: `path outside allowed root (${ROOT})` });
      return;
    }
    const start = Math.max(0, Number(req.body?.start) || 0);
    const end = req.body?.end !== undefined ? Math.max(start, Number(req.body.end) || 0) : undefined;
    const pathKey = filePath + (start > 0 || end !== undefined ? `#${start}-${end ?? ''}` : '');
    const existing = store.sourceForPath(pathKey);
    if (existing) {
      res.json(sourceInfo(existing));
      return;
    }
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      res.status(404).json({ error: 'file not found: ' + filePath });
      return;
    }
    // Gzipped rotations (magic bytes 1f 8b) are decompressed to a temp file and
    // opened from there. Byte offsets would refer to compressed bytes, so
    // chunked open is rejected for them.
    const gzipped = await isGzipFile(filePath);
    if (gzipped && (start > 0 || end !== undefined)) {
      res.status(400).json({ error: 'byte ranges (start/end) are not supported for gzipped files' });
      return;
    }
    const src = gzipped
      ? await FileLogSource.openGz('f' + fileSeq++, filePath)
      : await FileLogSource.open('f' + fileSeq++, filePath, start, end);
    store.addSource(src, pathKey);
    res.json(sourceInfo(src));
  })
);

app.post(
  '/api/logs/merge',
  wrap(async (req, res) => {
    const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const children = ids.map((id) => store.sources.get(id)).filter((s): s is BaseSource => !!s);
    if (children.length < 2) {
      res.status(400).json({ error: 'merge requires at least 2 open sources' });
      return;
    }
    if (children.some((c) => c.kind === 'merged')) {
      res.status(400).json({ error: 'cannot merge a merged view' });
      return;
    }
    const src = new MergedSource('m' + mergeSeq++, req.body?.name || 'Merged Logs', children);
    store.addSource(src);
    res.json(sourceInfo(src));
  })
);

// Opens a read-only mirror of a source on a peer instance (see RemoteSource).
// Like file open this is a local admin action and needs no stream key; the
// peer's own VIEW_KEY is supplied as `viewKey` and forwarded on every fetch.
app.post(
  '/api/logs/remote',
  wrap(async (req, res) => {
    const url = typeof req.body?.url === 'string' ? req.body.url : '';
    const source = typeof req.body?.source === 'string' ? req.body.source : '';
    if (!url || !source) {
      res.status(400).json({ error: 'url and source are required' });
      return;
    }
    const viewKey = typeof req.body?.viewKey === 'string' && req.body.viewKey ? req.body.viewKey : undefined;
    const src = await RemoteSource.open('r' + remoteSeq++, url, source, viewKey);
    store.addSource(src);
    res.json(sourceInfo(src));
  })
);

app.get('/api/logs', (_req, res) => {
  res.json({ sources: [...store.sources.values()].map(sourceInfo) });
});

app.get('/api/logs/:id', (req, res) => {
  const src = store.sources.get(req.params.id);
  if (!src) {
    res.status(404).json({ error: 'unknown log ' + req.params.id });
    return;
  }
  res.json(sourceInfo(src));
});

app.delete(
  '/api/logs/:id',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (src instanceof StreamSource && !streamMutationAuthorized(req, res, src.name)) return;
    await store.removeSource(req.params.id);
    res.json({ ok: true });
  })
);

// ---- Custom parser (user-defined conversion pattern) -------------------------

// Sets or clears a per-source log4j-style pattern. Setting re-indexes the
// source with the compiled format; deleting restores auto-detection.
app.post(
  '/api/logs/:id/parser',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
    if (!(src instanceof FileLogSource) && !(src instanceof StreamSource)) {
      res.status(400).json({ error: 'custom parser is not supported for merged views' });
      return;
    }
    if (src instanceof StreamSource && !streamMutationAuthorized(req, res, src.name)) return;
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
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
    if (!(src instanceof FileLogSource) && !(src instanceof StreamSource)) {
      res.status(400).json({ error: 'custom parser is not supported for merged views' });
      return;
    }
    if (src instanceof StreamSource && !streamMutationAuthorized(req, res, src.name)) return;
    await src.setFormat(null);
    res.json(sourceInfo(src));
  })
);

// ---- Filters ---------------------------------------------------------------

app.post(
  '/api/logs/:id/filters',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
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

app.delete('/api/logs/:id/filters/:fid', (req, res) => {
  store.removeFilter(req.params.fid);
  res.json({ ok: true });
});

// ---- Rules (match criteria → highlight/bookmark/webhook actions) -------------

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

app.post(
  '/api/logs/:id/rules',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
    if (src instanceof StreamSource && !streamMutationAuthorized(req, res, src.name)) return;
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
  const src = store.sources.get(req.params.id);
  if (!src) {
    res.status(404).json({ error: 'unknown log ' + req.params.id });
    return;
  }
  res.json({ rules: store.rulesFor(src.id).map(ruleInfo) });
});

app.delete('/api/logs/:id/rules/:rid', (req, res) => {
  const src = store.sources.get(req.params.id);
  if (src instanceof StreamSource && !streamMutationAuthorized(req, res, src.name)) return;
  store.removeRule(req.params.rid);
  res.json({ ok: true });
});

// ---- Entries (virtual scrolling windows) -----------------------------------

app.get(
  '/api/logs/:id/entries',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
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

// ---- Bookmarks ---------------------------------------------------------------

app.get('/api/logs/:id/bookmarks', (req, res) => {
  res.json({ indices: [...store.bookmarksFor(req.params.id)].sort((a, b) => a - b) });
});

app.put('/api/logs/:id/bookmarks', (req, res) => {
  const src = store.sources.get(req.params.id);
  if (!src) {
    res.status(404).json({ error: 'unknown log ' + req.params.id });
    return;
  }
  const idx = Number(req.body?.index);
  if (!Number.isInteger(idx) || idx < 0 || idx >= src.count) {
    res.status(400).json({ error: 'invalid index' });
    return;
  }
  const on = req.body?.on !== undefined ? !!req.body.on : !store.bookmarksFor(src.id).has(idx);
  const total = store.setBookmark(src.id, idx, on);
  res.json({ index: idx, on, total });
});

// Next/previous bookmark relative to a view position (honors active filter).
// ---- Locate (keep position across filter changes) ------------------------------

app.get('/api/logs/:id/locate', (req, res) => {
  const src = store.sources.get(req.params.id);
  if (!src) {
    res.status(404).json({ error: 'unknown log ' + req.params.id });
    return;
  }
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

app.get('/api/logs/:id/bookmarks/next', (req, res) => {
  const src = store.sources.get(req.params.id);
  if (!src) {
    res.status(404).json({ error: 'unknown log ' + req.params.id });
    return;
  }
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

// ---- Search (find next/prev without filtering) ---------------------------------

app.get(
  '/api/logs/:id/search',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
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
    // the first match; backward walks entry chunks, keeping the last (nearest)
    // match per chunk.
    let vi: number | null = null;
    let scanned = 0;
    if (dir === 1) {
      await src.scanTexts((i, raw) => {
        if (scanned >= MAX_SCAN) return false;
        scanned++;
        if (test(raw)) {
          vi = i;
          return false;
        }
      }, startVi, n);
    } else {
      const CHUNK = 500;
      let hi = startVi + 1;
      while (hi > 0 && scanned < MAX_SCAN && vi === null) {
        const lo = Math.max(0, hi - CHUNK);
        let last = -1;
        await src.scanTexts((i, raw) => {
          if (test(raw)) last = i;
        }, lo, hi);
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

// ---- Correlation (find every entry of a request/session) --------------------------

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

app.get(
  '/api/logs/:id/correlate',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
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
    // right semantics. Correlation ignores filters and always scans the whole
    // source; merged sources scan in merged-view indices.
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

// ---- Export current view as plain text ------------------------------------------

app.get(
  '/api/logs/:id/export',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
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

// ---- Report: time histogram + top loggers/threads/messages ----------------------

app.get(
  '/api/logs/:id/report',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
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

// ---- Minimap (navigation strip) --------------------------------------------

app.get(
  '/api/logs/:id/minimap',
  wrap(async (req, res) => {
    const src = store.sources.get(req.params.id);
    if (!src) {
      res.status(404).json({ error: 'unknown log ' + req.params.id });
      return;
    }
    const buckets = Math.min(2000, Math.max(10, Number(req.query.buckets) || 400));
    const fid = req.query.filter ? String(req.query.filter) : null;
    const f = fid ? store.filters.get(fid) : null;
    res.json(store.minimapFor(src, f, buckets));
  })
);

// ---- Streams (embedded / live mode) ----------------------------------------

app.get('/api/v1/capabilities', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.json({
    service: 'log-viewer',
    serviceVersion: SERVICE_VERSION,
    apiVersion: 'v1',
    streamLifecycle: {
      create: 'PUT /api/v1/streams/:channel',
      append: 'POST /api/v1/streams/:channel/entries',
      inspect: 'GET /api/v1/streams/:channel',
      delete: 'DELETE /api/v1/streams/:channel',
    },
    mutationAuth: STREAM_KEY || STREAM_TOKENS.length ? 'x-stream-key' : 'none',
    limits: STREAM_LIMITS,
  });
});

app.get('/api/v1/streams/:channel', (req, res) => {
  const channel = validChannel(req, res);
  if (!channel) return;
  const src = store.getStream(channel);
  if (!src) {
    res.status(404).json({ error: 'unknown stream ' + channel });
    return;
  }
  res.setHeader('cache-control', 'no-store');
  res.json(sourceInfo(src));
});

app.put(
  '/api/v1/streams/:channel',
  wrap(async (req, res) => {
    if (!streamMutationAuthorized(req, res, req.params.channel)) return;
    const channel = validChannel(req, res);
    if (!channel) return;
    const existing = store.getStream(channel);
    const src = existing ?? store.getOrCreateStream(channel);
    res.status(existing ? 200 : 201).json({ ...streamAck(src), created: !existing });
  })
);

app.post(
  '/api/v1/streams/:channel/entries',
  wrap(async (req, res) => {
    if (!streamMutationAuthorized(req, res, req.params.channel)) return;
    const channel = validChannel(req, res);
    if (!channel) return;
    const src = store.getStream(channel);
    if (!src) {
      res.status(404).json({ error: 'unknown stream ' + channel });
      return;
    }
    if (Array.isArray(req.body?.lines)) src.appendLines(req.body.lines.map(String));
    if (Array.isArray(req.body?.entries)) src.appendEntries(req.body.entries);
    res.json(streamAck(src));
  })
);

app.delete(
  '/api/v1/streams/:channel',
  wrap(async (req, res) => {
    if (!streamMutationAuthorized(req, res, req.params.channel)) return;
    const channel = validChannel(req, res);
    if (!channel) return;
    const src = store.getStream(channel, false);
    if (src) await store.removeSource(src.id);
    res.json({ ok: true, deleted: !!src });
  })
);

app.get('/api/streams/:channel', (req, res) => {
  markLegacyStreamRoute(res, `/api/v1/streams/${encodeURIComponent(req.params.channel)}`);
  res.json(sourceInfo(store.getOrCreateStream(req.params.channel)));
});

app.post(
  '/api/streams/:channel',
  wrap(async (req, res) => {
    if (!streamMutationAuthorized(req, res, req.params.channel)) return;
    markLegacyStreamRoute(res, `/api/v1/streams/${encodeURIComponent(req.params.channel)}/entries`);
    const src = store.getOrCreateStream(req.params.channel);
    if (Array.isArray(req.body?.lines)) src.appendLines(req.body.lines.map(String));
    if (Array.isArray(req.body?.entries)) src.appendEntries(req.body.entries);
    res.json(sourceInfo(src));
  })
);

app.get('/healthz', (_req, res) => {
  res.json({
    ok: true,
    uptime: process.uptime(),
    sources: store.sources.size,
    streams: store.streamCount,
    streamBytes: store.streamBytes,
  });
});

// ---- Static frontend (production build) --------------------------------------

const distDir = path.resolve(__dirname, '..', '..', 'web', 'dist');
if (fs.existsSync(distDir)) {
  app.use(express.static(distDir));
}

app.use((err: Error & { status?: number; type?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
  console.error(err);
  const status = err instanceof StoreCapacityError ? err.status : err.status || (err.type === 'entity.too.large' ? 413 : 500);
  const message = status >= 500 && !(err instanceof StoreCapacityError) ? 'internal server error' : err.message;
  res.status(status).json({ error: message, code: err instanceof StoreCapacityError ? err.code : undefined });
});

// ---- WebSocket: append notifications + stream ingestion ----------------------

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: STREAM_LIMITS.maxPayloadBytes });
const subs = new Map<WebSocket, Set<string>>();

server.on('error', (err) => {
  console.error('HTTP server error:', err);
  process.exitCode = 1;
});
wss.on('error', (err) => console.error('WebSocket server error:', err));

function subscriptionSnapshot(id: string) {
  const source = store.sources.get(id);
  if (!source) return null;
  const filters: Record<string, { count: number; stats: number[] }> = {};
  for (const filter of store.filters.values()) {
    if (filter.sourceId === id) filters[filter.id] = { count: filter.indices.length, stats: filter.stats };
  }
  return { type: 'reset', id, count: source.count, stats: source.stats, filters };
}

const wsBroadcaster = new WsBroadcaster(subscriptionSnapshot);

wss.on('connection', (ws) => {
  subs.set(ws, new Set());
  ws.on('message', (data) => {
    try {
      const m = JSON.parse(String(data));
      const set = subs.get(ws);
      if (!set) return;
      if (m.type === 'sub' && typeof m.id === 'string') {
        if (VIEW_KEY && m.viewKey !== VIEW_KEY && !(STREAM_KEY && m.key === STREAM_KEY)) {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(JSON.stringify({ type: 'error', code: 'view_auth_required', error: 'invalid or missing viewKey' }));
          return;
        }
        set.add(m.id);
        const source = store.sources.get(m.id);
        if (source instanceof StreamSource) source.touch();
        const snapshot = subscriptionSnapshot(m.id);
        if (snapshot && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(snapshot));
      }
      else if (m.type === 'unsub' && typeof m.id === 'string') set.delete(m.id);
      else if (m.type === 'publish' && typeof m.channel === 'string' && Array.isArray(m.lines)) {
        // WS producers can push lines directly.
        if (!mutationKeyAllowed(typeof m.key === 'string' ? m.key : undefined, m.channel)) return;
        if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(m.channel)) return;
        store.getOrCreateStream(m.channel).appendLines(m.lines.map(String));
      }
    } catch (err) {
      if (err instanceof StoreCapacityError && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'error', code: err.code, error: err.message }));
      }
      /* ignore malformed frames */
    }
  });
  ws.on('close', () => {
    subs.delete(ws);
    wsBroadcaster.forget(ws);
  });
  ws.on('error', () => {
    subs.delete(ws);
    wsBroadcaster.forget(ws);
  });
});

store.broadcast = (msg) => {
  const s = JSON.stringify(msg);
  const id = String(msg.id);
  for (const [ws, set] of subs) {
    if (set.has(id) && ws.readyState === WebSocket.OPEN) wsBroadcaster.send(ws, id, s);
  }
};

// ---- Boot --------------------------------------------------------------------

if (ENABLE_SAMPLES) ensureSampleLogs(SAMPLES_DIR);
if (ENABLE_DEMO) startDemoStream(store);

// Spool recovery: recreate one stream per *.spool file and load its retained
// tail before accepting traffic, so recovered streams are immediately live.
const spoolRecovery = spooler
  ? spooler
      .recover()
      .then((recovered) => {
        let streams = 0;
        let entries = 0;
        for (const { channel, entries: items } of recovered) {
          try {
            store.getOrCreateStream(channel).restore(items);
            streams++;
            entries += items.length;
          } catch (err) {
            console.error(`spool recovery skipped stream ${channel}:`, err);
          }
        }
        if (streams) console.log(`recovered ${entries} spooled entries into ${streams} stream(s)`);
      })
      .catch((err) => console.error('spool recovery failed:', err))
  : Promise.resolve();

// Directory monitor: auto-open new files under ROOT matching WATCH_GLOBS.
const dirWatcher = WATCH_GLOBS.length
  ? startDirectoryWatch({
      root: ROOT,
      globs: WATCH_GLOBS,
      intervalMs: WATCH_INTERVAL_MS,
      open: makeFileOpener(store, () => 'f' + fileSeq++, 'watch'),
      maxSources: STREAM_LIMITS.maxSources,
      sourceCount: () => store.sources.size,
    })
  : null;

const idleSweep =
  STREAM_LIMITS.idleTtlSeconds > 0
    ? setInterval(
        () => {
          // A connected viewer is active even when the underlying producer is
          // temporarily quiet, so do not expire its stream beneath the iframe.
          for (const ids of subs.values()) {
            for (const id of ids) {
              const source = store.sources.get(id);
              if (source instanceof StreamSource) source.touch();
            }
          }
          store
            .removeIdleStreams(STREAM_LIMITS.idleTtlSeconds * 1000)
            .then((removed) => {
              if (removed) console.log(`removed ${removed} idle stream${removed === 1 ? '' : 's'}`);
            })
            .catch((err) => console.error('idle stream cleanup failed:', err));
        },
        Math.min(60_000, Math.max(5_000, (STREAM_LIMITS.idleTtlSeconds * 1000) / 2))
      ).unref()
    : null;

void spoolRecovery.then(() => {
  server.listen(PORT, () => {
    console.log(`log-viewer server listening on http://localhost:${PORT}`);
    console.log(`  file browsing root: ${ROOT}`);
    console.log(`  sample logs:        ${SAMPLES_DIR}`);
    console.log(`  demo stream:        ${ENABLE_DEMO ? 'GET /embed.html?channel=demo' : 'disabled'}`);
    console.log(
      `  stream limits:      ${STREAM_LIMITS.maxSources || 'unlimited'} sources, ${STREAM_LIMITS.maxEntries || 'unlimited'} entries/source, ${STREAM_LIMITS.maxBytes || 'unlimited'} bytes/source`
    );
    if (STREAM_KEY) console.log('  stream ingestion requires x-stream-key');
    if (VIEW_KEY) console.log('  read access requires x-view-key');
    if (spooler) console.log(`  stream spool dir:   ${spooler.dir}`);
    if (dirWatcher) console.log(`  directory watch:    ${WATCH_GLOBS.join(', ')} every ${WATCH_INTERVAL_MS} ms`);
  });
});

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down…`);
  if (idleSweep) clearInterval(idleSweep);
  dirWatcher?.stop();
  server.close();
  for (const ws of wss.clients) ws.close();
  // Spool files stay on disk (dropSpool: false); pending writes are flushed.
  for (const id of [...store.sources.keys()]) await store.removeSource(id, { dropSpool: false }).catch(() => {});
  await spooler?.flush();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
