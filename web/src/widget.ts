// Shared log widget: toolbar + virtualized grid + detail pane bound to a
// stream channel (or server-side file path). Used by the iframe embed
// (embed.ts) and by the <log-viewer> custom element (component.ts).
//
// UI events are reported through opts.onEvent instead of postMessage, so each
// host decides how to surface them: embed.ts forwards them over the
// postMessage bridge, component.ts dispatches them as DOM CustomEvents.
// The caller owns api.setBase/api.setViewKey and any CSS scaffolding; the
// widget only fills the given container element.

import * as api from './api';
import { LogGrid } from './grid';
import { renderDetail } from './detail';
import type { Criteria, SourceInfo, WsAppendMsg } from './types';
import { LEVEL_COLORS, LEVEL_NAMES } from './types';
import { escapeHtml, fmtNum } from './util';
import { icon, logoMark } from './icons';

export type WidgetEventName = 'ready' | 'entrySelected' | 'stats';

export interface WidgetOptions {
  channel?: string | null;
  path?: string | null;
  title?: string;
  follow?: boolean; // default true
  pattern?: string | null;
  onEvent?: (name: WidgetEventName, detail?: Record<string, unknown>) => void;
}

export interface WidgetHandle {
  setFilter(text: string): void;
  setFollow(follow: boolean): void;
  clearFilter(): void;
  destroy(): void;
}

export function mountLogWidget(root: HTMLElement, opts: WidgetOptions): WidgetHandle {
  const channel = opts.channel || null;
  const path = opts.path || null;
  const title = opts.title || (channel ? `stream: ${channel}` : path?.split('/').pop() || 'log');
  const pattern = opts.pattern || null;
  const onEvent = opts.onEvent ?? (() => {});
  const $ = <T extends HTMLElement>(sel: string) => root.querySelector(sel) as T;

  root.innerHTML = `
    <div class="embed-toolbar">
      <span class="embed-title" title="${escapeHtml(title)}">${logoMark(16)}<span class="embed-name">${escapeHtml(title)}</span>${channel ? '<span class="live-badge">LIVE</span>' : ''}</span>
      <div class="embed-controls" aria-label="Log controls">
        <button type="button" class="tb-btn" id="em-follow" title="Follow new entries" aria-label="Follow new entries" aria-pressed="false">${icon('follow')}</button>
        <span class="tb-sep" aria-hidden="true"></span>
        ${LEVEL_NAMES.map(
          (n, i) =>
            `<button type="button" class="tb-dot" id="em-lv-${i}" title="Show ${n}" aria-label="Show ${n}" aria-pressed="true"><i style="background:${LEVEL_COLORS[i]}"></i></button>`
        ).join('')}
        <span class="tb-sep" aria-hidden="true"></span>
        <label class="sr-only" for="em-search">Filter log text</label>
        <input id="em-search" aria-label="Filter log text" placeholder="Filter… (Enter)" spellcheck="false" />
      </div>
      <span class="embed-status" id="em-status" role="status" aria-live="polite">connecting…</span>
    </div>
    <div class="embed-grid"><div id="em-grid"></div></div>
    <div id="em-detail" aria-label="Selected log entry detail"></div>
  `;

  const grid = new LogGrid($('#em-grid'));
  grid.rowH = 20;
  grid.onFollowChange = (on) => {
    st.follow = on;
    syncToolbar();
  };
  const detail = $('#em-detail');
  renderDetail(detail, null);
  grid.onSelect = (e) => {
    renderDetail(detail, e);
    if (e) {
      // Only user-visible fields cross the host boundary, never the raw line.
      onEvent('entrySelected', { entry: { t: e.t, lv: e.lv, th: e.th, lg: e.lg, msg: e.msg } });
    }
  };

  const st = {
    info: null as SourceInfo | null,
    levels: new Set<number>(),
    text: '',
    filterId: null as string | null,
    viewCount: 0,
    follow: opts.follow !== false,
    connected: false,
  };
  let filterRevision = 0;
  let pendingWs: WsAppendMsg | null = null;
  let wsFrame = 0;

  function renderStatus() {
    const connection = st.connected ? '' : ' • reconnecting…';
    $('#em-status').textContent = st.info
      ? `${fmtNum(st.viewCount)} records${connection}`
      : st.connected
        ? 'loading…'
        : 'connecting…';
  }

  function syncToolbar() {
    const follow = $('#em-follow');
    follow.classList.toggle('active', st.follow);
    follow.setAttribute('aria-pressed', String(st.follow));
    for (let i = 0; i < 6; i++) {
      const button = $(`#em-lv-${i}`);
      const shown = st.levels.size === 0 || st.levels.has(i);
      button.classList.toggle('active', shown);
      button.setAttribute('aria-pressed', String(shown));
    }
  }

  // "Filter by correlation" (GET /api/logs/:id/correlate) is standalone-UI only:
  // the widget stays compact and has no per-entry context menu, and hosts can
  // reach the same result via the filter controls / host commands.
  async function applyFilter() {
    const info = st.info;
    if (!info) return;
    const revision = ++filterRevision;
    const anchor = grid.captureAnchor();
    const c: Criteria = {};
    if (st.levels.size > 0 && st.levels.size < 6) c.levels = [...st.levels];
    if (st.text) c.text = st.text;
    const old = st.filterId;
    let nextFilter: string | null = null;
    let nextCount = info.count;
    if (!c.levels && !c.text) {
      nextFilter = null;
    } else {
      try {
        const r = await api.createFilter(info.id, c);
        nextFilter = r.filterId;
        nextCount = r.count;
      } catch (err) {
        if (revision === filterRevision) {
          $('#em-status').textContent = 'filter error: ' + (err as Error).message;
        }
        return;
      }
    }
    // Same entry in the new view, or the nearest one by time.
    const anchorVi = anchor ? ((await api.locate(info.id, anchor.i, nextFilter).catch(() => null))?.vi ?? null) : null;
    if (revision !== filterRevision || st.info !== info) {
      if (nextFilter) api.deleteFilter(info.id, nextFilter).catch(() => {});
      return;
    }
    st.filterId = nextFilter;
    st.viewCount = nextCount;
    if (old && old !== nextFilter) api.deleteFilter(info.id, old).catch(() => {});
    grid.reset(st.viewCount);
    if (anchor && anchorVi !== null) grid.restoreAnchor(anchorVi, anchor);
    else if (st.follow) grid.scrollToBottom();
    renderStatus();
    syncToolbar();
  }

  $('#em-follow').addEventListener('click', () => {
    st.follow = !st.follow;
    grid.follow = st.follow;
    if (st.follow) grid.scrollToBottom();
    syncToolbar();
  });
  for (let i = 0; i < 6; i++) {
    $(`#em-lv-${i}`).addEventListener('click', () => {
      // Empty means every level is visible. Clicking an active level hides it,
      // matching the standalone viewer and the pressed-state affordance.
      if (st.levels.size === 0) {
        for (let level = 0; level < 6; level++) if (level !== i) st.levels.add(level);
      } else if (st.levels.has(i)) {
        st.levels.delete(i);
      } else {
        st.levels.add(i);
        if (st.levels.size === 6) st.levels.clear();
      }
      void applyFilter();
    });
  }
  const searchInput = $('#em-search') as HTMLInputElement;
  searchInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      st.text = searchInput.value.trim();
      void applyFilter();
    }
  });

  function applyWs(msg: WsAppendMsg) {
    if (!st.info || msg.id !== st.info.id) return;
    st.info.count = msg.count;
    st.info.stats = msg.stats;
    if (st.filterId && msg.filters[st.filterId]) st.viewCount = msg.filters[st.filterId].count;
    else if (!st.filterId) st.viewCount = msg.count;
    if (msg.type === 'reset') grid.reset(st.viewCount);
    else grid.setCount(st.viewCount);
    renderStatus();
    // Piggyback on the existing rAF-throttled update cadence; no new frequency.
    onEvent('stats', { count: st.viewCount, levels: msg.stats });
  }

  function onWs(msg: WsAppendMsg) {
    if (!st.info || msg.id !== st.info.id) return;
    if (pendingWs?.type === 'reset' && msg.type !== 'reset') pendingWs = { ...msg, type: 'reset' };
    else pendingWs = msg;
    if (wsFrame) return;
    wsFrame = requestAnimationFrame(() => {
      wsFrame = 0;
      const latest = pendingWs;
      pendingWs = null;
      if (latest) applyWs(latest);
    });
  }

  const ws = api.wsConnect(onWs, (connection) => {
    st.connected = connection === 'connected';
    renderStatus();
  });

  async function boot() {
    try {
      const info = path ? await api.openLog(path) : await api.openStream(channel || 'demo');
      st.info = info;
      st.viewCount = info.count;
      grid.fetchPage = async (start, count) => (await api.getEntries(info.id, start, count, st.filterId)).entries;
      grid.follow = st.follow;
      grid.reset(info.count);
      if (st.follow) grid.scrollToBottom();
      ws.sub(info.id);
      // A pattern option overrides stream parsing once subscribed. Fire and
      // forget: a rejection (e.g. 400 invalid pattern, 401 when stream
      // mutations require a key) is surfaced in the status line.
      if (channel && pattern) {
        api.setParser(info.id, pattern).catch((err) => {
          $('#em-status').textContent = 'pattern error: ' + (err as Error).message;
        });
      }
      renderStatus();
      syncToolbar();
      onEvent('ready');
    } catch (err) {
      $('#em-status').textContent = 'error: ' + (err as Error).message;
    }
  }

  void boot();

  return {
    setFilter(text: string) {
      searchInput.value = text;
      st.text = text.trim();
      void applyFilter();
    },
    setFollow(follow: boolean) {
      st.follow = follow;
      grid.follow = follow;
      if (follow) grid.scrollToBottom();
      syncToolbar();
    },
    clearFilter() {
      searchInput.value = '';
      st.text = '';
      void applyFilter();
    },
    destroy() {
      ws.close();
      if (st.info && st.filterId) api.deleteFilter(st.info.id, st.filterId).catch(() => {});
      st.info = null;
    },
  };
}
