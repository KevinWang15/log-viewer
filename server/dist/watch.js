"use strict";
// Directory monitor: polls LOG_ROOT on an
// interval and opens files matching the configured globs. Polling is used
// instead of fs.watch because recursive watching is unreliable on Linux.
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.makeFileOpener = makeFileOpener;
exports.globToRegExp = globToRegExp;
exports.startDirectoryWatch = startDirectoryWatch;
const path = __importStar(require("node:path"));
const fsp = __importStar(require("node:fs/promises"));
const sources_1 = require("./sources");
// Opens a log file exactly like POST /api/logs/open: byPath dedup, gzip
// detection by magic bytes (a matching .log.gz rotation opens decompressed),
// and registration in the store. Open errors are reported, never thrown.
function makeFileOpener(store, nextId, origin) {
    return async (filePath) => {
        if (store.sourceForPath(filePath))
            return 'duplicate';
        let src;
        try {
            src = (await (0, sources_1.isGzipFile)(filePath))
                ? await sources_1.FileLogSource.openGz(nextId(), filePath)
                : await sources_1.FileLogSource.open(nextId(), filePath);
        }
        catch {
            return 'failed';
        }
        store.addSource(src, filePath);
        if (origin)
            store.setOrigin(src.id, origin);
        return 'opened';
    };
}
// Tiny glob matcher: `*` and `?` stay within a path segment, `**` crosses
// segments (`**/` also matches zero directories, so `**/*.log` covers the
// root itself). Matching is against the forward-slash path relative to root.
function globToRegExp(glob) {
    let re = '';
    for (let i = 0; i < glob.length; i++) {
        const c = glob[i];
        if (c === '*') {
            if (glob[i + 1] === '*') {
                i++;
                if (glob[i + 1] === '/') {
                    i++;
                    re += '(?:[^/]+/)*';
                }
                else {
                    re += '.*';
                }
            }
            else {
                re += '[^/]*';
            }
        }
        else if (c === '?') {
            re += '[^/]';
        }
        else {
            re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
        }
    }
    return new RegExp('^' + re + '$');
}
const MAX_DEPTH = 8;
// Recursive walk. Symlinks are never followed (Dirent.isFile/isDirectory are
// false for them), which both avoids loops and keeps rotated-link farms out.
async function collectMatches(dir, root, depth, matchers, out, onError) {
    let dirents;
    try {
        dirents = await fsp.readdir(dir, { withFileTypes: true });
    }
    catch (err) {
        onError(dir, err);
        return;
    }
    for (const d of dirents) {
        const full = path.join(dir, d.name);
        if (d.isDirectory()) {
            if (d.name.startsWith('.') || d.name === 'node_modules')
                continue;
            if (depth < MAX_DEPTH)
                await collectMatches(full, root, depth + 1, matchers, out, onError);
        }
        else if (d.isFile()) {
            const rel = path.relative(root, full).split(path.sep).join('/');
            if (!matchers.some((m) => m.test(rel)))
                continue;
            try {
                const st = await fsp.stat(full);
                out.push({ path: full, mtimeMs: st.mtimeMs });
            }
            catch (err) {
                onError(full, err);
            }
        }
    }
}
function startDirectoryWatch(opts) {
    const matchers = opts.globs.map(globToRegExp);
    const log = opts.log ?? ((msg) => console.warn(msg));
    const failed = new Map(); // path -> mtimeMs of the failed attempt
    const errorLogged = new Set(); // scan/open errors already reported
    let capWarned = false;
    let running = false;
    const logOnce = (key, msg) => {
        if (errorLogged.has(key))
            return;
        errorLogged.add(key);
        log(msg);
    };
    async function tick() {
        if (running)
            return; // a slow scan never overlaps the next interval
        running = true;
        try {
            const matches = [];
            await collectMatches(opts.root, opts.root, 0, matchers, matches, (p, err) => logOnce(p, `directory watch: cannot scan ${p}: ${err.message}`));
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
                if (failed.get(file.path) === file.mtimeMs)
                    continue;
                const result = await opts.open(file.path);
                if (result === 'failed') {
                    failed.set(file.path, file.mtimeMs);
                    logOnce(file.path, `directory watch: failed to open ${file.path}; will retry when the file changes`);
                }
                else {
                    failed.delete(file.path);
                }
            }
        }
        catch (err) {
            log(`directory watch: scan failed: ${err.message}`);
        }
        finally {
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
