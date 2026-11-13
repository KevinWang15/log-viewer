# Development

The repository is an npm workspace with two packages:

- `server/` is the published package `@kevinwang15/log-viewer`: Express and
  `ws` in TypeScript. It does all parsing, indexing, filtering and tailing.
- `web/` is the browser UI: Vite and TypeScript, no framework. It renders a
  virtualized grid fed by the HTTP API and the WebSocket.

Node.js 20 or newer is required; the examples and CI use Node 22.

## Layout

### `server/src`

| File | Role |
|---|---|
| `index.ts` | CLI entry (`log-viewer` bin): reads env vars through `config.ts`, calls `createLogViewer`, listens, handles `SIGTERM`/`SIGINT`. |
| `lib.ts` | Public exports of the package. |
| `viewer.ts` | `createLogViewer()`: builds the Express sub-app, the auth glue, the WebSocket hub, capabilities, `/healthz` and static UI, and enables the modules. |
| `module.ts` | `ModuleContext` and `ViewerModule`, the contract between the viewer and its feature modules. |
| `modules/core.ts` | Source list and info, parser, filters, rules, entries, bookmarks, locate, search, correlate, export, report, minimap. |
| `modules/files.ts` | Browse, stat, open (byte ranges, gzip), samples, directory watch. |
| `modules/streams.ts` | v1 stream lifecycle, legacy stream routes, WebSocket `publish`, spool recovery, idle expiry, demo channel. |
| `modules/merge.ts` | Merged views. |
| `modules/remote.ts` | Mirrors of sources on peer instances. |
| `modules/providers.ts` | Provider registry, catalogs, mirror open, capacity. |
| `provider/spi.ts` | Provider SPI types (`LogProvider`, `LogHandle`, `ProviderError`, `defineProvider`). Exported as `@kevinwang15/log-viewer/provider`. |
| `provider/source.ts` | `ProviderSource`: the bounded live mirror of a provider log (tail, list, watch or poll, backoff). |
| `provider/memory.ts` | `MemoryProvider`, an in-memory provider for tests and demos. |
| `provider/conformance.ts` | `checkProvider()` conformance checks. Exported as `@kevinwang15/log-viewer/testing`. |
| `source-api.ts` | The `LogSource` interface and entry, criteria and append-event types. |
| `sources.ts` | `BaseSource` and the built-in sources: `FileLogSource`, `MergedSource`, `StreamSource`, `RemoteSource`; gzip handling. |
| `entry-buffer.ts` | `EntryBuffer`, the in-memory entry index shared by streams, remote and provider mirrors (stats, thread/logger tracking, retention). |
| `store.ts` | Open sources, filters, rules and webhooks, bookmarks, locate, report and minimap caches, append/reset fan-out. |
| `streams.ts` | `StreamRegistry`: stream creation, source cap, spool attachment, idle expiry. |
| `ws-hub.ts` | WebSocket server: path routing on `upgrade`, `sub`/`unsub`, snapshots, module message handlers. |
| `broadcast.ts` | Backpressure for WebSocket broadcasts (drop, then one reset after drain). |
| `auth.ts` | Authorization actions, `keyAuthorizer()` (the built-in key scheme), default denials. |
| `config.ts` | `DEFAULTS`, `ENV_VARS` and `configFromEnv()`. |
| `options.ts` | Option and API types of the modules. |
| `parser.ts` | Format detection (log4j-style layouts, JSON lines, syslog), timestamp and level parsing, `compilePattern()`. |
| `spool.ts` | `StreamSpooler`: NDJSON spool files, compaction, recovery. |
| `watch.ts` | Directory watch: polling scanner and glob matcher. |
| `sample.ts`, `demo.ts` | Sample log files and the `demo` stream. |

### `web/src`

| File | Role |
|---|---|
| `main.ts` | The standalone app: sources tree, open dialog (files, samples, provider catalog), filters, toolbar, statistics, minimap, report, analysis files. |
| `grid.ts` | `LogGrid`: virtualized grid that fetches 200-entry pages with a 20-page LRU cache, follow mode, anchors. |
| `widget.ts` | The shared embeddable widget used by `embed.ts` and `component.ts`. |
| `embed.ts` | `embed.html`: query parameters and the postMessage bridge. |
| `component.ts` | The `<log-viewer>` custom element (shadow DOM). |
| `api.ts` | HTTP client and the reconnecting WebSocket client; base path and view key. |
| `detail.ts` | Detail pane with JSON and XML highlighting. |
| `splitter.ts` | Resizable panes. |
| `icons.ts` | Icons (lucide) and the logo mark. |
| `types.ts`, `util.ts` | Shared types, level names and colors, formatting helpers. |
| `styles.css` | All styles; the component inlines them into its shadow root. |

The Vite build has three entry pages: `index.html`, `embed.html` and
`component.html`. It uses relative asset URLs (`base: './'`), so one build
works at `/` and under a prefix.

Other directories: `e2e/` holds browser tests and benchmarks, `examples/`
the [SQLite provider](../examples/sqlite-provider/) and
[minimal embed](../examples/minimal-embed/) examples, `scripts/` the pack
check.

## Dev server

```bash
npm install
npm run dev
```

`npm run dev` runs the server with `tsx watch` on port 5178 and the Vite dev
server on port 5173. Vite proxies `/api` and `/ws` to the server. Open
http://localhost:5173. Sample logs are generated into `server/sample-logs/`
on first start, and the `demo` stream runs.

Production build:

```bash
npm run build   # web/dist and server/dist
npm start       # API and built UI on :5178
```

Environment variables work the same in both; see
[configuration.md](configuration.md).

## Tests

```bash
npm test
```

This runs the server tests (`server/test/*.test.ts`) with `tsx --test`. They
cover the parser, file indexing and tailing, streams, filters and views, the
store, WebSocket backpressure, spooling, remote mirrors, provider mirrors, the
`createLogViewer` factory (including the route inventory in
`server/test/fixtures/routes.json` and prefix mounting), and the HTTP API.
`docs.test.ts` checks that every env var in `ENV_VARS` appears in
[configuration.md](configuration.md) and every route appears in
[openapi.yaml](openapi.yaml). `sqlite-example.test.ts` is skipped on Node
versions without `node:sqlite` (before 22.13).

### Browser tests

The browser tests drive system Chrome through `puppeteer-core`. Set `CHROME`
to the Chrome executable; the default is the macOS application path. Each
script builds first.

| Script | What it does | Needs a running server |
|---|---|---|
| `npm run test:e2e` | Smoke test of the standalone app; screenshots go to `/tmp`. Opens `server/sample-logs/app.log`. | yes, at `BASE` (default `http://localhost:5178`) with samples on |
| `npm run test:e2e:bridge` | iframe postMessage bridge, with and without `allowOrigin`. | no, spawns one |
| `npm run test:e2e:component` | `<log-viewer>` element. | no, spawns one |
| `npm run test:e2e:prefix` | The full UI mounted under `/logs/` in `examples/minimal-embed`: assets, API, WebSocket, the host's session check, the provider catalog. | no, spawns the example |

```bash
CHROME="$(command -v google-chrome)" npm run test:e2e:prefix
```

### CDP quality audit

`e2e/cdp-audit.mjs` is the browser quality gate for both the standalone app
and the embed. It drives Chrome through Puppeteer and collects diagnostics
and screenshots through direct Chrome DevTools Protocol sessions.

```bash
npm run build
PORT=15180 ENABLE_DEMO=true ENABLE_SAMPLES=true npm start
# in another terminal
BASE=http://127.0.0.1:15180 ARTIFACT_DIR=/tmp/log-viewer-cdp-audit npm run test:cdp
```

| Variable | Default | Meaning |
|---|---|---|
| `BASE` | `http://localhost:5178` | server to audit |
| `ARTIFACT_DIR` | `/tmp/log-viewer-cdp-audit` | report and PNG captures |
| `CHROME` | macOS Chrome path | Chrome executable |
| `CDP_LOAD_ENTRIES` | 30000 | size of the load fixture |

It covers:

- standalone desktop selection, keyboard navigation, file browser, filters,
  report dialog, focus management, contrast and action menus;
- standalone and embedded layouts at 390 px: document overflow, usable grid
  width, compact toolbars, collapsed low-priority columns, controls of at
  least 24 px;
- a 30,000-entry embedded stream under rapid deep scrolling with 4x CPU
  throttling;
- bounded virtual DOM rows, 200-entry API windows, retained heap growth and
  redundant renders;
- WebSocket offline and reconnect catch-up;
- runtime exceptions, console errors, failed requests and HTTP errors;
- accessibility tree, DOM snapshot, DOM counter, heap and performance metric
  snapshots, and captures of the main screens and both mobile layouts.

The load thresholds are loose enough for developer laptops but catch
architectural regressions: fewer than 80 live row nodes, entry requests of
at most 200 records, less than 8 MiB retained heap growth after deep
scrolling, and completion within 4 s under 4x CPU throttling. Generated
artifacts are not committed. The audit and the smaller `test:e2e` smoke test
catch different regressions, so run both before UI changes land.

## Benchmarks

```bash
npm run bench
BENCH_ENTRIES=2000000 npm run bench   # about a 200 MB file
npm run bench -- --check              # fail on budget overruns (CI)
```

`npm run bench` builds the server and runs `server/test/perf.bench.mjs` with
`--expose-gc`. It writes a synthetic log (200,000 entries by default, about
10% multi-line) to a temp directory and measures indexing throughput, index
heap per entry, filter creation, minimap and report (cold and warm), entry
page and search latency over HTTP, and incremental append with a text filter.

`--check` compares the results with loose budgets, about 3 to 5 times the
numbers on a development machine, so only real regressions fail:

| Metric | Budget |
|---|---|
| `indexMs` | 5000 ms |
| `indexHeapPerEntry` | 120 bytes |
| `filterTextMs` | 1000 ms |
| `minimapWarmMs` | 5 ms |
| `reportWarmMs` | 20 ms |
| `pageWarmMs` | 100 ms |
| `searchMs` | 2000 ms |
| `appendMs` | 500 ms |

```bash
CHROME="$(command -v google-chrome)" npm run bench:ui
```

`npm run bench:ui` builds everything and runs `e2e/ui-perf.bench.mjs`. It
spawns the server with a synthetic log (`BENCH_ENTRIES`, default 200,000)
and measures, in headless Chrome under CPU throttling (`BENCH_CPU_THROTTLE`,
default 4): main-thread time per frame while scrolling smoothly, frames that
showed placeholder rows, time to fill the screen after a scrollbar jump, and
main-thread time per second while a stream appends. It is not part of CI.

## Packaging

The package is built from `server/`:

- `dist/` holds the compiled server (`dist/lib.js` is the library,
  `dist/index.js` the `log-viewer` CLI).
- Exports: `@kevinwang15/log-viewer`, `@kevinwang15/log-viewer/provider`
  and `@kevinwang15/log-viewer/testing`.
- `ui/` holds the bundled web UI. `createLogViewer` serves it by default.

`npm pack` and `npm publish` run the `prepack` script
(`server/scripts/prepack.mjs`). It builds the web UI and the server, copies
`web/dist` to `server/ui/`, and writes `server/README.md` (the root README
with relative links made absolute) and `server/LICENSE`. These generated
files and every `dist/` directory are ignored by git; build output is not
committed.

```bash
npm run pack:check
```

`scripts/pack-check.mjs` packs the server workspace into a temp directory
and checks the tarball: name, required files (`dist/`, `ui/index.html`,
`ui/embed.html`, UI assets, README, LICENSE), no tests or fixtures, size
under 2 MB, absolute README links. It then installs the tarball into a fresh
project and checks CommonJS `require`, ESM `import` with `listen`, the
bundled UI and a provider open, compiles a TypeScript consumer against the
published types, and starts the CLI.

## Releasing

1. Bump `version` in `server/package.json`.
2. Move the `unreleased` entries in [CHANGELOG.md](../CHANGELOG.md) under
   the new version and date.
3. Run `npm test` and `npm run pack:check`.
4. Publish from the server workspace:

   ```bash
   cd server
   npm publish --access public
   ```

5. Tag the release and push the tag:

   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```

## CI

`.github/workflows/build-docker-image.yml` runs on pushes to `main` and on
manual dispatch. It runs, in order:

1. `npm ci` and `npm test`;
2. `npm run bench -- --check`;
3. `npm run build` and `npm run pack:check`;
4. `npm run test:e2e:prefix` with the runner's Chrome;
5. the CDP audit against a server on port 15180, uploading the report,
   screenshots and server log as the `cdp-quality-audit` artifact (kept 14
   days);
6. a multi-arch (`linux/amd64`, `linux/arm64`) build of the `production`
   Dockerfile target, pushed to `ghcr.io/kevinwang15/log-viewer` with
   short-SHA, full-SHA, branch and `latest` tags.
