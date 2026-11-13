# Stream API v1

The v1 API is the stable producer lifecycle for embedded, in-memory log
streams. Producers should discover it with `GET /api/v1/capabilities` and must
not construct internal source IDs.

## Lifecycle

Given a URL-safe channel such as `deployment-7f92`:

1. `PUT /api/v1/streams/deployment-7f92` creates the stream. The operation is
   idempotent and never appends data. It returns `201` when created and `200`
   when the channel already exists.
2. `POST /api/v1/streams/deployment-7f92/entries` appends `lines` and/or
   structured `entries`. It returns a small acknowledgement with the source
   ID, retained count, severity statistics, and retained byte estimate.
3. `GET /api/v1/streams/deployment-7f92` inspects an existing stream without
   creating it. A missing stream is `404`.
4. `DELETE /api/v1/streams/deployment-7f92` releases the stream and is
   idempotent. Its response reports whether a stream was present.

When `STREAM_KEY` is configured, PUT, POST, and DELETE require:

```http
x-stream-key: <service credential>
```

The key is a server-to-server credential. Never put it in iframe query
parameters or browser JavaScript.

`STREAM_TOKENS` adds scoped mutation credentials as comma-separated
`token=channelPrefix` entries (for example `abc=web-,def=job-`). A scoped
token sent as `x-stream-key` authorizes mutations only on channels starting
with its prefix; a prefix of `*` or empty authorizes every channel. The master
`STREAM_KEY` still authorizes any channel. When neither is set, mutations are
open; when only `STREAM_TOKENS` is set, scoped tokens are enforced.

When `VIEW_KEY` is configured, read endpoints under `/api` (everything except
`/healthz`) require the key as an `x-view-key` header or a `viewKey` query
parameter; the master `x-stream-key` also satisfies read auth. WebSocket
subscribers pass it in the sub message: `{"type":"sub","id":"…","viewKey":"…"}`.
When `VIEW_KEY` is unset, reads are open and intentionally left to the
deployment boundary: expose them through an authenticated same-origin proxy or
keep the whole service private.

## Examples

```bash
base=http://127.0.0.1:5178
channel=deployment-7f92

curl -X PUT "$base/api/v1/streams/$channel" \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY"

curl -X POST "$base/api/v1/streams/$channel/entries" \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d '{"lines":["2026-07-13 10:00:00,000 [Main] INFO App - ready"]}'

curl -X POST "$base/api/v1/streams/$channel/entries" \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY" \
  -H 'content-type: application/json' \
  -d '{"entries":[{"time":"2026-07-13T10:00:01Z","level":"WARN","thread":"Main","logger":"App","message":"slow response"}]}'

curl -X DELETE "$base/api/v1/streams/$channel" \
  -H "x-stream-key: $LOG_VIEWER_SERVICE_KEY"
```

Channels are 1–128 characters and match
`[A-Za-z0-9][A-Za-z0-9._:-]*`. An append does not implicitly create a missing
channel; this makes producer mistakes visible instead of creating orphaned
state.

## Reading and live updates

The stream inspection response includes an opaque `id`, currently similar to
`s:deployment-7f92`. Use that returned value with the windowed read endpoint:

```http
GET /api/logs/<encoded-id>/entries?start=0&count=200
```

Subscribe to that same ID over `WS /ws`:

```json
{"type":"sub","id":"s:deployment-7f92"}
```

The server sends an immediate `reset` snapshot, then `append` or `reset`
notifications. Reconnection and re-subscription therefore recover the current
count even if notifications were missed. Entry text still comes from windowed
HTTP reads; WebSocket messages do not duplicate the log payload.

## Correlation

"Show this request's whole journey": extract a correlation id from one entry
and find every entry carrying it.

```bash
curl "$base/api/logs/<encoded-id>/correlate?i=42"
curl "$base/api/logs/<encoded-id>/correlate?i=42&key=requestId"
```

The endpoint reads entry `i`, extracts a `{key, value}` pair, then scans the
**whole source** (filters do not apply; merged views return merged-view
indices) for entries whose raw text contains the extracted value — correlation
ids are high-entropy, so substring matching on the value is the right
semantics. The scan uses the same case-insensitive test as text filters.

Key discovery order: structured stream entries retain only the mapped fields
(`time`, `level`, `thread`, `logger`, `message`), so there is no separate
field bag to consult — discovery is a regex scan of the entry text for
`key=value`, `key: value`, and JSON `"key":"value"` shapes, tried in this
order (case-insensitive): `requestId`, `request_id`, `request-id`, `traceId`,
`trace_id`, `correlationId`, `correlation_id`, `sessionId`, `session_id`,
`spanId`, `flowId`, `jobId`. An explicit `key=` query parameter restricts
extraction to that key only.

Success response:

```json
{ "key": "requestId", "value": "abc123", "count": 17, "indices": [42, 51, 63] }
```

`indices` is capped at 10 000 entries and the scan at 2 000 000 entries;
beyond either cap the response adds `"truncated": true`. Errors: `404` unknown
source, `400` for a missing/out-of-range `i`, and `422`
`{"error":"no correlation id found"}` when nothing is extractable.

## Report

Aggregates over a source (or a filtered view of it): a time histogram, a
per-level time series, and the top loggers, threads and message templates.

```bash
curl "$base/api/logs/<encoded-id>/report?buckets=60"
curl "$base/api/logs/<encoded-id>/report?buckets=60&filter=<filter-id>"
curl "$base/api/logs/<encoded-id>/report?format=csv"
```

`buckets` defaults to 60 and is clamped to 10–200. The JSON response:

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

`buckets[].counts` and `series` both use the level indexing
`[TRACE, DEBUG, INFO, WARN, ERROR, FATAL]`: `counts` is per bucket,
`series[lv][b]` is the same data transposed (one array per level) for line
charts. `topLoggers`/`topThreads` return the top 8, `topMessages` the top 10.
Message templates are normalized — uuids, quoted strings, hex tokens and digit
runs are replaced with `?` and templates are capped at 200 characters — so
repeated log statements collapse into one entry; `example` is the first
message seen for the template.

Aggregates are cached and folded forward incrementally on append (a new entry
outside the cached time range moves every bucket boundary and forces a full
recompute), so polling this endpoint on a tailing source is cheap.

With `format=csv` the response is `text/csv` with one row per bucket: the
bucket start as ISO 8601 followed by the six per-level counts.

```csv
bucket_start,trace,debug,info,warn,error,fatal
2026-07-13T10:00:00.000Z,0,3,40,5,2,0
```

## Custom parser patterns

When auto-detection does not recognize a log's layout, a source can be given a
log4j/logback-style conversion pattern. The pattern is compiled into a parsing
format and the source is re-indexed; filtering, merging, and live tailing then
work as with any detected format.

```bash
curl -X POST "$base/api/logs/<encoded-id>/parser" \
  -H 'content-type: application/json' \
  -d '{"pattern":"%d [%t] %-5p %c - %m"}'

curl -X DELETE "$base/api/logs/<encoded-id>/parser"
```

`POST` sets the pattern and re-indexes the source (for streams, the retained
buffer is re-parsed and the pattern also applies to newly appended lines).
`DELETE` restores auto-detection. Errors: `400` for a pattern that cannot be
compiled (or for merged views), `404` for an unknown source. The active pattern
is reported as `pattern` in the source info JSON returned by `GET /api/logs`
and the parser endpoints. Patterns are per-source and held in memory only; a
re-opened source falls back to auto-detection.

Supported conversion specifiers:

| Specifier | Field |
| --- | --- |
| `%d`, `%d{...}` | timestamp (date hint advisory; ISO8601 and `yyyy-MM-dd HH:mm:ss,SSS` shapes are handled, `%d{UNIX}`/`%d{UNIX_MILLIS}` match epoch digits) |
| `%p`, `%level` | level |
| `%t`, `%thread` | thread |
| `%c`, `%logger` | logger |
| `%m`, `%msg`, `%message` | message (rest of line) |
| `%n` | line separator (ignored; lines are already split) |
| `%%` | literal `%` |

Literal text between specifiers is matched exactly. Format modifiers such as
`%-5p` or `%c{1}` are tolerated; width padding is matched as optional spaces.
Unknown specifiers (e.g. `%X{requestId}`) match a single non-greedy token so
they do not hard-fail. Patterns are limited to 500 characters.

## Rules

A rule is "when an entry matches criteria, do actions" — highlight rows in the
UI, bookmark them, or POST a webhook notification. Criteria use the same shape
as the filter endpoint (`levels`, `threads`, `loggers`, `text`, `regex`,
`caseSensitive`, `exclude`, `timeFrom`, `timeTo`).

```bash
curl -X POST "$base/api/logs/<encoded-id>/rules" \
  -H 'content-type: application/json' \
  -d '{"name":"errors","criteria":{"levels":[4,5]},"actions":{"highlight":"#ffe0e0","bookmark":true,"webhook":"https://ops.example/hook"}}'

curl "$base/api/logs/<encoded-id>/rules"
curl -X DELETE "$base/api/logs/<encoded-id>/rules/<rule-id>"
```

- `POST` creates the rule and returns it with its `matchCount`. Creating a
  rule scans the existing entries once, exactly like creating a filter: the
  match count covers them, and the `bookmark` action applies to them
  immediately. Webhooks are the exception — they fire **only** for entries
  appended after creation, so creating a rule over a large log never produces
  a retroactive webhook storm.
- `GET` lists the source's rules with live `matchCount` and `webhookErrors`
  counters. Rules are also embedded in the source info JSON (`GET /api/logs`,
  `GET /api/logs/:id`), so clients can render highlights without extra calls.
- `DELETE` removes the rule. Bookmarks it created stay — they are plain
  bookmarks once set. Deleting the source removes its rules.
- On stream sources, rule creation and deletion require the same
  `x-stream-key` mutation auth as other stream mutations.
- `highlight` is a hex CSS color: `#rgb`, `#rgba`, `#rrggbb`, or `#rrggbbaa`
  (anything else is a `400`). The standalone web UI paints matching rows with
  it as the background color.
- `webhook` must be an `http(s)` URL of at most 2048 characters. On each
  append with matches the server POSTs, fire-and-forget (5s timeout, no
  retries; failures never delay ingestion and are counted in `webhookErrors`):

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

  `sample` carries up to 5 matched entries in the compact grid shape; entry
  text is already truncated at the usual 64 KiB cap.
- At most 20 rules per source (`MAX_RULES_PER_SOURCE`); the 21st returns `400`
  with code `rule_limit_reached`.

## Gzipped log files

`POST /api/logs/open` detects gzip members by magic bytes (`1f 8b`), not by
file extension, and opens them transparently: the file is streamed through a
gunzip into a temporary file (`$TMPDIR/log-viewer-*`) and that decompressed
copy is indexed as a regular file source. Format auto-detection, filters,
search, and export all work as usual.

- The source info reports `gzipped: true` and keeps the original file name as
  `name`; `path` points at the temporary decompressed copy.
- Gzipped rotations are static: no tail watcher is attached, so no `append`
  notifications are emitted for them.
- Chunked open does not apply — byte offsets would refer to compressed bytes.
  Passing `start`/`end` for a gzip member returns `400`.
- The decompressed size is capped by `GZIP_MAX_BYTES` (default 4 GiB); an
  oversized expansion fails with `413`.
- The temporary copy is deleted when the source is closed
  (`DELETE /api/logs/:id`) and on server shutdown.

`GET /api/browse` and `GET /api/stat` are path-based and work on `.gz` paths
unchanged.

## Remote sources (cross-instance mirroring)

`POST /api/logs/remote` opens a read-only, in-memory mirror of a source on a
peer log-viewer instance:

```json
{ "url": "http://peer:5178", "source": "s:channel-or-f1", "viewKey": "..." }
```

`source` is the peer's source id (as reported by its `GET /api/logs`); any
source kind works, including merged views. `viewKey` is only needed when the
peer is secured with `VIEW_KEY` — it is forwarded as `x-view-key` on every
HTTP fetch and as the `viewKey` field of the WS `sub` frame. The peer should
be secured with `VIEW_KEY` whenever it is reachable beyond localhost; see
[docs/security.md](security.md). Like file open, this is a local admin action
and requires no stream key on the opening instance.

- The initial load pages the peer's `entries` endpoint (1000 entries per
  page) until caught up; tailing then follows the peer's WebSocket broadcast:
  `append` frames fetch just the new range, `reset` frames (or any detected
  drift) trigger a full reload.
- The mirror is bounded by `REMOTE_MAX_ENTRIES` (default 100000, `0` =
  unbounded): once exceeded, the OLDEST entries are evicted and subscribers
  get a `reset`, mirroring stream retention semantics — the mirror always
  keeps the latest N entries.
- If the peer goes away, the source stays readable with its last known
  (stale) entries and reconnects with exponential backoff (1s doubling to a
  30s cap). The source info reports `remote: { url, source }` and a live
  `connected` flag.
- Entries, filters, search, correlation, report and export all work against
  the mirror unchanged, and a remote source is a valid `POST /api/logs/merge`
  child — merging a local file with a remote source interleaves entries by
  timestamp across instances.
- The mirror is strictly read-only: nothing is ever written back to the peer.
  `DELETE /api/logs/:id` closes the WebSocket and drops the mirror.

## Limits and errors

- `413` means the encoded request exceeded `STREAM_MAX_PAYLOAD_BYTES`.
- `503` with code `stream_capacity_reached` means `STREAM_MAX_SOURCES` is
  exhausted.
- Each entry is truncated at 64 KiB, and stream retention applies both an
  entry-count and estimated-byte bound.
- Idle streams are removed after `STREAM_IDLE_TTL_SECONDS` unless a subscribed
  viewer or producer is active.
- When `SPOOL_DIR` is set, appended entries are also written to a per-channel
  spool file so streams survive restarts. Spooling is at-least-once and
  asynchronous: an append is acknowledged once it is in memory, so a crash can
  lose the writes still in flight. Only the first line of each entry's raw text
  is persisted, alongside its parsed fields. A spool file is compacted to the
  currently retained entries once it exceeds ~2x `STREAM_MAX_BYTES`, and is
  deleted together with its stream. See
  [operations.md](operations.md#stream-spooling) for the full semantics.

The unversioned `/api/streams/:channel` endpoints remain temporarily available
and return a `Deprecation` header. New integrations should only use v1.
