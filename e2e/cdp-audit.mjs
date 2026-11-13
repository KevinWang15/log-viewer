// Chrome DevTools Protocol quality audit for the standalone and embedded UIs.
//
// This deliberately uses direct CDP sessions for screenshots, accessibility,
// DOM, heap, network, emulation and performance data. Puppeteer is only the
// small amount of browser/process and interaction plumbing around the protocol.
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const BASE = (process.env.BASE || 'http://localhost:5178').replace(/\/$/, '');
const ARTIFACT_DIR = process.env.ARTIFACT_DIR || '/tmp/log-viewer-cdp-audit';
const CHROME =
  process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SAMPLE_DIR = fileURLToPath(new URL('../server/sample-logs', import.meta.url));
const CHANNEL = `cdp-audit-${Date.now()}`;
const LOAD_ENTRIES = Number(process.env.CDP_LOAD_ENTRIES || 30_000);
const checks = [];
const scenarios = {};

await mkdir(ARTIFACT_DIR, { recursive: true });

function check(scenario, name, ok, detail = '') {
  const result = { scenario, name, ok: Boolean(ok), detail: String(detail || '') };
  checks.push(result);
  console.log(`${result.ok ? 'PASS' : 'FAIL'} [${scenario}] ${name}${detail ? ` — ${detail}` : ''}`);
  return result.ok;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(urlPath, init) {
  const response = await fetch(BASE + urlPath, init);
  if (!response.ok) throw new Error(`${init?.method || 'GET'} ${urlPath}: ${response.status} ${await response.text()}`);
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

async function seedData() {
  await request('/api/logs/open', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path: path.join(SAMPLE_DIR, 'app.log') }),
  });
  await request(`/api/v1/streams/${CHANNEL}`, { method: 'PUT' });
  const batchSize = 2_000;
  const levels = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];
  for (let start = 0; start < LOAD_ENTRIES; start += batchSize) {
    const end = Math.min(LOAD_ENTRIES, start + batchSize);
    const entries = [];
    for (let i = start; i < end; i++) {
      entries.push({
        time: 1_783_908_000_000 + i,
        level: levels[i % levels.length],
        thread: `worker-${i % 32}`,
        logger: `service.${i % 12}`,
        message: `CDP load entry ${i} correlation=${(i * 2654435761 >>> 0).toString(16)}`,
      });
    }
    await request(`/api/v1/streams/${CHANNEL}/entries`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ entries }),
    });
  }
}

async function createAuditedPage(browser, viewport) {
  const page = await browser.newPage();
  await page.setViewport(viewport);
  const cdp = await page.createCDPSession();
  const telemetry = { exceptions: [], consoleErrors: [], failedRequests: [], badResponses: [], responses: [] };
  await Promise.all([
    cdp.send('Page.enable'),
    cdp.send('Runtime.enable'),
    cdp.send('Log.enable'),
    cdp.send('Network.enable'),
    cdp.send('Performance.enable'),
    cdp.send('DOM.enable'),
    cdp.send('Accessibility.enable'),
    cdp.send('HeapProfiler.enable'),
  ]);
  cdp.on('Runtime.exceptionThrown', ({ exceptionDetails }) => {
    telemetry.exceptions.push(exceptionDetails.exception?.description || exceptionDetails.text);
  });
  cdp.on('Runtime.consoleAPICalled', ({ type, args }) => {
    if (type === 'error' || type === 'assert') {
      telemetry.consoleErrors.push(args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });
  cdp.on('Log.entryAdded', ({ entry }) => {
    if (entry.level === 'error') telemetry.consoleErrors.push(entry.text);
  });
  cdp.on('Network.loadingFailed', (event) => {
    if (!event.canceled) telemetry.failedRequests.push(`${event.type}: ${event.errorText}`);
  });
  cdp.on('Network.responseReceived', ({ response, type }) => {
    telemetry.responses.push({ url: response.url, status: response.status, type });
    if (response.status >= 400) telemetry.badResponses.push(`${response.status} ${response.url}`);
  });
  return { page, cdp, telemetry };
}

async function cdpValue(cdp, expression) {
  const result = await cdp.send('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.text);
  return result.result.value;
}

async function screenshot(cdp, name) {
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const target = path.join(ARTIFACT_DIR, name);
  await writeFile(target, Buffer.from(shot.data, 'base64'));
  return target;
}

async function collectProtocolSnapshot(cdp) {
  await cdp.send('HeapProfiler.collectGarbage');
  const [performance, dom, heap, ax, snapshot] = await Promise.all([
    cdp.send('Performance.getMetrics'),
    cdp.send('Memory.getDOMCounters'),
    cdp.send('Runtime.getHeapUsage'),
    cdp.send('Accessibility.getFullAXTree'),
    cdp.send('DOMSnapshot.captureSnapshot', {
      computedStyles: ['display', 'visibility', 'color', 'background-color', 'font-size'],
      includeDOMRects: true,
    }),
  ]);
  return {
    performance: Object.fromEntries(performance.metrics.map(({ name, value }) => [name, value])),
    dom,
    heap,
    accessibility: {
      nodes: ax.nodes.length,
      unnamedControls: ax.nodes
        .filter((node) => ['button', 'textbox', 'searchbox', 'grid'].includes(node.role?.value))
        .filter((node) => !String(node.name?.value || '').trim())
        .map((node) => ({ role: node.role?.value, backendDOMNodeId: node.backendDOMNodeId })),
    },
    snapshot: {
      documents: snapshot.documents.length,
      nodes: snapshot.documents.reduce((sum, document) => sum + document.nodes.nodeName.length, 0),
      layoutNodes: snapshot.documents.reduce((sum, document) => sum + document.layout.nodeIndex.length, 0),
    },
  };
}

async function layoutAudit(cdp) {
  return cdpValue(
    cdp,
    `(() => {
      const visible = (el) => {
        const s = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
      };
      const buttons = [...document.querySelectorAll('button')].filter(visible).map((el) => {
        const r = el.getBoundingClientRect();
        return { id: el.id, width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10 };
      });
      const toolbar = document.querySelector('#toolbar, .embed-toolbar');
      const main = document.querySelector('#main, .embed-grid');
      return {
        viewport: { width: innerWidth, height: innerHeight },
        documentWidth: document.documentElement.scrollWidth,
        bodyWidth: document.body.scrollWidth,
        overflowX: document.documentElement.scrollWidth > innerWidth + 1 || document.body.scrollWidth > innerWidth + 1,
        toolbar: toolbar ? {
          width: toolbar.clientWidth,
          scrollWidth: toolbar.scrollWidth,
          height: Math.round(toolbar.getBoundingClientRect().height),
        } : null,
        mainWidth: main ? Math.round(main.getBoundingClientRect().width) : 0,
        sidebarVisible: !!document.querySelector('#sidebar') && visible(document.querySelector('#sidebar')),
        detailHeight: Math.round((document.querySelector('#detail, #em-detail')?.getBoundingClientRect().height) || 0),
        hiddenGridColumns: ['.c-th', '.c-lg'].filter((selector) => {
          const el = document.querySelector(selector);
          return el && getComputedStyle(el).display === 'none';
        }),
        smallButtons: buttons.filter(({ width, height }) => width < 24 || height < 24),
      };
    })()`
  );
}

async function contrastAudit(cdp) {
  return cdpValue(
    cdp,
    `(() => {
      const parse = (value) => (value.match(/[\\d.]+/g) || []).slice(0, 3).map(Number);
      const lum = (rgb) => {
        const v = rgb.map((x) => { x /= 255; return x <= .04045 ? x / 12.92 : ((x + .055) / 1.055) ** 2.4; });
        return .2126 * v[0] + .7152 * v[1] + .0722 * v[2];
      };
      const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + .05) / (Math.min(x, y) + .05); };
      const background = (el) => {
        for (let n = el; n; n = n.parentElement) {
          const color = getComputedStyle(n).backgroundColor;
          if (color && !/rgba?\\(0, 0, 0(?:, 0)?\\)/.test(color) && color !== 'transparent') return parse(color);
        }
        return [255, 255, 255];
      };
      const selectors = ['.lg-row.lv-0:not(.lg-sel)', '.lg-row.lv-1:not(.lg-sel)', '.lg-row.lv-2:not(.lg-sel)', '.lg-row.lv-3:not(.lg-sel)', '.lg-row.lv-4:not(.lg-sel)', '#statusbar', '.detail-empty', '.embed-status'];
      return selectors.flatMap((selector) => {
        const el = document.querySelector(selector);
        if (!el) return [];
        const foreground = parse(getComputedStyle(el).color);
        const value = ratio(foreground, background(el));
        return [{ selector, foreground, background: background(el), ratio: Math.round(value * 100) / 100 }];
      });
    })()`
  );
}

function auditTelemetry(scenario, telemetry) {
  check(scenario, 'no JavaScript exceptions', telemetry.exceptions.length === 0, telemetry.exceptions.slice(0, 2).join(' | '));
  check(scenario, 'no console errors', telemetry.consoleErrors.length === 0, telemetry.consoleErrors.slice(0, 2).join(' | '));
  check(scenario, 'no failed network requests', telemetry.failedRequests.length === 0, telemetry.failedRequests.slice(0, 2).join(' | '));
  check(scenario, 'no HTTP error responses', telemetry.badResponses.length === 0, telemetry.badResponses.slice(0, 2).join(' | '));
}

async function auditDesktop(browser) {
  const scenario = 'standalone-desktop';
  const { page, cdp, telemetry } = await createAuditedPage(browser, { width: 1440, height: 900 });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lg-row', { timeout: 10_000 });
  const rowCount = await page.$$eval('.lg-row', (rows) => rows.length);
  check(scenario, 'virtual grid renders a bounded visible window', rowCount > 10 && rowCount < 80, `${rowCount} DOM rows`);

  await page.click('.lg-row[data-vi="3"]');
  await page.waitForFunction(() => (document.querySelector('#detail')?.textContent || '').trim().length > 20);
  check(scenario, 'row selection renders detail', true);
  await page.focus('.lg-root');
  await page.keyboard.press('ArrowDown');
  const selected = await page.$eval('.lg-row.lg-sel', (row) => Number(row.dataset.vi));
  check(scenario, 'grid keyboard navigation advances selection', selected === 4, `selected row ${selected}`);

  const redundantRenders = await page.evaluate(async () => {
    const viewport = document.querySelector('.lg-viewport');
    const rows = document.querySelector('.lg-rows');
    let mutations = 0;
    const observer = new MutationObserver((records) => (mutations += records.length));
    observer.observe(rows, { childList: true });
    const base = viewport.scrollTop;
    for (let i = 0; i < 80; i++) {
      viewport.scrollTop = base + (i % 8);
      viewport.dispatchEvent(new Event('scroll'));
    }
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    observer.disconnect();
    return mutations;
  });
  check(scenario, 'same-row scroll events avoid redundant DOM rebuilds', redundantRenders <= 2, `${redundantRenders} child-list mutations`);

  await page.click('#tb-open');
  await page.waitForSelector('.fm-item');
  const dialog = await page.$eval('#file-modal', (node) => ({ role: node.getAttribute('role'), modal: node.getAttribute('aria-modal') }));
  check(scenario, 'file browser exposes dialog semantics', dialog.role === 'dialog' && dialog.modal === 'true', JSON.stringify(dialog));
  const browserItems = await page.$$eval('.fm-item', (items) => items.map((item) => ({ tag: item.tagName, tabIndex: item.tabIndex })));
  check(scenario, 'file browser items are keyboard controls', browserItems.every((item) => item.tag === 'BUTTON' || item.tabIndex >= 0), JSON.stringify(browserItems.slice(0, 2)));
  await page.focus('#fm-cancel');
  await page.keyboard.press('Tab');
  check(scenario, 'file dialog traps keyboard focus', await page.$eval('#fm-up', (node) => document.activeElement === node));
  const fileDialogShot = await screenshot(cdp, 'standalone-file-dialog.png');
  await page.keyboard.press('Escape');
  const modalHidden = await page.$eval('#modal-backdrop', (node) => node.hidden);
  check(scenario, 'Escape closes the file browser', modalHidden);
  if (!modalHidden) await page.click('#fm-cancel');

  await page.keyboard.press('Tab');
  const focus = await page.evaluate(() => {
    const el = document.activeElement;
    const style = getComputedStyle(el);
    return { tag: el?.tagName, id: el?.id, outline: `${style.outlineStyle} ${style.outlineWidth}` };
  });
  check(scenario, 'keyboard focus is visible', focus.tag !== 'BODY' && !/^none 0px$/.test(focus.outline), JSON.stringify(focus));

  const protocol = await collectProtocolSnapshot(cdp);
  const contrast = await contrastAudit(cdp);
  check(scenario, 'accessibility tree has named controls', protocol.accessibility.unnamedControls.length === 0, JSON.stringify(protocol.accessibility.unnamedControls));
  check(scenario, 'log viewport exposes grid semantics', await page.$eval('.lg-root', (node) => node.getAttribute('role') === 'grid'));
  check(scenario, 'small text meets WCAG AA contrast', contrast.every((item) => item.ratio >= 4.5), contrast.map((item) => `${item.selector}=${item.ratio}`).join(', '));

  await page.click('#menu-filter');
  check(scenario, 'application Filter action focuses filter input', await page.$eval('#tb-search', (node) => document.activeElement === node));
  for (const level of [0, 1, 2, 5]) await page.click(`#tb-lv-${level}`);
  await page.waitForFunction(() => (document.querySelector('#tree')?.textContent || '').includes('WARN, ERROR'));
  await page.type('#tb-search', 'price');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => (document.querySelector('#tree')?.textContent || '').includes("'price'"));
  const filterSummary = await page.$eval('#status-right', (node) => node.textContent || '');
  check(scenario, 'rapid level and text filters converge on latest criteria', /filtered/.test(filterSummary), filterSummary.trim());
  const filteredShot = await screenshot(cdp, 'standalone-filtered.png');

  await page.click('.lg-row[data-vi="0"]');
  await page.keyboard.down('Shift');
  await page.keyboard.press('F10');
  await page.keyboard.up('Shift');
  await page.waitForSelector('#ctxmenu');
  const contextMenu = await page.$eval('#ctxmenu', (node) => ({
    role: node.getAttribute('role'),
    items: node.querySelectorAll('[role="menuitem"]').length,
  }));
  check(scenario, 'entry actions expose keyboard menu semantics', contextMenu.role === 'menu' && contextMenu.items >= 4, JSON.stringify(contextMenu));
  await page.keyboard.press('ArrowDown');
  check(scenario, 'context menu supports arrow navigation', await page.$eval('#ctxmenu', (node) => node.contains(document.activeElement)));
  await page.keyboard.press('Escape');
  check(scenario, 'Escape closes entry actions', !(await page.$('#ctxmenu')));

  await page.click('#menu-report');
  await page.waitForSelector('#report-canvas', { timeout: 5_000 });
  const reportDialog = await page.$eval('#rules-modal', (node) => ({ role: node.getAttribute('role'), modal: node.getAttribute('aria-modal') }));
  check(scenario, 'report exposes modal dialog semantics', reportDialog.role === 'dialog' && reportDialog.modal === 'true', JSON.stringify(reportDialog));
  const reportShot = await screenshot(cdp, 'standalone-report.png');
  await page.keyboard.press('Escape');
  check(scenario, 'Escape closes the report', !(await page.$('#report-canvas')));
  await page.click('#menu-view');
  check(scenario, 'View action toggles entry detail', await page.$eval('#detail', (node) => getComputedStyle(node).display === 'none'));
  await page.click('#menu-view');
  await page.click('#menu-tools');
  await page.waitForSelector('#rules-modal');
  check(scenario, 'Tools action opens accessible highlight rules', await page.$eval('#rules-modal', (node) => node.getAttribute('role') === 'dialog'));
  await page.keyboard.press('Escape');
  check(scenario, 'Escape closes highlight rules', !(await page.$('#rules-modal')));
  await page.click('#tb-clear');
  await page.waitForFunction(() => !(document.querySelector('#status-right')?.textContent || '').includes('filtered'));
  await page.waitForFunction(() => !!document.querySelector('.lg-row[data-vi="3"]:not(.lg-loading)'));
  await page.$eval('.lg-row[data-vi="3"]', (row) => row.click());
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const shot = await screenshot(cdp, 'standalone-desktop.png');

  scenarios[scenario] = {
    rowCount,
    redundantRenders,
    dialog,
    focus,
    filterSummary,
    reportDialog,
    protocol,
    contrast,
    screenshots: { desktop: shot, fileDialog: fileDialogShot, filtered: filteredShot, report: reportShot },
  };
  auditTelemetry(scenario, telemetry);
  await page.close();
}

async function auditMobileStandalone(browser) {
  const scenario = 'standalone-mobile';
  const { page, cdp, telemetry } = await createAuditedPage(browser, { width: 390, height: 844, isMobile: true, hasTouch: true });
  await page.goto(BASE + '/', { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lg-row', { timeout: 10_000 });
  const layout = await layoutAudit(cdp);
  check(scenario, 'page has no horizontal document overflow', !layout.overflowX, `${layout.documentWidth}px / ${layout.viewport.width}px`);
  check(scenario, 'log grid retains useful width', layout.mainWidth >= 350, `${layout.mainWidth}px`);
  check(scenario, 'toolbar stays to one compact row', layout.toolbar.height <= 42, `${layout.toolbar.height}px`);
  check(scenario, 'secondary sidebar yields to logs', !layout.sidebarVisible);
  check(scenario, 'low-priority grid columns collapse', layout.hiddenGridColumns.length === 2, layout.hiddenGridColumns.join(', '));
  check(scenario, 'visible controls meet 24px target size', layout.smallButtons.length === 0, JSON.stringify(layout.smallButtons.slice(0, 8)));
  await page.click('#tb-sidebar');
  const drawer = await page.$eval('#sidebar', (node) => ({ visible: getComputedStyle(node).display !== 'none', width: Math.round(node.getBoundingClientRect().width) }));
  check(scenario, 'sources remain available in a mobile drawer', drawer.visible && drawer.width >= 250, JSON.stringify(drawer));
  const drawerShot = await screenshot(cdp, 'standalone-mobile-drawer.png');
  await page.click('#tb-sidebar');
  const shot = await screenshot(cdp, 'standalone-mobile.png');
  scenarios[scenario] = { layout, drawer, protocol: await collectProtocolSnapshot(cdp), screenshots: { mobile: shot, drawer: drawerShot } };
  auditTelemetry(scenario, telemetry);
  await page.close();
}

async function waitForStatusCount(page, minimum, timeout = 10_000) {
  await page.waitForFunction(
    (min) => Number((document.querySelector('#em-status')?.textContent || '').replace(/\D/g, '')) >= min,
    { timeout },
    minimum
  );
  return page.$eval('#em-status', (node) => Number((node.textContent || '').replace(/\D/g, '')));
}

async function auditEmbeddedLoad(browser) {
  const scenario = 'embedded-load';
  const { page, cdp, telemetry } = await createAuditedPage(browser, { width: 900, height: 520 });
  await page.goto(`${BASE}/embed.html?channel=${CHANNEL}&follow=0&title=CDP%20load%20audit`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lg-row', { timeout: 10_000 });
  const total = await waitForStatusCount(page, LOAD_ENTRIES);
  let rows = await page.$$eval('.lg-row', (nodes) => nodes.length);
  check(scenario, 'large stream renders through a bounded DOM window', total === LOAD_ENTRIES && rows > 8 && rows < 80, `${total} records / ${rows} rows`);

  await page.click('#em-lv-3');
  await page.waitForFunction((all) => Number((document.querySelector('#em-status')?.textContent || '').replace(/\D/g, '')) !== all, {}, total);
  const afterToggle = await page.$eval('#em-status', (node) => Number((node.textContent || '').replace(/\D/g, '')));
  check(scenario, 'active level button hides that level consistently', afterToggle > total / 2 && afterToggle < total, `${total} -> ${afterToggle}`);
  await page.click('#em-lv-3');
  await waitForStatusCount(page, total);

  await cdp.send('HeapProfiler.collectGarbage');
  const heapBefore = await cdp.send('Runtime.getHeapUsage');
  const started = performance.now();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  for (let i = 0; i < 80; i++) {
    const fraction = (i % 2 ? 80 - i : i) / 80;
    await cdpValue(cdp, `(() => { const v = document.querySelector('.lg-viewport'); v.scrollTop = v.scrollHeight * ${fraction}; return v.scrollTop; })()`);
    await sleep(12);
  }
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  await sleep(150);
  const scrollMs = Math.round(performance.now() - started);
  rows = await page.$$eval('.lg-row', (nodes) => nodes.length);
  await cdp.send('HeapProfiler.collectGarbage');
  const heapAfter = await cdp.send('Runtime.getHeapUsage');
  const heapGrowth = heapAfter.usedSize - heapBefore.usedSize;
  check(scenario, 'rapid scrolling remains responsive under 4x CPU throttle', scrollMs < 4_000, `${scrollMs}ms`);
  check(scenario, 'virtual DOM stays bounded after deep scrolling', rows < 80, `${rows} rows`);
  check(scenario, 'deep scrolling has bounded retained heap', heapGrowth < 8 * 1024 * 1024, `${(heapGrowth / 1024 / 1024).toFixed(2)} MiB`);

  const pageFetches = telemetry.responses.filter((response) => /\/entries\?/.test(response.url));
  const maxWindow = Math.max(...pageFetches.map((response) => Number(new URL(response.url).searchParams.get('count')) || 0), 0);
  check(scenario, 'entry API remains windowed', pageFetches.length > 0 && maxWindow <= 200, `${pageFetches.length} requests, max ${maxWindow}`);

  await cdp.send('Network.emulateNetworkConditions', {
    offline: true,
    latency: 0,
    downloadThroughput: 0,
    uploadThroughput: 0,
    connectionType: 'none',
  });
  await sleep(500);
  const appended = 24;
  await request(`/api/v1/streams/${CHANNEL}/entries`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ entries: Array.from({ length: appended }, (_, i) => ({ level: 'INFO', message: `offline recovery ${i}` })) }),
  });
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 30,
    downloadThroughput: 256 * 1024,
    uploadThroughput: 128 * 1024,
    connectionType: 'wifi',
  });
  const recovered = await waitForStatusCount(page, total + appended, 12_000).catch(() => 0);
  check(scenario, 'WebSocket reconnect catches up missed entries', recovered >= total + appended, `${recovered} / ${total + appended}`);
  await cdp.send('Network.emulateNetworkConditions', {
    offline: false,
    latency: 0,
    downloadThroughput: -1,
    uploadThroughput: -1,
    connectionType: 'none',
  });

  const protocol = await collectProtocolSnapshot(cdp);
  const shot = await screenshot(cdp, 'embedded-load.png');
  scenarios[scenario] = { total, afterToggle, rows, scrollMs, heapBefore, heapAfter, heapGrowth, pageFetches: pageFetches.length, maxWindow, recovered, protocol, screenshot: shot };
  // The deliberately induced offline request is excluded from general network
  // failures; reconnect correctness is asserted explicitly above.
  telemetry.failedRequests = telemetry.failedRequests.filter((failure) => !/internet disconnected|ERR_INTERNET_DISCONNECTED/i.test(failure));
  auditTelemetry(scenario, telemetry);
  await page.close();
}

async function auditMobileEmbed(browser) {
  const scenario = 'embedded-mobile';
  const { page, cdp, telemetry } = await createAuditedPage(browser, { width: 390, height: 600, isMobile: true, hasTouch: true });
  await page.goto(`${BASE}/embed.html?channel=${CHANNEL}&follow=1&title=Production%20pod%20logs`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.lg-row', { timeout: 10_000 });
  const layout = await layoutAudit(cdp);
  check(scenario, 'widget has no horizontal document overflow', !layout.overflowX, `${layout.documentWidth}px / ${layout.viewport.width}px`);
  check(scenario, 'widget toolbar stays compact', layout.toolbar.height <= 42, `${layout.toolbar.height}px`);
  check(scenario, 'log grid uses full widget width', layout.mainWidth >= 380, `${layout.mainWidth}px`);
  check(scenario, 'low-priority grid columns collapse', layout.hiddenGridColumns.length === 2, layout.hiddenGridColumns.join(', '));
  check(scenario, 'visible controls meet 24px target size', layout.smallButtons.length === 0, JSON.stringify(layout.smallButtons.slice(0, 8)));
  const shot = await screenshot(cdp, 'embedded-mobile.png');
  scenarios[scenario] = { layout, protocol: await collectProtocolSnapshot(cdp), screenshot: shot };
  auditTelemetry(scenario, telemetry);
  await page.close();
}

let browser = null;
let browserVersion;
try {
  await seedData();
  browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--no-first-run', '--disable-background-networking', '--disable-default-apps',
      ...(typeof process.getuid === 'function' && process.getuid() === 0
        ? ['--no-sandbox', '--disable-setuid-sandbox'] : [])],
  });
  const browserCdp = await browser.target().createCDPSession();
  browserVersion = await browserCdp.send('Browser.getVersion');
  await auditDesktop(browser);
  await auditMobileStandalone(browser);
  await auditEmbeddedLoad(browser);
  await auditMobileEmbed(browser);
} finally {
  await browser?.close();
  await fetch(`${BASE}/api/v1/streams/${CHANNEL}`, { method: 'DELETE' }).catch(() => {});
}

const failures = checks.filter((result) => !result.ok);
const report = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  browser: browserVersion,
  loadEntries: LOAD_ENTRIES,
  summary: { checks: checks.length, passed: checks.length - failures.length, failed: failures.length },
  checks,
  scenarios,
};
await writeFile(path.join(ARTIFACT_DIR, 'report.json'), JSON.stringify(report, null, 2) + '\n');
const markdown = [
  '# log-viewer CDP audit',
  '',
  `- Browser: ${browserVersion.product}`,
  `- Checks: ${report.summary.passed}/${report.summary.checks} passed`,
  `- Load stream: ${LOAD_ENTRIES.toLocaleString()} entries`,
  '',
  '| Result | Scenario | Check | Detail |',
  '| --- | --- | --- | --- |',
  ...checks.map(({ ok, scenario, name, detail }) => `| ${ok ? 'PASS' : 'FAIL'} | ${scenario} | ${name} | ${detail.replace(/\|/g, '\\|')} |`),
  '',
].join('\n');
await writeFile(path.join(ARTIFACT_DIR, 'report.md'), markdown);
console.log(`\nArtifacts: ${ARTIFACT_DIR}`);
console.log(`Summary: ${report.summary.passed}/${report.summary.checks} checks passed`);
if (failures.length) process.exitCode = 1;
