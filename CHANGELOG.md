# Changelog

## 0.3.0

- **Structured fields.** Entries keep key-value fields from provider records
  (`fields`), structured stream entries (a `fields` object and any extra
  top-level keys) and JSON log lines (keys not used for time, level, thread,
  logger or message). The detail pane shows them; clicking one filters by it.
- **Field filters.** Criteria take `fields: { key: [values] }` (exact match;
  OR within a key, AND across keys), for filters and rules. New routes
  `GET /api/logs/:id/fields` and `GET /api/logs/:id/values` list keys and the
  most common values with counts.
- **Filter bar.** The text filter box is now a GitLab-style token bar: pick a
  field, an operator (`=` or `is one of`) and values from suggestions; typed
  text that matches no field searches the text.
- **Widget filter API.** The embed widget and `<log-viewer>` element take the
  filter (`criteria` property, `setCriteria` postMessage command) and report
  changes (`log-viewer-filter-changed`, `filterChanged`). The widget never
  writes the filter to the URL; hosts decide.
- Spool files keep fields, so they survive restarts.

## 0.2.0

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
