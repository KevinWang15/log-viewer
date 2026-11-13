# Configuration

The `log-viewer` CLI reads environment variables once at startup and turns
them into `createLogViewer` options. Library users pass the options directly
and the environment is not read at all. The full option reference is in
[library.md](library.md).

## Environment variables

| Variable | Default | Option | Meaning |
|---|---|---|---|
| `PORT` | `5178` | `viewer.listen(port)` | HTTP port. `0` picks a free port. The CLI listens on all interfaces. |
| `LOG_ROOT` | `$HOME` | `files.root` | Directory the file browser and `POST /api/logs/open` may read. |
| `STREAM_KEY` | unset | `auth.streamKey` | Master credential for stream ingestion, sent as `x-stream-key`. Also satisfies read auth. |
| `STREAM_TOKENS` | unset | `auth.streamTokens` | Scoped ingestion tokens: comma-separated `token=channelPrefix` entries, e.g. `abc=web-,def=job-`. A prefix of `*` or an empty prefix allows every channel. |
| `VIEW_KEY` | unset | `auth.viewKey` | Read credential. When set, every GET under `/api` and every WebSocket `sub` needs it (`x-view-key` header, `viewKey` query parameter or `viewKey` message field). |
| `CORS_ORIGIN` | unset | `cors: { origins }` | Comma-separated origins allowed to call the API cross-origin. `*` allows any origin. |
| `NODE_ENV` | unset | `cors` | When `CORS_ORIGIN` is unset, `production` turns CORS off (same-origin only); any other value allows every origin. |
| `ENABLE_DEMO` | `true` | `streams.demo` | Keeps a `demo` stream channel emitting sample lines. `0`, `false` or `no` (any case) disables it. |
| `ENABLE_SAMPLES` | `true` | `files.samples` | Generates sample log files into `./sample-logs` (relative to the working directory) and makes them browsable. `0`, `false` or `no` disables it. |
| `APP_VERSION` | unset | `version` | Reported as `serviceVersion` in `/api/v1/capabilities`. Unset reports the package version. |
| `SPOOL_DIR` | unset | `streams.spoolDir` | Directory for per-channel stream spool files, so streams survive restarts. Unset keeps streams in memory only. See [operations.md](operations.md#stream-spooling). |
| `GZIP_MAX_BYTES` | `4294967296` (4 GiB) | `files.gzipMaxBytes` | Cap on the decompressed size of a gzipped log. |
| `WATCH_GLOBS` | unset | `files.watch.globs` | Comma-separated globs, e.g. `**/*.log,**/*.log.gz`. Files under `LOG_ROOT` matching any glob are opened automatically. Unset disables the directory watch. |
| `WATCH_INTERVAL_MS` | `5000` | `files.watch.intervalMs` | How often the directory watch scans `LOG_ROOT`. |
| `REMOTE_MAX_ENTRIES` | `100000` | `remote.maxEntries` | Entries kept per remote mirror; the oldest are dropped first. `0` is unbounded. |
| `STREAM_MAX_ENTRIES` | `100000` | `streams.maxEntries` | Entries kept per stream. `0` is unbounded. |
| `STREAM_MAX_BYTES` | `33554432` (32 MiB) | `streams.maxBytes` | Estimated bytes kept per stream. `0` is unbounded. |
| `STREAM_MAX_SOURCES` | `16` | `streams.maxSources`, `files.watch.maxSources` | Maximum number of streams. The directory watch also stops opening files once this many sources are open. `0` is unlimited. |
| `STREAM_IDLE_TTL_SECONDS` | `3600` | `streams.idleTtlSeconds` | Streams with no producer activity and no subscriber for this long are removed. `0` never expires them. |
| `STREAM_MAX_PAYLOAD_BYTES` | `2097152` (2 MiB) | `maxPayloadBytes` | Maximum JSON request body and WebSocket message size. |

Parsing rules:

- Numeric variables that are empty or not a number use the default.
- `GZIP_MAX_BYTES`, `WATCH_INTERVAL_MS` and `STREAM_MAX_PAYLOAD_BYTES` must
  be positive; `0` uses the default.
- The other numeric limits accept `0`. Negative values become `0`.
- List variables (`STREAM_TOKENS`, `CORS_ORIGIN`, `WATCH_GLOBS`) split on
  commas and ignore empty items and surrounding spaces. A `STREAM_TOKENS`
  entry without `=` is ignored.
- Watch globs match the path relative to `LOG_ROOT`. `*` and `?` stay within
  one path segment; `**` crosses segments, and `**/` also matches zero
  directories.

Keep at least one of `STREAM_MAX_ENTRIES` and `STREAM_MAX_BYTES` non-zero in
production. Sizing guidance is in [operations.md](operations.md#resource-sizing).

The CLI always enables the files, streams, merge and remote modules. It
registers no providers; providers need the library.

## Library options

`createLogViewer(options)` groups its options by module. This list covers
the groups and their defaults; [library.md](library.md) has every field.

| Option | Purpose |
|---|---|
| `auth` | Built-in key scheme: `viewKey`, `streamKey`, `streamTokens`. Ignored when `authorize` is set. |
| `authorize` | Your own authorization hook, called for every protected action. |
| `cors` | `false`, `true`, or `{ origins: [...] }`. |
| `maxPayloadBytes` | Request body and WebSocket message limit. |
| `streams` | `false`, or limits, idle TTL, `spoolDir`, `demo`. |
| `files` | `false`, or `root`, `samples`, `watch`, `gzipMaxBytes`. |
| `merge` | `false` disables merged views. |
| `remote` | `false`, or `{ maxEntries }`. |
| `providers` | Provider instances to register. |
| `providerOptions` | Mirror limits, polling, catalog cache TTL, `maxOpen`, `autoOpen`. |
| `ui` | `true` (bundled UI), `false`, or `{ dir }`. |
| `version` | Reported as `serviceVersion`. |
| `logger` | Object with `log`, `warn`, `error`. |
| `ids` | Id generator for opened sources. |

### Library defaults and CLI defaults

The library starts with the smallest exposure. The CLI turns on everything a
local standalone viewer needs.

| Setting | Library default | CLI default |
|---|---|---|
| Auth | built-in key scheme with no keys: everything open | keys from `VIEW_KEY`, `STREAM_KEY`, `STREAM_TOKENS` |
| CORS | off (same-origin only) | open to any origin unless `NODE_ENV=production`; `CORS_ORIGIN` sets a list |
| Payload limit | 2 MiB | `STREAM_MAX_PAYLOAD_BYTES` |
| Streams | on: 100,000 entries, 32 MiB, 16 streams, 1 h idle TTL, no spool | same limits from env, spool from `SPOOL_DIR` |
| Demo channel | off | on (`ENABLE_DEMO`) |
| Files | off | on, root `LOG_ROOT` (default `$HOME`) |
| Sample logs | off (`samples: true` generates them into `<root>/sample-logs`) | on, in `./sample-logs` relative to the working directory |
| Directory watch | off | on when `WATCH_GLOBS` is set |
| Merge | on | on |
| Remote mirrors | off | on, 100,000 entries per mirror |
| Providers | module on, no providers | module on, no providers |
| Provider mirrors | 100,000 entries, 64 MiB, poll every 1 s, 16 open, catalog cached 10 s | same |
| UI | bundled build | bundled build |
| `serviceVersion` | package version | `APP_VERSION`, else the package version |

In the repository, `npm start` runs in `server/`, so the samples go to
`server/sample-logs/`. In the container image the working directory is
`/app/server`.
