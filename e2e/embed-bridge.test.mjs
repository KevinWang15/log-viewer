// Browser e2e for the embed postMessage bridge (docs/embedding.md).
//
// Self-contained: spawns the built server on an ephemeral port and a tiny
// host page on another, then drives both with system Chrome. The host page
// iframes the widget with (page 1) and without (page 2) an allowOrigin
// parameter to exercise both the enabled and the fail-closed bridge modes.
import { spawn } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CHANNEL = `bridge-e2e-${Date.now()}`;

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

// Wait for the server, then seed a deterministic stream.
for (let i = 0; ; i++) {
  try {
    await api('GET', '/api/v1/capabilities');
    break;
  } catch {
    if (i > 100) throw new Error('server did not start');
    await sleep(100);
  }
}
await api('PUT', `/api/v1/streams/${CHANNEL}`);
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
const entries = [];
for (let i = 0; i < 40; i++) {
  entries.push({
    time: 1_783_908_000_000 + i * 1000,
    level: ['INFO', 'WARN', 'ERROR'][i % 3],
    thread: `worker-${i % 4}`,
    logger: 'bridge.test',
    message: `${i % 2 ? 'beta' : 'alpha'} entry ${i}`,
  });
}
await api('POST', `/api/v1/streams/${CHANNEL}/entries`, { entries });

// ---- host page --------------------------------------------------------------
const hostPort = await freePort();
const HOST = `http://127.0.0.1:${hostPort}`;
const hostPage = (embedUrl) => `<!doctype html><html><body>
<iframe id="f" src="${embedUrl}" style="width:800px;height:400px;border:0"></iframe>
<script>
  window.received = [];
  window.addEventListener('message', (e) => window.received.push(e.data));
  window.sendCmd = (msg) => document.getElementById('f').contentWindow.postMessage(msg, '*');
</script>
</body></html>`;
const host = http.createServer((req, res) => {
  const u = new URL(req.url, HOST);
  let embedUrl = `${SERVER}/embed.html?channel=${encodeURIComponent(u.searchParams.get('channel') || CHANNEL)}`;
  const pattern = u.searchParams.get('pattern');
  if (pattern) embedUrl += `&pattern=${encodeURIComponent(pattern)}`;
  if (u.pathname !== '/noallow') embedUrl += `&allowOrigin=${encodeURIComponent(HOST)}`;
  res.setHeader('content-type', 'text/html');
  res.end(hostPage(embedUrl));
});
await new Promise((r) => host.listen(hostPort, '127.0.0.1', r));

// ---- browser ----------------------------------------------------------------
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-first-run', '--window-size=1000,700',
    ...(typeof process.getuid === 'function' && process.getuid() === 0
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
});

try {
  const errors = [];
  const page = await browser.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(HOST + '/', { waitUntil: 'networkidle2' });

  const frame = () => page.frames().find((f) => f.url().includes('embed.html'));
  const statusStarts = (f, prefix) =>
    f.waitForFunction(
      (p) => (document.getElementById('em-status')?.textContent || '').startsWith(p),
      { timeout: 8000 },
      prefix
    );
  const received = (fn) => page.waitForFunction(fn, { timeout: 8000 });

  // ready event
  await received(() => window.received.some((m) => m && m.logViewer === 'ready'));
  check('host receives ready', true);
  const f1 = frame();
  check('widget frame present', !!f1);
  await f1.waitForSelector('.lg-row', { timeout: 8000 });
  await statusStarts(f1, '40 records');

  // stats event piggybacks on append ticks
  const gamma = [0, 1, 2, 3, 4].map((i) => ({
    time: 1_783_908_100_000 + i * 1000,
    level: 'WARN',
    thread: 'worker-9',
    logger: 'bridge.test',
    message: `gamma entry ${i}`,
  }));
  entries.push(...gamma);
  await api('POST', `/api/v1/streams/${CHANNEL}/entries`, { entries: gamma });
  await received(() => window.received.some((m) => m && m.logViewer === 'stats' && m.count === 45));
  const statsMsg = await page.evaluate(() =>
    window.received.find((m) => m && m.logViewer === 'stats' && m.count === 45)
  );
  check(
    'stats event on append tick',
    Array.isArray(statsMsg.levels) && statsMsg.levels.length === 6,
    `count=${statsMsg.count} levels=${JSON.stringify(statsMsg.levels)}`
  );

  // setFilter command
  await page.evaluate(() => window.sendCmd({ logViewer: 'setFilter', text: 'alpha' }));
  await statusStarts(f1, '20 records');
  const searchVal = await f1.$eval('#em-search', (n) => n.value);
  check('setFilter narrows view', searchVal === 'alpha', `search="${searchVal}"`);

  // setFollow command both ways
  const followPressed = () => f1.$eval('#em-follow', (n) => n.getAttribute('aria-pressed'));
  await page.evaluate(() => window.sendCmd({ logViewer: 'setFollow', follow: false }));
  await f1.waitForFunction(() => document.getElementById('em-follow').getAttribute('aria-pressed') === 'false');
  check('setFollow false applied', (await followPressed()) === 'false');
  await page.evaluate(() => window.sendCmd({ logViewer: 'setFollow', follow: true }));
  await f1.waitForFunction(() => document.getElementById('em-follow').getAttribute('aria-pressed') === 'true');
  check('setFollow true applied', (await followPressed()) === 'true');

  // malformed commands are ignored
  await page.evaluate(() => {
    window.sendCmd({ logViewer: 'setFilter' }); // missing text
    window.sendCmd({ logViewer: 'setFollow', follow: 'yes' }); // wrong type
    window.sendCmd({ logViewer: 'nuke' }); // unknown command
    window.sendCmd('setFilter'); // not an object
  });
  await sleep(600);
  check('malformed commands ignored', (await followPressed()) === 'true' && /20 records/.test(await f1.$eval('#em-status', (n) => n.textContent)));

  // ---- pattern param: widget applies a custom parser after subscribing ------
  const PATTERN = '<%p> [%t] %c: %m';
  const PATTERN_CHANNEL = `${CHANNEL}-pattern`;
  await api('PUT', `/api/v1/streams/${PATTERN_CHANNEL}`);
  await api('POST', `/api/v1/streams/${PATTERN_CHANNEL}/entries`, {
    lines: ['<INFO> [Main] App: custom one', '<WARN> [T1] Db: custom two'],
  });
  const page3 = await browser.newPage();
  page3.on('pageerror', (e) => errors.push('pattern: ' + e));
  await page3.goto(HOST + `/?channel=${PATTERN_CHANNEL}&pattern=${encodeURIComponent(PATTERN)}`, {
    waitUntil: 'networkidle2',
  });
  const f3 = page3.frames().find((f) => f.url().includes('embed.html'));
  check('pattern widget frame present', !!f3);
  // Rows first render with auto-detected (plain) fields; once the pattern
  // lands the server resets and the grid refetches with parsed fields.
  await f3.waitForFunction(() => document.querySelector('.lg-row .c-lg')?.textContent === 'App', { timeout: 8000 });
  const cells = await f3.$eval('.lg-row', (n) => ({
    th: n.querySelector('.c-th')?.textContent,
    lg: n.querySelector('.c-lg')?.textContent,
    msg: n.querySelector('.c-msg')?.textContent,
  }));
  check(
    'pattern param parses stream lines',
    cells.th === 'Main' && cells.lg === 'App' && cells.msg === 'custom one',
    JSON.stringify(cells)
  );
  const fmt = (await api('GET', `/api/v1/streams/${PATTERN_CHANNEL}`)).format;
  check('pattern stored on the stream', fmt === `custom (${PATTERN})`, fmt);
  await page3.close();

  // clear command restores the full view
  await page.evaluate(() => window.sendCmd({ logViewer: 'clear' }));
  await statusStarts(f1, '45 records');
  check('clear restores full view', (await f1.$eval('#em-search', (n) => n.value)) === '');

  // entrySelected event on row click (click the first rendered row; the grid
  // is virtualized, so row 0 is not necessarily in the DOM while following)
  const vi = await f1.$eval('.lg-row', (n) => Number(n.getAttribute('data-vi')));
  await f1.click(`.lg-row[data-vi="${vi}"]`);
  await received(() => window.received.some((m) => m && m.logViewer === 'entrySelected'));
  const sel = await page.evaluate(() => window.received.find((m) => m && m.logViewer === 'entrySelected'));
  const want = entries[vi] || null;
  check(
    'entrySelected carries entry fields',
    !!want &&
      sel.entry.t === want.time &&
      sel.entry.lv === LEVELS.indexOf(want.level) &&
      sel.entry.th === want.thread &&
      sel.entry.lg === want.logger &&
      sel.entry.msg === want.message,
    `vi=${vi} ${JSON.stringify(sel && sel.entry)}`
  );

  // ---- fail-closed page: no allowOrigin --------------------------------------
  const page2 = await browser.newPage();
  page2.on('pageerror', (e) => errors.push('noallow: ' + e));
  await page2.goto(HOST + '/noallow', { waitUntil: 'networkidle2' });
  const f2 = page2.frames().find((f) => f.url().includes('embed.html'));
  check('noallow widget frame present', !!f2);
  await f2.waitForSelector('.lg-row', { timeout: 8000 });
  await statusStarts(f2, '45 records');
  await sleep(500);
  const got = await page2.evaluate(() => window.received.length);
  check('no events posted without allowOrigin', got === 0, `${got} messages`);
  await page2.evaluate(() => window.sendCmd({ logViewer: 'setFilter', text: 'alpha' }));
  await sleep(800);
  const ignored =
    (await f2.$eval('#em-search', (n) => n.value)) === '' &&
    /45 records/.test(await f2.$eval('#em-status', (n) => n.textContent));
  check('commands ignored without allowOrigin', ignored && (await page2.evaluate(() => window.received.length)) === 0);

  check('no page JS errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} finally {
  await browser.close();
  server.kill();
  host.close();
}
console.log(results.join('\n'));
