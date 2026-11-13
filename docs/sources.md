# Sources

log-viewer reads five kinds of sources: files, streams, merged views, remote mirrors and providers. This page covers how to open each one, how it stays live, and what it costs. [Concepts](concepts.md) explains the shared model (entry index, `append` and `reset`, retention). The [API reference](api.md) lists request and response fields; env vars are in [Configuration](configuration.md).

## Feature support

| | File | Stream | Merged | Remote | Provider |
|---|---|---|---|---|---|
| Tail / live updates | Yes, polls the file every 400 ms (not for parts or gzip) | Yes, on every append | Yes, through its children | Yes, over the peer's WebSocket | Yes, `watch()` or polling `list()` every 1 s |
| Custom parser pattern | Yes | Yes | No | No | No (records are already structured) |
| Byte-range open | Yes | No | No | No | No |
| Gzip | Yes, detected automatically | No | No | No | No |
| Survives restart | The file stays on disk; reopen it, or let the directory watch reopen it | Only with `SPOOL_DIR` | No, merge again | No, open again | Data stays in the provider; reopen it, or use `providerOptions.autoOpen` |
| Memory model | About 28 bytes of index per entry; text stays on disk | Entries in memory, capped per stream | Three numbers per entry; reads go to the children | Entries in memory, capped at `REMOTE_MAX_ENTRIES` | Entries in memory, capped by `maxEntries` and `maxBytes` |

Filters, find, bookmarks, server rules, minimap, report, correlation and export work on every kind. Filters, bookmarks and rules are held in memory and are lost when the server restarts.

## Files

The files module serves a directory tree. The CLI and Docker image use `LOG_ROOT` as the root (default: the home directory; `/logs` in the image). In the library it is off until you pass `files: { root }`.

- `GET /api/browse?path=…` lists a directory and `GET /api/stat?path=…` describes one path. Hidden entries (names starting with `.`) are skipped. Paths outside the root, and outside the samples directory when samples are enabled, return `403`.
- `POST /api/logs/open` with `{ "path": "/logs/app.log" }` opens and indexes a file. Opening the same path again returns the existing source.
- In the library, `viewer.files.open(path, { start, end })` does the same in-process.

Indexing reads the file once and keeps a byte offset, timestamp, level, thread id and logger id per entry. Entry text is read from disk when a client asks for it. Lines that don't start a new entry (stack traces, XML or JSON bodies) are joined to the entry before them. Each entry's text is capped at 64 KiB.

### Large files and byte ranges

`POST /api/logs/open` accepts `start` and `end` byte offsets to index only part of a file. A part that begins mid-line starts at the next full line. Parts are not tailed. The UI offers this automatically: opening a file larger than 128 MB shows a picker with 100 MB parts.

### Gzip

Files that start with the gzip magic bytes (`1f 8b`) are decompressed to a temporary file and opened from there, whatever their extension. The decompressed size is capped by `GZIP_MAX_BYTES` (default 4 GiB) so a large expansion cannot fill the temp volume. Gzipped files are not tailed, and byte ranges are rejected for them with `400`. The temporary copy is deleted when the source is closed.

### Tailing, truncation and rotation

An open file (not a part, not gzip) is checked every 400 ms. When it grows, only the new bytes are indexed, open filters are updated with the new entries, and subscribers get an `append`. When it shrinks, the file is re-indexed from the start and subscribers get a `reset`. This covers truncation and copy-and-truncate rotation (logrotate's `copytruncate`).

The source keeps reading the file it opened. If your rotation renames the file and creates a new one, use the directory watch below to open the new file as its own source.

### Directory watch

Set `WATCH_GLOBS` to a comma-separated glob list, for example `WATCH_GLOBS="**/*.log,**/*.log.gz"`, and files under the root that match any glob open automatically, gzipped ones included. Globs match the path relative to the root: `*` and `?` stay within one path segment and `**` crosses segments (`**/*.log` also matches files directly in the root). The root is scanned every `WATCH_INTERVAL_MS` (default 5000). Auto-opened sources report `origin: "watch"` in their source info. The watch stops opening files, with a one-time warning, once the viewer has `STREAM_MAX_SOURCES` open sources in total. Without `WATCH_GLOBS` the watch is off.

In the library, pass `files: { root, watch: { globs, intervalMs, maxSources } }`.

### Samples

The CLI generates three sample logs (`app.log`, `client.log`, `server.log`) into `sample-logs/` under its working directory, and the open dialog's **Samples** button jumps there. Set `ENABLE_SAMPLES=false` to turn this off. In the library, `files.samples` is off by default; `true` generates into `<root>/sample-logs` and a string names another directory.

## Streams

A stream is a named in-memory channel. Its source id is `s:<channel>`. Channel names are 1 to 128 characters, start with a letter or digit, and may contain letters, digits, `.`, `_`, `:` and `-`.

### Lifecycle

| Request | Effect |
|---|---|
| `PUT /api/v1/streams/:channel` | Creates the stream. Idempotent: `201` when created, `200` when it already exists. |
| `POST /api/v1/streams/:channel/entries` | Appends `lines` and/or `entries`. Returns `404` if the stream does not exist. |
| `GET /api/v1/streams/:channel` | Returns the source info, or `404`. Never creates the stream. |
| `DELETE /api/v1/streams/:channel` | Removes the stream. Idempotent; the response says whether it existed. |

When `STREAM_KEY` or `STREAM_TOKENS` is set, `PUT`, `POST` and `DELETE` need the `x-stream-key` header. The older `/api/streams/:channel` routes still work but are deprecated: a `GET` there creates the stream, and responses carry a `Deprecation` header that points to the v1 route.

### Lines and structured entries

`lines` are raw log lines. The stream detects its format from the first lines it receives (up to 100 lines or 256 KiB, while the format is still plain text). After that, a line that matches the format starts a new entry and any other line is joined to the previous entry, so stack traces sent line by line stay together. Empty lines are dropped.

`entries` are already structured:

```json
{"entries":[{"time":"2026-07-13T10:00:01Z","level":"WARN","thread":"main","logger":"App","message":"slow response"}]}
```

Only `message` is required. `time` may be an epoch-ms number or a timestamp string, and defaults to the time of arrival. `level` defaults to INFO. A multi-line `message` shows its first line in the grid and the full text in the detail pane.

### WebSocket publish

Producers that already hold a WebSocket can send:

```json
{"type":"publish","channel":"myapp","lines":["2026-07-13 10:00:00,000 [main] INFO App - hello"],"key":"<stream key>"}
```

`publish` accepts `lines` only, and creates the channel if it doesn't exist. Messages that fail authorization or have an invalid channel name are dropped silently. When the stream limit is reached, the server replies with an `error` frame with code `stream_capacity_reached`.

### In-process

A Node.js app that embeds the viewer can append without HTTP:

```js
viewer.streams.append('checkout', ['2026-07-13 10:00:00,000 [main] INFO Checkout - order placed']);
viewer.streams.append('checkout', [{ level: 'WARN', logger: 'checkout', message: 'payment retry' }]);
await viewer.streams.delete('checkout');
```

`append` creates the channel when needed. It treats the batch as lines when the first item is a string, and as structured entries otherwise.

### Limits and idle expiry

| Env var | Library option (`streams: {…}`) | Default | Meaning |
|---|---|---|---|
| `STREAM_MAX_SOURCES` | `maxSources` | 16 | Streams that can exist at once. Creating one more returns `503 stream_capacity_reached`. |
| `STREAM_MAX_ENTRIES` | `maxEntries` | 100,000 | Entries kept per stream |
| `STREAM_MAX_BYTES` | `maxBytes` | 32 MiB | Estimated bytes kept per stream |
| `STREAM_IDLE_TTL_SECONDS` | `idleTtlSeconds` | 3600 | A stream with no appends, reads or subscribers for this long is removed |
| `STREAM_MAX_PAYLOAD_BYTES` | `maxPayloadBytes` (top-level option) | 2 MiB | Largest JSON body or WebSocket message; larger HTTP bodies get `413` |

`0` disables the first four limits. When a stream crosses its entry or byte limit, the oldest entries are evicted down to about 90% of that limit and subscribers get a `reset`. A connected viewer counts as activity, so a stream is not expired under an open iframe while its producer is quiet.

### Spooling

Set `SPOOL_DIR` (library: `streams.spoolDir`) to keep streams across restarts. Each channel is appended to one NDJSON file in that directory, `<channel>.spool`, with characters outside `[A-Za-z0-9._-]` replaced by `_`. On start, every spool file recreates its stream, trimmed to the current limits. Spool writes happen in the background and never fail an append; a graceful shutdown flushes them. Only the first line of each entry's text is written, so continuation lines are lost on recovery. Deleting a stream or letting it expire also deletes its spool file. Files are compacted once they grow past about twice `STREAM_MAX_BYTES`. [Operations](operations.md) covers durability in more detail.

### Demo channel

With `ENABLE_DEMO` (on by default in the CLI) or `streams: { demo: true }`, a `demo` channel starts with 40 batches of sample lines and then receives one to three lines every 700 ms. Open it with `embed.html?channel=demo` or the welcome screen's **View live demo stream** button. Set `ENABLE_DEMO=false` in production.

## Merged views

`POST /api/logs/merge` with `{ "ids": ["f1", "s:myapp"], "name": "Checkout" }` creates one view over two or more open sources, ordered by timestamp. `name` is optional and defaults to "Merged Logs". A merged view cannot include another merged view. Each entry carries `src`, the name of the source it came from.

Appends to a child that arrive in time order extend the merge with an `append`. An entry older than the merge's last entry makes the merge rebuild its order and emit a `reset`, and so does a `reset` of any child. Closing a child closes every merge that uses it.

## Remote mirrors

The remote module mirrors a source that lives on another log-viewer instance (the peer). It is on in the CLI and off in the library until you pass `remote: {}`.

```bash
curl -X POST http://localhost:5178/api/logs/remote \
  -H 'content-type: application/json' \
  -d '{"url":"http://logs-eu.internal:5178","source":"s:checkout","viewKey":"<peer view key>"}'
```

- `url` is the peer's base URL, including its mount path if it has one. The mirror connects to `<url>/ws` for live updates.
- `source` is the source id on the peer.
- `viewKey` is optional. It is sent to the peer as `x-view-key` on every request and in the WebSocket `sub` message.

The mirror loads the newest `REMOTE_MAX_ENTRIES` entries (default 100,000; `0` is unbounded), then follows the peer's `append` frames by fetching just the new range. A peer `reset`, a missed frame or any mismatch triggers a full reload. If the connection drops, the mirror stays readable and reconnects with backoff; its source info reports `connected`. Nothing is ever written back to the peer.

## Providers

A provider plugs your own log storage into the viewer, for example a database table or a log service. It implements `listLogs()` for the catalog and `list()` (plus optional `tail()` and `watch()`) per log. The viewer keeps a bounded mirror of each opened log and follows it.

```js
const viewer = createLogViewer({
  providers: [myProvider],
  providerOptions: { maxEntries: 50_000, autoOpen: [{ provider: 'db', log: 'api' }] },
});
```

In the UI, provider logs appear on the **Catalog** tab of the open dialog. Over HTTP, `GET /api/v1/providers` lists providers, `GET /api/v1/providers/:pid/logs` lists a catalog, and `POST /api/v1/providers/:pid/logs/:logId/open` opens a log. At most 16 provider logs can be open at once by default (`providerOptions.maxOpen`).

See [Providers](providers.md) for the SPI and [Database providers](providers-database.md) for a SQLite walkthrough and Postgres `LISTEN/NOTIFY`.

## Custom parser patterns

When auto-detection doesn't recognize a layout, give the source a log4j/logback-style conversion pattern:

```bash
curl -X POST http://localhost:5178/api/logs/f1/parser \
  -H 'content-type: application/json' \
  -d '{"pattern":"%d [%t] %-5p %c - %m"}'
```

The pattern supports `%d` (time), `%p` (level), `%t` (thread), `%c` or `%logger` (logger) and `%m` (message, the rest of the line). Width modifiers such as `%-5p` are accepted, and other specifiers such as `%X{key}` match one token. A file is re-indexed with the pattern; a stream re-parses its retained entries and uses the pattern for new lines. `DELETE /api/logs/:id/parser` restores auto-detection. Patterns work for files and streams only, are held in memory, and need `configure` permission (the stream key, for streams, when keys are set).

The embed widget and the standalone UI also accept a `pattern` query parameter. The full specifier list is in the [API reference](api.md).
