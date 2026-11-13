// Server performance benchmark (not part of `npm test`).
//
// Run:  npm run build -w server && node server/test/perf.bench.mjs
//   (or from the repo root: `npm run bench`)
//
// Generates a synthetic log (~200k entries, ~10% multiline continuations) in a
// temp dir, then measures against the built server (dist/):
//   - indexing throughput (MB/s)
//   - filter create time (metadata-only and text-regex)
//   - minimap computation time (cold + immediate repeat, to show caching)
//   - entries page fetch latency over HTTP (200-entry window)
//   - search latency over HTTP (needle near the end of the file)
//   - incremental append handling (append 5k entries with a text filter active)

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { FileLogSource } from '../dist/sources.js';
import { Store } from '../dist/store.js';

const ENTRIES = 200_000;
const APPEND_ENTRIES = 5_000;
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];

// Loose anti-regression budgets for `node server/test/perf.bench.mjs --check`
// (used by CI). These are ~3-5x above the numbers on a dev machine so they
// only trip on real regressions, not on noisy shared runners.
const CHECK_MODE = process.argv.includes('--check');
const BUDGETS = {
  indexMs: 5_000,          // >= 4 MB/s indexing
  indexHeapPerEntry: 120,  // bytes
  filterTextMs: 1_000,
  minimapWarmMs: 5,
  reportWarmMs: 20,
  pageWarmMs: 100,
  searchMs: 2_000,
  appendMs: 500,
};
const measured = {};
const failures = [];
function record(key, value, text) {
  measured[key] = value;
  console.log(text);
  if (CHECK_MODE && key in BUDGETS && value > BUDGETS[key]) {
    failures.push(`${key}: ${value} > budget ${BUDGETS[key]}`);
  }
}

function* entryLines(startSeq, count) {
  const base = Date.parse('2026-07-13T10:00:00.000Z');
  for (let k = 0; k < count; k++) {
    const seq = startSeq + k;
    const t = new Date(base + seq * 7).toISOString().replace('T', ' ').replace('Z', '');
    const lv = LEVELS[seq % LEVELS.length];
    const needle = seq % 997 === 0 ? 'zebra ' : '';
    yield `${t} [Thread_${seq % 9}] ${lv} com.example.Service${seq % 23} - ${needle}request ${seq} handled in ${seq % 41}ms`;
    if (seq % 10 === 0) {
      yield `   at com.example.Service${seq % 23}.handle(Service.java:${seq % 400})`;
      yield `   at com.example.Dispatcher.route(Dispatcher.java:${seq % 200})`;
    }
  }
}

function writeLog(file, startSeq, count) {
  const chunks = [];
  for (const line of entryLines(startSeq, count)) chunks.push(line + '\n');
  fs.appendFileSync(file, chunks.join(''));
}

// Pre-change servers have no Store#minimapFor; fall back to the original
// per-request full scan so the same script measures both revisions.
function minimapOnce(store, src, buckets) {
  if (typeof store.minimapFor === 'function') return store.minimapFor(src, null, buckets);
  const n = src.count;
  const out = new Array(buckets).fill(-1);
  if (n > 0) {
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor((b * n) / buckets);
      const e = Math.max(s + 1, Math.floor(((b + 1) * n) / buckets));
      let mx = -1;
      for (let k = s; k < Math.min(e, n); k++) {
        const lv = src.levelAt(k);
        if (lv > mx) mx = lv;
      }
      out[b] = mx;
    }
  }
  return { buckets: out, bookmarks: new Array(buckets).fill(false), count: n };
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-bench-'));
const file = path.join(dir, 'bench.log');

function availablePort() {
  return new Promise((resolve, reject) => {
    const socket = createServer();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const port = socket.address().port;
      socket.close(() => resolve(port));
    });
  });
}

// Spawns the built server against the bench log and measures the entries-page
// and search routes end to end over HTTP.
async function httpTimings() {
  const port = await availablePort();
  const child = spawn(process.execPath, [fileURLToPath(new URL('../dist/index.js', import.meta.url))], {
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      LOG_ROOT: dir,
      ENABLE_DEMO: 'false',
      ENABLE_SAMPLES: 'false',
      STREAM_IDLE_TTL_SECONDS: '0',
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  try {
    for (let attempt = 0; attempt < 200; attempt++) {
      try {
        if ((await fetch(base + '/healthz')).ok) break;
      } catch {
        /* still starting */
      }
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const opened = await fetch(base + '/api/logs/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
    });
    const { id } = await opened.json();

    // Entries page: a 200-entry window mid-file (first fetch is cold-ish).
    const start = 120_000;
    let t0 = performance.now();
    let res = await fetch(`${base}/api/logs/${id}/entries?start=${start}&count=200`);
    let page = await res.json();
    record('pageColdMs', performance.now() - t0,
      `entries page (200, cold): ${(performance.now() - t0).toFixed(1)} ms  (${page.entries.length} entries)`);
    t0 = performance.now();
    res = await fetch(`${base}/api/logs/${id}/entries?start=${start}&count=200`);
    page = await res.json();
    record('pageWarmMs', performance.now() - t0,
      `entries page (200, warm): ${(performance.now() - t0).toFixed(1)} ms`);

    // Search: needle unique to an entry near the end of the file.
    const needle = `request ${ENTRIES - 5} handled`;
    t0 = performance.now();
    res = await fetch(`${base}/api/logs/${id}/search?q=${encodeURIComponent(needle)}&from=-1&dir=next`);
    const hit = await res.json();
    record('searchMs', performance.now() - t0,
      `search (needle at ${ENTRIES - 5}):  ${(performance.now() - t0).toFixed(1)} ms  (vi=${hit.vi})`);
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => child.once('exit', resolve));
    if (child.exitCode !== 0 && child.exitCode !== null) console.error(stderr);
  }
}

try {
  writeLog(file, 0, ENTRIES);
  const sizeBytes = fs.statSync(file).size;
  console.log(`synthetic log: ${ENTRIES} entries, ${(sizeBytes / 1048576).toFixed(1)} MB`);

  // 1. Indexing throughput (+ index heap per entry; arrayBuffers covers
  // typed-array backing stores, which live outside heapUsed).
  const memUsed = () => {
    const mu = process.memoryUsage();
    return mu.heapUsed + (mu.arrayBuffers ?? 0);
  };
  global.gc?.();
  const heapBefore = memUsed();
  let t0 = performance.now();
  const src = await FileLogSource.open('bench', file);
  let dt = performance.now() - t0;
  global.gc?.();
  const heapDelta = memUsed() - heapBefore;
  record('indexMs', dt,
    `index:            ${dt.toFixed(0)} ms  (${(sizeBytes / 1048576 / (dt / 1000)).toFixed(1)} MB/s, ${src.count} entries)`);
  record('indexHeapPerEntry', heapDelta / src.count,
    `index heap:       ${(heapDelta / src.count).toFixed(1)} B/entry  (${(heapDelta / 1048576).toFixed(1)} MB total)`);

  const store = new Store();
  store.addSource(src);

  // 2. Filter create: metadata-only, then text regex.
  t0 = performance.now();
  const metaFilter = await store.createFilter(src, { levels: [4, 5] });
  dt = performance.now() - t0;
  console.log(`filter (meta):    ${dt.toFixed(1)} ms  (${metaFilter.indices.length} matches)`);
  store.removeFilter(metaFilter.id);

  t0 = performance.now();
  const textFilter = await store.createFilter(src, { text: 'zebra|quux', regex: true });
  dt = performance.now() - t0;
  record('filterTextMs', dt, `filter (text/re): ${dt.toFixed(1)} ms  (${textFilter.indices.length} matches)`);

  // 3. Minimap: cold computation, then an immediate repeat (warm cache, if any).
  t0 = performance.now();
  minimapOnce(store, src, 400);
  dt = performance.now() - t0;
  console.log(`minimap (cold):   ${dt.toFixed(1)} ms`);
  t0 = performance.now();
  minimapOnce(store, src, 400);
  dt = performance.now() - t0;
  record('minimapWarmMs', dt, `minimap (warm):   ${dt.toFixed(2)} ms`);

  // 3b. Report: cold computation (histogram + top loggers/threads/messages),
  // then an immediate repeat (fold cache hit).
  t0 = performance.now();
  await store.reportFor(src, null, 60);
  dt = performance.now() - t0;
  console.log(`report (cold):    ${dt.toFixed(1)} ms`);
  t0 = performance.now();
  await store.reportFor(src, null, 60);
  dt = performance.now() - t0;
  record('reportWarmMs', dt, `report (warm):    ${dt.toFixed(2)} ms`);

  // 4. HTTP routes: entries page + search against the same file.
  await httpTimings();

  // 5. Append 5k entries with the text filter still active. Measures from the
  // file change until the store broadcast the updated filter counts.
  const appended = new Promise((resolve) => {
    store.broadcast = (msg) => {
      if (msg.type === 'append') resolve(msg);
    };
  });
  writeLog(file, ENTRIES, APPEND_ENTRIES);
  t0 = performance.now();
  await src.onFileChange(fs.statSync(file).size); // ts-private, plain method at runtime
  const msg = await appended;
  dt = performance.now() - t0;
  record('appendMs', dt,
    `append 5k (text filter active): ${dt.toFixed(1)} ms  (filter now ${msg.filters[textFilter.id].count} matches)`
  );

  await store.removeSource(src.id);

  if (CHECK_MODE) {
    if (failures.length) {
      console.error('\nBUDGET FAILURES:\n  ' + failures.join('\n  '));
      process.exitCode = 1;
    } else {
      console.log('\nbudget check: all within loose CI budgets');
    }
  }
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
