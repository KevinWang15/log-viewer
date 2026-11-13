# Improvement Plan

Status: implemented — 2026-08-23 (27 of 28 items shipped; item 17 deferred with bench evidence)

This plan maps what the log-viewer codebase already does and proposes improvements ordered by
leverage. Two deliberate product boundaries shape every recommendation:

- **This is a web service, not a desktop application.** Anything that only makes sense on a
  desktop (PuTTY integration, mapped drives, ETW) is a non-goal.
- **Embedding into any web application is the core differentiator** (see `docs/embedding.md`).
  Improvements should strengthen the embed/integration story first, and the standalone viewer
  second.

## 1. Current state (verified against the codebase)

Architecture: npm-workspace monorepo. `server/` (Express + `ws`, TypeScript) does all parsing,
indexing, filtering, and tailing; `web/` (Vite, no framework) renders a virtualized grid fed by
REST + WebSocket. Production serves `web/dist` from the server (`server/src/index.ts:575`).

Already implemented:

- Local file sources rooted at `LOG_ROOT`, byte-offset index with on-demand disk reads,
  `fs.watchFile` tailing with truncation/rotation handling (`server/src/sources.ts`).
- Byte-range chunked open for very large files (>128 MB chunk picker in `web/src/main.ts`).
- Merged sources (time-ordered union), filter tree (levels/threads/loggers/text-regex/time
  range, include+exclude), bookmarks, server-side search, follow/tail over WS.
- Ingestion streams v1 (`PUT /api/v1/streams/:channel`, entries push, retention caps,
  `x-stream-key` auth) and WS `publish` — this is the "any web app" ingestion path.
- Report endpoint (time histogram + top loggers/threads), minimap, export, save/load analysis
  JSON, JSON/XML syntax highlighting in the detail pane.
- Embed widget (`web/embed.html` + `web/src/embed.ts`) designed for iframe + reverse-proxy
  embedding.
- Solid engineering baseline: unit tests, Puppeteer e2e, a 57-check CDP quality gate,
  multi-arch Docker image via GH Actions.

## 2. Capability review

Core capabilities and enhancement opportunities, mapped to implementation status:

| Capability | Status | Verdict |
|---|---|---|
| Parse / filter / tail / merge / bookmarks / large files | Done, server-backed | Core strength |
| Parser auto-detection (log4j-style, JSON lines) | Done (`server/src/parser.ts`) | Complete |
| Pattern parser + parser wizard (user-defined formats) | **Missing** — formats hardcoded | High value |
| Syslog parser | **Missing** | High value (ubiquitous in server/web world) |
| SFTP/FTP/SSH remote sources | **Missing** | Rethink: we ingest over HTTP/WS instead; pull-sources optional |
| SQL query engine + dashboards | Report endpoint only | Selective adoption |
| Rules (actions triggered by matching entries) | **Missing** | Fits web model well (webhooks/alerts) |
| Directory monitors (auto-open new files) | **Missing** | Cheap win on server |
| Gzip/zip archive support | **Missing** | Cheap win |
| Filter templates, session tracking, elapsed-time column, CSV/HTML export, clipboard import | Partially/missing | UX polish tier |
| ETW, Windows Event Log, SMTP notify, PuTTY | N/A | Non-goals (desktop-only) |

Also noted in `docs/deploy-dashboard-integration.md` follow-ups: single deployment-wide stream
key (no per-producer credentials), no disk-backed stream spooling, no cross-pod merged views.
And one security caveat: read endpoints are unauthenticated by design — fine behind a reverse
proxy, dangerous if port 5178 is published.

## 3. Improvement themes, in priority order

### Phase 1 — Harden the differentiator: embedding & integration

The embed path is why this project exists; it should be the most polished part.

1. **Per-channel stream keys / scoped tokens.** ✅ Implemented (`STREAM_TOKENS`
   token=prefix scoping for mutations, optional `VIEW_KEY` for reads, `viewKey` embed param).
   ~~Replace the single `STREAM_KEY` with per-channel~~
   or per-producer credentials (e.g. `POST /api/v1/keys` issuing tokens scoped to a channel
   prefix, stored hashed). Read access gets optional view-only tokens so embeds can be exposed
   without trusting the iframe with full API access. Files: `server/src/index.ts` auth
   middleware, `docs/embedding.md`.
2. **Web Component embed in addition to iframe.** ✅ Implemented (`web/src/component.ts`,
   shared widget in `web/src/widget.ts`, third Vite entry `component.html`) — `<log-viewer>`
   with `channel`/`server`/`title`/`follow`/`pattern`/`view-key` attributes and
   `log-viewer-ready`/`log-viewer-entry-selected`/`log-viewer-stats` DOM events. e2e:
   `npm run test:e2e:component`.
3. **postMessage bridge for the iframe.** ✅ Implemented (`web/src/embed.ts`) — commands
   `setFilter`/`setFollow`/`clear`, events `ready`/`entrySelected`/`stats`, gated by the
   `allowOrigin` embed param (fail closed without it). e2e: `npm run test:e2e:bridge` (13 checks).
4. **SDK snippets + OpenAPI spec.** ✅ Implemented — hand-written `docs/openapi.yaml`
   (v1 streams lifecycle + core read endpoints + auth schemes) and copy-paste producers in
   `docs/snippets/` (Node fetch, Python, curl, Winston transport).
5. **Auth posture docs.** ✅ Implemented (`docs/security.md`) — threat model, loopback/proxy/
   credential checklist, and what breaks when the port is published.

### Phase 2 — Parsing depth

6. **Syslog parser** ✅ Implemented — RFC 3164 + RFC 5424 candidates in
   `server/src/parser.ts` (host→logger, tag→thread, PRI→level, year inference), 8 new tests.
7. **User-defined pattern parser.** ✅ Implemented — `compilePattern()` (log4j-style
   `%d/%p/%t/%c/%m` specifiers) + `POST/DELETE /api/logs/:id/parser` with re-indexing for file
   and stream sources, 7 new tests.
8. **Parser override in embed URL** ✅ Implemented — `embed.html?channel=x&pattern=...`
   posts the log4j-style pattern to `/api/logs/:id/parser` after subscribing
   (400s surface in the widget status line); the standalone app honors the
   same `?pattern=` query. Documented in `docs/embedding.md`.
9. **Gzip support** ✅ Implemented — magic-byte detection, streaming decompress to temp file
   (4 GiB cap, `GZIP_MAX_BYTES`), no tailing, cleanup on close/shutdown, 5 new tests.
10. **Elapsed-time column** ✅ Implemented — `/entries` returns per-entry
    `elapsed` ms against the previous entry in the current view (filter-aware,
    computed from indexed times, no storage); grid column (`+1.2s`, `1m 3s`)
    on by default in the standalone app, off in the embed widget.

### Phase 3 — Live-analysis power

11. **Rules / triggers.** ✅ Implemented — `POST/GET/DELETE /api/logs/:id/rules` with
    criteria (same shape as filters) and actions `highlight` / `bookmark` / `webhook`
    (fire-and-forget POST, 5s timeout, on-append-only; creation scans without firing).
    Standalone grid renders `highlight` via the existing rule mechanism. 4 new tests.
12. **Session/correlation tracking.** ✅ Implemented — `GET /api/logs/:id/correlate?i=N[&key=]`
    extracts requestId/traceId/sessionId/etc. (`k=v`, `k: v`, JSON) and scans the whole source
    for matching entries; standalone context menu "Filter by correlation" applies the value as
    a text filter. Verified live.
13. **Richer reports.** ✅ Implemented — report gains per-level `series` (incrementally
    folded), `topMessages` templates (digits/hex/uuid/quoted normalized), and `format=csv`
    export; report modal renders a level-trend chart + top-messages table. Verified live.
14. **Directory monitor.** ✅ Implemented — `WATCH_GLOBS` / `WATCH_INTERVAL_MS` env,
    polling scanner (tiny glob matcher, no deps), auto-open incl. gzip, `origin: "watch"` in
    source info, source-cap aware. 7 new tests.

### Phase 4 — Scale & ops

15. **Disk-backed stream spooling.** ✅ Implemented — `SPOOL_DIR` env: NDJSON spool per
    channel with serialized async writes (ingestion never blocks), tmp+rename compaction at
    2× byte cap, recovery of the retained tail on boot, flush on graceful shutdown. 5 new
    tests in server/test/spool.test.ts; verified live across a real SIGTERM restart.
16. **Cross-pod / multi-instance merged view.** ✅ Implemented — `RemoteSource`
    mirrors a source on a peer instance over its HTTP entries API + WS broadcast
    (`POST /api/logs/remote`, `REMOTE_MAX_ENTRIES` cap, reconnect with backoff,
    view-key forwarding) and joins `MergedSource` like any local source. See
    docs/api-v1.md "Remote sources". 5 new tests in server/test/remote.test.ts.
17. **Search scale.** ⏸️ Deferred with evidence — after item 21's block-scan search, the
    bench does an end-of-file scan of 200k entries in ~130 ms; extrapolating, the 2M-entry cap
    bites at ~1.3 s worst case, which is acceptable. Revisit only if a real deployment hits it.
18. **HTTP-level API tests** ✅ Implemented — `server/test/api2.test.ts` covers filter
    lifecycle/criteria combos, bookmark navigation semantics, export, browse/stat root
    confinement; two real bugs found and fixed (invalid-regex filter POST 500→400,
    browse/stat missing path 500→404).

### Phase 5 — Performance (measure first, then fix the O(n) hot spots)

The frontend is already in decent shape (true virtualization, rAF-coalesced scroll, page LRU,
budgets enforced by `e2e/cdp-audit.mjs`). The hot spots are on the **server**. Two rules for
this phase: every optimization ships with a benchmark proving it, and no caching layer without
an invalidation story.

**19. Build a server-side benchmark harness first.** ✅ `server/test/perf.bench.mjs` +
`npm run bench` (200k-entry synthetic log: indexing, filter scan, minimap cold/warm, append
costs). CI regression gate still open.

**20. Cache report/minimap results** ✅ Implemented in `server/src/store.ts`
(`minimapFor`/`reportFor`, epoch+count+bookmark-version keyed; report folds appends
incrementally, minimap invalidation-caches). Measured: warm minimap 0.84 ms → 0.01 ms.

**21. Coalesce entry reads.** ✅ Implemented — `getEntries` reads consecutive index runs with
one block read per run; unfiltered `/search` uses `scanTexts` block reads with early stop.
Measured (200k entries): entries page 18 ms → 9 ms; end-of-file search **7037 ms → 117 ms**.

**22. Shrink the index with typed arrays.** ✅ Implemented — the `FileLogSource` index is
`Float64Array` (offsets/times) + `Int32Array` (levels/thread/logger) with amortized doubling,
an explicit entry counter (`count`; buffer `.length` is capacity), and a post-reset shrink
that releases spare capacity after truncate-rotate (`sources.ts`). `MergedSource` and
`StreamSource` stay on plain arrays: the former rebuilds via length assignment from a scratch
list, the latter stores entry objects with head-based eviction. Measured (200k entries):
index heap 53.0 → 38.2 B/entry (new `index heap` bench line, `--expose-gc` + `arrayBuffers`).

**23. Indexing micro-costs.** ✅ Partially implemented — `isStart` + `parse` merged into a
single regex exec per line via `LogFormat.match`/`matchLine` (`parser.ts`), used by file
indexing and stream appends. Measured (interleaved A/B, 9 rounds): indexing median
633 ms → 588 ms (~7%). The continuation-`toString` skip was *not* done: classifying a line as
start vs continuation requires the decoded string (`isStart` runs on every line), and entry
text is re-derived from disk on fetch, so there is no safe byte-level shortcut that survives
custom patterns.

**24. Fix the 2000-entry append cliff.** ✅ Implemented — filters always evaluate only the
appended range (`store.ts` `handleAppend` + ranged `evalCriteria`/`scanTexts`); text filters
block-read only appended bytes. Measured: append 5k with text filter 114 ms → 23 ms.

**25. Frontend render micro-costs.** ✅ Implemented — rule matching caches `raw.toLowerCase()`
per entry object in a `WeakMap` (`web/src/grid.ts`), `fmtTime`/`fmtFullTime` reuse a shared
scratch `Date` via `setTime` (`web/src/util.ts`), and the detail pane skips re-highlighting
when the same entry object is re-selected (`web/src/detail.ts`, arrow-key hold repeats).

**26. WS backpressure.** ✅ Implemented — `WsBroadcaster` (`server/src/broadcast.ts`):
drops frames for clients above 1 MB `bufferedAmount`, sends a single `reset` snapshot once
drained below 256 KB; 5 new tests.

**27. Stream retention housekeeping.** ✅ Implemented — incremental byte/tracking accounting
in `StreamSource` (no O(n) `rebuildTracking` on eviction, no re-measuring `raw` on
continuation appends). Retention-heavy ingest micro-bench: 1266 ms → 871 ms.

**28. `MergedSource` churn.** ✅ Implemented — cached thread/logger lists, scratch-array
rebuild, in-order append fast path. 200k `threadList` calls: 276 ms → 3.9 ms.

Perf work is sequenced by measurement: items 19–21 are the milestone, the rest land as the
benchmarks prove them out. Items 24 and 26 are correctness-adjacent (unbounded work / memory)
and should not wait for benchmarks.

### Non-goals (deliberate)

- Windows/desktop-only sources: ETW, Event Log, mapped drives, PuTTY/SSH session launching.
- A general SQL engine: high complexity, low fit; targeted reports + export cover the need.
- Standalone .exe packaging: explicitly out of the product's scope.

## 4. Suggested sequencing

All milestones below are **done** (28 items: 27 implemented, item 17 deferred with bench
evidence). Table kept for reference.

| Milestone | Items | Status |
|---|---|---|
| M1: Embed hardening | 1, 3, 5 | ✅ |
| M2: Format coverage | 6, 7, 8, 9, 10 | ✅ |
| M3: Performance | 19, 20, 21, 24, 26 | ✅ |
| M4: Live analysis | 11, 12, 13, 14 | ✅ |
| M5: Integration UX | 2, 4, 5 | ✅ |
| M6: Scale | 15, 16, 18, 22, 23, 25, 27, 28 ✅; 17 ⏸️ deferred | ✅ |

Each milestone was independently shippable and landed as its own commit series with tests
(85 unit/integration tests, 57 CDP audit checks, 16 bridge + 7 component e2e checks) and
live-stack verification.
