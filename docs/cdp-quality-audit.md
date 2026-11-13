# Chrome DevTools Protocol quality audit

`e2e/cdp-audit.mjs` is the repeatable browser quality gate for both log-viewer
surfaces. It drives system Chrome through Puppeteer, but collects diagnostics
and screenshots through direct Chrome DevTools Protocol sessions.

## Run it

Build and start the production server in one terminal:

```bash
npm run build
PORT=15180 ENABLE_DEMO=true ENABLE_SAMPLES=true npm start
```

Run the audit in another terminal:

```bash
BASE=http://127.0.0.1:15180 \
ARTIFACT_DIR=/tmp/log-viewer-cdp-audit \
npm run test:cdp
```

`CHROME` can override the Chrome executable and `CDP_LOAD_ENTRIES` can change
the 30,000-entry load fixture. The report and PNG captures are written beneath
`ARTIFACT_DIR`; generated artifacts are intentionally not committed.

The container image workflow runs the same 30,000-entry gate before publishing
and uploads its report, screenshots, and server log as the `cdp-quality-audit`
workflow artifact.

## What it covers

- standalone desktop selection, keyboard navigation, file browser, filters,
  report dialog, focus management, visual contrast, and action-menu behavior;
- standalone and embedded layouts at 390 px, including document overflow,
  useful grid width, compact toolbars, collapsed low-priority columns, and
  minimum 24 px controls;
- a 30,000-entry embedded stream under rapid deep scrolling and 4x CPU
  throttling;
- bounded virtual DOM rows, 200-entry API windows, retained heap growth, and
  redundant-render detection;
- WebSocket offline/reconnect catch-up;
- runtime exceptions, error console entries, failed requests, and HTTP errors;
- `Accessibility.getFullAXTree`, `DOMSnapshot.captureSnapshot`,
  `Memory.getDOMCounters`, `Runtime.getHeapUsage`, and
  `Performance.getMetrics` snapshots;
- protocol-native captures of the desktop, file dialog, filtered view, report,
  mobile source drawer, high-volume embed, and both mobile layouts.

The load thresholds are deliberately broad enough for developer laptops while
still catching architectural regressions: fewer than 80 live row nodes, entry
requests no larger than 200 records, less than 8 MiB retained heap growth after
deep scrolling, and completion within four seconds under 4x CPU throttling.

## 2026-07-13 baseline and remediation

The first audit passed 30 of 44 checks. Virtualization and reconnect behavior
were already strong: a 30,000-entry stream used 20 row nodes, retained only
0.74 MiB after deep scrolling, fetched at most 200 entries per request, and
caught up after an induced network outage.

The failing checks exposed narrow-screen collapse, 13–22 px embedded controls,
missing grid/dialog semantics, non-keyboard file rows, inconsistent embedded
level toggles, and low-contrast TRACE/DEBUG/WARN/status text. The remediation
also added animation-frame stream coalescing, same-range scroll render
deduplication, stale-filter response protection, reconnect backoff, focus
trapping, and explicit isolated page surfaces for reliable incremental paints.

The current post-change matrix passes all 57 quality gates. Keep this audit
alongside the smaller `npm run test:e2e` interaction smoke test; they catch
different classes of regression.
