# Operations Guide

## Resource controls

| Variable | Default | Meaning |
|---|---:|---|
| `STREAM_MAX_ENTRIES` | 100,000 | retained entries per stream |
| `STREAM_MAX_BYTES` | 33,554,432 | estimated retained bytes per stream |
| `STREAM_MAX_SOURCES` | 16 | concurrent in-memory streams |
| `STREAM_IDLE_TTL_SECONDS` | 3,600 | idle stream lifetime |
| `STREAM_MAX_PAYLOAD_BYTES` | 2,097,152 | HTTP JSON and WebSocket frame limit |

Zero disables the first four limits. The payload limit always remains
positive. Keep at least the entry or byte limit enabled in production.

After a stream crosses an entry or byte limit, the server evicts from the head
until it has about ten percent headroom. Evicted objects are released
immediately; the backing arrays are compacted only occasionally. This avoids
both unbounded bursts and an O(n) array copy on every retention event. A single
entry is capped at 64 KiB.

The browser renders only visible rows, fetches 200-entry pages, and keeps a
20-page LRU cache (about 4,000 entries). Log payload volume therefore does not
translate into an equally large browser DOM or cache.

Browser stream notifications are coalesced to one update per animation frame,
and scrolls that remain within the same visible row range do not rebuild the
DOM. Reconnects use bounded exponential backoff and resubscribe with an
authoritative snapshot, so missed notifications do not create a data gap.

## Stream spooling

Set `SPOOL_DIR` to a writable directory to make streams durable across
restarts; the directory is created recursively on boot. When unset (the
default) nothing is written to disk and behavior is unchanged.

Each channel gets one NDJSON file, `<channel>.spool` (channel characters
outside `[A-Za-z0-9._-]` become `_`; avoid channel names that collide after
this sanitization, e.g. `a:b` and `a_b`, as they would share one file). The
first line is a header carrying the original channel name; every following
line is one entry with its parsed fields (time, level, thread, logger,
message) and the first line of its raw text — continuation lines of
multi-line entries are not persisted.

Durability semantics:

- Appends are at-least-once and fire-and-forget: the HTTP/WS append is
  acknowledged once entries are in memory, and the spool write happens on a
  serialized per-file queue. A crash loses at most the writes still in that
  queue (the crash window); a graceful SIGTERM/SIGINT flushes it first.
- Spool write failures are logged and never fail ingestion.
- Once a spool file exceeds ~2x `STREAM_MAX_BYTES` it is atomically rewritten
  (temp file + rename) with only the entries currently retained in memory, so
  disk usage stays bounded by the same retention policy as RAM. With
  `STREAM_MAX_BYTES=0` (unbounded) spool files grow without compaction.
- On boot each spool file recreates its channel and loads the tail within the
  retention caps, so a spool written under larger limits is trimmed on load.
  Malformed lines are skipped (counted, logged once per file). Recovered
  streams behave exactly like live ones, including deletion and idle expiry,
  both of which remove the spool file.

## Container deployment

The image runs as the unprivileged Node user and contains production
dependencies only. A private host deployment should look like:

```bash
nerdctl run -d --name log-viewer --restart always \
  -p 127.0.0.1:5178:5178 \
  --security-opt no-new-privileges \
  -e STREAM_KEY="$LOG_VIEWER_SERVICE_KEY" \
  -e STREAM_MAX_ENTRIES=100000 \
  -e STREAM_MAX_BYTES=33554432 \
  -e STREAM_MAX_SOURCES=16 \
  -e STREAM_IDLE_TTL_SECONDS=3600 \
  -e STREAM_MAX_PAYLOAD_BYTES=2097152 \
  -e ENABLE_DEMO=false \
  -e ENABLE_SAMPLES=false \
  ghcr.io/kevinwang15/log-viewer:<immutable-commit-tag>
```

The checked-in Compose file has the same loopback binding and defaults. In
Kubernetes, prefer a ClusterIP Service with no Ingress. If a host process must
reach it, bind any host port to `127.0.0.1` only.

## Health and diagnostics

`GET /healthz` reports uptime, source count, stream count, and retained stream
bytes. `GET /api/v1/capabilities` reports the active protocol and configured
limits. Neither endpoint should be treated as user authentication.

Common failures:

- `401` on mutation: producer and service do not share the same `STREAM_KEY`.
- `404` on append/read: the stream was never created, was explicitly deleted,
  or reached its idle TTL.
- `413`: producer batch exceeds `STREAM_MAX_PAYLOAD_BYTES`; reduce producer
  batch bytes rather than increasing the limit without a memory review.
- `503 stream_capacity_reached`: too many concurrent channels; look for missed
  cleanup, shorten TTL, or deliberately raise `STREAM_MAX_SOURCES`.
- iframe connects but does not update: confirm the proxy upgrades
  `/log-viewer/ws` and does not buffer or redirect the handshake.

The process handles SIGTERM/SIGINT, stops accepting connections, closes
WebSockets, and releases sources. Pin deployments to immutable commit tags;
GitHub Actions also publishes `main` and `latest` for convenience, but those
are unsuitable for a controlled rollback.
