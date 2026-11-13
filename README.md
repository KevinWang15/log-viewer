<p align="center"><img src="docs/logo.png" width="160" alt="log-viewer logo"></p>

# log-viewer

log-viewer provides quick and clear log analysis in the browser. The Node.js backend does all the heavy lifting (indexing, parsing, filtering, tailing), so multi-GB log files stay fast — the browser only ever holds the rows on screen.

## Features

- **Parsing** — format auto-detection (log4j-style layouts, JSON lines, plain text); multiline entries (stack traces, XML/JSON payloads) grouped with their parent entry
- **Filtering** — chainable criteria: levels, text (substring/regex), thread, logger, before/after time, exclude; shown as an interactive filter tree
- **Merged logs** — merge any open logs into one time-ordered view; live appends flow through the merge
- **Tail your data** — file tailing with incremental indexing; filters and statistics update automatically; rotation/truncation handled
- **Open large log files** — "Open Part of File" chunk picker for files >128 MB; only numbers per entry are kept in memory, text stays on disk
- **Find** — F3 / Shift+F3 server-side search through the current view, independent of filters
- **Bookmarks** — Ctrl+B, gutter flags, next/previous navigation, shown in the minimap
- **Custom rules** — highlight rules (text/level match → foreground/background/bold), persisted locally
- **Easy navigation** — minimap strip with warnings/errors/bookmarks, keyboard navigation, one-click scrolling
- **Syntax highlighting** — XML and JSON highlighting + pretty-printing in the detail pane
- **Share your analysis** — save/load analysis files (open logs + filters + bookmarks + rules); export the current view as plain text
- **Statistics** — All vs. View counts per level, thread/logger/bookmark totals

## Two ways to use it

**1. Local log browsing** — the full desktop-style app: open files from disk, auto-detected parsing, chained filters, tail/follow, statistics, minimap navigation, syntax-highlighted detail pane.

**2. Embedded in a site** — a compact widget that renders a live log stream pushed to the server by any producer, either as an iframe:

```html
<iframe src="http://localhost:5178/embed.html?channel=myapp"
        style="width:100%;height:400px;border:1px solid #ccc"></iframe>
```

or iframe-free as a `<log-viewer>` custom element (self-contained script from the build, shadow-DOM styles — see [Embedding](docs/embedding.md#web-component-iframe-free)).

Producers create a stream and push lines via the v1 REST lifecycle:

```bash
curl -X PUT http://localhost:5178/api/v1/streams/myapp \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY"
curl -X POST http://localhost:5178/api/v1/streams/myapp/entries \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d '{"lines":["2026-07-13 10:00:00,000 [Main] INFO App - hello world"]}'
```

or over WebSocket (`/ws`): `{"type":"publish","channel":"myapp","lines":[...]}`.
Structured entries also work: `{"entries":[{"level":"WARN","logger":"Auth","message":"…"}]}`.

A `demo` channel emits fake log traffic continuously: `embed.html?channel=demo`.

## Quick start

```bash
npm install
npm run dev        # backend on :5178, Vite dev server on :5173
```

Open http://localhost:5173. Sample log files are generated into `server/sample-logs/` on first boot (use the **Samples** button in the open-file dialog).

Production:

```bash
npm run build
npm start          # serves API + built frontend on :5178
```

## Architecture

```
server/   Express + ws (TypeScript)
  parser.ts    log format auto-detection (log4j-style, JSON lines, …)
  sources.ts   FileLogSource: byte-offset index per entry, on-demand reads,
               tail via file watching. StreamSource: in-memory live channels.
  store.ts     filter registry; incremental filter updates on append
  index.ts     REST API + WebSocket notifications

web/      Vite + TypeScript (no framework)
  main.ts      full app UI (tree, toolbar, stats, minimap, detail pane)
  grid.ts      virtualized grid — fetches 200-row pages from the backend
  widget.ts    shared embeddable widget (toolbar + grid + detail)
  embed.ts     iframe embed (embed.html): URL params + postMessage bridge
  component.ts <log-viewer> custom element (component.html dev harness)
```

### How large files stay fast

- Indexing streams the file once and stores only numbers per entry: byte offset, timestamp, level, and interned thread/logger ids. A 4 GB file with 10M entries costs ~300 MB of index, not 4 GB.
- Entry text is read from disk on demand, in 200-row pages, as you scroll.
- Multiline entries (stack traces, XML payloads) are grouped with their parent entry by the format's timestamp anchor.
- Level/thread/time filters evaluate against the in-memory index; text filters stream the file in 4 MB blocks.
- Tail: appended bytes are indexed incrementally; open filters are updated with just the new entries and clients are notified over WebSocket.

## API sketch

| Endpoint | Purpose |
|---|---|
| `GET /api/browse?path=` / `GET /api/stat?path=` | server-side file browser (rooted at `LOG_ROOT`, default home dir) |
| `POST /api/logs/open {path, start?, end?}` | open + index a file (optionally a byte-range chunk) |
| `POST /api/logs/merge {ids}` | merge open sources into a time-ordered view |
| `POST /api/logs/:id/filters {criteria}` | create filter → `{filterId, count, stats}` |
| `GET /api/logs/:id/entries?start&count&filter` | windowed entry fetch |
| `GET /api/logs/:id/search?q&from&dir&filter` | find next/previous match |
| `GET/PUT /api/logs/:id/bookmarks` | list / toggle bookmarks; `/bookmarks/next` navigates |
| `GET /api/logs/:id/minimap?buckets` | severity + bookmark buckets for the navigation strip |
| `GET /api/logs/:id/export?filter` | download the current view as plain text |
| `GET /api/v1/capabilities` | protocol discovery and active limits |
| `PUT/GET/DELETE /api/v1/streams/:channel` | explicit live-stream lifecycle |
| `POST /api/v1/streams/:channel/entries` | append lines or structured entries |
| `WS /ws` | `{type:'sub',id}` → append/reset notifications; `{type:'publish',channel,lines}` to ingest |
| `GET /healthz` | liveness probe |

Env vars: `PORT` (default 5178), `LOG_ROOT` (default `$HOME`), `STREAM_KEY`,
`CORS_ORIGIN`, `STREAM_MAX_ENTRIES` (100,000), `STREAM_MAX_BYTES` (32 MiB),
`STREAM_MAX_SOURCES` (16), `STREAM_IDLE_TTL_SECONDS` (3,600), and
`STREAM_MAX_PAYLOAD_BYTES` (2 MiB). `ENABLE_DEMO=false` and
`ENABLE_SAMPLES=false` disable development data.

Directory monitor: set `WATCH_GLOBS` to a comma-separated glob list (e.g.
`WATCH_GLOBS="**/*.log,**/*.log.gz"`) and new files under `LOG_ROOT` matching
any glob are opened automatically — gzipped rotations included. Globs match
the root-relative path: `*`/`?` stay within a path segment, `**` crosses
segments. The scan interval is `WATCH_INTERVAL_MS` (default 5000). Auto-opened
sources report `origin: "watch"` in their source info; opening stops (with a
one-time warning) when `STREAM_MAX_SOURCES` is reached. Unset `WATCH_GLOBS`
disables the monitor entirely.

See [Stream API v1](docs/api-v1.md) ([openapi.yaml](docs/openapi.yaml),
[producer snippets](docs/snippets/)), [Embedding](docs/embedding.md),
[Securing a Deployment](docs/security.md), and the
[Operations Guide](docs/operations.md) for the supported integration contract,
security boundary, and sizing guidance.

### Containerized dashboard integration

log-viewer can run as a private container while another application exposes
the embedded viewer through an authenticated reverse proxy. Publish the service
on loopback only and use the same secret in the producer application:

```bash
export LOG_VIEWER_SERVICE_KEY="$(openssl rand -hex 32)"
nerdctl pull ghcr.io/kevinwang15/log-viewer:latest
nerdctl run -d --name log-viewer --restart always \
  -p 127.0.0.1:5178:5178 \
  -e STREAM_KEY="$LOG_VIEWER_SERVICE_KEY" \
  -e STREAM_MAX_ENTRIES=100000 \
  -e STREAM_MAX_BYTES=33554432 \
  -e STREAM_MAX_SOURCES=16 \
  -e STREAM_IDLE_TTL_SECONDS=3600 \
  -e STREAM_MAX_PAYLOAD_BYTES=2097152 \
  -e ENABLE_DEMO=false \
  -e ENABLE_SAMPLES=false \
  ghcr.io/kevinwang15/log-viewer:latest
```

Or use the checked-in Compose definition:

```bash
export LOG_VIEWER_SERVICE_KEY="$(openssl rand -hex 32)"
printf 'LOG_VIEWER_SERVICE_KEY=%s\nLOG_VIEWER_IMAGE=ghcr.io/kevinwang15/log-viewer:latest\nLOG_VIEWER_PORT=5178\nLOG_VIEWER_MAX_ENTRIES=100000\n' \
  "$LOG_VIEWER_SERVICE_KEY" > .env.integration
nerdctl compose --env-file .env.integration -f compose.integration.yaml pull
nerdctl compose --env-file .env.integration -f compose.integration.yaml up -d
```

Pushes to `main` publish `latest`, `main`, short-commit, and full-commit tags to
`ghcr.io/kevinwang15/log-viewer`. If the package is private, authenticate the
host first with `nerdctl login ghcr.io` using a token with package read access.

The deploy-dashboard integration proxies `/log-viewer/*` to this local port and
feeds random, short-lived streams from authenticated `kubectl logs` sessions.
See [`docs/deploy-dashboard-integration.md`](docs/deploy-dashboard-integration.md)
for the architecture and implementation tracker.

## Development

```bash
npm test               # unit tests (parser, indexing, filtering, merge)
npm run test:e2e       # browser e2e (needs `npm start` running + Chrome; set CHROME=<path> to override)
npm run test:e2e:bridge     # iframe postMessage bridge e2e (self-contained)
npm run test:e2e:component  # <log-viewer> custom element e2e (self-contained)
npm run test:cdp       # CDP visual/a11y/load/performance audit; writes artifacts under /tmp
npm run bench          # server benchmark (BENCH_ENTRIES=2000000 for a ~200 MB file)
npm run bench:ui       # frontend benchmark: scroll/tail main-thread cost under 4x CPU throttle (needs Chrome)
nerdctl build -t log-viewer:local .
nerdctl run --rm -p 5178:5178 -v /var/log:/logs log-viewer:local
```

The full browser matrix and its thresholds are documented in the
[CDP Quality Audit](docs/cdp-quality-audit.md).
