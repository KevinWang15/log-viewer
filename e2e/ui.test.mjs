// Browser smoke test: drives the built app with system Chrome.
import puppeteer from 'puppeteer-core';

const BASE = process.env.BASE || 'http://localhost:5178';
const SHOT = process.env.SHOT_DIR || '.';
const results = [];
const check = (name, ok, extra = '') => {
  results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ' — ' + extra : ''}`);
  if (!ok) process.exitCode = 1;
};

// Open a sample file server-side so the app restores it on load.
const D = new URL('../server/sample-logs', import.meta.url).pathname;
await fetch(BASE + '/api/logs/open', {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ path: D + '/app.log' }),
});

const browser = await puppeteer.launch({
  executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  headless: 'new',
  args: ['--no-first-run', '--window-size=1440,900',
    ...(typeof process.getuid === 'function' && process.getuid() === 0
      ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
});
const page = await browser.newPage();
await page.setViewport({ width: 1440, height: 900 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => {
  if (m.type() === 'error') errors.push(m.text());
});

await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
await page.waitForSelector('.lg-row', { timeout: 8000 }).catch(() => {});
const rowCount = await page.$$eval('.lg-row', (r) => r.length);
check('grid renders rows', rowCount > 10, `${rowCount} rows`);

const statusRight = await page.$eval('#status-right', (n) => n.textContent);
check('status shows record count', /[\d,]+ records/.test(statusRight), statusRight.trim());

// Select a row -> detail pane fills
await page.click('.lg-row[data-vi="3"]');
await new Promise((r) => setTimeout(r, 300));
const detail = await page.$eval('#detail', (n) => n.textContent);
check('detail pane shows entry', detail.trim().length > 20);

await page.screenshot({ path: SHOT + '/main.png' });

// Apply a level filter: click WARN + ERROR dots off-others via toolbar (toggle TRACE..INFO off)
for (const i of [0, 1, 2, 5]) await page.click(`#tb-lv-${i}`); // leave WARN+ERROR
await new Promise((r) => setTimeout(r, 800));
const filteredStatus = await page.$eval('#status-right', (n) => n.textContent);
check('level filter applied', /filtered/.test(filteredStatus), filteredStatus.trim());
const treeText = await page.$eval('#tree', (n) => n.textContent);
check('filter shown in tree', treeText.includes('WARN, ERROR'), '');

// Text filter on top
await page.type('#tb-search', 'price');
await page.keyboard.press('Enter');
await new Promise((r) => setTimeout(r, 800));
const t2 = await page.$eval('#tree', (n) => n.textContent);
check('text filter chained in tree', t2.includes("'price'"));
const firstMsg = await page.$eval('.lg-row .c-msg', (n) => n.textContent.toLowerCase());
check('filtered rows match', firstMsg.includes('price') || firstMsg.includes('…'), firstMsg.slice(0, 60));
await page.screenshot({ path: SHOT + '/filtered.png' });

// Bookmark selected row and verify both transitions. Restore the initial state
// so repeated test runs are deterministic against a long-lived server.
await page.click('.lg-row[data-vi="0"]');
const flags = async () => page.$$eval('.bm-flag', (r) => r.length);
const selectedFlag = async () => !!(await page.$('.lg-row[data-vi="0"] .bm-flag'));
const ctrlB = async () => {
  await page.keyboard.down('Control');
  await page.keyboard.press('b');
  await page.keyboard.up('Control');
  await new Promise((r) => setTimeout(r, 400));
};
const before = await flags();
const initiallyOn = await selectedFlag();
await ctrlB();
const toggled = await flags();
check('bookmark flag toggles', toggled === before + (initiallyOn ? -1 : 1), `${before} -> ${toggled} flags`);
await ctrlB();
const restored = await flags();
check('bookmark state restores', restored === before, `${toggled} -> ${restored} flags`);

// Report modal
await page.click('#tb-report');
await page.waitForSelector('#report-canvas', { timeout: 5000 }).catch(() => {});
const hasReport = await page.$('#report-canvas');
check('report modal renders', !!hasReport);
if (hasReport) await page.screenshot({ path: SHOT + '/report.png' });
await page.click('#report-close').catch(() => {});

// Embed page with live demo stream
const embed = await browser.newPage();
await embed.setViewport({ width: 900, height: 420 });
embed.on('pageerror', (e) => errors.push('embed: ' + e));
await embed.goto(BASE + '/embed.html?channel=demo', { waitUntil: 'networkidle2' });
await embed.waitForSelector('.lg-row', { timeout: 8000 }).catch(() => {});
const embedRows1 = await embed.$$eval('.lg-row', (r) => r.length);
const embedStatus1 = await embed.$eval('#em-status', (n) => n.textContent);
await new Promise((r) => setTimeout(r, 2500));
const embedStatus2 = await embed.$eval('#em-status', (n) => n.textContent);
check('embed renders live rows', embedRows1 > 3, `${embedRows1} rows`);
check(
  'embed count grows (live)',
  parseInt(embedStatus2.replace(/\D/g, '')) > parseInt(embedStatus1.replace(/\D/g, '')),
  `${embedStatus1.trim()} -> ${embedStatus2.trim()}`
);
await embed.screenshot({ path: SHOT + '/embed.png' });

check('no page JS errors', errors.length === 0, errors.slice(0, 3).join(' | '));

await browser.close();
console.log(results.join('\n'));
