// Frontend performance benchmark (not part of the test suites).
//
// Run:  npm run build && CHROME=<path> node e2e/ui-perf.bench.mjs
//   (or from the repo root: `npm run bench:ui`)
//
// Self-contained: writes a synthetic 200k-entry log to a temp dir, spawns the
// built server (which also serves web/dist) on an ephemeral port, and drives
// the full app in headless Chrome under 4x CPU throttling. Measures:
//   - smooth scrolling: main-thread time per frame (script + style + layout)
//     and how many frames showed "Loading…" placeholder rows
//   - jump scrolling (scrollbar drags): time until a jumped-to screen is filled
//   - live tailing: main-thread time per second while a stream appends lines

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const ENTRIES = Number(process.env.BENCH_ENTRIES) || 200_000;
const THROTTLE = Number(process.env.BENCH_CPU_THROTTLE) || 4;
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-uibench-'));
const file = path.join(dir, 'bench.log');
{
  const base = Date.parse('2026-07-13T10:00:00.000Z');
  const out = [];
  for (let s = 0; s < ENTRIES; s++) {
    const t = new Date(base + s * 7).toISOString().replace('T', ' ').replace('Z', '');
    out.push(`${t} [Thread_${s % 9}] ${LEVELS[s % LEVELS.length]} com.example.Service${s % 23} - request ${s} handled in ${s % 41}ms\n`);
    if (s % 10 === 0) out.push(`   at com.example.Service${s % 23}.handle(Service.java:${s % 400})\n`);
  }
  fs.writeFileSync(file, out.join(''));
}

const port = await new Promise((resolve, reject) => {
  const socket = createServer();
  socket.once('error', reject);
  socket.listen(0, '127.0.0.1', () => {
    const p = socket.address().port;
    socket.close(() => resolve(p));
  });
});
const server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, PORT: String(port), LOG_ROOT: dir, ENABLE_DEMO: 'false', ENABLE_SAMPLES: 'false', STREAM_IDLE_TTL_SECONDS: '0' },
  stdio: ['ignore', 'ignore', 'inherit'],
});
const BASE = `http://127.0.0.1:${port}`;
for (let k = 0; k < 200; k++) {
  try {
    if ((await fetch(BASE + '/healthz')).ok) break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 25));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = {};
const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1400, height: 900 });
  await page.evaluateOnNewDocument(() => localStorage.clear());
  const cdp = await page.createCDPSession();
  await cdp.send('Performance.enable');
  const metrics = async () => {
    const { metrics } = await cdp.send('Performance.getMetrics');
    const m = Object.fromEntries(metrics.map((x) => [x.name, x.value]));
    return { script: m.ScriptDuration * 1000, style: m.RecalcStyleDuration * 1000, layout: m.LayoutDuration * 1000 };
  };
  const split = (a, b, n) =>
    Object.fromEntries(['script', 'style', 'layout'].map((k) => [k, +((b[k] - a[k]) / n).toFixed(2)]));

  await fetch(BASE + '/api/logs/open', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: file }) });
  await page.goto(BASE + '/', { waitUntil: 'networkidle0' });
  await page.waitForSelector('.lg-row:not(.lg-loading)');
  if ((await page.$eval('#tb-follow', (n) => n.getAttribute('aria-pressed'))) === 'true') await page.click('#tb-follow');
  await page.evaluate(() => (document.querySelector('.lg-viewport').scrollTop = 0));
  await sleep(500);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: THROTTLE });

  // 1. Smooth scrolling: 3 rows per frame for 600 frames (~1,800 rows, crossing
  // several 200-row pages). Counts frames that painted placeholder rows.
  {
    const m0 = await metrics();
    const r = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const v = document.querySelector('.lg-viewport');
          const rows = document.querySelector('.lg-rows');
          let frames = 0;
          let blankFrames = 0;
          const t0 = performance.now();
          const step = () => {
            if (rows.querySelector('.lg-loading')) blankFrames++;
            if (frames++ >= 600) return resolve({ frames, blankFrames, wallMs: performance.now() - t0 });
            v.scrollTop += 63;
            requestAnimationFrame(step);
          };
          requestAnimationFrame(step);
        })
    );
    const m1 = await metrics();
    const sp = split(m0, m1, r.frames);
    results.smoothScroll = { msPerFrame: +(sp.script + sp.style + sp.layout).toFixed(2), split: sp, blankFrames: r.blankFrames, frames: r.frames, fps: +((r.frames / r.wallMs) * 1000).toFixed(1) };
  }

  // 2. Jump scrolling: 25 jumps to spread-out positions; time until no row on
  // screen is a placeholder.
  {
    const times = [];
    for (let k = 0; k < 25; k++) {
      const frac = ((k * 0.37) % 1) * 0.98;
      times.push(
        await page.evaluate(
          (frac) =>
            new Promise((resolve) => {
              const v = document.querySelector('.lg-viewport');
              const rows = document.querySelector('.lg-rows');
              const t0 = performance.now();
              v.scrollTop = v.scrollHeight * frac;
              const poll = () => {
                if (rows.children.length && !rows.querySelector('.lg-loading')) resolve(performance.now() - t0);
                else requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            }),
          frac
        )
      );
      await sleep(50);
    }
    times.sort((a, b) => a - b);
    results.jumpScroll = { medianMs: +times[12].toFixed(1), p90Ms: +times[22].toFixed(1), maxMs: +times[24].toFixed(1) };
  }

  // 3. Live tailing: a stream receiving 40 lines every 100 ms for 5 s while
  // following. Main-thread time per second of tailing.
  {
    const ch = 'uibench';
    await fetch(`${BASE}/api/v1/streams/${ch}`, { method: 'PUT' });
    await page.evaluate(() => (window.prompt = () => 'uibench'));
    await page.click('#tb-stream');
    await page.waitForFunction(() => document.getElementById('win-title').textContent.startsWith('uibench'));
    if ((await page.$eval('#tb-follow', (n) => n.getAttribute('aria-pressed'))) !== 'true') await page.click('#tb-follow');
    let seq = 0;
    const push = async () => {
      const lines = [];
      for (let k = 0; k < 40; k++, seq++) {
        lines.push(`2026-07-13 10:00:00,000 [Main] ${LEVELS[seq % LEVELS.length]} Bench - live ${seq}`);
      }
      await fetch(`${BASE}/api/v1/streams/${ch}/entries`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ lines }) });
    };
    for (let k = 0; k < 10; k++) await push();
    await sleep(500);
    const m0 = await metrics();
    const t0 = Date.now();
    while (Date.now() - t0 < 5000) {
      await push();
      await sleep(100);
    }
    await sleep(300);
    const sp = split(m0, await metrics(), (Date.now() - t0) / 1000);
    results.liveTail = { msPerSecond: +(sp.script + sp.style + sp.layout).toFixed(1), split: sp, linesPerSecond: 400 };
  }
} finally {
  await browser.close();
  server.kill('SIGTERM');
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`UI benchmark: ${ENTRIES} entries, ${THROTTLE}x CPU throttle`);
console.log(`smooth scroll: ${results.smoothScroll.msPerFrame} ms main-thread/frame, ${results.smoothScroll.blankFrames}/${results.smoothScroll.frames} frames with placeholder rows, ${results.smoothScroll.fps} fps  ${JSON.stringify(results.smoothScroll.split)}`);
console.log(`jump scroll:   median ${results.jumpScroll.medianMs} ms, p90 ${results.jumpScroll.p90Ms} ms, max ${results.jumpScroll.maxMs} ms until filled`);
console.log(`live tail:     ${results.liveTail.msPerSecond} ms main-thread per second at ${results.liveTail.linesPerSecond} lines/s  ${JSON.stringify(results.liveTail.split)}`);
