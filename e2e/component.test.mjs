// Browser e2e for the <log-viewer> custom element (docs/embedding-ui.md).
//
// Self-contained: spawns the built server on an ephemeral port, serves the
// built web/dist on another, and drives component.html with system Chrome.
// Asserts rows render, log-viewer-ready/log-viewer-entry-selected/log-viewer-stats
// fire, and a channel attribute switch re-subscribes.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CH1 = `comp-e2e-a-${Date.now()}`;
const CH2 = `comp-e2e-b-${Date.now()}`;
const CH3 = `comp-e2e-c-${Date.now()}`;

const results = [];
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });

// ---- spawn the log viewer server -------------------------------------------
const serverPort = await freePort();
const SERVER = `http://127.0.0.1:${serverPort}`;
const server = spawn(process.execPath, [path.join(ROOT, 'server/dist/index.js')], {
  env: { ...process.env, PORT: String(serverPort), ENABLE_DEMO: 'false', ENABLE_SAMPLES: 'false' },
  stdio: ['ignore', 'ignore', 'inherit'],
});

async function api(method, urlPath, body) {
  const res = await fetch(SERVER + urlPath, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${urlPath}: ${res.status} ${await res.text()}`);
  return res.json();
}

for (let i = 0; ; i++) {
  try {
    await api('GET', '/api/v1/capabilities');
    break;
  } catch {
    if (i > 100) throw new Error('server did not start');
    await sleep(100);
  }
}

const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
async function seed(channel, count, tag, baseTime) {
  await api('PUT', `/api/v1/streams/${channel}`);
  const entries = [];
  for (let i = 0; i < count; i++) {
    entries.push({
      time: baseTime + i * 1000,
      level: ['INFO', 'WARN', 'ERROR'][i % 3],
      thread: `worker-${i % 4}`,
      logger: 'component.test',
      message: `${tag} entry ${i}`,
      shard: i % 2 ? 'b' : 'a',
    });
  }
  if (entries.length) await api('POST', `/api/v1/streams/${channel}/entries`, { entries });
  return entries;
}
const seedA = await seed(CH1, 40, 'alpha', 1_783_908_000_000);
await seed(CH2, 7, 'beta', 1_783_908_100_000);
await seed(CH3, 3, 'switched', 1_783_908_200_000);

// ---- static hosting for the built component page ----------------------------
const distDir = path.join(ROOT, 'web/dist');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
const staticPort = await freePort();
const STATIC = `http://127.0.0.1:${staticPort}`;
const staticServer = http.createServer((req, res) => {
  const u = new URL(req.url, STATIC);
  const file = path.join(distDir, u.pathname === '/' ? 'component.html' : u.pathname);
  if (!file.startsWith(distDir) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.statusCode = 404;
    res.end('not found');
    return;
  }
  res.setHeader('content-type', MIME[path.extname(file)] || 'application/octet-stream');
  fs.createReadStream(file).pipe(res);
});
await new Promise((r) => staticServer.listen(staticPort, '127.0.0.1', r));

// ---- browser ----------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--window-size=1000,800',
    ...(typeof process.getuid === 'function' && process.getuid() === 0
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
});

try {
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.evaluateOnNewDocument(() => {
    window.__events = [];
    for (const type of ['log-viewer-ready', 'log-viewer-entry-selected', 'log-viewer-stats', 'log-viewer-filter-changed']) {
      window.addEventListener(type, (e) =>
        window.__events.push({ type, channel: e.target.getAttribute('channel'), detail: e.detail })
      );
    }
  });
  await page.goto(`${STATIC}/component.html?server=${encodeURIComponent(SERVER)}&channels=${CH1},${CH2}`, {
    waitUntil: 'networkidle2',
  });

  const shadow = (idx, fn, ...args) =>
    page.evaluate(
      (i, f, ...a) => {
        const root = document.querySelectorAll('log-viewer')[i]?.shadowRoot;
        return root ? new Function('root', 'args', `return (${f})(root, ...args)`)(root, a) : null;
      },
      idx,
      String(fn),
      ...args
    );
  const waitShadow = (idx, fn, ...args) =>
    page.waitForFunction(
      (i, f, ...a) => {
        const root = document.querySelectorAll('log-viewer')[i]?.shadowRoot;
        return root ? new Function('root', 'args', `return (${f})(root, ...args)`)(root, a) : null;
      },
      { timeout: 8000 },
      idx,
      String(fn),
      ...args
    );
  const rowsIn = (root) => root.querySelectorAll('.lg-row').length;
  const statusText = (root) => root.getElementById('em-status')?.textContent || '';

  // ready events: one per element
  await page.waitForFunction(() => window.__events.filter((e) => e.type === 'log-viewer-ready').length === 2, {
    timeout: 8000,
  });
  const readyChannels = await page.evaluate(() =>
    window.__events.filter((e) => e.type === 'log-viewer-ready').map((e) => e.channel)
  );
  check('log-viewer-ready fires once per element', readyChannels.join(',') === `${CH1},${CH2}`, readyChannels.join(','));

  // rows render in both shadow roots
  await waitShadow(0, rowsIn);
  await waitShadow(1, rowsIn);
  check('rows render in both elements', (await shadow(0, rowsIn)) > 0 && (await shadow(1, rowsIn)) > 0);
  await waitShadow(0, (root) => (root.getElementById('em-status')?.textContent || '').startsWith('40 records'));
  await waitShadow(1, (root) => (root.getElementById('em-status')?.textContent || '').startsWith('7 records'));
  check(
    'status shows per-channel counts',
    (await shadow(0, statusText)).startsWith('40 records') &&
      (await shadow(1, statusText)).startsWith('7 records')
  );

  // stats event piggybacks on append ticks
  const gamma = [0, 1].map((i) => ({
    time: 1_783_908_300_000 + i * 1000,
    level: 'WARN',
    thread: 'worker-9',
    logger: 'component.test',
    message: `gamma entry ${i}`,
  }));
  await api('POST', `/api/v1/streams/${CH1}/entries`, { entries: gamma });
  await page.waitForFunction(
    () => window.__events.some((e) => e.type === 'log-viewer-stats' && e.detail?.count === 42),
    { timeout: 8000 }
  );
  const statsEv = await page.evaluate(() => window.__events.find((e) => e.type === 'log-viewer-stats' && e.detail?.count === 42));
  check(
    'log-viewer-stats on append tick',
    statsEv.channel === CH1 && Array.isArray(statsEv.detail.levels) && statsEv.detail.levels.length === 6,
    JSON.stringify(statsEv.detail)
  );

  // entrySelected on row click (click the first rendered row in element 0)
  const clickedVi = await shadow(0, (root) => {
    const row = root.querySelector('.lg-row');
    if (!row) return -1;
    row.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    return Number(row.getAttribute('data-vi'));
  });
  await page.waitForFunction(() => window.__events.some((e) => e.type === 'log-viewer-entry-selected'), {
    timeout: 8000,
  });
  const selEv = await page.evaluate(() => window.__events.find((e) => e.type === 'log-viewer-entry-selected'));
  const want = seedA[clickedVi] || null;
  check(
    'log-viewer-entry-selected carries entry fields',
    !!want &&
      selEv.channel === CH1 &&
      selEv.detail.entry.t === want.time &&
      selEv.detail.entry.lv === LEVELS.indexOf(want.level) &&
      selEv.detail.entry.th === want.thread &&
      selEv.detail.entry.lg === want.logger &&
      selEv.detail.entry.msg === want.message,
    `vi=${clickedVi} ${JSON.stringify(selEv.detail)}`
  );

  // criteria property: set from the host, read back, and change events
  await page.evaluate(() => (document.querySelectorAll('log-viewer')[0].criteria = { fields: { shard: ['a'] } }));
  await waitShadow(0, (root) => (root.getElementById('em-status')?.textContent || '').startsWith('20 records'));
  const apiEv = await page.evaluate(() => window.__events.filter((e) => e.type === 'log-viewer-filter-changed').at(-1));
  const readBack = await page.evaluate(() => document.querySelectorAll('log-viewer')[0].criteria);
  check(
    'criteria property filters and reports the change',
    apiEv?.detail?.source === 'api' && apiEv.detail.criteria.fields.shard[0] === 'a' && readBack.fields.shard[0] === 'a',
    JSON.stringify({ apiEv: apiEv?.detail, readBack })
  );
  // A field chip in the detail pane is a user change.
  await shadow(0, (root) => root.querySelector('.lg-row')?.click());
  await waitShadow(0, (root) => !!root.querySelector('button.field-chip'));
  await shadow(0, (root) => root.querySelector('button.field-chip')?.click());
  await page.waitForFunction(() => window.__events.some((e) => e.type === 'log-viewer-filter-changed' && e.detail?.source === 'user'), {
    timeout: 8000,
  });
  check('field chips change the filter as the user', true);

  // channel attribute switch re-subscribes the second element
  await page.evaluate(
    (ch) => document.querySelectorAll('log-viewer')[1].setAttribute('channel', ch),
    CH3
  );
  await page.waitForFunction(
    (ch) => window.__events.filter((e) => e.type === 'log-viewer-ready' && e.channel === ch).length === 1,
    { timeout: 8000 },
    CH3
  );
  await waitShadow(1, (root) => (root.getElementById('em-status')?.textContent || '').startsWith('3 records'));
  await waitShadow(1, (root) => root.querySelector('.lg-row .c-msg')?.textContent?.includes('switched'));
  const switched = await shadow(1, (root) => ({
    status: root.getElementById('em-status')?.textContent || '',
    msg: root.querySelector('.lg-row .c-msg')?.textContent,
  }));
  check(
    'channel switch re-subscribes',
    switched.status.startsWith('3 records') && switched.msg.includes('switched'),
    JSON.stringify(switched)
  );

  check('no page JS errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  staticServer.close();
}
console.log(results.join('\n'));
