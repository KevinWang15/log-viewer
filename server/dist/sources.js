"use strict";
// Log sources: a common base plus three implementations.
//  - FileLogSource: indexes a log file on disk (byte offsets + parsed metadata
//    per entry) and tails it for appended data. Entry text stays on disk and
//    is read on demand, so multi-GB files only cost a few numbers per entry.
//  - StreamSource: an in-memory buffer fed over HTTP/WS by external producers
//    (the "embedded in a site" mode).
//  - RemoteSource: a read-only in-memory mirror of a source on a peer
//    instance, loaded over the peer's HTTP entries API and tailed over its
//    WebSocket broadcast (cross-instance merging).
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
exports.RemoteSource = exports.StreamSource = exports.MergedSource = exports.FileLogSource = exports.BaseSource = exports.GzipTooLargeError = void 0;
exports.isGzipFile = isGzipFile;
exports.gunzipToTempFile = gunzipToTempFile;
exports.textTester = textTester;
exports.matcherFor = matcherFor;
const node_events_1 = require("node:events");
const fs = __importStar(require("node:fs"));
const fsp = __importStar(require("node:fs/promises"));
const os = __importStar(require("node:os"));
const path = __importStar(require("node:path"));
const node_stream_1 = require("node:stream");
const promises_1 = require("node:stream/promises");
const node_zlib_1 = require("node:zlib");
const ws_1 = require("ws");
const config_1 = require("./config");
const parser_1 = require("./parser");
const MAX_ENTRY_BYTES = 64 * 1024;
const MAX_METADATA_BYTES = 4 * 1024;
const MAX_FORMAT_DETECTION_BYTES = 256 * 1024;
const SCAN_BLOCK = 4 * 1024 * 1024;
const INDEX_INITIAL_CAPACITY = 1024;
class GzipTooLargeError extends Error {
    maxBytes;
    status = 413;
    constructor(maxBytes) {
        super(`decompressed log exceeds the ${Math.floor(maxBytes / 1048576)} MB gzip limit`);
        this.maxBytes = maxBytes;
    }
}
exports.GzipTooLargeError = GzipTooLargeError;
// Gzip is detected by magic bytes, not by extension: rotated logs are
// sometimes renamed or stored without a .gz suffix.
async function isGzipFile(filePath) {
    const fh = await fsp.open(filePath, 'r');
    try {
        const head = Buffer.alloc(2);
        const { bytesRead } = await fh.read(head, 0, 2, 0);
        return bytesRead === 2 && head[0] === 0x1f && head[1] === 0x8b;
    }
    finally {
        await fh.close();
    }
}
// Streams the gzip member at `gzPath` into a fresh temp file and returns its
// path. The temp file lives in its own mkdtemp directory so concurrent
// decompressions never collide; the caller owns deleting that directory.
async function gunzipToTempFile(gzPath, maxBytes = config_1.GZIP_LIMITS.maxBytes) {
    const tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'log-viewer-'));
    const tmpPath = path.join(tmpDir, 'decompressed.log');
    let total = 0;
    const guard = new node_stream_1.Transform({
        transform(chunk, _enc, cb) {
            total += chunk.length;
            if (total > maxBytes)
                cb(new GzipTooLargeError(maxBytes));
            else
                cb(null, chunk);
        },
    });
    try {
        await (0, promises_1.pipeline)(fs.createReadStream(gzPath), (0, node_zlib_1.createGunzip)(), guard, fs.createWriteStream(tmpPath));
        return tmpPath;
    }
    catch (err) {
        await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
        if (err instanceof GzipTooLargeError)
            throw err;
        const bad = new Error('failed to decompress gzip file: ' + err.message);
        bad.status = 400;
        throw bad;
    }
}
function truncateUtf8(value, maxBytes, suffix = '\n… (entry truncated)') {
    if (Buffer.byteLength(value) <= maxBytes)
        return value;
    const suffixBytes = Buffer.byteLength(suffix);
    if (suffixBytes >= maxBytes)
        return Buffer.from(suffix).subarray(0, maxBytes).toString('utf8');
    const input = Buffer.from(value);
    let end = maxBytes - suffixBytes;
    // Never split a UTF-8 continuation sequence. The lead byte is excluded too,
    // leaving the complete character for a future (untruncated) payload.
    while (end > 0 && end < input.length && (input[end] & 0xc0) === 0x80)
        end--;
    return input.subarray(0, end).toString('utf8') + suffix;
}
function textTester(text, regex, caseSensitive) {
    if (regex) {
        const re = new RegExp(text, caseSensitive ? '' : 'i');
        return (raw) => re.test(raw);
    }
    const needle = caseSensitive ? text : text.toLowerCase();
    if (caseSensitive)
        return (raw) => raw.includes(needle);
    return (raw) => raw.toLowerCase().includes(needle);
}
function buildTextTest(c) {
    if (!c.text)
        return null;
    return textTester(c.text, c.regex, c.caseSensitive);
}
function matcherFor(c) {
    const lvSet = c.levels && c.levels.length ? new Set(c.levels) : null;
    const thSet = c.threads && c.threads.length ? new Set(c.threads) : null;
    const lgSet = c.loggers && c.loggers.length ? new Set(c.loggers) : null;
    const textTest = buildTextTest(c);
    const ex = !!c.exclude;
    return (e) => {
        let ok = true;
        if (lvSet && !lvSet.has(e.lv))
            ok = false;
        else if (thSet && !thSet.has(e.th))
            ok = false;
        else if (lgSet && !lgSet.has(e.lg))
            ok = false;
        else if (c.timeFrom && e.t && e.t < c.timeFrom)
            ok = false;
        else if (c.timeTo && e.t && e.t > c.timeTo)
            ok = false;
        else if (textTest && !textTest(e.raw))
            ok = false;
        return ok !== ex;
    };
}
class BaseSource extends node_events_1.EventEmitter {
    stats = [0, 0, 0, 0, 0, 0];
    // Grid messages (EntryOut.msg) for the given indices, skipping out-of-range
    // ones like getEntries. For aggregate scans that need only the message;
    // sources that can avoid building full entries override this.
    async getMessages(idxs) {
        return (await this.getEntries(idxs)).map((e) => e.msg);
    }
    // Evaluates criteria over entries in [from, to) (default: the whole source).
    // The ranged form lets append handling evaluate only the new entries instead
    // of re-scanning everything when the batch carried no per-entry payloads.
    async evalCriteria(c, from = 0, to = this.count) {
        const lvSet = c.levels && c.levels.length ? new Set(c.levels) : null;
        const thSet = c.threads && c.threads.length ? new Set(c.threads) : null;
        const lgSet = c.loggers && c.loggers.length ? new Set(c.loggers) : null;
        const textTest = buildTextTest(c);
        const ex = !!c.exclude;
        const metaOk = (i) => {
            if (lvSet && !lvSet.has(this.levelAt(i)))
                return false;
            if (thSet && !thSet.has(this.threadAt(i)))
                return false;
            if (lgSet && !lgSet.has(this.loggerAt(i)))
                return false;
            const t = this.timeAt(i);
            if (c.timeFrom && t && t < c.timeFrom)
                return false;
            if (c.timeTo && t && t > c.timeTo)
                return false;
            return true;
        };
        const out = [];
        if (!textTest) {
            for (let i = from; i < to; i++)
                if (metaOk(i) !== ex)
                    out.push(i);
        }
        else {
            await this.scanTexts((i, raw) => {
                if ((metaOk(i) && textTest(raw)) !== ex)
                    out.push(i);
            }, from, to);
        }
        return out;
    }
    statsOf(indices) {
        const s = [0, 0, 0, 0, 0, 0];
        for (const i of indices)
            s[this.levelAt(i)]++;
        return s;
    }
}
exports.BaseSource = BaseSource;
// Streams `path` bytes [from, to) and invokes onLine for every line with the
// absolute byte offset of the line start.
async function scanLines(filePath, from, to, onLine) {
    if (to <= from)
        return;
    await new Promise((resolve, reject) => {
        const stream = fs.createReadStream(filePath, { start: from, end: to - 1, highWaterMark: 1024 * 1024 });
        let leftover = null;
        let lineStart = from;
        stream.on('data', (chunk) => {
            let buf = leftover ? Buffer.concat([leftover, chunk]) : chunk;
            let pos = 0;
            while (true) {
                const nl = buf.indexOf(10, pos);
                if (nl === -1)
                    break;
                let end = nl;
                if (end > pos && buf[end - 1] === 13)
                    end--;
                onLine(buf.toString('utf8', pos, end), lineStart);
                lineStart += nl - pos + 1;
                pos = nl + 1;
            }
            leftover = pos < buf.length ? buf.subarray(pos) : null;
        });
        stream.on('end', () => {
            if (leftover && leftover.length)
                onLine(leftover.toString('utf8'), lineStart);
            resolve();
        });
        stream.on('error', reject);
    });
}
class FileLogSource extends BaseSource {
    id;
    path;
    gzippedPath;
    kind = 'file';
    name;
    format = parser_1.PLAIN_FORMAT;
    customPattern;
    // Typed-array index: ~28 B/entry instead of several boxed-array slots.
    // The arrays are capacity buffers; `n` is the live entry count (never read
    // `.length` on these — it is the capacity, exposed via `count`).
    offsets = new Float64Array(INDEX_INITIAL_CAPACITY);
    times = new Float64Array(INDEX_INITIAL_CAPACITY);
    levels = new Int32Array(INDEX_INITIAL_CAPACITY);
    threadIdx = new Int32Array(INDEX_INITIAL_CAPACITY);
    loggerIdx = new Int32Array(INDEX_INITIAL_CAPACITY);
    n = 0;
    threadMap = new Map();
    loggerMap = new Map();
    threads = [];
    loggers = [];
    indexedSize = 0;
    fh = null;
    queue = Promise.resolve();
    watching = false;
    // Chunked ("Open Part of File") mode: only [rangeStart, rangeEnd) is indexed
    // and the file is not tailed.
    rangeStart = 0;
    rangeEnd;
    // Gzipped source: `path` is the decompressed temp copy and `gzippedPath` the
    // original .gz file. Gzip members are static, so the temp copy is never
    // tailed and is deleted with its temp directory on close.
    tempDir;
    constructor(id, path, rangeStart = 0, rangeEnd, gzippedPath) {
        super();
        this.id = id;
        this.path = path;
        this.gzippedPath = gzippedPath;
        this.rangeStart = rangeStart;
        this.rangeEnd = rangeEnd;
        const base = (gzippedPath ?? path).split('/').pop() || path;
        this.name =
            rangeEnd !== undefined || rangeStart > 0
                ? `${base} [${Math.floor(rangeStart / 1048576)}–${rangeEnd !== undefined ? Math.ceil(rangeEnd / 1048576) : '∞'} MB]`
                : base;
    }
    get isChunk() {
        return this.rangeEnd !== undefined;
    }
    get gzipped() {
        return this.gzippedPath !== undefined;
    }
    get count() {
        return this.n;
    }
    get formatName() {
        return this.format.name;
    }
    get threadList() {
        return this.threads;
    }
    get loggerList() {
        return this.loggers;
    }
    levelAt(i) {
        return this.levels[i];
    }
    threadAt(i) {
        return this.threads[this.threadIdx[i]];
    }
    loggerAt(i) {
        return this.loggers[this.loggerIdx[i]];
    }
    timeAt(i) {
        return this.times[i];
    }
    static async open(id, filePath, rangeStart = 0, rangeEnd) {
        const src = new FileLogSource(id, path.resolve(filePath), rangeStart, rangeEnd);
        await src.init();
        return src;
    }
    // Opens a gzipped log: decompresses to a temp file and indexes that copy.
    // Byte-range chunks don't apply (offsets would refer to compressed bytes).
    static async openGz(id, gzPath, maxBytes = config_1.GZIP_LIMITS.maxBytes) {
        const resolved = path.resolve(gzPath);
        const tmpPath = await gunzipToTempFile(resolved, maxBytes);
        const src = new FileLogSource(id, tmpPath, 0, undefined, resolved);
        src.tempDir = path.dirname(tmpPath);
        try {
            await src.init();
            return src;
        }
        catch (err) {
            await fsp.rm(src.tempDir, { recursive: true, force: true }).catch(() => { });
            throw err;
        }
    }
    async init() {
        this.fh = await fsp.open(this.path, 'r');
        const st = await this.fh.stat();
        let from = Math.min(this.rangeStart, st.size);
        const to = this.rangeEnd !== undefined ? Math.min(this.rangeEnd, st.size) : st.size;
        // A chunk may begin mid-line: skip forward to the next line start.
        if (from > 0) {
            const probe = Buffer.alloc(Math.min(64 * 1024, st.size - from));
            await this.fh.read(probe, 0, probe.length, from);
            const nl = probe.indexOf(10);
            from = nl === -1 ? to : from + nl + 1;
        }
        this.rangeStart = from;
        const headLen = Math.min(to - from, 256 * 1024);
        if (headLen > 0) {
            const head = Buffer.alloc(headLen);
            await this.fh.read(head, 0, headLen, from);
            this.format = (0, parser_1.detectFormat)(head.toString('utf8').split(/\r?\n/));
        }
        this.indexedSize = from;
        await this.indexRange(from, to);
        if (!this.isChunk && !this.gzipped)
            this.watch();
    }
    intern(map, list, v) {
        let id = map.get(v);
        if (id === undefined) {
            id = list.length;
            list.push(v);
            map.set(v, id);
        }
        return id;
    }
    // Amortized doubling growth for the index buffers.
    growIndex() {
        const next = this.offsets.length * 2;
        const grow = (a, make) => {
            const b = make(next);
            b.set(a);
            return b;
        };
        this.offsets = grow(this.offsets, (n) => new Float64Array(n));
        this.times = grow(this.times, (n) => new Float64Array(n));
        this.levels = grow(this.levels, (n) => new Int32Array(n));
        this.threadIdx = grow(this.threadIdx, (n) => new Int32Array(n));
        this.loggerIdx = grow(this.loggerIdx, (n) => new Int32Array(n));
    }
    // Releases spare capacity after a reset/reindex: a truncate-rotate can make
    // the file far smaller than the previous indexing run, and a retained giant
    // buffer would keep that memory pinned.
    shrinkIndex() {
        const cap = this.offsets.length;
        if (cap <= 4096 || cap <= this.n * 4)
            return;
        const next = Math.max(INDEX_INITIAL_CAPACITY, this.n * 2);
        this.offsets = this.offsets.slice(0, next);
        this.times = this.times.slice(0, next);
        this.levels = this.levels.slice(0, next);
        this.threadIdx = this.threadIdx.slice(0, next);
        this.loggerIdx = this.loggerIdx.slice(0, next);
    }
    recordEntry(offset, p) {
        const lv = (0, parser_1.levelFromString)(p.level);
        if (this.n === this.offsets.length)
            this.growIndex();
        const i = this.n++;
        this.offsets[i] = offset;
        this.times[i] = (0, parser_1.parseTimestamp)(p.time);
        this.levels[i] = lv;
        this.stats[lv]++;
        this.threadIdx[i] = this.intern(this.threadMap, this.threads, p.thread ?? '');
        this.loggerIdx[i] = this.intern(this.loggerMap, this.loggers, p.logger ?? '');
    }
    async indexRange(from, to) {
        if (to <= from)
            return;
        const fmt = this.format;
        await scanLines(this.path, from, to, (line, offset) => {
            const p = (0, parser_1.matchLine)(fmt, line);
            if (p) {
                this.recordEntry(offset, p);
            }
            else if (this.n === 0 && line.trim()) {
                // Continuation lines before any recognized entry become a plain entry.
                this.recordEntry(offset, { message: line });
            }
        });
        this.indexedSize = to;
    }
    watch() {
        if (this.watching)
            return;
        this.watching = true;
        fs.watchFile(this.path, { interval: 400 }, (curr) => {
            this.queue = this.queue.then(() => this.onFileChange(curr.size)).catch((err) => {
                console.error(`tail error for ${this.path}:`, err);
            });
        });
    }
    // Re-indexes the whole file (or chunk range) with `format`; null restores
    // auto-detection from the current head sample. Serialized with tail updates.
    async setFormat(format, pattern) {
        this.queue = this.queue.then(() => this.applyFormat(format, pattern));
        await this.queue;
    }
    async applyFormat(format, pattern) {
        if (!this.fh)
            return;
        this.customPattern = pattern;
        const st = await this.fh.stat();
        const to = this.rangeEnd !== undefined ? Math.min(this.rangeEnd, st.size) : st.size;
        if (format) {
            this.format = format;
        }
        else {
            const headLen = Math.min(to - this.rangeStart, MAX_FORMAT_DETECTION_BYTES);
            if (headLen > 0) {
                const head = Buffer.alloc(headLen);
                await this.fh.read(head, 0, headLen, this.rangeStart);
                this.format = (0, parser_1.detectFormat)(head.toString('utf8').split(/\r?\n/));
            }
            else {
                this.format = parser_1.PLAIN_FORMAT;
            }
        }
        this.resetIndex();
        this.indexedSize = this.rangeStart;
        await this.indexRange(this.rangeStart, to);
        this.shrinkIndex();
        this.emit('reset');
    }
    resetIndex() {
        // Capacity is kept for the re-index that always follows; shrinkIndex()
        // releases any excess afterwards.
        this.n = 0;
        this.threadMap.clear();
        this.loggerMap.clear();
        this.threads = [];
        this.loggers = [];
        this.stats = [0, 0, 0, 0, 0, 0];
    }
    async onFileChange(size) {
        if (size === this.indexedSize)
            return;
        if (size < this.indexedSize) {
            // Truncated / rotated: rebuild from scratch.
            this.resetIndex();
            this.indexedSize = 0;
            await this.indexRange(0, size);
            this.shrinkIndex();
            this.emit('reset');
            return;
        }
        const startIdx = this.count;
        await this.indexRange(this.indexedSize, size);
        const added = this.count - startIdx;
        if (!added) {
            this.emit('append', { startIdx, added: 0, entries: [] });
            return;
        }
        let entries = null;
        if (added <= 2000) {
            const idxs = [];
            for (let i = startIdx; i < this.count; i++)
                idxs.push(i);
            entries = await this.getEntries(idxs);
        }
        this.emit('append', { startIdx, added, entries });
    }
    async getEntries(idxs) {
        if (!this.fh)
            return [];
        const out = new Array(idxs.length);
        // Coalesce reads: consecutive indices occupy contiguous bytes, so each run
        // is fetched with one large read and sliced per entry in memory.
        const order = idxs
            .map((i, k) => ({ i, k }))
            .filter(({ i }) => i >= 0 && i < this.count)
            .sort((a, b) => a.i - b.i);
        let q = 0;
        while (q < order.length) {
            const qStart = q;
            const runStart = this.offsets[order[q].i];
            let lastIdx = order[q].i - 1;
            let runEnd = runStart;
            while (q < order.length && order[q].i <= lastIdx + 1) {
                const idx = order[q].i;
                const end = idx + 1 < this.count ? this.offsets[idx + 1] : this.indexedSize;
                if (end - runStart > SCAN_BLOCK && q > qStart)
                    break;
                lastIdx = idx;
                runEnd = end;
                q++;
            }
            // Entry text is capped at MAX_ENTRY_BYTES; never read past that.
            const readLen = Math.min(runEnd, this.offsets[lastIdx] + MAX_ENTRY_BYTES) - runStart;
            const buf = Buffer.alloc(readLen);
            await this.fh.read(buf, 0, readLen, runStart);
            for (let p = qStart; p < q; p++) {
                const { i, k } = order[p];
                const s = this.offsets[i] - runStart;
                const e = (i + 1 < this.count ? this.offsets[i + 1] : this.indexedSize) - runStart;
                const len = Math.min(e - s, MAX_ENTRY_BYTES);
                let raw = buf.toString('utf8', s, s + len).replace(/\r?\n$/, '');
                if (e - s > MAX_ENTRY_BYTES)
                    raw += '\n… (entry truncated)';
                const nl = raw.indexOf('\n');
                const first = nl === -1 ? raw : raw.slice(0, nl);
                const parsed = this.format.parse(first);
                out[k] = {
                    i,
                    t: this.times[i],
                    lv: this.levels[i],
                    th: this.threads[this.threadIdx[i]],
                    lg: this.loggers[this.loggerIdx[i]],
                    msg: parsed.message || first,
                    raw,
                };
            }
        }
        return out.filter((e) => !!e);
    }
    // Same messages as getEntries(idxs).map(e => e.msg), but decodes and parses
    // only each entry's first line and builds no entry objects. Mirrors
    // getEntries byte for byte: the MAX_ENTRY_BYTES cap, the trailing \r?\n
    // strip, and the first-line split.
    async getMessages(idxs) {
        if (!this.fh)
            return [];
        const list = idxs.filter((i) => i >= 0 && i < this.count);
        for (let k = 1; k < list.length; k++) {
            if (list[k] < list[k - 1]) {
                list.sort((a, b) => a - b);
                break;
            }
        }
        const endOf = (i) => (i + 1 < this.count ? this.offsets[i + 1] : this.indexedSize);
        const out = [];
        let q = 0;
        while (q < list.length) {
            // Consecutive indices share one read, capped at SCAN_BLOCK.
            const runStart = this.offsets[list[q]];
            let r = q;
            let runEnd = runStart;
            while (r < list.length && (r === q || list[r] === list[r - 1] + 1)) {
                const end = endOf(list[r]);
                if (end - runStart > SCAN_BLOCK && r > q)
                    break;
                runEnd = end;
                r++;
            }
            const readLen = Math.min(runEnd, this.offsets[list[r - 1]] + MAX_ENTRY_BYTES) - runStart;
            const buf = Buffer.alloc(readLen);
            await this.fh.read(buf, 0, readLen, runStart);
            for (let p = q; p < r; p++) {
                const i = list[p];
                const s = this.offsets[i] - runStart;
                let end = s + Math.min(endOf(i) - this.offsets[i], MAX_ENTRY_BYTES);
                if (end > s && buf[end - 1] === 10) {
                    end--;
                    if (end > s && buf[end - 1] === 13)
                        end--;
                }
                const nl = buf.indexOf(10, s);
                const first = buf.toString('utf8', s, nl !== -1 && nl < end ? nl : end);
                out.push(this.format.parse(first).message || first);
            }
            q = r;
        }
        return out;
    }
    async scanTexts(cb, from = 0, to = this.count) {
        if (!this.fh)
            return;
        const n = Math.min(to, this.count);
        let i = Math.max(0, from);
        while (i < n) {
            const blockStart = this.offsets[i];
            let j = i;
            let blockEnd = blockStart;
            while (j < n && blockEnd - blockStart < SCAN_BLOCK) {
                blockEnd = j + 1 < this.count ? this.offsets[j + 1] : this.indexedSize;
                j++;
            }
            const buf = Buffer.alloc(blockEnd - blockStart);
            await this.fh.read(buf, 0, buf.length, blockStart);
            for (let k = i; k < j; k++) {
                const s = this.offsets[k] - blockStart;
                const e = (k + 1 < this.count ? this.offsets[k + 1] : this.indexedSize) - blockStart;
                if (cb(k, buf.toString('utf8', s, Math.min(e, s + MAX_ENTRY_BYTES))) === false)
                    return;
            }
            i = j;
        }
    }
    async close() {
        fs.unwatchFile(this.path);
        this.watching = false;
        await this.fh?.close();
        this.fh = null;
        if (this.tempDir) {
            const dir = this.tempDir;
            this.tempDir = undefined;
            await fsp.rm(dir, { recursive: true, force: true }).catch(() => { });
        }
    }
}
exports.FileLogSource = FileLogSource;
// Merges several sources into one view ordered by timestamp. Holds only the
// (child, index) mapping — entry text still lives in the children.
class MergedSource extends BaseSource {
    id;
    name;
    children;
    kind = 'merged';
    srcOf = [];
    idxOf = [];
    mtimes = [];
    closed = false;
    handlers = [];
    // Scratch for rebuild(), reused so an out-of-order append doesn't
    // re-allocate the whole merge each time.
    scratch = [];
    threadCache = null;
    loggerCache = null;
    constructor(id, name, children) {
        super();
        this.id = id;
        this.name = name;
        this.children = children;
        this.rebuild();
        for (let s = 0; s < children.length; s++) {
            const child = children[s];
            const append = (ev) => {
                if (!this.closed)
                    this.onChildAppend(s, ev);
            };
            const reset = () => {
                if (this.closed)
                    return;
                this.rebuild();
                this.emit('reset');
            };
            child.on('append', append);
            child.on('reset', reset);
            this.handlers.push({ child, append, reset });
        }
    }
    get childIds() {
        return this.children.map((c) => c.id);
    }
    get count() {
        return this.srcOf.length;
    }
    get formatName() {
        return 'merged (' + this.children.map((c) => c.name).join(', ') + ')';
    }
    get threadList() {
        if (!this.threadCache)
            this.threadCache = [...new Set(this.children.flatMap((c) => c.threadList))];
        return this.threadCache;
    }
    get loggerList() {
        if (!this.loggerCache)
            this.loggerCache = [...new Set(this.children.flatMap((c) => c.loggerList))];
        return this.loggerCache;
    }
    levelAt(i) {
        return this.children[this.srcOf[i]].levelAt(this.idxOf[i]);
    }
    threadAt(i) {
        return this.children[this.srcOf[i]].threadAt(this.idxOf[i]);
    }
    loggerAt(i) {
        return this.children[this.srcOf[i]].loggerAt(this.idxOf[i]);
    }
    timeAt(i) {
        return this.mtimes[i];
    }
    recalcStats() {
        const s = [0, 0, 0, 0, 0, 0];
        for (const c of this.children)
            for (let i = 0; i < 6; i++)
                s[i] += c.stats[i];
        this.stats = s;
    }
    rebuild() {
        this.threadCache = this.loggerCache = null;
        const all = this.scratch;
        all.length = 0;
        for (let s = 0; s < this.children.length; s++) {
            const c = this.children[s];
            for (let i = 0; i < c.count; i++)
                all.push({ s, i, t: c.timeAt(i) });
        }
        all.sort((a, b) => a.t - b.t || a.s - b.s || a.i - b.i);
        const n = all.length;
        this.srcOf.length = n;
        this.idxOf.length = n;
        this.mtimes.length = n;
        for (let k = 0; k < n; k++) {
            this.srcOf[k] = all[k].s;
            this.idxOf[k] = all[k].i;
            this.mtimes[k] = all[k].t;
        }
        this.recalcStats();
    }
    onChildAppend(s, ev) {
        // A child append may introduce threads/loggers the cache doesn't know.
        this.threadCache = this.loggerCache = null;
        this.recalcStats();
        const child = this.children[s];
        const lastT = this.mtimes.length ? this.mtimes[this.mtimes.length - 1] : -Infinity;
        let inOrder = true;
        let prev = lastT;
        for (let i = ev.startIdx; i < ev.startIdx + ev.added; i++) {
            const t = child.timeAt(i);
            if (t < prev) {
                inOrder = false;
                break;
            }
            prev = t;
        }
        if (!inOrder) {
            // Out-of-order arrival: rebuild the merge; consumers must re-evaluate.
            this.rebuild();
            this.emit('reset');
            return;
        }
        const startIdx = this.count;
        const mapped = ev.entries ? [] : null;
        for (let k = 0; k < ev.added; k++) {
            const i = ev.startIdx + k;
            this.srcOf.push(s);
            this.idxOf.push(i);
            this.mtimes.push(child.timeAt(i));
            if (mapped && ev.entries)
                mapped.push({ ...ev.entries[k], i: startIdx + k, src: child.name });
        }
        this.emit('append', { startIdx, added: ev.added, entries: mapped });
    }
    async getEntries(idxs) {
        const perChild = new Map();
        idxs.forEach((mi, k) => {
            if (mi < 0 || mi >= this.count)
                return;
            const s = this.srcOf[mi];
            let g = perChild.get(s);
            if (!g) {
                g = { local: [], pos: [] };
                perChild.set(s, g);
            }
            g.local.push(this.idxOf[mi]);
            g.pos.push(k);
        });
        const out = new Array(idxs.length);
        for (const [s, g] of perChild) {
            const es = await this.children[s].getEntries(g.local);
            es.forEach((e, j) => {
                out[g.pos[j]] = { ...e, i: idxs[g.pos[j]], src: this.children[s].name };
            });
        }
        return out.filter((e) => !!e);
    }
    async scanTexts(cb, from = 0, to = this.count) {
        const BATCH = 500;
        const end = Math.min(to, this.count);
        for (let start = Math.max(0, from); start < end; start += BATCH) {
            const idxs = [];
            for (let i = start; i < Math.min(end, start + BATCH); i++)
                idxs.push(i);
            const es = await this.getEntries(idxs);
            for (const e of es)
                if (cb(e.i, e.raw) === false)
                    return;
        }
    }
    async close() {
        this.closed = true;
        for (const h of this.handlers) {
            h.child.off('append', h.append);
            h.child.off('reset', h.reset);
        }
        this.handlers = [];
    }
}
exports.MergedSource = MergedSource;
class StreamSource extends BaseSource {
    id;
    name;
    maxEntries;
    maxBytes;
    kind = 'stream';
    format = null;
    customPattern;
    entries = [];
    entryBytes = [];
    entryRawBytes = [];
    head = 0;
    retainedBytes = 0;
    threadSet = new Set();
    loggerSet = new Set();
    // Refcounts so eviction can untrack incrementally instead of re-scanning
    // every retained entry.
    threadCounts = new Map();
    loggerCounts = new Map();
    threads = [];
    loggers = [];
    firstLines = [];
    firstLineBytes = 0;
    lastActivity = Date.now();
    // Set by the store when SPOOL_DIR is active; receives every appended batch.
    spool;
    constructor(id, name, maxEntries = config_1.STREAM_LIMITS.maxEntries, maxBytes = config_1.STREAM_LIMITS.maxBytes) {
        super();
        this.id = id;
        this.name = name;
        this.maxEntries = maxEntries;
        this.maxBytes = maxBytes;
    }
    get count() {
        return this.entries.length - this.head;
    }
    get bytes() {
        return this.retainedBytes + this.firstLineBytes;
    }
    get lastActivityAt() {
        return this.lastActivity;
    }
    get formatName() {
        return this.format?.name ?? 'plain';
    }
    get threadList() {
        return this.threads;
    }
    get loggerList() {
        return this.loggers;
    }
    levelAt(i) {
        return this.entryAt(i).lv;
    }
    threadAt(i) {
        return this.entryAt(i).th;
    }
    loggerAt(i) {
        return this.entryAt(i).lg;
    }
    timeAt(i) {
        return this.entryAt(i).t;
    }
    touch(now = Date.now()) {
        this.lastActivity = now;
    }
    entryAt(i) {
        const entry = this.entries[this.head + i];
        if (!entry)
            throw new RangeError(`stream entry index out of range: ${i}`);
        return entry;
    }
    track(e) {
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
    untrackMeta(v, set, counts, list) {
        const n = (counts.get(v) ?? 1) - 1;
        if (n > 0) {
            counts.set(v, n);
            return;
        }
        counts.delete(v);
        set.delete(v);
        const i = list.indexOf(v);
        if (i !== -1)
            list.splice(i, 1);
    }
    untrack(e) {
        this.stats[e.lv]--;
        this.untrackMeta(e.th, this.threadSet, this.threadCounts, this.threads);
        this.untrackMeta(e.lg, this.loggerSet, this.loggerCounts, this.loggers);
    }
    // Full re-scan; only needed when entry metadata is re-parsed (setFormat).
    // Eviction untracks incrementally instead.
    rebuildTracking() {
        this.threadSet.clear();
        this.loggerSet.clear();
        this.threadCounts.clear();
        this.loggerCounts.clear();
        this.threads = [];
        this.loggers = [];
        this.stats = [0, 0, 0, 0, 0, 0];
        for (let i = 0; i < this.count; i++)
            this.track(this.entryAt(i));
    }
    appendEntry(e) {
        this.entries.push(e);
        const rawBytes = Buffer.byteLength(e.raw);
        this.entryRawBytes.push(rawBytes);
        // The fixed allowance covers numbers, object fields and allocator overhead.
        const bytes = 64 + rawBytes + Buffer.byteLength(e.msg) + Buffer.byteLength(e.th) + Buffer.byteLength(e.lg);
        this.entryBytes.push(bytes);
        this.retainedBytes += bytes;
        this.track(e);
    }
    compactIfUseful() {
        if (this.head < 4096 || this.head * 2 < this.entries.length)
            return;
        this.entries = this.entries.slice(this.head);
        this.entryBytes = this.entryBytes.slice(this.head);
        this.entryRawBytes = this.entryRawBytes.slice(this.head);
        this.head = 0;
    }
    retentionTarget(limit) {
        if (limit < 10)
            return limit;
        return limit - Math.max(1, Math.ceil(limit / 10));
    }
    // Once a hard limit is crossed, evict enough entries to restore roughly
    // 10% headroom. Dropped array slots are cleared immediately; occasional
    // compaction only removes the cheap empty prefix.
    enforceRetention() {
        const countExceeded = this.maxEntries > 0 && this.count > this.maxEntries;
        const bytesExceeded = this.maxBytes > 0 && this.bytes > this.maxBytes;
        if (!countExceeded && !bytesExceeded)
            return false;
        const countTarget = countExceeded ? this.retentionTarget(this.maxEntries) : this.maxEntries || Infinity;
        const bytesTarget = bytesExceeded ? this.retentionTarget(this.maxBytes) : this.maxBytes || Infinity;
        // Format-detection samples are auxiliary and may duplicate retained plain
        // lines, so release them before evicting real entries for a byte limit.
        if (bytesExceeded && this.firstLines.length) {
            this.firstLines = [];
            this.firstLineBytes = 0;
        }
        while (this.count > 0 && (this.count > countTarget || this.bytes > bytesTarget)) {
            const evicted = this.entries[this.head];
            if (evicted)
                this.untrack(evicted);
            this.retainedBytes -= this.entryBytes[this.head] || 0;
            this.entries[this.head] = undefined;
            this.entryBytes[this.head] = 0;
            this.entryRawBytes[this.head] = 0;
            this.head++;
        }
        this.compactIfUseful();
        return true;
    }
    // Re-parses retained entries with `format`; null restores auto-detection.
    // Entry boundaries are kept — only the parsed metadata is recomputed.
    setFormat(format, pattern) {
        const heads = [];
        for (let i = 0; i < this.count; i++) {
            const raw = this.entryAt(i).raw;
            const nl = raw.indexOf('\n');
            heads.push(nl === -1 ? raw : raw.slice(0, nl));
        }
        this.customPattern = pattern;
        this.format = format ?? (heads.length ? (0, parser_1.detectFormat)(heads) : null);
        const fmt = this.format;
        if (fmt) {
            for (let i = 0; i < this.count; i++) {
                const e = this.entryAt(i);
                const p = fmt.parse(heads[i]);
                e.t = (0, parser_1.parseTimestamp)(p.time);
                e.lv = (0, parser_1.levelFromString)(p.level);
                e.th = truncateUtf8(p.thread ?? '', MAX_METADATA_BYTES, '');
                e.lg = truncateUtf8(p.logger ?? '', MAX_METADATA_BYTES, '');
                e.msg = truncateUtf8(p.message || heads[i], MAX_ENTRY_BYTES, '');
            }
        }
        this.rebuildTracking();
        this.emit('reset');
    }
    appendLines(lines) {
        this.touch();
        const clean = lines.filter((l) => l.length > 0).map((l) => truncateUtf8(l, MAX_ENTRY_BYTES));
        if (!clean.length)
            return;
        // (Re-)detect the format while the stream is young.
        if (!this.format
            || (this.format.name === 'plain' && this.firstLines.length < 100 && this.firstLineBytes < MAX_FORMAT_DETECTION_BYTES)) {
            for (const line of clean) {
                if (this.firstLines.length >= 100 || this.firstLineBytes >= MAX_FORMAT_DETECTION_BYTES)
                    break;
                const sample = truncateUtf8(line, MAX_FORMAT_DETECTION_BYTES - this.firstLineBytes, '');
                this.firstLines.push(sample);
                this.firstLineBytes += Buffer.byteLength(sample);
            }
            this.format = (0, parser_1.detectFormat)(this.firstLines);
            if (this.format.name !== 'plain') {
                this.firstLines = [];
                this.firstLineBytes = 0;
            }
        }
        const fmt = this.format;
        const startIdx = this.count;
        const added = [];
        let changedExisting = false;
        for (const line of clean) {
            const m = (0, parser_1.matchLine)(fmt, line);
            if (m || this.count === 0) {
                const p = m ?? fmt.parse(line);
                const e = {
                    i: this.count,
                    t: (0, parser_1.parseTimestamp)(p.time),
                    lv: (0, parser_1.levelFromString)(p.level),
                    th: truncateUtf8(p.thread ?? '', MAX_METADATA_BYTES, ''),
                    lg: truncateUtf8(p.logger ?? '', MAX_METADATA_BYTES, ''),
                    msg: truncateUtf8(p.message || line, MAX_ENTRY_BYTES, ''),
                    raw: line,
                };
                this.appendEntry(e);
                added.push(e);
            }
            else {
                const changedRetainedEntry = this.count <= startIdx;
                const physical = this.entries.length - 1;
                const last = this.entries[physical];
                const rawBefore = this.entryRawBytes[physical];
                const addition = '\n' + line;
                const additionBytes = Buffer.byteLength(addition);
                // Fast path: measure only the appended line; the full re-measure (and
                // possible truncation of the whole entry) only happens at the cap.
                let nextRaw;
                let rawAfter;
                if (rawBefore + additionBytes <= MAX_ENTRY_BYTES) {
                    nextRaw = last.raw + addition;
                    rawAfter = rawBefore + additionBytes;
                }
                else {
                    nextRaw = truncateUtf8(last.raw + addition, MAX_ENTRY_BYTES);
                    rawAfter = Buffer.byteLength(nextRaw);
                }
                if (nextRaw !== last.raw) {
                    last.raw = nextRaw;
                    this.entryRawBytes[physical] = rawAfter;
                    this.entryBytes[physical] += rawAfter - rawBefore;
                    this.retainedBytes += rawAfter - rawBefore;
                    changedExisting ||= changedRetainedEntry;
                }
            }
        }
        if (added.length)
            this.spool?.append(added);
        if (this.enforceRetention()) {
            this.emit('reset');
        }
        else if (changedExisting) {
            // A cached row and any text filter may have changed without count growth.
            this.emit('reset');
        }
        else if (added.length) {
            this.emit('append', { startIdx, added: added.length, entries: added });
        }
    }
    appendEntries(items) {
        this.touch();
        const startIdx = this.count;
        const added = [];
        for (const it of items) {
            if (!it || typeof it.message !== 'string')
                continue;
            const t = typeof it.time === 'number' ? it.time : typeof it.time === 'string' ? (0, parser_1.parseTimestamp)(it.time) : 0;
            const raw = truncateUtf8(it.message, MAX_ENTRY_BYTES);
            const e = {
                i: this.count,
                t: t || Date.now(),
                lv: (0, parser_1.levelFromString)(typeof it.level === 'string' ? it.level : undefined),
                th: truncateUtf8(typeof it.thread === 'string' ? it.thread : '', MAX_METADATA_BYTES, ''),
                lg: truncateUtf8(typeof it.logger === 'string' ? it.logger : '', MAX_METADATA_BYTES, ''),
                msg: raw.split('\n', 1)[0],
                raw,
            };
            this.appendEntry(e);
            added.push(e);
        }
        if (added.length)
            this.spool?.append(added);
        if (this.enforceRetention()) {
            this.emit('reset');
        }
        else if (added.length) {
            this.emit('append', { startIdx, added: added.length, entries: added });
        }
    }
    // Bulk-loads entries recovered from a spool file at boot. Unlike the append
    // paths nothing is written back to the spool (the data came from there) and
    // no events are emitted (no subscribers exist yet). Retention caps apply as
    // usual, so a spool written under larger limits is trimmed on load.
    restore(items) {
        this.touch();
        for (const it of items) {
            const e = {
                i: this.count,
                t: typeof it.t === 'number' ? it.t : 0,
                lv: typeof it.lv === 'number' && it.lv >= 0 && it.lv <= 5 ? it.lv : 0,
                th: typeof it.th === 'string' ? it.th : '',
                lg: typeof it.lg === 'string' ? it.lg : '',
                msg: typeof it.msg === 'string' ? it.msg : '',
                raw: it.raw,
            };
            this.appendEntry(e);
        }
        this.enforceRetention();
    }
    async getEntries(idxs) {
        this.touch();
        const out = [];
        for (const i of idxs)
            if (i >= 0 && i < this.count)
                out.push({ ...this.entryAt(i), i });
        return out;
    }
    async scanTexts(cb, from = 0, to = this.count) {
        this.touch();
        const end = Math.min(to, this.count);
        for (let i = Math.max(0, from); i < end; i++)
            if (cb(i, this.entryAt(i).raw) === false)
                return;
    }
    async close() {
        this.entries = [];
        this.entryBytes = [];
        this.entryRawBytes = [];
        this.head = 0;
        this.retainedBytes = 0;
        this.firstLines = [];
        this.firstLineBytes = 0;
    }
}
exports.StreamSource = StreamSource;
const REMOTE_PAGE_SIZE = 1_000; // the entries endpoint caps count at 1000
const REMOTE_FETCH_TIMEOUT_MS = 15_000;
const REMOTE_RECONNECT_MIN_MS = 1_000;
const REMOTE_RECONNECT_MAX_MS = 30_000;
function remoteError(status, message) {
    const err = new Error(message);
    err.status = status;
    return err;
}
// A read-only mirror of a source on a peer log-viewer instance. The initial
// load pages the peer's entries API until caught up; tailing follows the
// peer's WS broadcast: `append` frames fetch just the new range, `reset`
// frames (and any detected drift) trigger a full reload. Nothing is ever
// written back to the peer.
//
// The mirror is bounded by `maxEntries` (REMOTE_MAX_ENTRIES): once exceeded,
// the OLDEST entries are evicted and subscribers get a reset, mirroring
// stream retention semantics. Because filters/search/correlate run against
// the generic BaseSource paths, a remote source behaves like any other —
// including as a MergedSource child.
class RemoteSource extends BaseSource {
    id;
    remoteUrl;
    remoteSourceId;
    viewKey;
    maxEntries;
    kind = 'remote';
    // Mutable: the display name is refined from the peer's source info on load.
    name;
    entries = [];
    peerFormat = 'plain';
    threadSet = new Set();
    loggerSet = new Set();
    threadCounts = new Map();
    loggerCounts = new Map();
    threads = [];
    loggers = [];
    ws = null;
    // Entry count on the peer as of the last successful sync; append frames are
    // validated against it (a length-only check can't tell capped tails apart).
    peerCount = 0;
    // A snapshot reset on the live socket marks the subscription as established.
    synced = false;
    closed = false;
    reconnectDelay = REMOTE_RECONNECT_MIN_MS;
    reconnectTimer = null;
    // Serializes frame handling: append/reset handlers await HTTP fetches and
    // must not interleave.
    queue = Promise.resolve();
    constructor(id, remoteUrl, remoteSourceId, viewKey, maxEntries, name) {
        super();
        this.id = id;
        this.remoteUrl = remoteUrl;
        this.remoteSourceId = remoteSourceId;
        this.viewKey = viewKey;
        this.maxEntries = maxEntries;
        this.name = name;
    }
    // Validates the peer address and performs the initial load, then starts
    // tailing. Peer failures map to HTTP statuses for the opening request.
    static async open(id, url, sourceId, viewKey, maxEntries = config_1.REMOTE_MAX_ENTRIES) {
        let base;
        try {
            base = new URL(url);
        }
        catch {
            throw remoteError(400, 'url must be a valid URL');
        }
        if (base.protocol !== 'http:' && base.protocol !== 'https:') {
            throw remoteError(400, 'url must be an http(s) URL');
        }
        const remoteUrl = base.origin + base.pathname.replace(/\/+$/, '');
        const src = new RemoteSource(id, remoteUrl, sourceId, viewKey, maxEntries, `${sourceId} @ ${base.host}`);
        try {
            await src.reload();
        }
        catch (err) {
            if (err instanceof Error && 'status' in err)
                throw err;
            throw remoteError(502, 'cannot reach peer: ' + err.message);
        }
        src.connect();
        return src;
    }
    get count() {
        return this.entries.length;
    }
    get formatName() {
        return this.peerFormat;
    }
    get threadList() {
        return this.threads;
    }
    get loggerList() {
        return this.loggers;
    }
    get connected() {
        return this.synced && this.ws !== null && this.ws.readyState === ws_1.WebSocket.OPEN;
    }
    entryAt(i) {
        const entry = this.entries[i];
        if (!entry)
            throw new RangeError(`remote entry index out of range: ${i}`);
        return entry;
    }
    levelAt(i) {
        return this.entryAt(i).lv;
    }
    threadAt(i) {
        return this.entryAt(i).th;
    }
    loggerAt(i) {
        return this.entryAt(i).lg;
    }
    timeAt(i) {
        return this.entryAt(i).t;
    }
    track(e) {
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
    untrackMeta(v, set, counts, list) {
        const n = (counts.get(v) ?? 1) - 1;
        if (n > 0) {
            counts.set(v, n);
            return;
        }
        counts.delete(v);
        set.delete(v);
        const i = list.indexOf(v);
        if (i !== -1)
            list.splice(i, 1);
    }
    untrack(e) {
        this.stats[e.lv]--;
        this.untrackMeta(e.th, this.threadSet, this.threadCounts, this.threads);
        this.untrackMeta(e.lg, this.loggerSet, this.loggerCounts, this.loggers);
    }
    // Drops peer-side fields that would be stale locally (indices, elapsed).
    normalize(e) {
        return { i: 0, t: e.t || 0, lv: e.lv | 0, th: e.th || '', lg: e.lg || '', msg: e.msg || '', raw: e.raw || '' };
    }
    // Evicts the oldest entries once the cap is crossed. Returns true when
    // anything was dropped — indices rebased, so callers must emit a reset.
    enforceCap() {
        if (this.maxEntries <= 0 || this.entries.length <= this.maxEntries)
            return false;
        const drop = this.entries.length - this.maxEntries;
        for (let k = 0; k < drop; k++)
            this.untrack(this.entries[k]);
        this.entries.splice(0, drop);
        return true;
    }
    replaceAll(entries) {
        this.entries = [];
        this.threadSet.clear();
        this.loggerSet.clear();
        this.threadCounts.clear();
        this.loggerCounts.clear();
        this.threads = [];
        this.loggers = [];
        this.stats = [0, 0, 0, 0, 0, 0];
        for (const e of entries) {
            const entry = this.normalize(e);
            this.entries.push(entry);
            this.track(entry);
        }
        this.enforceCap();
    }
    peerFetch(pathname) {
        const headers = {};
        if (this.viewKey)
            headers['x-view-key'] = this.viewKey;
        return fetch(this.remoteUrl + pathname, { headers, signal: AbortSignal.timeout(REMOTE_FETCH_TIMEOUT_MS) });
    }
    async checkPeer(res) {
        if (res.ok)
            return;
        if (res.status === 401)
            throw remoteError(401, 'peer rejected the view key');
        if (res.status === 404)
            throw remoteError(404, `unknown log ${this.remoteSourceId} on peer`);
        throw remoteError(502, `peer returned ${res.status}`);
    }
    async peerInfo() {
        const res = await this.peerFetch(`/api/logs/${encodeURIComponent(this.remoteSourceId)}`);
        await this.checkPeer(res);
        return (await res.json());
    }
    // Pages the peer's entries API over [from, to).
    async fetchRange(from, to) {
        const out = [];
        for (let start = from; start < to; start += REMOTE_PAGE_SIZE) {
            const res = await this.peerFetch(`/api/logs/${encodeURIComponent(this.remoteSourceId)}/entries?start=${start}&count=${Math.min(REMOTE_PAGE_SIZE, to - start)}`);
            await this.checkPeer(res);
            const body = (await res.json());
            const entries = Array.isArray(body.entries) ? body.entries : [];
            out.push(...entries);
            if (entries.length < REMOTE_PAGE_SIZE)
                break;
        }
        return out;
    }
    // Full reload: replaces the mirror with the latest page window and emits a
    // reset. Also the fallback whenever an append frame doesn't line up.
    async reload() {
        const info = await this.peerInfo();
        const total = Math.max(0, Number(info.count) || 0);
        this.peerFormat = typeof info.format === 'string' && info.format ? info.format : 'plain';
        if (typeof info.name === 'string' && info.name)
            this.name = `${info.name} @ ${new URL(this.remoteUrl).host}`;
        const from = this.maxEntries > 0 ? Math.max(0, total - this.maxEntries) : 0;
        this.replaceAll(await this.fetchRange(from, total));
        this.peerCount = total;
    }
    enqueue(task) {
        this.queue = this.queue.then(task).catch((err) => console.error(`remote source ${this.id}: frame handling failed:`, err));
    }
    onAppendFrame(frame) {
        const count = Number(frame.count);
        const added = Number(frame.added);
        if (!Number.isFinite(count) || !Number.isFinite(added) || added <= 0)
            return;
        // The mirror must reflect exactly the peer's pre-append state; anything
        // else — a missed frame, a snapshot reload that already included these
        // entries, or a peer-side eviction — means a full reload.
        const before = count - added;
        const expectedTail = this.maxEntries > 0 ? Math.min(before, this.maxEntries) : before;
        if (before < 0 || this.peerCount !== before || this.entries.length !== expectedTail) {
            return this.reloadAndEmit();
        }
        return (async () => {
            const fetched = await this.fetchRange(before, count);
            if (fetched.length !== added) {
                await this.reloadAndEmit();
                return;
            }
            const startIdx = this.entries.length;
            const addedEntries = [];
            for (const e of fetched) {
                const entry = this.normalize(e);
                this.entries.push(entry);
                this.track(entry);
                addedEntries.push(entry);
            }
            this.peerCount = count;
            if (this.enforceCap()) {
                this.emit('reset');
                return;
            }
            this.emit('append', {
                startIdx,
                added: addedEntries.length,
                entries: addedEntries.map((e, k) => ({ ...e, i: startIdx + k })),
            });
        })();
    }
    async reloadAndEmit() {
        if (this.closed)
            return;
        await this.reload();
        this.emit('reset');
    }
    connect() {
        if (this.closed)
            return;
        const ws = new ws_1.WebSocket(this.remoteUrl.replace(/^http/, 'ws') + '/ws');
        this.ws = ws;
        this.synced = false;
        ws.on('open', () => {
            ws.send(JSON.stringify({ type: 'sub', id: this.remoteSourceId, ...(this.viewKey ? { viewKey: this.viewKey } : {}) }));
        });
        ws.on('message', (data) => {
            let m;
            try {
                m = JSON.parse(String(data));
            }
            catch {
                return;
            }
            if (m.type === 'error') {
                // e.g. view_auth_required: the peer keeps the socket open but never
                // subscribes us; close and retry (a fixed viewKey needs a redeploy).
                ws.close();
                return;
            }
            if (m.id !== this.remoteSourceId)
                return;
            if (m.type === 'reset') {
                // The subscription snapshot doubles as the sync point for `connected`.
                this.synced = true;
                this.reconnectDelay = REMOTE_RECONNECT_MIN_MS;
                this.enqueue(() => this.reloadAndEmit());
            }
            else if (m.type === 'append') {
                this.enqueue(() => this.onAppendFrame(m) ?? Promise.resolve());
            }
        });
        ws.on('error', () => ws.close());
        ws.on('close', () => {
            if (ws !== this.ws)
                return;
            this.ws = null;
            this.synced = false;
            if (this.closed)
                return;
            // Stale but readable: entries stay served while we reconnect.
            this.reconnectTimer = setTimeout(() => this.connect(), this.reconnectDelay);
            this.reconnectTimer.unref();
            this.reconnectDelay = Math.min(this.reconnectDelay * 2, REMOTE_RECONNECT_MAX_MS);
        });
    }
    async getEntries(idxs) {
        const out = [];
        for (const i of idxs)
            if (i >= 0 && i < this.count)
                out.push({ ...this.entryAt(i), i });
        return out;
    }
    async scanTexts(cb, from = 0, to = this.count) {
        const end = Math.min(to, this.count);
        for (let i = Math.max(0, from); i < end; i++)
            if (cb(i, this.entryAt(i).raw) === false)
                return;
    }
    async close() {
        this.closed = true;
        if (this.reconnectTimer) {
            clearTimeout(this.reconnectTimer);
            this.reconnectTimer = null;
        }
        const ws = this.ws;
        this.ws = null;
        ws?.close();
    }
}
exports.RemoteSource = RemoteSource;
