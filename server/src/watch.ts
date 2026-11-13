// Directory monitor: polls LOG_ROOT on an
// interval and opens files matching the configured globs. Polling is used
// instead of fs.watch because recursive watching is unreliable on Linux.

import * as path from 'node:path';
import * as fsp from 'node:fs/promises';
import { Store } from './store';
import { BaseSource, FileLogSource, isGzipFile } from './sources';

export type OpenResult = 'opened' | 'duplicate' | 'failed';
export type OpenFileFn = (filePath: string) => Promise<OpenResult>;

// Opens a log file exactly like POST /api/logs/open: byPath dedup, gzip
// detection by magic bytes (a matching .log.gz rotation opens decompressed),
// and registration in the store. Open errors are reported, never thrown.
export function makeFileOpener(store: Store, nextId: () => string, origin?: string, gzipMaxBytes?: number): OpenFileFn {
  return async (filePath) => {
    if (store.sourceForPath(filePath)) return 'duplicate';
    let src: BaseSource;
    try {
      src = (await isGzipFile(filePath))
        ? await FileLogSource.openGz(nextId(), filePath, gzipMaxBytes)
        : await FileLogSource.open(nextId(), filePath);
    } catch {
      return 'failed';
    }
    store.addSource(src, filePath);
    if (origin) store.setOrigin(src.id, origin);
    return 'opened';
  };
}

// Tiny glob matcher: `*` and `?` stay within a path segment, `**` crosses
// segments (`**/` also matches zero directories, so `**/*.log` covers the
// root itself). Matching is against the forward-slash path relative to root.
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:[^/]+/)*';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp('^' + re + '$');
}

const MAX_DEPTH = 8;

interface MatchedFile {
  path: string;
  mtimeMs: number;
}

// Recursive walk. Symlinks are never followed (Dirent.isFile/isDirectory are
// false for them), which both avoids loops and keeps rotated-link farms out.
async function collectMatches(
  dir: string,
  root: string,
  depth: number,
  matchers: RegExp[],
  out: MatchedFile[],
  onError: (p: string, err: unknown) => void
): Promise<void> {
  let dirents;
  try {
    dirents = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    onError(dir, err);
    return;
  }
  for (const d of dirents) {
    const full = path.join(dir, d.name);
    if (d.isDirectory()) {
      if (d.name.startsWith('.') || d.name === 'node_modules') continue;
      if (depth < MAX_DEPTH) await collectMatches(full, root, depth + 1, matchers, out, onError);
    } else if (d.isFile()) {
      const rel = path.relative(root, full).split(path.sep).join('/');
      if (!matchers.some((m) => m.test(rel))) continue;
      try {
        const st = await fsp.stat(full);
        out.push({ path: full, mtimeMs: st.mtimeMs });
      } catch (err) {
        onError(full, err);
      }
    }
  }
}

export interface WatchOptions {
  root: string;
  globs: string[];
  intervalMs: number;
  open: OpenFileFn;
  // Source cap: when sourceCount() reaches maxSources, no new files are
  // opened and a warning is logged once (re-armed when capacity frees up).
  maxSources?: number;
  sourceCount?: () => number;
  log?: (msg: string) => void;
}

export interface DirectoryWatcher {
  stop(): void;
}

export function startDirectoryWatch(opts: WatchOptions): DirectoryWatcher {
  const matchers = opts.globs.map(globToRegExp);
  const log = opts.log ?? ((msg: string) => console.warn(msg));
  const failed = new Map<string, number>(); // path -> mtimeMs of the failed attempt
  const errorLogged = new Set<string>(); // scan/open errors already reported
  let capWarned = false;
  let running = false;

  const logOnce = (key: string, msg: string) => {
    if (errorLogged.has(key)) return;
    errorLogged.add(key);
    log(msg);
  };

  async function tick() {
    if (running) return; // a slow scan never overlaps the next interval
    running = true;
    try {
      const matches: MatchedFile[] = [];
      await collectMatches(opts.root, opts.root, 0, matchers, matches, (p, err) =>
        logOnce(p, `directory watch: cannot scan ${p}: ${(err as Error).message}`)
      );
      for (const file of matches) {
        if (opts.maxSources && opts.sourceCount && opts.sourceCount() >= opts.maxSources) {
          if (!capWarned) {
            capWarned = true;
            log(`directory watch: source cap (${opts.maxSources}) reached; new files will not be opened`);
          }
          break;
        }
        capWarned = false;
        // A file that failed to open is not retried until it changes.
        if (failed.get(file.path) === file.mtimeMs) continue;
        const result = await opts.open(file.path);
        if (result === 'failed') {
          failed.set(file.path, file.mtimeMs);
          logOnce(file.path, `directory watch: failed to open ${file.path}; will retry when the file changes`);
        } else {
          failed.delete(file.path);
        }
      }
    } catch (err) {
      log(`directory watch: scan failed: ${(err as Error).message}`);
    } finally {
      running = false;
    }
  }

  void tick();
  const timer = setInterval(() => void tick(), opts.intervalMs);
  timer.unref();
  return {
    stop() {
      clearInterval(timer);
    },
  };
}
