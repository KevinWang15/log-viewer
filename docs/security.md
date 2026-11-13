# Security

This page covers what log-viewer exposes, how the built-in key scheme
authorizes requests, how to replace it with your own `authorize` hook, and
what to check before a deployment. Route-level details are in
[HTTP and WebSocket API](api.md).

## Threat model

**Log contents are sensitive.** Logs routinely contain tokens, personal data,
internal hostnames and stack traces. Anyone who passes the `read` check can
list sources, read every retained entry, search, export and subscribe to live
updates.

**Reads are open by default.** Without `VIEW_KEY` (library: `auth.viewKey`)
or a custom authorizer, anyone who can reach the port can read everything.

**File browsing is confined to a root.** With the files module enabled (the
CLI always enables it), `/api/browse`, `/api/stat` and `POST /api/logs/open`
only accept paths under `LOG_ROOT` (default: the home directory of the user
running the server) and the sample-logs directory. Paths are resolved before
the check, so `..` cannot escape. Symbolic links inside the root are
followed, so a link can expose a file outside it. Within the root, every readable file is
exposed, including hidden files opened by exact path (the browser listing
skips names starting with `.`). The programmatic `viewer.files.open()` does
not apply the root check.

**Ingestion endpoints accept writes.** Stream routes
(`PUT`/`POST`/`DELETE /api/v1/streams/...`, the deprecated
`POST /api/streams/:channel`) and the WebSocket `publish` message let
producers create streams and append entries. Without `STREAM_KEY` or
`STREAM_TOKENS`, anyone who can reach the port can write fake log lines.

**The server makes outbound requests.** Remote mirrors
(`POST /api/logs/remote`, always enabled in the CLI, off by default in the
library) make the server fetch any http(s) URL the caller supplies. Rules with a
`webhook` action make the server POST matching entries to any http(s) URL.
Both can reach hosts on the server's internal network.

**The stream key is a server-to-server credential.** It authorizes writes, and
the master `STREAM_KEY` also satisfies read checks. It must live in the
producer's secret store and never appear in browser JavaScript, iframe URLs
or `postMessage` traffic.

## The default authorization matrix

Every protected operation asks the viewer's authorizer for one of five
actions. Without an `authorize` option, the viewer uses
`keyAuthorizer({ viewKey, streamKey, streamTokens })`. The CLI fills these
from `VIEW_KEY`, `STREAM_KEY` and `STREAM_TOKENS`.

| Action | Requests | Default rule |
| --- | --- | --- |
| `read` | Every `GET`/`HEAD` under `/api` (sources list, entries, search, export, report, minimap, bookmarks, capabilities, browse, stat, provider catalog, stream info). WebSocket `sub`. | Allowed when no view key is set. Otherwise the view key (`x-view-key` header or `?viewKey=`) or the master stream key (`x-stream-key`) is required. Scoped tokens do not grant reads. |
| `view-state` | Create or delete a filter, toggle a bookmark. | Always allowed. |
| `open` | Open a file, create a merged view, open a remote mirror, open a provider log. | Always allowed. |
| `ingest` | Create, append to or delete a stream. WebSocket `publish`. | Allowed when neither `STREAM_KEY` nor `STREAM_TOKENS` is set. Otherwise the master stream key, or a scoped token whose prefix matches the channel (an empty prefix or `*` matches every channel). |
| `configure` | Delete a source, set or clear a custom parser, create or delete a rule. | For stream sources, the same rule as `ingest`, with the stream's channel. For all other sources, always allowed. |

Not checked by the authorizer: `GET /healthz` and the static UI files
(`index.html`, `embed.html`, assets).

Credentials by transport:

| Transport | View key | Stream key |
| --- | --- | --- |
| HTTP | `x-view-key` header, or `viewKey` query parameter | `x-stream-key` header |
| WebSocket `sub` | `viewKey` field of the message | `key` field of the message |
| WebSocket `publish` | not used | `key` field, checked against the message's `channel` |

`STREAM_TOKENS` is a comma-separated list of `token=channelPrefix` entries,
for example `abc=web-,def=job-`. Token `abc` may write to `web-1` but not to
`job-1`.

Denials:

| Result | HTTP response |
| --- | --- |
| `read` denied | 401 `{ "error": "invalid or missing x-view-key header" }` |
| `ingest` or `configure` denied | 401 `{ "error": "invalid or missing x-stream-key header" }` |
| WebSocket `sub` denied | Frame `{ "type": "error", "code": "view_auth_required", "error": "invalid or missing viewKey" }`. The connection stays open. |
| WebSocket `publish` denied | The message is dropped. No frame is sent. |

### What the defaults do not protect

The view key only guards `GET`/`HEAD` reads and WebSocket subscriptions.
Because `open`, `view-state` and non-stream `configure` are always allowed,
a caller without any key can still:

- Open any file under `LOG_ROOT`. The response includes the source's entry
  count, per-level counts, and thread and logger names.
- Create filters on any source. The response carries the match count, which
  can confirm whether a given text appears in a log.
- Create a rule with a `webhook` on a file, provider, merged or remote
  source. The server then POSTs the first-line messages of new matching
  entries to the caller's URL.
- Delete file, provider, merged and remote sources.
- Make the server fetch any http(s) URL through remote mirrors, when the
  remote module is enabled.

The deprecated `GET /api/streams/:channel` also creates a stream, and it is
checked only as a `read`.

In any deployment where untrusted users can reach the server, put `open`,
`view-state` and `configure` behind your own authorizer, or behind a reverse
proxy that authenticates every request.

## The authorize hook

Pass `authorize` to `createLogViewer` to replace the key scheme. `auth` is
then ignored.

```ts
type AuthAction = 'read' | 'view-state' | 'open' | 'ingest' | 'configure';
type AuthDecision = boolean | { status: number; error: string; code?: string };
type Authorizer = (ctx: AuthContext) => AuthDecision | Promise<AuthDecision>;
```

`AuthContext`:

| Field | Meaning |
| --- | --- |
| `action` | One of the five actions. |
| `transport` | `'http'` or `'ws'`. |
| `source` | `{ id, kind, name }` of the targeted source, when the request names an existing one. `kind` is `file`, `stream`, `merged`, `remote`, `provider`, or your own. |
| `channel` | The stream channel, for `ingest` and for reads of `/api/v1/streams/:channel`. |
| `credentials` | `{ viewKey?, streamKey? }` as sent by the client (see the credentials table above). |
| `headers` | Request headers. For WebSocket messages, the headers of the upgrade request. |
| `req` | The request object. For HTTP it is the Express request, so `originalUrl` holds the full path. For WebSocket it is the upgrade request. |

Decisions:

| Return | Effect |
| --- | --- |
| `true` | Allowed. |
| `false` | Denied with the default response: 401 for `read`, `ingest` and `configure` (messages as above), 403 `forbidden` for `open` and `view-state`. |
| `{ status, error, code? }` | Denied with this status and JSON body `{ error, code }`. |

The authorizer may be async, for example to look up a session.

### Per-source read scoping

The authorizer can limit which sources each user reads:

- Routes under `/api/logs/:id/...` and `/api/v1/streams/:channel` pass the
  source in `ctx.source`.
- `GET /api/logs` first runs a `read` check without a source (deny it to
  reject the whole request). It then asks once per source and lists only the
  sources for which the authorizer returned exactly `true`.
- A WebSocket `sub` passes the source when it exists. A denial sends the
  error frame with your `code`, or `view_auth_required` when you return
  `false` or a decision without `code`.

Points to handle in a scoped authorizer:

- `ctx.source` is undefined for ids that do not exist. HTTP routes then
  answer 404, but a WebSocket `sub` to an unknown id is recorded and starts
  receiving count updates if a source with that id appears later. Deny WebSocket reads
  without a source.
- A merged view (`kind: 'merged'`) contains its children's entries. Creating
  one asks for `open`, then for `read` on every child, so a caller can only
  merge logs it may read.
- `view-state` and `configure` also carry `ctx.source`. Apply the same scope
  there, because filters reveal match counts and rules can send entries to
  webhooks.
- Provider logs are scoped before they are opened. Opening
  (`POST /api/v1/providers/:pid/logs/:logId/open`) asks for `open` and `read`
  with `ctx.source` set to `{ id: 'p:<provider>:<log>', kind: 'provider',
  name: <log id> }`, the id the log gets once open. The catalog
  (`GET /api/v1/providers/:pid/logs`) lists only the logs for which `read`
  with that source returns `true`.

An example for an app with sessions and teams:

```ts
import { createLogViewer, type Authorizer } from '@kevinwang15/log-viewer';

declare function sessionUser(req: unknown): Promise<{ admin: boolean; team: string } | undefined>;

const authorize: Authorizer = async (ctx) => {
  const user = ctx.req ? await sessionUser(ctx.req) : undefined;
  if (!user) return { status: 401, error: 'log in first' };
  if (ctx.action === 'ingest') return false; // producers write in-process only
  if (user.admin) return true;
  if (ctx.action === 'open' || ctx.action === 'configure') return { status: 403, error: 'admins only' };
  // read and view-state: own team's sources only
  if (!ctx.source) return ctx.transport === 'http';
  if (ctx.source.kind === 'merged') return false;
  return ctx.source.name.startsWith(`${user.team}-`) || { status: 403, error: 'not your log', code: 'forbidden_source' };
};

const viewer = createLogViewer({ authorize });
```

The browser UI sends cookies with its API calls and its WebSocket upgrade, so
a cookie session works without changes to the UI. See
[examples/minimal-embed](../examples/minimal-embed/server.mjs) and
[Library](library.md).

## Deployment checklist

- [ ] **Bind to loopback or a private network.** Publish `127.0.0.1:5178` or
      a private container network, never a public interface. In the library,
      pass a host to `listen(port, '127.0.0.1')`; without one, Node listens on
      all interfaces.
- [ ] **Authenticate in front of the viewer.** Put a reverse proxy with your
      app's authentication in front, and require it on every proxied HTTP
      request and on the WebSocket upgrade (`/ws`, or `<prefix>/ws`), not
      only on `embed.html`. If the viewer must be internet-facing, use a real
      authentication gateway; random channel names and `STREAM_KEY` alone do
      not protect reads.
- [ ] **Set credentials or an authorizer.** Set `VIEW_KEY` for readers and
      `STREAM_KEY` (or scoped `STREAM_TOKENS`) for producers. In multi-user
      deployments, use a custom `authorize` hook that also covers `open`,
      `view-state` and `configure`, as described above.
- [ ] **Strip credentials at the proxy.** Remove browser-supplied
      `x-stream-key`, cookies, `authorization` and forwarded headers before
      proxying, and add only what upstream needs. If the widget's `pattern`
      parameter should work on streams protected by a stream key, the proxy
      (not the browser) injects `x-stream-key` on `/api/logs/:id/parser`.
- [ ] **Keep `viewKey` out of access logs.** The UI sends the view key as a
      `viewKey` query parameter, so strip it from logged request URLs.
- [ ] **Restrict CORS.** The library disables CORS by default. The CLI allows
      any origin unless `NODE_ENV=production` or `CORS_ORIGIN` is set. Set
      `NODE_ENV=production` for same-origin proxying, or set `CORS_ORIGIN` to
      a comma-separated allow-list of exact origins. With open CORS and no
      view key, any web page a user visits can read a viewer running on
      their machine.
- [ ] **Keep `LOG_ROOT` minimal.** Point it at the log directory, not a home
      directory or `/`. Every readable file below it can be opened.
- [ ] **Cap decompression.** `GZIP_MAX_BYTES` (default 4 GiB) caps the
      decompressed size of gzipped logs, which are inflated to a temporary
      file. Lower it to fit the temp volume.
- [ ] **Size the stream limits.** `STREAM_MAX_ENTRIES` (100,000),
      `STREAM_MAX_BYTES` (32 MiB), `STREAM_MAX_SOURCES` (16),
      `STREAM_IDLE_TTL_SECONDS` (3600) and `STREAM_MAX_PAYLOAD_BYTES` (2 MiB)
      bound memory per stream and per request. Idle expiry is the safety net
      for leaked channels.
- [ ] **Control outbound traffic.** Remote mirrors and rule webhooks make the
      server send requests to caller-chosen URLs. Restrict egress at the
      network level, or deny `open` and `configure` to untrusted users. In the
      library, leave `remote` off unless you need it.
- [ ] **Disable development data.** Set `ENABLE_DEMO=false` and
      `ENABLE_SAMPLES=false`.
- [ ] **Use unguessable, short-lived channels.** Generate random channel names
      per session and delete them when the session ends.

See [Configuration](configuration.md) for every env var and
[Operations](operations.md) for proxy setup.

## Embedding boundary

The UI can be embedded as an iframe (`embed.html`) or as the `<log-viewer>`
web component. Details are in [Embedding the UI](embedding-ui.md).

**Iframe.** The iframe is a separate document. Its `postMessage` bridge is
off unless the `allowOrigin` parameter lists host page origins:

- Without `allowOrigin`, the widget ignores every incoming message and posts
  nothing.
- With it, a command is processed only if `event.origin` exactly matches an
  `allowOrigin` entry (scheme, host and port) and `event.source` is the
  parent window. Malformed and unknown messages are ignored.
- Events are posted with an explicit target origin, never `*`: the origin of
  the first valid command, or the first `allowOrigin` entry before any
  command arrives.
- A listed origin can change the widget's filter and follow mode and receives
  selected entries and counts. List only origins you trust.

**Web component.** The element runs in the host page's origin, inside a shadow
root. There is no origin boundary between it and the host page, and the host
page's scripts can read everything it displays. Its API base and view key are
global to the page.

**Credentials in the browser.** Both forms accept a view key (`viewKey`
parameter, `view-key` attribute) and send it on every request. Never give
the browser the stream key. When the host app's session already guards the
proxied viewer, the browser needs no key at all.
