// <log-viewer> custom element: an iframe-free embed of the log widget for
// hosts that can load a script directly.
//
// Usage:
//   <script type="module" src="/log-viewer/assets/component-<hash>.js"></script>
//   <log-viewer channel="deployment-7f92" server="/log-viewer" style="height:400px"></log-viewer>
//
// Attributes mirror the embed.html query params: channel, server (API base,
// default the page origin), title, follow=0|1, pattern, view-key. Changing an
// attribute after mount (e.g. channel) re-mounts and re-subscribes the widget.
//
// Host events (dispatched from the element, bubbling, same semantics as the
// iframe postMessage bridge documented in docs/embedding-ui.md):
//   log-viewer-ready
//   log-viewer-entry-selected  detail: { entry: { t, lv, th, lg, msg } }
//   log-viewer-stats           detail: { count, levels }
//
// Styles are compiled into the shadow root, so the element neither leaks nor
// requires page CSS. Note api.setBase/api.setViewKey are module-global: use a
// single server/view-key per page.

import widgetCss from './styles.css?inline';
import * as api from './api';
import { mountLogWidget, type WidgetHandle } from './widget';

// The shared stylesheet targets document-level selectors; remap them onto the
// shadow host and add the sizing the document styles would normally provide.
const SHADOW_CSS =
  widgetCss.replace(/:root/g, ':host').replace(/\.embed-body/g, ':host') +
  `
:host {
  display: block;
  overflow: hidden;
  font-family: var(--font-sans);
  font-size: 13px;
  color: var(--text);
  background: #fff;
}
:host > #embed-root {
  height: 100%;
  display: flex;
  flex-direction: column;
}
`;

class LogViewerElement extends HTMLElement {
  static observedAttributes = ['channel', 'server', 'title', 'follow', 'pattern', 'view-key'];
  private handle: WidgetHandle | null = null;

  connectedCallback() {
    if (!this.shadowRoot) {
      const shadow = this.attachShadow({ mode: 'open' });
      const style = document.createElement('style');
      style.textContent = SHADOW_CSS;
      const rootEl = document.createElement('div');
      rootEl.id = 'embed-root';
      shadow.append(style, rootEl);
    }
    this.mount();
  }

  disconnectedCallback() {
    this.handle?.destroy();
    this.handle = null;
  }

  attributeChangedCallback(_name: string, oldValue: string | null, newValue: string | null) {
    // Initial attributes also fire here (before connectedCallback); the
    // connected mount covers those. Later changes re-mount the widget.
    if (oldValue === newValue || !this.isConnected || !this.shadowRoot) return;
    this.mount();
  }

  private mount() {
    this.handle?.destroy();
    const server = this.getAttribute('server') || '';
    api.setBase(server);
    const viewKey = this.getAttribute('view-key');
    if (viewKey) api.setViewKey(viewKey);
    this.handle = mountLogWidget(this.shadowRoot!.querySelector('#embed-root') as HTMLElement, {
      channel: this.getAttribute('channel'),
      title: this.getAttribute('title') || undefined,
      follow: this.getAttribute('follow') !== '0',
      pattern: this.getAttribute('pattern'),
      onEvent: (name, detail) =>
        this.dispatchEvent(
          new CustomEvent('log-viewer-' + (name === 'entrySelected' ? 'entry-selected' : name), {
            detail: detail ?? null,
            bubbles: true,
          })
        ),
    });
  }
}

if (!customElements.get('log-viewer')) customElements.define('log-viewer', LogViewerElement);
