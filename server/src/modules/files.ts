// Files: browse a directory tree under `root`, open (and tail) log files,
// including byte-range chunks and gzipped rotations, and optionally
// auto-open new files matching globs (directory watch).

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { DEFAULTS } from '../config';
import { FileLogSource, isGzipFile } from '../sources';
import type { LogSource } from '../source-api';
import { ensureSampleLogs } from '../sample';
import { DirectoryWatcher, startDirectoryWatch } from '../watch';
import type { ModuleContext, ViewerModule } from '../module';

export interface FilesOptions {
  // Directory users may browse and open files from.
  root: string;
  // Sample logs directory (also browsable): true = generate into
  // `<root>/sample-logs`, a string = generate into that directory.
  samples?: boolean | string;
  // Auto-open files under root matching any glob (polling).
  watch?: { globs: string[]; intervalMs?: number; maxSources?: number };
  // Cap on the decompressed size of gzipped logs.
  gzipMaxBytes?: number;
}

export interface FileOpener {
  // Opens (or returns the already open) source for a file path and optional
  // byte range. Errors carry an HTTP `status`.
  open(filePath: string, range?: { start?: number; end?: number }, origin?: string): Promise<LogSource>;
}

function httpError(status: number, message: string) {
  return Object.assign(new Error(message), { status });
}

export function filesModule(ctx: ModuleContext, opts: FilesOptions): ViewerModule & FileOpener {
  const { router: app, store, wrap, sourceInfo } = ctx;
  const ROOT = path.resolve(opts.root);
  const SAMPLES_DIR =
    opts.samples === true ? path.join(ROOT, 'sample-logs') : typeof opts.samples === 'string' ? path.resolve(opts.samples) : '';
  const gzipMaxBytes = opts.gzipMaxBytes ?? DEFAULTS.gzipMaxBytes;
  let watcher: DirectoryWatcher | null = null;

  const isAllowedPath = (p: string) =>
    p === ROOT || p.startsWith(ROOT + path.sep) || (!!SAMPLES_DIR && (p === SAMPLES_DIR || p.startsWith(SAMPLES_DIR + path.sep)));

  async function open(filePath: string, range: { start?: number; end?: number } = {}, origin?: string): Promise<LogSource> {
    const start = Math.max(0, Number(range.start) || 0);
    const end = range.end !== undefined ? Math.max(start, Number(range.end) || 0) : undefined;
    const alias = filePath + (start > 0 || end !== undefined ? `#${start}-${end ?? ''}` : '');
    const existing = store.sourceForAlias(alias);
    if (existing) return existing;
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) throw httpError(404, 'file not found: ' + filePath);
    // Gzipped rotations (magic bytes 1f 8b) are decompressed to a temp file and
    // opened from there. Byte offsets would refer to compressed bytes, so
    // chunked open is rejected for them.
    const gzipped = await isGzipFile(filePath);
    if (gzipped && (start > 0 || end !== undefined)) {
      throw httpError(400, 'byte ranges (start/end) are not supported for gzipped files');
    }
    const id = ctx.nextId('f');
    const src = gzipped
      ? await FileLogSource.openGz(id, filePath, gzipMaxBytes)
      : await FileLogSource.open(id, filePath, start, end);
    store.addSource(src, alias);
    if (origin) store.setOrigin(src.id, origin);
    return src;
  }

  app.get(
    '/api/browse',
    wrap(async (req, res) => {
      const p = path.resolve(String(req.query.path || SAMPLES_DIR || ROOT));
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
      res.json({ path: p, parent: path.dirname(p), root: ROOT, samples: SAMPLES_DIR || undefined, dirs, files });
    })
  );

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
      if (!(await ctx.allow(req, res, 'open'))) return;
      try {
        res.json(sourceInfo(await open(filePath, { start: req.body?.start, end: req.body?.end })));
      } catch (err) {
        const status = (err as { status?: number }).status;
        if (status && status < 500) {
          res.status(status).json({ error: (err as Error).message });
          return;
        }
        throw err;
      }
    })
  );

  return {
    name: 'files',
    open,
    capabilities: () => ({ root: ROOT, samples: SAMPLES_DIR || undefined, watch: opts.watch?.globs.length ? opts.watch.globs : undefined }),
    start() {
      if (SAMPLES_DIR) ensureSampleLogs(SAMPLES_DIR);
      if (opts.watch?.globs.length) {
        watcher = startDirectoryWatch({
          root: ROOT,
          globs: opts.watch.globs,
          intervalMs: opts.watch.intervalMs ?? DEFAULTS.watchIntervalMs,
          open: async (filePath) => {
            if (store.sourceForPath(filePath)) return 'duplicate';
            try {
              await open(filePath, {}, 'watch');
              return 'opened';
            } catch {
              return 'failed';
            }
          },
          maxSources: opts.watch.maxSources ?? DEFAULTS.streamMaxSources,
          sourceCount: () => store.sources.size,
          log: (msg) => ctx.logger.warn(msg),
        });
      }
    },
    stop() {
      watcher?.stop();
      watcher = null;
    },
  };
}
