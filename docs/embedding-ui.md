# Embedding the UI

log-viewer ships a compact log widget for other web pages: a toolbar (follow,
level toggles, text filter), a virtualized grid and a detail pane, bound to
one stream or one file. You can embed it two ways:

- as an iframe of `embed.html`, which works from any page and isolates the
  widget completely;
- as the `<log-viewer>` custom element, for pages that can load a script
  from the viewer.

Both need the viewer's HTTP API and WebSocket reachable from the browser,
usually through the host application's authenticated reverse proxy. See
[operations.md](operations.md#running-behind-a-reverse-proxy-under-a-prefix)
for the proxy and [security.md](security.md) for the security boundary. The
full standalone UI (`index.html`) can be mounted under a prefix the same way.

## Iframe

```html
<iframe
  src="/log-viewer/embed.html?channel=deployment-7f92&title=Backend&follow=1"
  style="width:100%;height:500px;border:0"
></iframe>
```

Query parameters:

| Parameter | Meaning |
|---|---|
| `channel` | Stream channel to show. The stream must already exist (create it with `PUT /api/v1/streams/:channel`); otherwise the status line shows the `404` error. Without `channel` and `path`, the widget shows the `demo` channel. |
| `path` | Show a server-side file instead of a stream. The widget opens it with `POST /api/logs/open`, so the files module must be enabled and the path must be under its root. |
| `server` | API base. Defaults to the directory `embed.html` is served from, so `/log-viewer/embed.html` talks to `/log-viewer/api/...` and `/log-viewer/ws`. Set it only when the API lives elsewhere. |
| `title` | Label in the toolbar. Defaults to `stream: <channel>` or the file name. |
| `follow` | `0` starts without following the tail. Default: follow. |
| `pattern` | log4j-style conversion pattern applied to the stream after subscribing, URL-encoded, e.g. `pattern=%25d%20%5B%25t%5D%20%25-5p%20%25c%20-%20%25m`. Streams only. |
| `viewKey` | Read credential when the server requires a view key. Sent as the `viewKey` query parameter on API calls and in the WebSocket `sub` message. |
| `allowOrigin` | Comma-separated host page origins allowed to use the postMessage bridge. Without it the bridge is off. |

Notes:

- `pattern` calls `POST /api/logs/:id/parser`, which is a `configure`
  action. With stream keys configured it needs `x-stream-key`, which the
  browser never holds. It therefore only works when stream mutations are
  open, when the proxy adds the key for that route, or when a custom
  `authorize` hook allows it. Errors appear as `pattern error: …` in the
  status line. The standalone UI accepts the same `?pattern=` parameter.
- `viewKey` travels in URLs. If it is sensitive, strip it from the proxy's
  access logs.
- When `server` points at another origin, that origin must allow CORS and
  WebSocket connections from the page.

## Web component

```html
<script type="module" src="/log-viewer/assets/component-<hash>.js"></script>
<log-viewer
  channel="deployment-7f92"
  server="/log-viewer"
  title="Backend"
  style="display:block;height:500px"
></log-viewer>
```

The script name contains a content hash. `npm run build` writes it to
`web/dist/component.html`, and the npm package ships the same file in
`ui/component.html`. Load the script from the viewer's own `assets/`
directory: it imports sibling chunks from there. Styles are compiled into the
element's shadow root, so the element does not leak styles and needs no page
CSS.

Attributes:

| Attribute | Meaning |
|---|---|
| `channel` | Stream channel. Defaults to `demo`. |
| `server` | API base. Defaults to the page origin (`""`), unlike the iframe. Set it to the viewer's mount path, e.g. `/log-viewer`. |
| `title` | Toolbar label. |
| `follow` | `0` starts without following the tail. |
| `pattern` | Conversion pattern, as for the iframe. |
| `view-key` | Read credential, as `viewKey` for the iframe. |

The element supports streams only; it has no `path` attribute. Changing any
attribute after it is connected re-mounts the widget and re-subscribes.
`server` and `view-key` are global to the page's module instance, so use one
server and one view key per page.

Events, dispatched on the element and bubbling:

| Event | `detail` | When |
|---|---|---|
| `log-viewer-ready` | `null` | once, after the initial load |
| `log-viewer-entry-selected` | `{ entry: { t, lv, th, lg, msg } }` | the user selects a row |
| `log-viewer-stats` | `{ count, levels }` | after live updates, at most once per animation frame |
| `log-viewer-filter-changed` | `{ criteria, source }` | the filter changed; `source` is `'user'` or `'api'` (your own `criteria` assignment) |

```js
document.querySelector('log-viewer').addEventListener('log-viewer-entry-selected', (e) => {
  console.log(e.detail.entry.msg);
});
```

The filter is the `criteria` property, with the same shape as the HTTP
filter criteria (`levels`, `text`, `threads`, `loggers`, `fields`,
`timeFrom`, `timeTo`). Assigning replaces it; reading returns the current
one. Clicking a field in the detail pane adds it to the filter.

```js
const viewer = document.querySelector('log-viewer');
viewer.criteria = { levels: [4, 5], fields: { tenant: ['acme'] } };
```

The element never writes the filter anywhere: not to the URL, not to
storage. To keep it in your router or state, listen to
`log-viewer-filter-changed` and ignore `source: 'api'` changes you made
yourself:

```js
viewer.addEventListener('log-viewer-filter-changed', (e) => {
  if (e.detail.source === 'user') router.replace({ query: { filter: JSON.stringify(e.detail.criteria) } });
});
```

The element runs in the host page's origin, so there is no origin check
between them. Anything on the page can read what the element shows.

## postMessage bridge

With `allowOrigin` set, the iframe exchanges messages with its parent page.
Every message is an object with a `logViewer` field naming the command or
event.

Rules the widget enforces:

- It processes a command only when `event.origin` exactly matches an
  `allowOrigin` entry (scheme, host and port) and `event.source` is
  `window.parent`.
- Unknown commands, wrong field types and non-object messages are ignored.
- Without `allowOrigin` it accepts no commands and posts no events.
- It posts events with an explicit target origin, never `*`: the origin of
  the first valid command, or the first `allowOrigin` entry until a command
  arrives.

`allowOrigin` grants control of the embedded view. List only origins you
trust.

Host to widget:

| Message | Effect |
|---|---|
| `{ logViewer: 'setCriteria', criteria: object }` | Replaces the filter (same shape as the element's `criteria`). |
| `{ logViewer: 'setFilter', text: string }` | Applies a text filter, like typing in the filter box and pressing Enter. |
| `{ logViewer: 'setFollow', follow: boolean }` | Turns following the tail on or off. |
| `{ logViewer: 'clear' }` | Clears the text filter. |

Widget to host:

| Message | When |
|---|---|
| `{ logViewer: 'ready' }` | once, after the initial load |
| `{ logViewer: 'entrySelected', entry: { t, lv, th, lg, msg } }` | the user selects a row. `t` is epoch ms, `lv` the level (0 = TRACE to 5 = FATAL), `th` and `lg` thread and logger, `msg` the first line of the message. The raw entry text is never sent. |
| `{ logViewer: 'stats', count, levels }` | after live updates, at most once per animation frame. `count` is the number of rows in the current view (after filters), `levels` the per-level totals of the whole source. |
| `{ logViewer: 'filterChanged', criteria, source }` | the filter changed. `source` is `'user'`, or `'api'` after your `setCriteria`. The widget never puts the filter in its URL; keep it in the host if you want deep links. |

Host page example, with the viewer proxied under `/log-viewer/` on the same
origin `https://app.example.com`:

```html
<iframe
  id="logs"
  src="/log-viewer/embed.html?channel=deployment-7f92&allowOrigin=https://app.example.com"
  style="width:100%;height:500px;border:0"
></iframe>
<script>
  const frame = document.getElementById('logs');
  const viewerOrigin = 'https://app.example.com';
  window.addEventListener('message', (e) => {
    if (e.origin !== viewerOrigin || e.source !== frame.contentWindow) return;
    if (e.data?.logViewer === 'entrySelected') console.log('selected', e.data.entry);
  });
  frame.addEventListener('load', () => {
    frame.contentWindow.postMessage({ logViewer: 'setFilter', text: 'timeout' }, viewerOrigin);
    frame.contentWindow.postMessage({ logViewer: 'setFollow', follow: false }, viewerOrigin);
  });
</script>
```

When the iframe is served from another origin, use that origin as
`viewerOrigin` and keep `allowOrigin` set to the host page's origin.

## Producers

The widget shows what producers push into a stream:

- the HTTP lifecycle (`PUT`, `POST .../entries`, `DELETE`) in
  [api.md](api.md#streams), with the schema in [openapi.yaml](openapi.yaml);
- WebSocket `publish` messages, see [api.md](api.md#websocket);
- `viewer.streams.append(channel, lines)` when the viewer runs inside your
  Node.js process, see [library.md](library.md).

Ready-made producers are in [snippets/](snippets/):
[curl.sh](snippets/curl.sh), [node-fetch.mjs](snippets/node-fetch.mjs),
[python.py](snippets/python.py) and
[winston-transport.js](snippets/winston-transport.js).

A host application should create the channel before it starts producing,
send batches of complete lines below the advertised payload limit, apply
backpressure to its log source while appends are pending, and delete the
channel when the session ends. See
[operations.md](operations.md#dashboard-integration-pattern).

## Security

The embedded widget is only as private as the routes that serve it. Keep the
stream key out of the browser, authenticate every proxied HTTP request and
WebSocket upgrade, and use unguessable, short-lived channels. The checklist
is in [security.md](security.md).
