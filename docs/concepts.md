# Concepts

This page describes the model behind log-viewer: what a source is, how entries are addressed, and how filters, live updates, rules and retention work on top of that. The HTTP routes mentioned here are listed in full in the [API reference](api.md).

## Sources

A source is one log the viewer has open. Every feature (filters, find, bookmarks, minimap, report, correlation, export) works on any source, whatever its kind.

| Kind | What it is | Id | Opened by |
|---|---|---|---|
| `file` | A file under the configured root, indexed from disk and tailed | `f1`, `f2`, … | `POST /api/logs/open`, the directory watch, `viewer.files.open()` |
| `stream` | A named in-memory channel that producers push into | `s:<channel>` | `PUT /api/v1/streams/:channel`, WebSocket `publish`, `viewer.streams.append()` |
| `merged` | A time-ordered view over two or more open sources | `m1`, … | `POST /api/logs/merge` |
| `remote` | A read-only mirror of a source on another log-viewer instance | `r1`, … | `POST /api/logs/remote` |
| `provider` | A mirror of one log from a provider (your database or service) | `p:<provider>:<log>` | `POST /api/v1/providers/:pid/logs/:logId/open`, `viewer.openProviderLog()` |

Treat source ids as opaque. Read them from the responses of the routes above or from `GET /api/logs`. The `kind` set is open: a library user can register any object that implements the `LogSource` interface with `viewer.addSource()`.

[Sources](sources.md) explains each kind in detail.

## The entry index

A source is a dense, time-ordered list of entries addressed by index, from `0` to `count - 1`. An entry is one log record: a first line plus any continuation lines (stack traces, XML or JSON payloads). Each entry has a timestamp, a level (0 to 5 for TRACE, DEBUG, INFO, WARN, ERROR, FATAL), a thread, a logger, a message and its raw text.

The server keeps the timestamp, level, thread and logger of every entry in memory. The text may stay on disk (files) or in memory (streams and mirrors). Clients never download the whole log. They ask for windows: `GET /api/logs/:id/entries?start=…&count=…` returns at most 1000 entries per request, and the UI fetches 200-row pages as you scroll.

A source tells its listeners about changes with two events:

| Event | Meaning | What clients do |
|---|---|---|
| `append` | Entries were added at the end. Existing indices did not change. | Extend the row count and fetch the new rows if they are visible (or if follow mode is on). Cached rows stay valid. |
| `reset` | Anything else changed: old entries were evicted, a file was truncated, the source was re-parsed, or a mirror was reloaded. | Drop cached rows and re-read from the new count. Indices may now point to different entries. |

On a `reset` the server also re-evaluates every filter of the source, recomputes rule match counts, and clears the source's bookmarks, because old indices are no longer meaningful.

## Views and filters

A view is either the whole source or a filtered subset of it. Filters live on the server. `POST /api/logs/:id/filters` with a criteria object creates one and returns `{ filterId, count, stats }`. Requests for entries, find, minimap, report and export then take `filter=<filterId>` and work in view positions (0 to the filter's count minus 1).

Criteria fields:

| Field | Type | Matches entries |
|---|---|---|
| `levels` | number[] | whose level is in the list |
| `threads` | string[] | whose thread is in the list |
| `loggers` | string[] | whose logger is in the list |
| `text` | string | whose raw text contains the text |
| `regex` | boolean | treat `text` as a regular expression |
| `caseSensitive` | boolean | match `text` case-sensitively (default: case-insensitive) |
| `timeFrom`, `timeTo` | number (epoch ms) | inside the time range; entries without a timestamp pass |
| `fields` | `{ key: string[] }` | whose structured field `key` has one of the values, for every key given |
| `exclude` | boolean | invert the whole match |

All fields that are set must match. The UI combines its filter bar, level dots, right-click filters and detail-pane field chips into one criteria object per source; `regex`, `caseSensitive` and `exclude` are available through the API. When entries are appended, the server tests only the new entries against each filter and pushes the updated count and per-level stats to subscribers.

### Structured fields

Besides time, level, thread, logger and message, an entry can carry structured fields: key-value pairs such as `tenant=acme` or `status=500`. They come from:

- provider records (`LogRecord.fields`), e.g. extra columns of a database table;
- structured stream entries: a `fields` object and any other top-level key with a primitive value;
- JSON log lines: every key not used for time, level, thread, logger or message.

Values are stored as strings and matched exactly, so `status=500` is the string `"500"`. Streams, mirrors and providers keep fields in memory and filter them as fast as levels. File sources read them from the entry text when they filter, which is slower, about as fast as reading every entry. Plain-text lines have no fields; use a text filter there.

`GET /api/logs/:id/locate?i=<index>&filter=<filterId>` maps a source index to the nearest view position, so the UI keeps your place when the filter changes.

## Live updates over WebSocket

Clients receive changes over a WebSocket at `/ws` (or `<prefix>/ws` when the viewer is mounted under a path). The protocol is small:

- `{"type":"sub","id":"<source id>"}` subscribes to a source. The server replies right away with a `reset` snapshot carrying the current `count`, per-level `stats`, and the count and stats of every filter on the source.
- `{"type":"unsub","id":"<source id>"}` ends the subscription.
- After that, the server sends `append` frames (`count`, `stats`, `added`, `filters`) and `reset` frames (`count`, `stats`, `filters`).

Frames carry counts only, never entry text. A client fetches the text over HTTP. Because every subscription starts with a snapshot, a client that reconnects and subscribes again recovers the current state even if it missed frames. The UI does this with bounded exponential backoff.

Producers can also write over the same socket with `publish` messages. See [Sources](sources.md#streams).

## Bookmarks

Bookmarks are entry indices stored on the server per source, in memory. `PUT /api/logs/:id/bookmarks` with `{ "index": n }` toggles one, and `{ "index": n, "on": true }` sets it explicitly. `GET /api/logs/:id/bookmarks/next?from=<view position>&dir=next|prev&filter=…` finds the next one in the current view. The minimap marks the buckets that contain bookmarks.

A `reset` clears the bookmarks of that source. Save an analysis file in the UI if you want to keep them.

## Rules

There are two kinds of rules.

Local highlight rules belong to the UI. They color rows that match a text or a level, and they are stored in the browser's `localStorage` and in saved analysis files. Edit them under **Tools** or with the "Custom highlight rules" toolbar button.

Server rules belong to a source. `POST /api/logs/:id/rules` takes the same criteria as a filter plus one or more actions:

| Action | Effect |
|---|---|
| `highlight` | Hex color (`#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`). The UI renders it for rules with plain text and at most one level. |
| `bookmark` | Bookmarks every matching entry, including the entries that already exist when the rule is created. |
| `webhook` | An `http` or `https` URL. For each appended batch with matches, the server POSTs JSON with the rule id and name, the source id and name, the match count, and up to 5 sample entries. |

Webhooks fire only for entries appended after the rule was created, never for the creation-time scan or after a `reset`. Delivery is fire-and-forget with a 5 second timeout and no retries; failures are counted in the rule's `webhookErrors`. A source can have at most 20 rules. Rules are held in memory and removed with their source.

## Retention

Sources that keep entries in memory have a cap. When the cap is exceeded, the oldest entries are evicted, every remaining index shifts down, and the source emits a `reset`.

| Kind | Cap | Eviction |
|---|---|---|
| `stream` | `STREAM_MAX_ENTRIES` (100,000) and `STREAM_MAX_BYTES` (32 MiB) per stream | Down to about 90% of the limit that was crossed, so the next appends don't evict again right away |
| `remote` | `REMOTE_MAX_ENTRIES` (100,000) | Exactly the newest `maxEntries` are kept |
| `provider` | `providerOptions.maxEntries` (100,000) and `maxBytes` (64 MiB) | Down to about 90% of the limit that was crossed, like streams |

A limit of `0` means unbounded. File sources have no entry cap: their index holds a few numbers per entry and the text stays on disk. Merged views hold three numbers per entry and follow their children.

## Modules

`createLogViewer()` assembles the viewer from feature modules. Each module adds its routes and reports its settings under `modules` in `GET /api/v1/capabilities`. The UI reads that response and hides controls for disabled modules.

| Module | Provides | Default in the library | Enabled by |
|---|---|---|---|
| core | Source info, filters, entries, find, bookmarks, rules, parser, locate, correlation, report, minimap, export | Always on | |
| files | Browse and open files under a root, chunks, gzip, directory watch, samples | Off | `files: { root }` |
| streams | Push streams over HTTP, WebSocket and in-process | On | `streams: false` turns it off |
| merge | Merged views | On | `merge: false` turns it off |
| remote | Mirrors of sources on other log-viewer instances | Off | `remote: {}` or `remote: { maxEntries }` |
| providers | Provider catalog and mirrors | Always on, empty without providers | `providers: [...]` or `viewer.registerProvider()` |

The `log-viewer` CLI and the Docker image enable all of them, configured from env vars. See [Library](library.md) and [Configuration](configuration.md).

## Providers: mirror now, pushdown later

A provider exposes logs that live elsewhere, such as rows in a database. In API version 1 the viewer keeps a bounded mirror of each opened log: it loads the newest records (with `tail()`, or by paging `list()`), then follows new ones with `watch()` or by polling `list()`. Every feature runs on the mirror, so a provider only needs list and watch.

The consequence is that records older than the mirror's window are not visible in the viewer. The SPI reserves `count`, `query` and `search` capabilities for a later version, where filters and searches could be pushed down to the provider instead of running on the mirror. Version 1 ignores them. See [Providers](providers.md).

## Authorization

Every protected operation asks one authorizer function with an action name:

| Action | Covers |
|---|---|
| `read` | All `GET` and `HEAD` requests under `/api`, and WebSocket `sub` |
| `view-state` | Creating and deleting filters, setting bookmarks |
| `open` | Opening files, merges, remote mirrors and provider logs |
| `ingest` | Creating, appending to and deleting streams, and WebSocket `publish` |
| `configure` | Deleting a source, setting or clearing a custom parser, creating and deleting rules |

`GET /healthz` is not under `/api` and is not checked.

The built-in key scheme (`VIEW_KEY`, `STREAM_KEY`, `STREAM_TOKENS`) implements this function. With `VIEW_KEY` set, `read` needs the view key (or the master stream key). `ingest` needs the stream key or a token scoped to the channel when keys are configured. `configure` on a stream source follows the `ingest` rule for its channel. `view-state`, `open`, and `configure` on other kinds are always allowed. Library users replace the scheme with `createLogViewer({ authorize })`, for example to check a session cookie or to limit which sources a user may read. See [Security](security.md) and [Library](library.md).
