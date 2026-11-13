# HTTP and WebSocket API

This is the reference for the HTTP API and the WebSocket protocol. The
machine-readable HTTP description is [openapi.yaml](openapi.yaml). Copy-paste
producers for curl, Node.js, Python and winston are in [snippets/](snippets/).

## Conventions

- Paths are relative to where the viewer is mounted. The CLI mounts it at `/`.
  A host app that mounts it with `app.use('/logs', viewer.handler)` serves
  `/logs/api/...`, `/logs/healthz` and, if it attaches the WebSocket there,
  `/logs/ws`. See [library.md](library.md).
- Request and response bodies are JSON unless noted. JSON bodies larger than
  the payload limit (default 2 MiB) are rejected with `413`.
- Errors have the shape `{"error": "message"}`, plus `"code"` for errors a
  client may want to branch on. See [Errors](#errors).
- Levels are numbered 0 to 5: TRACE, DEBUG, INFO, WARN, ERROR, FATAL. Every
  `stats` array uses this order.
- Timestamps (`t`, `timeFrom`, `timeTo`) are epoch milliseconds. Logs with
  time-only stamps use milliseconds since midnight. `0` means "no timestamp".

### Source ids

Every open log is a source with an opaque `id`. Clients should take ids from
API responses and never build them. The current shapes are:

| Kind | Id | Created by |
|---|---|---|
| `file` | `f1`, `f2`, … | `POST /api/logs/open`, directory watch |
| `stream` | `s:<channel>` | stream lifecycle, WebSocket `publish`, in-process append |
| `merged` | `m1`, … | `POST /api/logs/merge` |
| `remote` | `r1`, … | `POST /api/logs/remote` |
| `provider` | `p:<provider>:<log>` | `POST /api/v1/providers/:pid/logs/:logId/open` |

`kind` is an open set: a host app can register its own source kinds. Encode
ids with `encodeURIComponent` when you put them in a path (`s:web` becomes
`s%3Aweb`).

### Modules

Routes belong to feature modules. A route exists only when its module is
enabled; otherwise the server answers with Express's default `404` (not a JSON body). `GET
/api/v1/capabilities` lists the enabled modules under `modules`.

| Module | Routes | CLI | Library default |
|---|---|---|---|
| core | `/api/logs`, `/api/logs/:id/...` | on | always on |
| files | `/api/browse`, `/api/stat`, `/api/logs/open` | on | off |
| streams | `/api/v1/streams/...`, `/api/streams/...`, WS `publish` | on | on |
| merge | `/api/logs/merge` | on | on |
| remote | `/api/logs/remote` | on | off |
| providers | `/api/v1/providers/...` | on, with no providers | always on |

`/api/v1/capabilities` and `/healthz` always exist.

### Authorization

Every protected operation asks the viewer's authorizer for one action:

| Action | Covers |
|---|---|
| `read` | every `GET`/`HEAD` under `/api`, and WebSocket `sub` |
| `view-state` | filters and bookmarks |
| `open` | opening files, merges, remote mirrors and provider logs (merges and provider logs also check `read`) |
| `ingest` | stream create, append, delete, and WebSocket `publish` |
| `configure` | deleting a source, custom parsers, rules |

The built-in key scheme (CLI env vars `VIEW_KEY`, `STREAM_KEY`,
`STREAM_TOKENS`, see [configuration.md](configuration.md)) decides them like
this:

- `read`: open when no view key is set. Otherwise the request needs the view
  key as the `x-view-key` header or the `viewKey` query parameter. The master
  stream key in `x-stream-key` also works.
- `view-state` and `open`: always allowed.
- `ingest`: open when no stream key and no tokens are set. Otherwise
  `x-stream-key` must hold the master `STREAM_KEY` or a `STREAM_TOKENS` token
  whose prefix matches the channel.
- `configure`: on stream sources, the same rule as `ingest` for the stream's
  channel. On every other source kind, allowed.

A host app can replace the key scheme with its own `authorize` hook (for
example a session-cookie check). Then each action means whatever the hook
decides. See [library.md](library.md) and [security.md](security.md).

`/healthz` is never authenticated.

## Core

The core module works on any source kind.

### `GET /api/logs`

Lists the open sources the caller may read.

Response: `{"sources": [SourceInfo, ...]}`. Auth: `read`, checked per source.

### `GET /api/logs/:id`

Returns one source's info. Auth: `read`. `404` for an unknown id.

The SourceInfo object has these fields on every source:

| Field | Meaning |
|---|---|
| `id`, `kind`, `name` | identity |
| `count` | entries currently in the source |
| `stats` | per-level counts, TRACE to FATAL |
| `threads`, `loggers` | distinct thread and logger names |
| `format` | detected format name, such as `time [thread] level logger - message`, `json`, `syslog (RFC 5424)` or `plain`; `custom (<pattern>)` with a custom parser |
| `rules` | the source's rules, see [Rules](#rules) |
| `origin` | `"watch"` for files opened by the directory watch; absent otherwise |

Kind-specific fields:

| Kind | Fields |
|---|---|
| `file` | `path` (the decompressed temp copy for gzipped files), `pattern`, `gzipped` |
| `stream` | `pattern`, `bytes` (retained byte estimate), `lastActivityAt` (epoch ms) |
| `remote` | `remote: {url, source}`, `connected` |
| `provider` | `provider: {id, name, log}`, `description`, `labels`, `state`, `connected`, `lastError` |

`state` of a provider mirror is one of `loading`, `live`, `polling`,
`reconnecting`, `failed`, `closed`. `connected` is true in `live` and
`polling`.

### `DELETE /api/logs/:id`

Closes a source and drops its filters, rules and bookmarks. Merged views that
include it are closed too. Deleting a stream also deletes its spool file.
Deleting an unknown id succeeds.

Response: `{"ok": true}`. Auth: `configure`.

### Custom parser

`POST /api/logs/:id/parser` with `{"pattern": "<conversion pattern>"}` sets a
log4j/logback-style conversion pattern for one source and re-indexes it.
`DELETE /api/logs/:id/parser` restores format auto-detection. Both return the
updated SourceInfo. Auth: `configure`.

Only file and stream sources support custom parsers. Merged, remote and
provider sources return `400`. For streams, the retained entries are
re-parsed and the pattern also applies to new lines. Patterns are held in
memory per source; a re-opened source starts with auto-detection again. The
active pattern appears as `pattern` in SourceInfo, and `format` becomes
`custom (<pattern>)`.

```bash
curl -X POST "$base/api/logs/f1/parser" \
  -H 'content-type: application/json' \
  -d '{"pattern":"%d [%t] %-5p %c - %m"}'
```

Supported conversion specifiers:

| Specifier | Field |
|---|---|
| `%d`, `%date`, `%d{...}` | timestamp. The date hint is advisory: ISO 8601 and `yyyy-MM-dd HH:mm:ss,SSS` shapes are handled; a hint containing `UNIX` (`%d{UNIX}`, `%d{UNIX_MILLIS}`) matches epoch digits |
| `%p`, `%level` | level |
| `%t`, `%thread` | thread |
| `%c`, `%logger` | logger |
| `%m`, `%msg`, `%message` | message (rest of the line) |
| `%n` | line separator, ignored |
| `%%` | a literal `%` |

Literal text between specifiers must match exactly. Format modifiers such as
`%-5p` or `%c{1}` are accepted; width padding matches optional spaces. Unknown
specifiers such as `%X{requestId}` match one short token, so they do not fail.
A pattern needs at least one specifier and at most 500 characters. A pattern
that cannot be compiled returns `400` with the reason.

### Filters

`POST /api/logs/:id/filters` creates a filtered view. The body is
`{"criteria": {...}}`; a bare criteria object is also accepted.

| Criteria field | Meaning |
|---|---|
| `levels` | level numbers to keep |
| `threads`, `loggers` | names to keep |
| `text` | substring, or a regular expression with `regex: true` |
| `regex`, `caseSensitive` | how `text` matches (default: substring, case-insensitive) |
| `exclude` | invert the match |
| `timeFrom`, `timeTo` | time range |

Response: `{"filterId": "F1", "count": 120, "stats": [...]}`. An invalid
regular expression returns `400`. Auth: `view-state`.

A filter stays current: appends are matched as they arrive and WebSocket
frames report its new count. Pass the id as `filter=<filterId>` to the
entries, search, locate, bookmarks/next, export, report and minimap
endpoints.

`DELETE /api/logs/:id/filters/:fid` removes a filter. Response:
`{"ok": true}`. Auth: `view-state`.

### Rules

A rule is "when an entry matches criteria, do actions": highlight the row,
bookmark it, or POST a webhook. Criteria have the same shape as filter
criteria.

```bash
curl -X POST "$base/api/logs/f1/rules" \
  -H 'content-type: application/json' \
  -d '{"name":"errors","criteria":{"levels":[4,5]},"actions":{"highlight":"#ffe0e0","bookmark":true,"webhook":"https://ops.example/hook"}}'
```

- `POST /api/logs/:id/rules` creates a rule and returns it:
  `{id, name, criteria, actions, matchCount, webhookErrors}`. Auth:
  `configure`.
- `GET /api/logs/:id/rules` returns `{"rules": [...]}` with live
  `matchCount` and `webhookErrors`. Auth: `read`. Rules are also included in
  SourceInfo.
- `DELETE /api/logs/:id/rules/:rid` removes a rule. Bookmarks it set stay.
  Auth: `configure`.

Creating a rule scans the existing entries once. `matchCount` covers them and
the `bookmark` action applies to them right away. Webhooks fire only for
entries appended after the rule was created, so a rule over a large log never
sends a burst of old matches.

Validation:

- `name` is trimmed and cut to 200 characters.
- `highlight` must be a hex color: `#rgb`, `#rgba`, `#rrggbb` or `#rrggbbaa`.
- `webhook` must be an `http` or `https` URL of at most 2048 characters.
- A source holds at most 20 rules. The 21st returns `400` with code
  `rule_limit_reached`.

On each append with matches, the server POSTs this payload to the webhook. It
uses a 5 s timeout and no retries. Failures never delay ingestion and are
counted in `webhookErrors`.

```json
{
  "ruleId": "R1",
  "ruleName": "errors",
  "source": "s:deployment-7f92",
  "sourceName": "deployment-7f92",
  "matched": 2,
  "sample": [{ "i": 41, "t": 1752393600000, "lv": 4, "th": "Main", "lg": "App", "msg": "boom" }]
}
```

`sample` holds up to 5 matched entries.

### `GET /api/logs/:id/entries`

Returns a window of entries for virtual scrolling.

| Query | Default | Meaning |
|---|---|---|
| `start` | 0 | first view index |
| `count` | 100 | entries to return, 1 to 1000 |
| `filter` | none | filter id; indices then refer to the filtered view |

Response: `{"start": 0, "entries": [Entry, ...]}`. An unknown filter returns
`404`. Auth: `read`.

Entry fields:

| Field | Meaning |
|---|---|
| `i` | entry index in the source (stable across filters) |
| `t`, `lv`, `th`, `lg` | time, level, thread, logger |
| `msg` | first line of the parsed message |
| `raw` | full entry text including continuation lines, capped at 64 KiB |
| `src` | originating source name, merged views only |
| `elapsed` | ms since the previous entry in the current view, or `null` |

`elapsed` compares against the entry just above in the same view, filter
included. The first row of a window compares against the row before the
window, so paging into the middle of a view gives correct values. It is
`null` for the first entry of the view and when either timestamp is missing.

### Bookmarks

- `GET /api/logs/:id/bookmarks` returns `{"indices": [...]}`, sorted entry
  indices. Auth: `read`.
- `PUT /api/logs/:id/bookmarks` with `{"index": 42}` toggles a bookmark;
  add `"on": true` or `"on": false` to set it explicitly. Response:
  `{"index": 42, "on": true, "total": 3}`. An index outside the source
  returns `400`. Auth: `view-state`.
- `GET /api/logs/:id/bookmarks/next?from=<vi>&dir=next|prev&filter=<fid>`
  finds the next or previous bookmarked row relative to view index `from`
  (default `-1`). Response: `{"vi": 17}` or `{"vi": null}`. Auth: `read`.

A `reset` of the source (rotation, retention eviction, re-parse) clears its
bookmarks, because entry indices may have moved.

### `GET /api/logs/:id/locate`

Maps an entry index `i` to a view index, so a client keeps its place when the
filter changes.

Query: `i` (required, the entry's `i`), `filter`. Response:
`{"vi": 120, "exact": true}`. When the view does not contain the entry, `vi`
is the neighbouring row with the closer timestamp and `exact` is `false`. An
empty view returns `{"vi": null, "exact": false}`. Auth: `read`.

### `GET /api/logs/:id/search`

Finds the next or previous matching row without filtering.

| Query | Default | Meaning |
|---|---|---|
| `q` | required | search text; empty returns `{"vi": null}` |
| `regex` | `0` | `1` treats `q` as a regular expression |
| `cs` | `0` | `1` matches case-sensitively |
| `from` | `-1` | view index to start after |
| `dir` | `next` | `next` or `prev` |
| `filter` | none | search within a filtered view |

Response: `{"vi": 512}` or `{"vi": null, "capped": false}`. A search scans at
most 2,000,000 entries; `capped: true` means it stopped there. An invalid
regular expression returns `400`. Auth: `read`.

### `GET /api/logs/:id/correlate`

Extracts a correlation id from entry `i` and finds every entry that carries
it.

```bash
curl "$base/api/logs/f1/correlate?i=42"
curl "$base/api/logs/f1/correlate?i=42&key=requestId"
```

The server scans the entry text for `key=value`, `key: value` and JSON
`"key":"value"` shapes. It tries these keys in order, case-insensitively:
`requestId`, `request_id`, `request-id`, `traceId`, `trace_id`,
`correlationId`, `correlation_id`, `sessionId`, `session_id`, `spanId`,
`flowId`, `jobId`. The `key` query parameter restricts extraction to that one
key.

It then scans the whole source for entries whose text contains the value,
using the same case-insensitive substring test as text filters. Filters do
not apply. Merged views return merged-view indices.

Response:

```json
{ "key": "requestId", "value": "abc123", "count": 17, "indices": [42, 51, 63] }
```

`indices` holds at most 10,000 entries and the scan covers at most 2,000,000
entries. Past either cap the response adds `"truncated": true`. Errors: `400`
for a missing or out-of-range `i`, `422` with `{"error": "no correlation id
found"}` when the entry has no recognizable id. Auth: `read`.

### `GET /api/logs/:id/export`

Downloads the view as plain text, one raw entry per line, with
`content-disposition: attachment; filename="<name>-view.log"`. Query:
`filter`. The export stops after 2,000,000 entries. Auth: `read`.

### `GET /api/logs/:id/report`

Aggregates over a source or a filtered view: a time histogram, a per-level
series, and the top loggers, threads and message templates.

Query: `buckets` (default 60, clamped to 10 to 200), `filter`, `format=csv`.

```json
{
  "from": 1752391200000,
  "to": 1752394800000,
  "total": 12345,
  "buckets": [{ "t": 1752391200000, "counts": [0, 3, 40, 5, 2, 0] }],
  "series": [[0], [3], [40], [5], [2], [0]],
  "topLoggers": [{ "name": "com.example.Service", "count": 9000 }],
  "topThreads": [{ "name": "main", "count": 8000 }],
  "topMessages": [{ "template": "User ? logged in", "count": 412, "example": "User 1234 logged in" }]
}
```

- `buckets[].counts` holds per-level counts for one bucket. `series[lv][b]` is
  the same data transposed, one array per level, for line charts.
- `topLoggers` and `topThreads` return the top 8, `topMessages` the top 10.
- Message templates replace UUIDs, quoted strings, hex tokens and digit runs
  with `?`, and are cut to 200 characters. `example` is the first message
  seen for the template.
- Results are cached and updated incrementally on append. An entry outside
  the cached time range forces a full recompute. Polling a tailing source is
  cheap.

With `format=csv` the response is `text/csv`, one row per bucket:

```csv
bucket_start,trace,debug,info,warn,error,fatal
2026-07-13T10:00:00.000Z,0,3,40,5,2,0
```

Auth: `read`.

### `GET /api/logs/:id/minimap`

Returns the data for the navigation strip. Query: `buckets` (default 400,
clamped to 10 to 2000), `filter`.

Response: `{"buckets": [...], "bookmarks": [...], "count": 5000}`. Each
bucket holds the highest level in that slice of the view, or `-1` for an
empty view. `bookmarks[b]` is true when the slice contains a bookmark. Auth:
`read`.

## Files

The files module serves files under one root directory (CLI: `LOG_ROOT`) and
an optional samples directory. Paths outside both return `403`.

### `GET /api/browse`

Lists a directory. Query: `path` (absolute). Without `path` it lists the
samples directory, or the root when samples are disabled.

```json
{
  "path": "/var/log/app",
  "parent": "/var/log",
  "root": "/var/log",
  "samples": "/srv/log-viewer/sample-logs",
  "dirs": [{ "name": "archive" }],
  "files": [{ "name": "app.log", "size": 10485760, "mtime": 1752391200000 }]
}
```

Names starting with `.` are skipped. `samples` is absent when samples are
disabled. A missing path returns `404`. Auth: `read`.

### `GET /api/stat`

Returns `{"path", "size", "mtime", "isFile"}` for one path. A missing path
returns `404`. Auth: `read`.

### `POST /api/logs/open`

Opens and indexes a file. Body: `{"path": "/var/log/app.log"}`, optionally
with `start` and `end` byte offsets to open only part of a large file.

- Opening the same path and range again returns the existing source.
- A whole file is tailed: appends are indexed incrementally, and truncation
  or rotation triggers a re-index (`reset`).
- A byte-range chunk is not tailed. Its name gets a `[a–b MB]` suffix.
- The response is the SourceInfo. Auth: `open`.

Errors: `403` outside the root, `404` file not found.

#### Gzipped files

The server detects gzip by its magic bytes (`1f 8b`), not by the file
extension. It streams the file through gunzip into a temporary file
(`$TMPDIR/log-viewer-*/decompressed.log`) and indexes that copy as a regular
file source.

- SourceInfo reports `gzipped: true`, keeps the original file name as `name`,
  and `path` points at the temporary copy.
- Gzipped files are not tailed.
- `start`/`end` are rejected with `400`, because offsets would refer to
  compressed bytes.
- The decompressed size is capped (CLI: `GZIP_MAX_BYTES`, default 4 GiB). A
  larger expansion fails with `413`. A corrupt file fails with `400`.
- The temporary copy is deleted when the source is closed and at shutdown.

## Streams

Streams are named in-memory channels that producers push to. The v1
lifecycle is the stable producer API. Producers should read
`/api/v1/capabilities` first and must not construct internal source ids.

Channels are 1 to 128 characters matching `[A-Za-z0-9][A-Za-z0-9._:-]*`.
Other names return `400`.

### `PUT /api/v1/streams/:channel`

Creates the stream. It is idempotent and never appends data. Returns `201`
when created and `200` when the channel already existed:

```json
{ "ok": true, "id": "s:deployment-7f92", "count": 0, "stats": [0, 0, 0, 0, 0, 0], "bytes": 0, "created": true }
```

`503` with code `stream_capacity_reached` means the stream limit (CLI:
`STREAM_MAX_SOURCES`) is reached. Auth: `ingest`.

### `POST /api/v1/streams/:channel/entries`

Appends to an existing stream. A missing stream returns `404`; appends never
create streams, so producer mistakes stay visible. Auth: `ingest`.

The body takes raw `lines`, structured `entries`, or both:

```json
{ "lines": ["2026-07-13 10:00:00,000 [Main] INFO App - ready"] }
```

```json
{ "entries": [{ "time": "2026-07-13T10:00:01Z", "level": "WARN", "thread": "Main", "logger": "App", "message": "slow response" }] }
```

- Lines are parsed with the stream's format, which is auto-detected from the
  first lines. A line that does not start a new entry (a stack trace line,
  for example) is joined to the previous entry. Empty lines are dropped.
- Structured entries need a string `message`; others are skipped. `time` is
  epoch ms or a timestamp string; when it is missing or unparsable, the
  server uses the time of ingestion. `level` accepts TRACE to FATAL and
  common aliases. Only `time`, `level`, `thread`, `logger` and `message` are
  kept.
- Entry text is capped at 64 KiB, thread and logger names at 4 KiB.

The response has the same shape as the `PUT` response, without `created`.

### `GET /api/v1/streams/:channel`

Returns the stream's SourceInfo without creating it, with
`cache-control: no-store`. A missing stream returns `404`. Auth: `read`.

### `DELETE /api/v1/streams/:channel`

Removes the stream and its spool file. It is idempotent. Response:
`{"ok": true, "deleted": true}`; `deleted` is false when the stream did not
exist. Auth: `ingest`.

### Reading a stream

Use the `id` from the lifecycle response with the core endpoints, for
example `GET /api/logs/s%3Adeployment-7f92/entries?start=0&count=200`, and
subscribe to the same id over the WebSocket.

```bash
base=http://127.0.0.1:5178
channel=deployment-7f92

curl -X PUT "$base/api/v1/streams/$channel" -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY"

curl -X POST "$base/api/v1/streams/$channel/entries" \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d '{"lines":["2026-07-13 10:00:00,000 [Main] INFO App - ready"]}'

curl -X DELETE "$base/api/v1/streams/$channel" -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY"
```

### Retention and expiry

- A stream keeps at most `maxEntries` entries and about `maxBytes` bytes
  (CLI: `STREAM_MAX_ENTRIES`, default 100,000, and `STREAM_MAX_BYTES`,
  default 32 MiB). When either limit is crossed, the oldest entries are
  evicted until the stream is about 10% below the limit, and subscribers get
  a `reset`.
- A stream with no producer activity and no subscriber for the idle TTL
  (CLI: `STREAM_IDLE_TTL_SECONDS`, default 3600) is removed. A connected
  subscriber keeps it alive.
- With spooling on (CLI: `SPOOL_DIR`), streams survive restarts. See
  [operations.md](operations.md#stream-spooling).

### Legacy routes (deprecated)

The pre-v1 routes still work but will be removed. Their responses carry
`Deprecation: true` and a `Link: <...>; rel="successor-version"` header that
names the v1 route.

| Route | Behaviour | Replace with |
|---|---|---|
| `GET /api/streams/:channel` | creates the stream if missing, returns SourceInfo; needs only `read` | `PUT` + `GET /api/v1/streams/:channel` |
| `POST /api/streams/:channel` | creates the stream if missing, appends `lines`/`entries`, returns SourceInfo; auth `ingest` | `POST /api/v1/streams/:channel/entries` |

The legacy routes do not validate the channel name.

## Merge

### `POST /api/logs/merge`

Creates one time-ordered view over several open sources. Body:
`{"ids": ["f1", "r1"], "name": "API + worker"}`. `name` defaults to
`Merged Logs`.

- Unknown ids are ignored. At least 2 open sources are required; otherwise
  `400`.
- A merged view cannot be merged again (`400`).
- Appends to the children flow into the merged view. Entries carry `src`, the
  child's name.
- Closing a child closes the merged view.

The response is the SourceInfo (`kind` is `merged`). Auth: `open`, plus
`read` on every child, because the merged view shows their entries.

## Remote

### `POST /api/logs/remote`

Opens a read-only in-memory mirror of a source on another log-viewer
instance.

```json
{ "url": "http://peer:5178", "source": "s:deployment-7f92", "viewKey": "..." }
```

- `url` is the peer's base URL. It may include a mount prefix, such as
  `https://host/logs`; the mirror uses `<url>/api/...` and `<url>/ws`.
- `source` is a source id on the peer, from its `GET /api/logs`. Any kind
  works, including merged views.
- `viewKey` is needed only when the peer requires a view key. It is sent as
  `x-view-key` on every fetch and in the WebSocket `sub` message.

Behaviour:

- The initial load pages the peer's entries endpoint, 1000 entries per
  request. Tailing follows the peer's WebSocket: `append` frames fetch only
  the new range; `reset` frames, or any detected drift, reload everything.
- The mirror keeps the newest `maxEntries` entries (CLI: `REMOTE_MAX_ENTRIES`,
  default 100,000, `0` = unbounded). Evicting old entries sends a `reset`.
- If the peer goes away, the mirror stays readable with its last entries and
  reconnects with backoff from 1 s up to 30 s. SourceInfo reports
  `remote: {url, source}` and `connected`.
- Every core feature works on the mirror, and a mirror can be a merge child,
  so a local file and a remote stream can be interleaved by time.
- Nothing is written to the peer. `DELETE /api/logs/:id` closes the mirror.

Errors: `400` for a missing or non-http(s) `url` or missing `source`, `401`
when the peer rejects the view key, `404` when the peer has no such source,
`502` when the peer is unreachable or answers with another error. Auth:
`open`.

## Providers

Providers plug your own log storage (a database table, a log service) into
the viewer. See [providers.md](providers.md). Opening a provider log creates a
bounded in-memory mirror that every core feature works on.

### `GET /api/v1/providers`

Response: `{"providers": [{"id": "db", "name": "Database", "capabilities": {}}]}`.
Auth: `read`.

### `GET /api/v1/providers/:pid/logs`

Returns the provider's log catalog:

```json
{ "logs": [{ "id": "api", "name": "API service", "description": "…", "labels": { "team": "core" }, "open": true }] }
```

`open` is present when the log's mirror is open. The catalog is cached for 10
seconds by default; `?fresh=1` bypasses the cache. Errors: `404` unknown
provider, `502` when the provider's `listLogs()` fails. Auth: `read`, and the
list contains only the logs the caller may `read` (each checked as a
`provider` source with id `p:<pid>:<logId>`).

### `POST /api/v1/providers/:pid/logs/:logId/open`

Opens the live mirror of a provider log, or returns it when it is already
open. No body is needed. The mirror's id is `p:<pid>:<logId>` and the response
is its SourceInfo. Auth: `open` and `read`, both for that provider source.

Errors:

- `404`: unknown provider or log.
- `429` with code `provider_capacity_reached`: too many provider logs open
  (default 16, library option `providerOptions.maxOpen`).
- The provider's own `ProviderError` status, or `502`, when the provider
  fails while opening.

## Discovery

### `GET /api/v1/capabilities`

Describes the deployment, with `cache-control: no-store`. Auth: `read`.

```json
{
  "service": "log-viewer",
  "serviceVersion": "0.2.0",
  "apiVersion": "v1",
  "streamLifecycle": {
    "create": "PUT /api/v1/streams/:channel",
    "append": "POST /api/v1/streams/:channel/entries",
    "inspect": "GET /api/v1/streams/:channel",
    "delete": "DELETE /api/v1/streams/:channel"
  },
  "mutationAuth": "x-stream-key",
  "limits": { "maxEntries": 100000, "maxBytes": 33554432, "maxSources": 16, "idleTtlSeconds": 3600, "maxPayloadBytes": 2097152 },
  "modules": {
    "streams": { "lifecycle": { "…": "…" }, "mutationAuth": "x-stream-key", "limits": { "…": "…" }, "spool": false, "demo": false },
    "files": { "root": "/logs" },
    "merge": {},
    "remote": { "maxEntries": 100000 },
    "providers": { "providers": [], "maxOpen": 16 }
  }
}
```

- `serviceVersion` is the `version` option (CLI: `APP_VERSION`), default
  the package version.
- `mutationAuth` is `x-stream-key` when stream keys are configured, `none`
  when ingestion is open, and `custom` when the host app supplied an
  `authorize` hook.
- `streamLifecycle`, `mutationAuth` and `limits` at the top level predate
  `modules` and are kept for existing clients. Without the streams module,
  `streamLifecycle` is absent and `limits` holds only `maxPayloadBytes`.
- `modules` has one key per enabled module other than core. A missing key
  means the module and its routes are off. `files` reports `root`, plus
  `samples` and `watch` (the glob list) when set.

### `GET /healthz`

Liveness probe. Never authenticated.

```json
{ "ok": true, "uptime": 3605.2, "sources": 4, "streams": 2, "streamBytes": 18432, "providerLogs": 1 }
```

`uptime` is process uptime in seconds and `sources` counts open sources of
every kind. Modules add fields: `streams` and `streamBytes` (retained stream
bytes) come from the streams module, `providerLogs` (open provider mirrors)
from the providers module.

## WebSocket

The WebSocket carries change notifications. It never carries entry text:
clients read entries over HTTP and use the frames to learn when counts change.
The CLI serves it at `/ws`. A host app chooses the path with
`viewer.attach(server, { path })`, typically `<prefix>/ws`.

Messages in both directions are JSON text frames. The server ignores frames
that are not valid JSON, and messages of unknown type. Messages from one
connection are handled in order. A message larger than the payload limit
(default 2 MiB) closes the connection.

### Client messages

| Message | Effect |
|---|---|
| `{"type":"sub","id":"<source id>","viewKey":"…","key":"…"}` | Subscribe to a source. `viewKey` and `key` (a stream key) are optional credentials. |
| `{"type":"unsub","id":"<source id>"}` | Stop receiving frames for that source. |
| `{"type":"publish","channel":"<channel>","lines":["…"],"key":"…"}` | Append raw lines to a stream, creating it if missing (streams module). |

`sub` is checked as the `read` action, with `viewKey` and `key` as the
credentials. On success the server sends a `reset` snapshot of the source
right away. On denial it sends an `error` frame. Subscribing to an id that
does not exist yet sends nothing; frames start when a source with that id
appears.

`publish` is checked as `ingest`, with `key` as the stream key. Denied
publishes and invalid channel names are dropped without a reply. When the
stream limit is reached, the server sends an `error` frame with code
`stream_capacity_reached`. `publish` takes `lines` only; send structured
entries over HTTP.

### Server frames

```json
{ "type": "reset", "id": "s:web", "count": 1200, "stats": [0, 10, 1100, 70, 20, 0], "filters": { "F3": { "count": 90, "stats": [0, 0, 0, 70, 20, 0] } } }
```

```json
{ "type": "append", "id": "s:web", "count": 1205, "stats": [0, 10, 1104, 71, 20, 0], "added": 5, "filters": { "F3": { "count": 91, "stats": [0, 0, 0, 71, 20, 0] } } }
```

```json
{ "type": "error", "code": "view_auth_required", "error": "invalid or missing viewKey" }
```

- `reset`: the source changed in a way other than appending (subscription
  snapshot, rotation, retention eviction, re-parse, mirror reload). Indices
  may have moved. Re-read the visible window and refresh filter counts.
- `append`: `added` entries were appended at the end. Existing indices are
  unchanged. `count` and `stats` are the new totals.
- `filters` maps every filter on that source to its current `count` and
  `stats`.
- `error`: `code` is `view_auth_required` for a denied `sub` (or the code a
  custom authorizer returned), and `stream_capacity_reached` for a `publish`
  over the stream limit.

### Backpressure

A slow client does not build up an unbounded send buffer. When the
connection's buffered amount exceeds 1 MiB, the server drops frames for that
source and marks it as missed. On the next broadcast for that source after
the buffer has drained below 256 KiB, it sends one `reset` snapshot instead
of the missed frames. A quiet source sends nothing until its next change.

### Reconnecting

After a reconnect, send `sub` again for each source. The `reset` snapshot
gives the current counts, so missed frames do not leave a gap. The bundled UI
reconnects with exponential backoff from 0.5 s up to 10 s.

## Errors

| Status | Code | Meaning |
|---|---|---|
| `400` | | invalid input: bad channel name, bad regex, bad pattern, bad rule, bad index, byte range on a gzipped file |
| `400` | `rule_limit_reached` | the source already has 20 rules |
| `401` | | missing or wrong credential; `invalid or missing x-view-key header` for reads, `invalid or missing x-stream-key header` for ingest and configure |
| `403` | | path outside the file root; or a custom authorizer returned `false` for `view-state` or `open` (`forbidden`) |
| `404` | | unknown source, filter, stream, provider, log, path, or a disabled module's route |
| `413` | | request body over the payload limit, or gzip expansion over its limit |
| `422` | | no correlation id found in the entry |
| `429` | `provider_capacity_reached` | too many provider logs open |
| `502` | | a peer instance or provider failed |
| `503` | `stream_capacity_reached` | the stream limit is reached; delete a stream or wait for one to expire |
| `500` | | unexpected server error; the body says `internal server error` |

A custom authorizer can deny with its own `{status, error, code}`. That
response is passed to the client unchanged; over the WebSocket it becomes an
`error` frame.

Common causes:

- `401` on a stream mutation: the producer and the server do not share the
  same `STREAM_KEY`, or the scoped token's prefix does not match the channel.
- `404` on append: the stream was never created, was deleted, or expired
  after its idle TTL.
- `413`: reduce the producer's batch size rather than raising the limit
  without a memory review.

## Limits

| Limit | Value | Setting |
|---|---|---|
| JSON body and WebSocket message size | 2 MiB | `maxPayloadBytes` (CLI: `STREAM_MAX_PAYLOAD_BYTES`) |
| Entry text | 64 KiB, longer entries are truncated | fixed |
| Thread and logger name | 4 KiB | fixed |
| Entries per `GET .../entries` | 1000 | fixed |
| Search and correlation scan | 2,000,000 entries | fixed |
| Correlation `indices` | 10,000 | fixed |
| Export | 2,000,000 entries | fixed |
| Report buckets | 10 to 200 (default 60) | per request |
| Minimap buckets | 10 to 2000 (default 400) | per request |
| Rules per source | 20 | fixed |
| Custom pattern length | 500 characters | fixed |
| Webhook URL length | 2048 characters | fixed |
| Channel name | 1 to 128 characters | fixed |
| Entries per stream | 100,000 | `streams.maxEntries` (CLI: `STREAM_MAX_ENTRIES`) |
| Bytes per stream | 32 MiB | `streams.maxBytes` (CLI: `STREAM_MAX_BYTES`) |
| Streams | 16 | `streams.maxSources` (CLI: `STREAM_MAX_SOURCES`) |
| Stream idle TTL | 3600 s | `streams.idleTtlSeconds` (CLI: `STREAM_IDLE_TTL_SECONDS`) |
| Entries per remote mirror | 100,000 | `remote.maxEntries` (CLI: `REMOTE_MAX_ENTRIES`) |
| Entries per provider mirror | 100,000 | `providerOptions.maxEntries` |
| Bytes per provider mirror | 64 MiB | `providerOptions.maxBytes` |
| Provider logs open | 16 | `providerOptions.maxOpen` |
| Gzip decompressed size | 4 GiB | `files.gzipMaxBytes` (CLI: `GZIP_MAX_BYTES`) |

For the stream, remote and provider limits, `0` means unlimited. See
[configuration.md](configuration.md) for every setting and
[operations.md](operations.md#resource-sizing) for sizing.
