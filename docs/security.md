# Securing a Deployment

One page of guidance for running log-viewer in production. See
[embedding.md](embedding.md) for the full embedded topology and
[api-v1.md](api-v1.md) for the auth mechanics of each endpoint.

## Threat model

- **Read endpoints are open by default.** Unless `VIEW_KEY` is set, anyone who
  can reach port 5178 can list sources, read every retained log line, search,
  and export. Logs routinely contain tokens, user data, and internal topology
  — treat read access as sensitive.
- **The stream key is a server-to-server credential.** `STREAM_KEY` /
  `STREAM_TOKENS` authorize producers to create streams, append entries, set
  parsers, and manage rules. The key must live in the producer's secret store;
  it must never appear in browser JavaScript, iframe URLs, or `postMessage`
  traffic.
- **Embeds inherit the host's authentication via the reverse proxy.** The
  iframe widget and the `<log-viewer>` element are served from the host
  application's authenticated origin (`/log-viewer/*` proxied to log-viewer), so
  log-viewer itself never sees end users and needs no session logic of its
  own.

## Checklist

- [ ] **Bind loopback / private network only.** Publish `127.0.0.1:5178` (or a
      private container network), never a public interface. If port 5178 is
      published directly, all of the above breaks: with no `VIEW_KEY` the
      internet can read your logs; the `x-stream-key` can be observed or
      brute-forced without rate limiting; and the file APIs
      (`/api/logs/open`, `/api/browse`, `/api/stat`) expose the server's
      `LOG_ROOT` filesystem to anonymous callers.
- [ ] **Reverse-proxy `/log-viewer` with WebSocket upgrade.** Forward both HTTP
      below `/log-viewer/` and the WS upgrade at `/log-viewer/ws`, strip the prefix
      upstream, and require the host application's authentication on every
      proxied request — not just on `embed.html`/`component.html`.
- [ ] **Set the credentials.** `STREAM_KEY` (or scoped `STREAM_TOKENS`
      `token=channelPrefix` entries) for producers, `VIEW_KEY` for readers.
      The widget forwards `VIEW_KEY` as the `viewKey` query parameter / WS
      sub field; the master stream key also satisfies read auth.
- [ ] **Strip `x-stream-key` at the proxy.** Remove browser-supplied
      `x-stream-key`, cookies, authorization, and forwarded headers before
      proxying; add only what upstream needs. If the widget's `pattern`
      param should work, the proxy (not the browser) injects the stream key
      on `/api/logs/:id/parser`.
- [ ] **Keep `viewKey` out of access logs.** The read credential travels as a
      query parameter, so configure the proxy to strip `viewKey` from logged
      request paths if the key is sensitive.
- [ ] **Size the limits.** `STREAM_MAX_ENTRIES` (100k), `STREAM_MAX_BYTES`
      (32 MiB), `STREAM_MAX_SOURCES` (16), `STREAM_IDLE_TTL_SECONDS` (3600),
      `STREAM_MAX_PAYLOAD_BYTES` (2 MiB) bound memory per stream and total
      ingestion; `GZIP_MAX_BYTES` (4 GiB) caps decompression of gzipped log
      files. Tighten them to your volume; idle TTL is the safety net for
      leaked channels.
- [ ] **Disable dev data.** `ENABLE_DEMO=false`, `ENABLE_SAMPLES=false`, and
      leave `CORS_ORIGIN` unset for same-origin proxying.
- [ ] **Use unguessable, short-lived channels.** Generate random channel
      names per session and `DELETE` them when the session ends.
