// The full UI mounted under a prefix of a host app (examples/minimal-embed):
// assets, API and WebSocket all resolve under /logs/, the host's session
// check guards access, and provider logs open from the Catalog tab.
// Self-contained: spawns the example (run `npm run build` first).

import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
};

const port = await new Promise((resolve) => {
  const s = createServer();
  s.listen(0, '127.0.0.1', () => {
    const p = s.address().port;
    s.close(() => resolve(p));
  });
});
const host = spawn(process.execPath, ['server.mjs'], {
  cwd: path.join(ROOT, 'examples/minimal-embed'),
  env: { ...process.env, PORT: String(port) },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const BASE = `http://localhost:${port}`;
for (let k = 0; k < 100; k++) {
  try {
    if ((await fetch(BASE + '/')).ok) break;
  } catch {
    /* starting */
  }
  await new Promise((r) => setTimeout(r, 50));
}

const browser = await puppeteer.launch({ executablePath: CHROME, args: ['--no-sandbox'] });
try {
  const anon = await fetch(BASE + '/logs/api/logs');
  check('API rejects requests without a session', anon.status === 401, String(anon.status));

  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => localStorage.clear());
  await page.goto(BASE + '/login?user=alice', { waitUntil: 'networkidle0' });
  check('login lands on the prefixed UI', new URL(page.url()).pathname === '/logs/', page.url());
  check('UI assets load under the prefix', await page.$eval('#toolbar', (n) => n.children.length > 5));

  await page.waitForFunction(() => !document.getElementById('fm-tab-catalog').hidden, { timeout: 5000 });
  await page.click('#tb-open');
  await page.waitForSelector('.fm-log[data-log="nightly"]', { timeout: 5000 });
  check('catalog lists the provider log', true);
  await page.click('.fm-log[data-log="nightly"]');
  await page.waitForFunction(() => document.getElementById('win-title').textContent.startsWith('Nightly'), { timeout: 5000 });
  const count = () => page.$eval('#status-right', (n) => Number((n.textContent || '').replace(/[^\d]/g, '')) || 0);
  const c0 = await count();
  await new Promise((r) => setTimeout(r, 2500));
  const c1 = await count();
  check('provider rows arrive live over /logs/ws', c1 > c0, `${c0} -> ${c1}`);
  check('no page errors', errors.length === 0, errors.join('; '));
} finally {
  await browser.close();
  host.kill('SIGTERM');
}
process.exitCode = results.every(Boolean) ? 0 : 1;
