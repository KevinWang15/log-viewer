// Embeddable log viewer widget.
//
// Usage from any site:
//   <iframe src="http://<server>/embed.html?channel=myapp" style="width:100%;height:400px"></iframe>
//
// Producers push log lines to the channel:
//   PUT /api/v1/streams/myapp
//   POST /api/v1/streams/myapp/entries  {"lines": ["2026-07-13 10:00:00,000 [Main] INFO App - hello"]}
// or over WebSocket: {"type":"publish","channel":"myapp","lines":[...]}
//
// Query params: channel (stream mode), path (server-side file mode),
// server (API origin, defaults to the directory serving embed.html), title, follow=0|1,
// pattern (log4j-style conversion pattern applied to the stream after
// subscribing), viewKey (read credential when the server sets VIEW_KEY),
// allowOrigin (comma-separated host origins allowed to drive the widget
// over postMessage; without it the bridge stays disabled).
//
// The UI itself lives in widget.ts and is shared with the <log-viewer>
// custom element (component.ts); this file only adapts URL params and the
// postMessage bridge.

import './styles.css';
import * as api from './api';
import { mountLogWidget } from './widget';

const params = new URLSearchParams(location.search);
const server = params.get('server') || '';
api.setBase(server || api.deriveBase());
const viewKey = params.get('viewKey');
if (viewKey) api.setViewKey(viewKey);

// ---- postMessage bridge -----------------------------------------------------
// Two-way protocol with the host page, documented in docs/embedding-ui.md.
// The bridge is opt-in: it activates only when the embed URL carries an
// `allowOrigin` parameter (comma-separated list of exact host origins).
// Without it every incoming message is ignored and nothing is ever posted,
// so existing embeds behave exactly as before (fail closed).
const allowedOrigins = (params.get('allowOrigin') || '')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);
// Events are posted to the origin that first sent a valid command, falling
// back to the first allowlisted origin (the common single-host case).
let eventOrigin = allowedOrigins[0] || '';

function postToHost(msg: Record<string, unknown>) {
  if (!eventOrigin || window.parent === window) return;
  window.parent.postMessage(msg, eventOrigin);
}

const widget = mountLogWidget(document.getElementById('embed-root')!, {
  channel: params.get('channel'),
  path: params.get('path'),
  title: params.get('title') || undefined,
  follow: params.get('follow') !== '0',
  pattern: params.get('pattern'),
  onEvent: (name, detail) => postToHost({ logViewer: name, ...detail }),
});

window.addEventListener('message', (ev) => {
  if (!allowedOrigins.length) return;
  if (ev.source !== window.parent) return;
  if (!allowedOrigins.includes(ev.origin)) return;
  const d = ev.data as { logViewer?: unknown; text?: unknown; follow?: unknown } | null;
  if (!d || typeof d !== 'object' || typeof d.logViewer !== 'string') return;
  eventOrigin = ev.origin;
  switch (d.logViewer) {
    case 'setFilter':
      if (typeof d.text !== 'string') return;
      widget.setFilter(d.text);
      break;
    case 'setFollow':
      if (typeof d.follow !== 'boolean') return;
      widget.setFollow(d.follow);
      break;
    case 'clear':
      widget.clearFilter();
      break;
    // Unknown commands and malformed payloads are ignored silently.
  }
});
