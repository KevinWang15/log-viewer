# Embedding log-viewer

log-viewer supports two deployment modes from the same image:

- standalone, with the full UI and API served at `/`;
- embedded, with `embed.html` placed behind another application's authenticated
  reverse proxy.

The recommended embedded topology is:

```text
browser ──HTTPS──> host application ──private HTTP──> log-viewer
                         │
                         └──server-to-server stream producer
```

The host application owns user authentication and authorization. log-viewer
owns parsing, bounded stream storage, filtering, virtualized reads, and live
notifications. It deliberately has no Kubernetes-specific behavior.

## Iframe contract

```html
<iframe
  src="/log-viewer/embed.html?channel=deployment-7f92&server=/log-viewer&title=Backend&follow=1"
  style="width:100%;height:500px;border:0"
></iframe>
```

Parameters:

- `channel`: existing v1 stream channel;
- `server`: API/proxy base, empty for the page origin;
- `title`: display label;
- `follow=0|1`: whether the initial view follows the tail;
- `path`: alternatively opens a server-side file instead of a stream;
- `allowOrigin`: comma-separated list of host page origins allowed to drive
  the widget over `postMessage` (see below). Origins must match exactly —
  scheme, host, and port — e.g. `allowOrigin=https://app.example.com`. When
  the parameter is absent, the bridge is fully disabled: the widget ignores
  every incoming message and never posts anything out;
- `viewKey`: read credential when the server sets `VIEW_KEY`. The widget
  forwards it as a `viewKey` query parameter on API requests and in the
  WebSocket sub message. A reverse proxy should strip it from access logs if
  the key is sensitive;
- `pattern`: log4j-style conversion pattern (e.g.
  `pattern=%d+%5B%t%5D+%25-5p+%25c+-+%25m`, URL-encoded) applied to the
  stream right after the widget subscribes, so producers can declare their
  format instead of relying on auto-detection. An invalid pattern surfaces as
  a `pattern error: …` note in the widget status line. The standalone app
  accepts the same `pattern` query parameter and applies it after the first
  log is opened.

Note that `pattern` POSTs to the mutation endpoint `/api/logs/:id/parser`:
when the server sets `STREAM_KEY`/`STREAM_TOKENS`, that call needs the
stream key. Setting a pattern from the widget therefore only works when
mutations are open (no stream key configured) or the reverse proxy injects
the `x-stream-key` header — the widget never holds the key itself.

The proxy must forward both ordinary HTTP traffic below `/log-viewer/` and the
WebSocket upgrade at `/log-viewer/ws`. It should remove the prefix before sending
requests upstream. Relative frontend assets make the UI safe below this path.

## Web component (iframe-free)

Hosts that can load a script directly can skip the iframe entirely with the
`<log-viewer>` custom element. The built bundle is self-contained (styles are
compiled into the shadow DOM, so the element neither leaks nor requires page
CSS):

```html
<script type="module" src="/log-viewer/assets/component-<hash>.js"></script>
<log-viewer
  channel="deployment-7f92"
  server="/log-viewer"
  title="Backend"
  follow="1"
  style="display:block;height:500px"
></log-viewer>
```

The exact hashed asset name is emitted by `npm run build` (see
`web/dist/component.html`); the same file doubles as a dev harness
(`component.html?server=…&channels=a,b`).

Attributes mirror the iframe query params: `channel`, `server` (API base,
default the page origin), `title`, `follow=0|1`, `pattern`, and `view-key`
(the `viewKey` credential). Changing an attribute after mount — `channel` in
particular — re-mounts the widget and re-subscribes to the new stream. Note
that the API base and view key are module-global: use a single server and key
per page.

Instead of `postMessage`, the element dispatches bubbling DOM events with the
same semantics as the bridge events:

| Event | `detail` | When |
| --- | --- | --- |
| `log-viewer-ready` | `null` | Once, after the initial load completes. |
| `log-viewer-entry-selected` | `{ entry: { t, lv, th, lg, msg } }` | When the user clicks a row. |
| `log-viewer-stats` | `{ count, levels }` | On append ticks, throttled to the widget's animation-frame cadence. |

Because the component runs in the host page's origin, there is no
`allowOrigin` handshake and no cross-origin boundary — the host's own DOM
access rules apply.


## Security boundary

The one-page checklist is in [security.md](security.md). For an authenticated
application integration:

1. Bind the container to loopback (`127.0.0.1:5178`) or use a private container
   network. Do not publish port 5178 on a public interface.
2. Require application authentication for every proxied log-viewer HTTP and
   WebSocket request, not only for `embed.html`.
3. Strip browser-supplied cookies, authorization headers, forwarded headers,
   and `x-stream-key` before proxying. Add only the headers the upstream needs.
4. Keep `STREAM_KEY` in the producer process/container secret store. It is not
   a browser credential, though it also satisfies `VIEW_KEY` read auth.
5. Generate unguessable per-session channels and delete them when the session
   ends. Idle TTL is the safety net for abnormal disconnects.
6. Leave CORS disabled in production for same-origin proxying. Set
   `CORS_ORIGIN` only for an intentional, reviewed cross-origin design.

If log-viewer itself must be internet-facing, place a real authentication
gateway in front of it. Random channel names and `STREAM_KEY` alone do not
protect read endpoints.

## postMessage bridge

With `allowOrigin` set, the widget exchanges JSON messages with the host page
over `postMessage`. All messages carry a `logViewer` string field naming the
command or event.

Security rules enforced by the widget:

- A command is processed only if `event.origin` matches an `allowOrigin`
  entry exactly and `event.source === window.parent`. Everything else —
  unknown commands, wrong field types, non-object payloads — is ignored
  silently.
- Without `allowOrigin` the widget accepts no commands and posts no events
  (fail closed), so existing embeds are unaffected.
- Events are posted with an explicit `targetOrigin`, never `*`: the origin
  that first sent a valid command, or the first `allowOrigin` entry if no
  command has arrived yet. Treat `allowOrigin` as granting control of the
  embedded view; list only origins you trust.

Host → widget commands:

| Message | Effect |
| --- | --- |
| `{ logViewer: 'setFilter', text: string }` | Applies the text filter, same as typing in the filter box and pressing Enter. |
| `{ logViewer: 'setFollow', follow: boolean }` | Toggles follow/tail mode, same as the ▶ toolbar button. |
| `{ logViewer: 'clear' }` | Clears the current text filter. |

Widget → host events:

| Message | When |
| --- | --- |
| `{ logViewer: 'ready' }` | Once, after the initial load completes. |
| `{ logViewer: 'entrySelected', entry: { t, lv, th, lg, msg } }` | When the user clicks a row. `t` is the epoch-ms timestamp, `lv` the level index (0=TRACE … 5=FATAL), `th`/`lg` thread and logger, `msg` the parsed message. |
| `{ logViewer: 'stats', count, levels }` | On append ticks, throttled to the widget's existing animation-frame update cadence. `count` is the number of entries in the current view (after filters), `levels` the per-level totals for the whole source. |

Minimal host page:

```html
<iframe
  id="logs"
  src="/log-viewer/embed.html?channel=deployment-7f92&server=/log-viewer&allowOrigin=https://app.example.com"
  style="width:100%;height:500px;border:0"
></iframe>
<script>
  const frame = document.getElementById('logs');
  window.addEventListener('message', (e) => {
    if (e.origin !== 'https://log-viewer.internal' || e.source !== frame.contentWindow) return;
    if (e.data?.logViewer === 'entrySelected') console.log('selected', e.data.entry);
  });
  // e.g. focus on errors mentioning "timeout", then stop following:
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ logViewer: 'setFilter', text: 'timeout' }, 'https://log-viewer.internal');
    frame.contentWindow.postMessage({ logViewer: 'setFollow', follow: false }, 'https://log-viewer.internal');
  });
</script>
```

## Producer integration

Use the explicit lifecycle in [Stream API v1](api-v1.md) (machine-readable:
[openapi.yaml](openapi.yaml)). Copy-paste producers for Node.js, Python, curl,
and winston live in [snippets/](snippets/). A host application
should create the channel before starting its log subprocess, batch complete
lines into requests below the advertised payload limit, apply backpressure to
the subprocess, and delete the channel during normal and timeout cleanup.

The deploy-dashboard implementation is the reference integration. It checks
`/api/v1/capabilities`, uses random channels, pauses `kubectl logs` when its
pending byte budget is reached, and proxies all viewer traffic through its
existing authenticated origin.

## Standalone mode

Run the same service without a proxy and open `/`. Development defaults create
sample files and a `demo` stream. In a production embedded deployment, set
`ENABLE_DEMO=false` and `ENABLE_SAMPLES=false`.
