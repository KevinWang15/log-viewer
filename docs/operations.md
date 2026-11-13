# Operations

This guide covers running log-viewer as a service: the container image,
Compose, reverse proxies, health checks, stream spooling, resource sizing and
the pattern for embedding it in another application. Every setting is listed
in [configuration.md](configuration.md). The security checklist is in
[security.md](security.md).

## Docker

GitHub Actions publishes the image `ghcr.io/kevinwang15/log-viewer` for
`linux/amd64` and `linux/arm64` on every push to `main`. Each build is tagged
with the short commit SHA, the full commit SHA, the branch name, and
`latest`. Pin deployments to a commit tag. `latest` and `main` move, so they
do not give you a controlled rollback.

The image:

- runs `node dist/index.js` as the unprivileged `node` user, with production
  dependencies only;
- listens on port 5178 and declares the volume `/logs`, which is `LOG_ROOT`;
- sets `NODE_ENV=production`, so CORS is off unless `CORS_ORIGIN` is set;
- sets the stream limits to their defaults (`STREAM_MAX_ENTRIES=100000`,
  `STREAM_MAX_BYTES=33554432`, `STREAM_MAX_SOURCES=16`,
  `STREAM_IDLE_TTL_SECONDS=3600`, `STREAM_MAX_PAYLOAD_BYTES=2097152`);
- has a `HEALTHCHECK` that fetches `/healthz` every 30 s.

Demo traffic and sample logs are on by default, as in the CLI. Turn them off
in production.

```bash
docker run -d --name log-viewer --restart always \
  -p 127.0.0.1:5178:5178 \
  --security-opt no-new-privileges \
  -v /var/log/myapp:/logs:ro \
  -e STREAM_KEY="$LOG_VIEWER_SERVICE_KEY" \
  -e ENABLE_DEMO=false \
  -e ENABLE_SAMPLES=false \
  ghcr.io/kevinwang15/log-viewer:<commit-sha>
```

Mount the logs you want to browse at `/logs`, read-only is enough. To keep
streams across restarts, also mount a writable directory and set
`SPOOL_DIR` to it (for example `-v log-viewer-spool:/spool -e
SPOOL_DIR=/spool`). The same commands work with `nerdctl` or `podman`.

Bind the published port to `127.0.0.1` or a private network. In Kubernetes,
use a ClusterIP Service and no Ingress unless an authenticating proxy sits in
front.

To build the image locally:

```bash
docker build -t log-viewer:local .
docker run --rm -p 127.0.0.1:5178:5178 -v /var/log:/logs:ro log-viewer:local
```

## Compose

`compose.integration.yaml` at the repository root runs the published image
for an integration behind another application. It:

- publishes `127.0.0.1:${LOG_VIEWER_PORT:-5178}` only;
- takes the image from `LOG_VIEWER_IMAGE` (default
  `ghcr.io/kevinwang15/log-viewer:latest`);
- sets `STREAM_KEY` from `LOG_VIEWER_SERVICE_KEY`;
- sets the stream limits from `LOG_VIEWER_MAX_ENTRIES`,
  `LOG_VIEWER_MAX_BYTES`, `LOG_VIEWER_MAX_SOURCES`,
  `LOG_VIEWER_IDLE_TTL_SECONDS` and `LOG_VIEWER_MAX_PAYLOAD_BYTES`, with the
  usual defaults;
- turns off demo traffic and sample logs;
- mounts the named volume `log-viewer-logs` read-only at `/logs`;
- sets `no-new-privileges` and `restart: unless-stopped`.

Copy `.env.integration.example` to `.env.integration`, replace the key, and
pin the image to a commit tag:

```bash
cp .env.integration.example .env.integration
# edit LOG_VIEWER_SERVICE_KEY (for example: openssl rand -hex 32) and LOG_VIEWER_IMAGE
docker compose --env-file .env.integration -f compose.integration.yaml pull
docker compose --env-file .env.integration -f compose.integration.yaml up -d
```

`.env.integration` is ignored by git. If the image is private, run
`docker login ghcr.io` with a token that can read packages first.

## Running behind a reverse proxy under a prefix

The UI uses relative asset URLs and derives its API base from the directory
it is served from. A UI at `/logs/` therefore calls `/logs/api/...` and opens
its WebSocket at `/logs/ws`. The proxy must:

- forward HTTP below the prefix and strip the prefix upstream;
- forward the WebSocket upgrade at `<prefix>/ws` to `/ws` upstream;
- redirect `<prefix>` to `<prefix>/`, so relative URLs resolve inside the
  prefix;
- not buffer the WebSocket or redirect the handshake.

nginx example for `/logs/`:

```nginx
location = /logs {
    return 301 /logs/;
}

location /logs/ws {
    proxy_pass http://127.0.0.1:5178/ws;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 1h;
}

location /logs/ {
    proxy_pass http://127.0.0.1:5178/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    # Never forward a browser-supplied stream key.
    proxy_set_header x-stream-key "";
    proxy_buffering off;
}
```

nginx picks the longest matching prefix, so `/logs/ws` wins over `/logs/`.
Put your authentication in front of both locations, for example with
`auth_request`. Authenticating only the HTML page is not enough: the API and
the WebSocket carry the log data.

When log-viewer runs inside a Node.js host app instead, mount it with
`app.use('/logs', viewer.handler)` and `viewer.attach(server, { path:
'/logs/ws' })`. The viewer then handles the redirect itself. See
[library.md](library.md).

## Health

`GET /healthz` is never authenticated:

```json
{ "ok": true, "uptime": 3605.2, "sources": 4, "streams": 2, "streamBytes": 18432, "providerLogs": 0 }
```

| Field | Meaning |
|---|---|
| `ok` | always `true` while the process serves requests |
| `uptime` | process uptime in seconds |
| `sources` | open sources of every kind |
| `streams` | open streams (streams module) |
| `streamBytes` | retained bytes across all streams (streams module) |
| `providerLogs` | open provider mirrors (providers module) |

`GET /api/v1/capabilities` reports the enabled modules and the configured
limits. It needs read access when `VIEW_KEY` is set. Neither endpoint
authenticates users.

The process handles `SIGTERM` and `SIGINT`: it stops the modules, closes
WebSocket connections, closes every source, flushes pending spool writes and
closes the HTTP server.

## Stream spooling

Set `SPOOL_DIR` to a writable directory to keep streams across restarts. The
directory is created on start. When `SPOOL_DIR` is unset, nothing is written
to disk.

### File format

Each channel gets one NDJSON file, `<channel>.spool`. Characters outside
`[A-Za-z0-9._-]` in the channel name become `_`. Two channels that collide
after this change, such as `a:b` and `a_b`, share one file, so avoid such
pairs. The first line is a header with the original channel name. Every other
line is one entry with its parsed fields and the first line of its raw text:

```
{"spool":1,"channel":"web"}
{"t":1752477600000,"lv":2,"th":"T1","lg":"Db","msg":"connected","raw":"2026-07-14 07:20:00,000 [T1] INFO Db - connected"}
```

Continuation lines of multi-line entries (stack traces) are not persisted.

### Durability

- Writes are asynchronous. An append is acknowledged once the entries are in
  memory; the spool write follows on a per-file queue. A crash loses at most
  the writes still queued. A graceful shutdown flushes the queue first.
- Spool write failures are logged and never fail ingestion.
- Deleting a stream, or its idle expiry, deletes its spool file. Shutdown
  keeps the files.

### Compaction

The spooler tracks the bytes it has written to each file. When a file grows
past twice `STREAM_MAX_BYTES`, it is rewritten with only the entries the
stream currently keeps in memory, through a temp file and an atomic rename.
Disk use therefore follows the same retention as memory. With
`STREAM_MAX_BYTES=0`, spool files are never compacted and grow without bound.

### Recovery

On start, before serving streams, the viewer reads every `*.spool` file:

- the header restores the original channel name;
- malformed lines are skipped and counted in one log message per file;
- the newest `STREAM_MAX_ENTRIES` entries are loaded, then the byte limit
  applies, so a spool written under larger limits is trimmed;
- leftover `*.spool.tmp` files from an interrupted compaction are deleted;
- a channel that would exceed `STREAM_MAX_SOURCES` is skipped and logged.

Recovered streams behave like live ones. Their idle TTL starts at the
restart.

## Resource sizing

### Streams

| Setting | Default | Bounds |
|---|---|---|
| `STREAM_MAX_ENTRIES` | 100,000 | entries kept per stream |
| `STREAM_MAX_BYTES` | 32 MiB | estimated bytes kept per stream |
| `STREAM_MAX_SOURCES` | 16 | concurrent streams |
| `STREAM_IDLE_TTL_SECONDS` | 3600 | lifetime of an idle stream |
| `STREAM_MAX_PAYLOAD_BYTES` | 2 MiB | HTTP JSON body and WebSocket message |

`0` disables the first four limits. Keep the entry or the byte limit on in
production. Worst-case stream memory is about `STREAM_MAX_SOURCES ×
STREAM_MAX_BYTES` (512 MiB with the defaults) plus overhead.

When a stream crosses a limit, the oldest entries are evicted until it is
about 10% below the limit. That headroom stops every following append from
evicting again. Each eviction sends subscribers one `reset`. A single entry
is capped at 64 KiB.

### Files

File sources keep only an index in memory: byte offset, timestamp, level,
and thread and logger ids per entry. The index costs about 28 bytes per entry
in its typed arrays and about 38 to 40 bytes per entry measured on the heap,
including spare capacity. A file with 10 million entries needs roughly 300 to
400 MB of index. Entry text stays on disk and is read on demand. Text filters
and searches stream the file in 4 MiB blocks.

Gzipped files are decompressed to `$TMPDIR` first, so the temp volume needs
room for the decompressed size, up to `GZIP_MAX_BYTES` (4 GiB by default)
per file.

### Remote and provider mirrors

Mirrors hold their entries in memory, including the text:

- remote mirrors keep up to `REMOTE_MAX_ENTRIES` (100,000) entries each;
- provider mirrors keep up to 100,000 entries and 64 MiB each, with at most
  16 open at once (library options in `providerOptions`).

### Browser

The UI renders only the visible rows. It fetches 200-entry pages and keeps
at most 20 pages (about 4,000 entries) in an LRU cache, so log volume does
not turn into DOM size. Live updates are coalesced to one render per
animation frame. After a reconnect the UI re-subscribes and gets a fresh
snapshot, so missed notifications leave no gap.

## Dashboard integration pattern

A common deployment runs log-viewer as a private service next to an
existing web application (a deploy dashboard, an admin console). The host
application owns users and permissions. log-viewer owns parsing, bounded
storage, filtering and live updates.

```text
browser ──HTTPS──> host application ──private HTTP/WS──> log-viewer
                          │
                          └── producer (server to server) ──> stream API
```

- Publish log-viewer's port on loopback or a private network only. The
  browser never connects to it directly.
- The host application proxies `/<prefix>/*` and `/<prefix>/ws` and
  authenticates every proxied HTTP request and WebSocket upgrade, not only the
  embed page.
- The producer side of the host application creates a random, short-lived
  channel per log session (`PUT /api/v1/streams/:channel` with
  `x-stream-key`), appends batches of complete lines below the advertised
  payload limit, and deletes the channel when the session ends. The idle TTL
  cleans up after abnormal disconnects.
- Apply backpressure to whatever produces the lines (for example pause the
  child process reading a log) while appends are pending, instead of
  buffering without bound.
- Check `GET /api/v1/capabilities` on start for `apiVersion`, the lifecycle
  routes and the limits. Use the `id` returned by the lifecycle; never build
  source ids.
- Use only the v1 stream routes. The unversioned `/api/streams/:channel`
  routes are deprecated.
- The browser shows the stream with `embed.html?channel=<channel>` or the
  `<log-viewer>` element, served through the proxy. See
  [embedding-ui.md](embedding-ui.md).

When the host application is itself a Node.js server, embedding the library
removes the proxy and the separate container: mount the viewer under a
prefix, pass an `authorize` hook that checks the host's session, and append
to streams in-process. See [library.md](library.md) and
[examples/minimal-embed/](../examples/minimal-embed/).
