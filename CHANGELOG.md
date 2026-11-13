# Changelog

## 0.2.0 (unreleased)

### Added

- Provider SPI: plug your own log storage (a database, a log service) into
  the viewer by implementing `listLogs()` and `list()`, with optional
  `tail()` and `watch()`. Opened logs become bounded live mirrors that every
  feature works on. Includes `defineProvider`, `MemoryProvider` and
  `checkProvider()` conformance checks (`@kevinwang15/log-viewer/testing`).
  See [docs/providers.md](docs/providers.md).
- Provider routes: `GET /api/v1/providers`, `GET /api/v1/providers/:pid/logs`
  and `POST /api/v1/providers/:pid/logs/:logId/open`, and a Catalog tab in
  the UI's open dialog.
- `createLogViewer()` library API and the npm package
  `@kevinwang15/log-viewer`, with TypeScript types, CommonJS and ESM support,
  the bundled UI, and the `log-viewer` CLI. See
  [docs/library.md](docs/library.md).
- `authorize` hook: one function decides every `read`, `view-state`, `open`,
  `ingest` and `configure` action, over HTTP and WebSocket. It replaces the
  key scheme, for example with a session check.
- Feature modules (core, files, streams, merge, remote, providers), enabled
  from options and listed under `modules` in `/api/v1/capabilities`.
  `/healthz` gains `providerLogs`.
- Mounting under a prefix of a host app: `app.use('/logs', viewer.handler)`
  with the WebSocket on `/logs/ws` next to the host's own WebSocket servers.
  The UI derives its API base from its own path.
- Examples: [SQLite provider](examples/sqlite-provider/) and
  [minimal embed](examples/minimal-embed/).
- Documentation rewritten and reorganized: getting started, concepts,
  sources, providers, library, UI embedding, API reference, configuration,
  operations, security and development guides.

### Changed

- UI refresh: new icons and color palette, resizable panes, stick-to-bottom
  while tailing, the scroll position is kept across filter changes, and rows
  no longer flash while tailing.
- Performance: file indexing is about 38% faster and reports about 31%
  faster. Smooth scrolling costs 2.7 ms of main-thread time per frame
  instead of 7.2 ms (`npm run bench:ui`: 200,000 entries, 4x CPU
  throttling).

### Notes for existing users

- The CLI, its environment variables and the HTTP API are unchanged.
- Library users get the files and remote modules off by default; enable them
  with `files: { root }` and `remote: {}`. The CLI still enables both.
- `GET /api/browse` omits `samples` when sample logs are disabled.
- Build output (`dist/`) is no longer committed. Run `npm run build` after
  checking out.

## 0.1.0

Initial version.
