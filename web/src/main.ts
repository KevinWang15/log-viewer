import './styles.css';
import * as api from './api';
import { LogGrid } from './grid';
import { renderDetail } from './detail';
import type { BrowseResult, Capabilities, CatalogLog, Criteria, EntryOut, ProviderInfo, Rule, SourceInfo, WsAppendMsg } from './types';
import { LEVEL_COLORS, LEVEL_NAMES } from './types';
import { escapeHtml, fmtBytes, fmtFullTime, fmtNum, throttle } from './util';
import { icon, type IconName, logoMark } from './icons';
import { makeSplitter } from './splitter';

interface UICriteria {
  levels: Set<number>;
  text: string;
  threads: Set<string>;
  loggers: Set<string>;
  timeFrom: number | null;
  timeTo: number | null;
}

interface SourceState {
  info: SourceInfo;
  criteria: UICriteria;
  filterId: string | null;
  viewCount: number;
  viewStats: number[];
  bookmarks: Set<number>;
  filterRevision: number;
}

const RULES_KEY = 'lvw-rules';
const CHUNK_SIZE = 100 * 1024 * 1024;
const CHUNK_THRESHOLD = 128 * 1024 * 1024;

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

function trapModalTab(container: HTMLElement, ev: KeyboardEvent) {
  if (ev.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')].filter(
    (node) => node.offsetWidth > 0 && node.offsetHeight > 0
  );
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (ev.shiftKey && document.activeElement === first) {
    ev.preventDefault();
    last.focus();
  } else if (!ev.shiftKey && document.activeElement === last) {
    ev.preventDefault();
    first.focus();
  }
}

const emptyCriteria = (): UICriteria => ({
  levels: new Set(),
  text: '',
  threads: new Set(),
  loggers: new Set(),
  timeFrom: null,
  timeTo: null,
});

const state = {
  sources: new Map<string, SourceState>(),
  activeId: null as string | null,
  follow: false,
  rules: [] as Rule[],
};

const grid = new LogGrid(el('grid'));
const detailEl = el('detail');
const minimapCanvas = el<HTMLCanvasElement>('minimap');
let ws: api.WsClient;
const pendingWs = new Map<string, WsAppendMsg>();
let wsFrame = 0;
let fileModalReturnFocus: HTMLElement | null = null;
// A ?pattern= query applies a custom parser to the first source opened.
let pendingPattern: string | null = null;

function active(): SourceState | null {
  return state.activeId ? state.sources.get(state.activeId) ?? null : null;
}

// ---- Toolbar ----------------------------------------------------------------

function buildToolbar() {
  const tb = el('toolbar');
  const dots = LEVEL_NAMES.map(
    (name, i) =>
      `<button type="button" class="tb-dot" id="tb-lv-${i}" title="Show ${name}" aria-label="Show ${name}" aria-pressed="true"><i style="background:${LEVEL_COLORS[i]}"></i></button>`
  ).join('');
  tb.innerHTML = `
    <button type="button" class="tb-btn" id="tb-sidebar" title="Sources and statistics" aria-label="Show sources and statistics" aria-expanded="false">${icon('menu')}</button>
    <button type="button" class="tb-btn" id="tb-open" title="Open log file" aria-label="Open log file">${icon('open')}</button>
    <button type="button" class="tb-btn" id="tb-stream" title="Open live stream" aria-label="Open live stream">${icon('stream')}</button>
    <button type="button" class="tb-btn" id="tb-merge" title="Merge all open logs by time" aria-label="Merge all open logs by time">${icon('merge')}</button>
    <span class="tb-sep" aria-hidden="true"></span>
    <button type="button" class="tb-btn" id="tb-follow" title="Tail: follow new entries" aria-label="Follow new entries" aria-pressed="false">${icon('follow')}</button>
    <span class="tb-sep" aria-hidden="true"></span>
    ${dots}
    <label class="sr-only" for="tb-search">Filter log text</label>
    <input id="tb-search" aria-label="Filter log text" placeholder="Filter text… (Enter)" spellcheck="false" />
    <button type="button" class="tb-btn" id="tb-clear" title="Clear all filters" aria-label="Clear all filters">${icon('filterClear')}</button>
    <span class="tb-sep" aria-hidden="true"></span>
    <label class="sr-only" for="tb-find">Find log text</label>
    <input id="tb-find" aria-label="Find log text" placeholder="Find… (F3)" spellcheck="false" />
    <button type="button" class="tb-btn" id="tb-find-prev" title="Find previous (Shift+F3)" aria-label="Find previous">${icon('arrowUp')}</button>
    <button type="button" class="tb-btn" id="tb-find-next" title="Find next (F3)" aria-label="Find next">${icon('arrowDown')}</button>
    <span class="tb-sep" aria-hidden="true"></span>
    <button type="button" class="tb-btn" id="tb-bm" title="Toggle bookmark (Ctrl+B)" aria-label="Toggle bookmark">${icon('bookmark')}</button>
    <button type="button" class="tb-btn" id="tb-bm-prev" title="Previous bookmark" aria-label="Previous bookmark">${icon('chevronUp')}</button>
    <button type="button" class="tb-btn" id="tb-bm-next" title="Next bookmark" aria-label="Next bookmark">${icon('chevronDown')}</button>
    <span class="tb-sep" aria-hidden="true"></span>
    <button type="button" class="tb-btn" id="tb-report" title="Report: level histogram" aria-label="Open level report">${icon('report')}</button>
    <button type="button" class="tb-btn" id="tb-rules" title="Custom highlight rules" aria-label="Edit highlight rules">${icon('palette')}</button>
    <button type="button" class="tb-btn" id="tb-export" title="Export current view" aria-label="Export current view">${icon('download')}</button>
    <button type="button" class="tb-btn" id="tb-save" title="Save analysis" aria-label="Save analysis">${icon('save')}</button>
    <button type="button" class="tb-btn" id="tb-load" title="Load analysis" aria-label="Load analysis">${icon('load')}</button>
    <span class="tb-sep" aria-hidden="true"></span>
    <button type="button" class="tb-btn" id="tb-top" title="Go to start" aria-label="Go to first entry">${icon('top')}</button>
    <button type="button" class="tb-btn" id="tb-bottom" title="Go to end" aria-label="Go to last entry">${icon('bottom')}</button>
    <input type="file" id="tb-load-input" accept=".json" hidden />
  `;
  el('tb-sidebar').onclick = () => {
    const open = el('app').classList.toggle('sidebar-open');
    el('tb-sidebar').setAttribute('aria-expanded', String(open));
  };
  el('tb-open').onclick = () => openFileModal();
  el('tb-stream').onclick = () => {
    const ch = prompt('Stream channel name:', 'demo');
    if (ch) void openStream(ch);
  };
  el('tb-merge').onclick = () => void mergeOpenLogs();
  el('tb-follow').onclick = () => setFollow(!state.follow);
  for (let i = 0; i < 6; i++) {
    el(`tb-lv-${i}`).onclick = () => {
      const s = active();
      if (!s) return;
      // Dots show which levels are visible: empty set = all visible.
      const lv = s.criteria.levels;
      if (lv.size === 0) {
        for (let k = 0; k < 6; k++) if (k !== i) lv.add(k);
      } else if (lv.has(i)) {
        lv.delete(i);
      } else {
        lv.add(i);
        if (lv.size === 6) lv.clear();
      }
      void applyCriteria();
    };
  }
  const search = el<HTMLInputElement>('tb-search');
  search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') {
      const s = active();
      if (!s) return;
      s.criteria.text = search.value.trim();
      void applyCriteria();
    }
  });
  el('tb-clear').onclick = () => {
    const s = active();
    if (!s) return;
    s.criteria = emptyCriteria();
    void applyCriteria();
  };
  el<HTMLInputElement>('tb-find').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void findNext(ev.shiftKey ? 'prev' : 'next');
  });
  el('tb-find-next').onclick = () => void findNext('next');
  el('tb-find-prev').onclick = () => void findNext('prev');
  el('tb-bm').onclick = () => void toggleBookmark();
  el('tb-bm-next').onclick = () => void gotoBookmark('next');
  el('tb-bm-prev').onclick = () => void gotoBookmark('prev');
  el('tb-report').onclick = () => void openReportModal();
  el('tb-rules').onclick = () => openRulesModal();
  el('tb-export').onclick = () => {
    const s = active();
    if (s) window.open(api.exportUrl(s.info.id, s.filterId), '_blank');
  };
  el('tb-save').onclick = () => void saveAnalysis();
  el('tb-load').onclick = () => el<HTMLInputElement>('tb-load-input').click();
  el<HTMLInputElement>('tb-load-input').addEventListener('change', (ev) => {
    const f = (ev.target as HTMLInputElement).files?.[0];
    if (f) void loadAnalysis(f);
    (ev.target as HTMLInputElement).value = '';
  });
  el('tb-bottom').onclick = () => grid.scrollToBottom();
  el('tb-top').onclick = () => grid.scrollToIndex(0);
}

function syncToolbar() {
  const s = active();
  const follow = el('tb-follow');
  follow.classList.toggle('active', state.follow);
  follow.setAttribute('aria-pressed', String(state.follow));
  for (let i = 0; i < 6; i++) {
    const button = el(`tb-lv-${i}`);
    const shown = !s || s.criteria.levels.size === 0 || s.criteria.levels.has(i);
    button.classList.toggle('active', shown);
    button.setAttribute('aria-pressed', String(shown));
  }
  el<HTMLInputElement>('tb-search').value = s?.criteria.text ?? '';
}

function setFollow(on: boolean) {
  state.follow = on;
  grid.follow = on;
  if (on) grid.scrollToBottom();
  syncToolbar();
  updateStatus();
}

grid.onFollowChange = (on) => {
  state.follow = on;
  syncToolbar();
  updateStatus();
};

// ---- Find / bookmarks ----------------------------------------------------------

async function findNext(dir: 'next' | 'prev') {
  const s = active();
  const q = el<HTMLInputElement>('tb-find').value.trim();
  if (!s || !q) return;
  const from = grid.selection.vi >= 0 ? grid.selection.vi : dir === 'next' ? -1 : s.viewCount;
  el('status-left').textContent = 'Searching…';
  try {
    const r = await api.search(s.info.id, q, from, dir, s.filterId);
    if (r.vi !== null) grid.selectVi(r.vi);
    else el('status-left').textContent = `'${q}' not found ${dir === 'next' ? 'below' : 'above'}.`;
  } catch (err) {
    el('status-left').textContent = 'Search failed: ' + (err as Error).message;
    return;
  }
  setTimeout(updateStatus, 1500);
}

async function toggleBookmark() {
  const s = active();
  const e = grid.selection.entry;
  if (!s || !e) return;
  const r = await api.toggleBookmark(s.info.id, e.i);
  if (r.on) s.bookmarks.add(e.i);
  else s.bookmarks.delete(e.i);
  grid.bookmarks = s.bookmarks;
  grid.render();
  refreshMinimap();
}

async function gotoBookmark(dir: 'next' | 'prev') {
  const s = active();
  if (!s) return;
  const from = grid.selection.vi >= 0 ? grid.selection.vi : dir === 'next' ? -1 : s.viewCount;
  const r = await api.nextBookmark(s.info.id, from, dir, s.filterId);
  if (r.vi !== null) grid.selectVi(r.vi);
}

// ---- Tree + stats -------------------------------------------------------------

function criteriaParts(s: SourceState): Array<{ key: string; html: string }> {
  const parts: Array<{ key: string; html: string }> = [];
  const c = s.criteria;
  if (c.levels.size > 0 && c.levels.size < 6) {
    const lvls = [...c.levels].sort((a, b) => a - b);
    const dots = lvls.map((l) => `<i style="background:${LEVEL_COLORS[l]}"></i>`).join('');
    parts.push({
      key: 'levels',
      html: `<span class="tree-dots">${dots}</span><span>${lvls.map((l) => LEVEL_NAMES[l]).join(', ')}</span>`,
    });
  }
  if (c.text) parts.push({ key: 'text', html: `${icon('search', 14)}<span>'${escapeHtml(c.text)}'</span>` });
  if (c.threads.size)
    parts.push({
      key: 'threads',
      html: `${icon('thread', 14)}<span>Thread (${[...c.threads].map(escapeHtml).join(' OR ')})</span>`,
    });
  if (c.loggers.size)
    parts.push({
      key: 'loggers',
      html: `${icon('tag', 14)}<span>Logger (${[...c.loggers].map(escapeHtml).join(' OR ')})</span>`,
    });
  if (c.timeFrom !== null)
    parts.push({ key: 'timeFrom', html: `${icon('clock', 14)}<span>After ${fmtFullTime(c.timeFrom)}</span>` });
  if (c.timeTo !== null)
    parts.push({ key: 'timeTo', html: `${icon('clock', 14)}<span>Before ${fmtFullTime(c.timeTo)}</span>` });
  return parts;
}

const KIND_ICONS: Record<string, IconName> = {
  file: 'file',
  stream: 'stream',
  merged: 'merge',
  remote: 'globe',
  provider: 'database',
};

function renderTree() {
  const tree = el('tree');
  if (state.sources.size === 0) {
    tree.innerHTML = '<div class="tree-empty">No log files open.<br/>Use File ▸ Open or the Open button in the toolbar.</div>';
    return;
  }
  const parts: string[] = [];
  for (const s of state.sources.values()) {
    const isActive = s.info.id === state.activeId;
    const kindIcon = icon(KIND_ICONS[s.info.kind] ?? 'file', 14);
    const live =
      s.info.kind === 'stream'
        ? ' <span class="live-badge">LIVE</span>'
        : s.info.connected === false
          ? ` <span class="off-badge" title="${escapeHtml(s.info.lastError || s.info.state || 'disconnected')}">${escapeHtml(s.info.state === 'failed' ? 'FAILED' : 'OFFLINE')}</span>`
          : '';
    parts.push(
      `<div class="tree-node${isActive ? ' active' : ''}" data-src="${s.info.id}" role="treeitem" tabindex="0" aria-selected="${isActive}">` +
        `${kindIcon}<span class="tree-name">${escapeHtml(s.info.name)}</span>${live}` +
        `<button type="button" class="close" data-close="${s.info.id}" aria-label="Close ${escapeHtml(s.info.name)}">${icon('close', 14)}</button></div>`
    );
    if (isActive) {
      for (const p of criteriaParts(s)) {
        parts.push(
          `<div class="tree-node tree-child" role="treeitem">${p.html}<button type="button" class="close" data-clear="${p.key}" aria-label="Clear ${p.key} filter">${icon('close', 14)}</button></div>`
        );
      }
    }
  }
  tree.innerHTML = parts.join('');
  tree.querySelectorAll<HTMLElement>('.tree-node[data-src]').forEach((n) => {
    n.onclick = (ev) => {
      const close = (ev.target as HTMLElement).dataset.close;
      if (close) {
        void closeSource(close);
        return;
      }
      void selectSource(n.dataset.src!);
    };
    n.onkeydown = (ev) => {
      if (ev.target !== n || (ev.key !== 'Enter' && ev.key !== ' ')) return;
      ev.preventDefault();
      void selectSource(n.dataset.src!);
    };
  });
  tree.querySelectorAll<HTMLElement>('[data-clear]').forEach((n) => {
    n.onclick = () => {
      const s = active();
      if (!s) return;
      const k = n.dataset.clear!;
      if (k === 'levels') s.criteria.levels.clear();
      else if (k === 'text') s.criteria.text = '';
      else if (k === 'threads') s.criteria.threads.clear();
      else if (k === 'loggers') s.criteria.loggers.clear();
      else if (k === 'timeFrom') s.criteria.timeFrom = null;
      else if (k === 'timeTo') s.criteria.timeTo = null;
      void applyCriteria();
    };
  });
}

function renderStats() {
  const s = active();
  const panel = el('stats-panel');
  if (!s) {
    panel.innerHTML = '';
    return;
  }
  const all = s.info.stats;
  const view = s.filterId ? s.viewStats : all;
  const total = all.reduce((a, b) => a + b, 0);
  const viewTotal = s.filterId ? s.viewCount : total;
  const rows: string[] = [
    `<tr><td>Records</td><td>${fmtNum(total)}</td><td>${fmtNum(viewTotal)}</td></tr>`,
    `<tr><td>Threads</td><td>${fmtNum(s.info.threads.filter(Boolean).length)}</td><td></td></tr>`,
    `<tr><td>Loggers</td><td>${fmtNum(s.info.loggers.filter(Boolean).length)}</td><td></td></tr>`,
    `<tr><td>Bookmarks</td><td>${fmtNum(s.bookmarks.size)}</td><td></td></tr>`,
  ];
  LEVEL_NAMES.forEach((name, i) => {
    const label = name.charAt(0) + name.slice(1).toLowerCase();
    rows.push(
      `<tr><td class="st-lv"><i class="lv-dot" style="background:${LEVEL_COLORS[i]}"></i>${label}</td>` +
        `<td>${fmtNum(all[i])}</td><td>${fmtNum(view[i])}</td></tr>`
    );
  });
  panel.innerHTML = `<table class="stats-table"><tr><th></th><th>All</th><th>View</th></tr>${rows.join('')}</table>`;
}

function updateStatus() {
  const s = active();
  const sep = '<i class="sb-sep" aria-hidden="true"></i>';
  el('status-left').innerHTML = s
    ? `<span class="sb-name">${escapeHtml(s.info.name)}</span>${sep}<span class="sb-chip" title="Detected log format">${escapeHtml(s.info.format)}</span>` +
      (s.info.path ? `${sep}<span class="sb-path" title="${escapeHtml(s.info.path)}">${escapeHtml(s.info.path)}</span>` : '')
    : 'Ready';
  el('status-right').innerHTML = s
    ? `<span>${fmtNum(s.viewCount)} records</span>` +
      (s.filterId ? `<span class="sb-chip sb-filtered">filtered</span>` : '') +
      (state.follow ? `${sep}<span class="sb-follow">following</span>` : '')
    : '';
  el('win-title').textContent = s ? `${s.info.name} - log-viewer` : 'log-viewer';
}

// ---- Minimap ------------------------------------------------------------------

// Bumped on every refresh so a slow response can't paint over a newer one,
// e.g. marks from a source that was closed while its request was in flight.
let minimapGen = 0;

const refreshMinimap = throttle(async () => {
  const gen = ++minimapGen;
  const s = active();
  const ctx = minimapCanvas.getContext('2d');
  if (!ctx) return;
  const h = minimapCanvas.clientHeight || 400;
  minimapCanvas.width = 16;
  minimapCanvas.height = h;
  ctx.clearRect(0, 0, 16, h);
  minimapCanvas.setAttribute('aria-valuemax', String(Math.max(0, (s?.viewCount ?? 1) - 1)));
  minimapCanvas.setAttribute('aria-valuenow', String(Math.min(grid.firstVisible, Math.max(0, (s?.viewCount ?? 1) - 1))));
  if (!s || s.viewCount === 0) return;
  try {
    const { buckets, bookmarks } = await api.getMinimap(s.info.id, Math.max(50, Math.floor(h / 3)), s.filterId);
    if (gen !== minimapGen || active() !== s) return;
    const bh = h / buckets.length;
    buckets.forEach((lv, b) => {
      if (lv >= 3) {
        ctx.fillStyle = LEVEL_COLORS[lv];
        ctx.fillRect(4, b * bh, 10, Math.max(2, bh - 1));
      }
    });
    bookmarks?.forEach((on, b) => {
      if (on) {
        ctx.fillStyle = '#6366f1';
        ctx.fillRect(0, b * bh, 4, Math.max(2, bh - 1));
      }
    });
  } catch {
    /* source may have been closed */
  }
}, 1500);

minimapCanvas.addEventListener('click', (ev) => {
  const s = active();
  if (!s || !s.viewCount) return;
  const frac = ev.offsetY / minimapCanvas.clientHeight;
  const target = Math.floor(frac * s.viewCount);
  grid.scrollToIndex(target);
  minimapCanvas.setAttribute('aria-valuenow', String(target));
});

minimapCanvas.addEventListener('focus', () => {
  minimapCanvas.setAttribute('aria-valuenow', String(grid.firstVisible));
});

minimapCanvas.addEventListener('keydown', (ev) => {
  const s = active();
  if (!s || !s.viewCount) return;
  const small = Math.max(1, Math.floor(s.viewCount / 100));
  const large = Math.max(1, Math.floor(s.viewCount / 10));
  let target = grid.firstVisible;
  if (ev.key === 'ArrowDown') target += small;
  else if (ev.key === 'ArrowUp') target -= small;
  else if (ev.key === 'PageDown') target += large;
  else if (ev.key === 'PageUp') target -= large;
  else if (ev.key === 'Home') target = 0;
  else if (ev.key === 'End') target = s.viewCount - 1;
  else return;
  ev.preventDefault();
  target = Math.max(0, Math.min(s.viewCount - 1, target));
  grid.scrollToIndex(target);
  minimapCanvas.setAttribute('aria-valuenow', String(target));
});

// ---- Context menu ----------------------------------------------------------------

let ctxEl: HTMLElement | null = null;
let ctxReturnFocus: HTMLElement | null = null;

function hideContextMenu() {
  const returnFocus = ctxReturnFocus;
  ctxEl?.remove();
  ctxEl = null;
  ctxReturnFocus = null;
  returnFocus?.focus();
}

function showContextMenu(e: EntryOut, x: number, y: number) {
  hideContextMenu();
  ctxReturnFocus = document.activeElement as HTMLElement | null;
  const s = active();
  if (!s) return;
  const items: Array<{ label: string; kbd?: string; act: () => void } | 'sep'> = [
    {
      label: `Filter: Thread '${e.th || '(none)'}'`,
      act: () => {
        s.criteria.threads.add(e.th);
        void applyCriteria();
      },
    },
    {
      label: `Filter: Logger '${e.lg || '(none)'}'`,
      act: () => {
        s.criteria.loggers.add(e.lg);
        void applyCriteria();
      },
    },
    {
      label: `Filter: Level ${LEVEL_NAMES[e.lv]} only`,
      act: () => {
        s.criteria.levels = new Set([e.lv]);
        void applyCriteria();
      },
    },
    {
      label: 'Filter by correlation',
      act: () => void filterByCorrelation(s, e),
    },
    'sep',
    {
      label: `After this time (${fmtFullTime(e.t)})`,
      act: () => {
        s.criteria.timeFrom = e.t;
        void applyCriteria();
      },
    },
    {
      label: `Before this time`,
      act: () => {
        s.criteria.timeTo = e.t;
        void applyCriteria();
      },
    },
    'sep',
    { label: 'Toggle bookmark', kbd: 'Ctrl+B', act: () => void toggleBookmark() },
    {
      label: 'Copy message',
      act: () => void navigator.clipboard.writeText(e.msg),
    },
    {
      label: 'Copy full entry',
      act: () => void navigator.clipboard.writeText(e.raw),
    },
    'sep',
    {
      label: 'Clear all filters',
      act: () => {
        s.criteria = emptyCriteria();
        void applyCriteria();
      },
    },
  ];
  ctxEl = document.createElement('div');
  ctxEl.id = 'ctxmenu';
  ctxEl.setAttribute('role', 'menu');
  ctxEl.setAttribute('aria-label', 'Log entry actions');
  ctxEl.innerHTML = items
    .map((it, k) =>
      it === 'sep'
        ? '<div class="ctx-sep" role="separator"></div>'
        : `<button type="button" role="menuitem" class="ctx-item" data-k="${k}">${escapeHtml(it.label)}${it.kbd ? `<span class="kbd">${it.kbd}</span>` : ''}</button>`
    )
    .join('');
  document.body.appendChild(ctxEl);
  const rect = ctxEl.getBoundingClientRect();
  ctxEl.style.left = Math.min(x, window.innerWidth - rect.width - 6) + 'px';
  ctxEl.style.top = Math.min(y, window.innerHeight - rect.height - 6) + 'px';
  ctxEl.querySelectorAll<HTMLElement>('.ctx-item').forEach((n) => {
    n.onclick = () => {
      const it = items[Number(n.dataset.k)];
      hideContextMenu();
      if (it !== 'sep') it.act();
    };
  });
  const controls = [...ctxEl.querySelectorAll<HTMLButtonElement>('.ctx-item')];
  ctxEl.onkeydown = (ev) => {
    const current = Math.max(0, controls.indexOf(document.activeElement as HTMLButtonElement));
    let next = current;
    if (ev.key === 'ArrowDown') next = (current + 1) % controls.length;
    else if (ev.key === 'ArrowUp') next = (current - 1 + controls.length) % controls.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = controls.length - 1;
    else return;
    ev.preventDefault();
    controls[next]?.focus();
  };
  controls[0]?.focus();
}

// Extracts a correlation id from the entry via the server, then applies the
// extracted value as the plain text filter so breadcrumbs and clearing work
// unchanged. The status bar flashes the applied `key=value` (or the 422).
async function filterByCorrelation(s: SourceState, e: EntryOut) {
  el('status-left').textContent = 'Extracting correlation id…';
  try {
    const r = await api.correlate(s.info.id, e.i);
    s.criteria.text = r.value;
    await applyCriteria();
    el('status-left').textContent = `Filtered by ${r.key}=${r.value} (${fmtNum(r.count)} entries)`;
  } catch (err) {
    el('status-left').textContent =
      (err as { status?: number }).status === 422
        ? 'No correlation id in entry.'
        : 'Correlation failed: ' + (err as Error).message;
  }
  setTimeout(updateStatus, 4000);
}

// ---- Rules ---------------------------------------------------------------------

function loadRules(): Rule[] {
  try {
    return (JSON.parse(localStorage.getItem(RULES_KEY) || '[]') as Rule[]).filter((r) => r && r.id);
  } catch {
    return [];
  }
}

function saveRules() {
  localStorage.setItem(RULES_KEY, JSON.stringify(state.rules));
  applyGridRules();
}

// Server-side rules with a highlight action render through the same grid
// mechanism as local custom rules (they coexist; first match wins). The grid
// matcher supports plain text and a single level, so server rules with more
// complex criteria (regex, multi-level, logger/thread-only) don't highlight.
function serverGridRules(): Rule[] {
  const s = active();
  if (!s) return [];
  return (s.info.rules ?? [])
    .filter((r) => r.actions.highlight)
    .map((r) => ({
      id: 'srv-' + r.id,
      name: r.name || r.id,
      text: r.criteria.regex ? '' : (r.criteria.text ?? ''),
      level: r.criteria.levels && r.criteria.levels.length === 1 ? r.criteria.levels[0] : null,
      bg: r.actions.highlight!,
      enabled: true,
    }));
}

function applyGridRules() {
  grid.setRules([...state.rules, ...serverGridRules()]);
}

function wireModal(backdrop: HTMLElement, focusSelector: string) {
  const returnFocus = document.activeElement as HTMLElement | null;
  let close = () => {};
  const onKey = (ev: KeyboardEvent) => {
    if (ev.key === 'Escape') close();
    else trapModalTab(backdrop, ev);
  };
  close = () => {
    document.removeEventListener('keydown', onKey);
    backdrop.remove();
    returnFocus?.focus();
  };
  backdrop.addEventListener('click', (ev) => {
    if (ev.target === backdrop) close();
  });
  document.addEventListener('keydown', onKey);
  requestAnimationFrame(() => (backdrop.querySelector(focusSelector) as HTMLElement | null)?.focus());
  return close;
}

function openRulesModal() {
  const backdrop = document.createElement('div');
  backdrop.id = 'rules-backdrop';
  backdrop.innerHTML = `
    <div id="rules-modal" role="dialog" aria-modal="true" aria-labelledby="rules-modal-title">
      <div class="modal-title" id="rules-modal-title">Highlight rules <span class="modal-sub">Color entries that match</span></div>
      <div id="rules-list"></div>
      <div class="rules-footer">
        <button type="button" id="rule-add">＋ Add rule</button>
        <span class="spacer"></span>
        <button type="button" id="rules-close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(backdrop);
  const list = backdrop.querySelector('#rules-list') as HTMLElement;

  const render = () => {
    const head =
      '<div class="rule-row rule-head"><span>On</span><span>Text contains</span><span>Level</span><span>Name</span><span>Fore</span><span>Back</span><span>Bold</span><span></span></div>';
    list.innerHTML =
      head +
      state.rules
        .map(
          (r, k) => `
      <div class="rule-row" data-k="${k}">
        <input type="checkbox" class="r-on" aria-label="Enable rule" ${r.enabled ? 'checked' : ''} />
        <input type="text" class="r-text" aria-label="Text to match" value="${escapeHtml(r.text ?? '')}" placeholder="(any text)" />
        <select class="r-level" aria-label="Log level to match">
          <option value="">(any level)</option>
          ${LEVEL_NAMES.map((n, i) => `<option value="${i}" ${r.level === i ? 'selected' : ''}>${n}</option>`).join('')}
        </select>
        <input type="text" class="r-name" aria-label="Rule name" value="${escapeHtml(r.name)}" placeholder="name" />
        <input type="color" class="r-fg" aria-label="Foreground color" value="${r.fg || '#000000'}" />
        <input type="color" class="r-bg" aria-label="Background color" value="${r.bg || '#fff2f2'}" />
        <input type="checkbox" class="r-bold" aria-label="Use bold text" ${r.bold ? 'checked' : ''} />
        <button type="button" class="rule-del" title="Delete" aria-label="Delete rule">${icon('delete', 14)}</button>
      </div>`
        )
        .join('');
    list.querySelectorAll<HTMLElement>('.rule-row[data-k]').forEach((row) => {
      const k = Number(row.dataset.k);
      const r = state.rules[k];
      const q = <T extends HTMLElement>(sel: string) => row.querySelector(sel) as T;
      q<HTMLInputElement>('.r-on').onchange = (ev) => {
        r.enabled = (ev.target as HTMLInputElement).checked;
        saveRules();
      };
      q<HTMLInputElement>('.r-text').onchange = (ev) => {
        r.text = (ev.target as HTMLInputElement).value;
        saveRules();
      };
      q<HTMLSelectElement>('.r-level').onchange = (ev) => {
        const v = (ev.target as HTMLSelectElement).value;
        r.level = v === '' ? null : Number(v);
        saveRules();
      };
      q<HTMLInputElement>('.r-name').onchange = (ev) => {
        r.name = (ev.target as HTMLInputElement).value;
        saveRules();
      };
      q<HTMLInputElement>('.r-fg').onchange = (ev) => {
        r.fg = (ev.target as HTMLInputElement).value;
        saveRules();
      };
      q<HTMLInputElement>('.r-bg').onchange = (ev) => {
        r.bg = (ev.target as HTMLInputElement).value;
        saveRules();
      };
      q<HTMLInputElement>('.r-bold').onchange = (ev) => {
        r.bold = (ev.target as HTMLInputElement).checked;
        saveRules();
      };
      q<HTMLButtonElement>('.rule-del').onclick = () => {
        state.rules.splice(k, 1);
        saveRules();
        render();
      };
    });
  };
  render();

  (backdrop.querySelector('#rule-add') as HTMLElement).onclick = () => {
    state.rules.push({
      id: 'r' + Date.now(),
      name: 'Rule ' + (state.rules.length + 1),
      text: '',
      level: null,
      fg: '#000000',
      bg: '#fff2c8',
      bold: false,
      enabled: true,
    });
    saveRules();
    render();
  };
  const close = wireModal(backdrop, '#rules-close');
  (backdrop.querySelector('#rules-close') as HTMLElement).onclick = close;
}

// ---- Report ---------------------------------------------------------------------

async function openReportModal() {
  const s = active();
  if (!s) return;
  const backdrop = document.createElement('div');
  backdrop.id = 'rules-backdrop';
  backdrop.innerHTML = `
    <div id="rules-modal" role="dialog" aria-modal="true" aria-labelledby="report-modal-title">
      <div class="modal-title" id="report-modal-title">Report <span class="modal-sub">${escapeHtml(s.info.name)}${s.filterId ? ', filtered view' : ''}</span></div>
      <div id="report-body" aria-live="polite" style="flex:1;overflow:auto;padding:14px">Loading…</div>
      <div class="rules-footer"><span class="spacer"></span><button type="button" id="report-close">Close</button></div>
    </div>`;
  document.body.appendChild(backdrop);
  const close = wireModal(backdrop, '#report-close');
  (backdrop.querySelector('#report-close') as HTMLElement).onclick = close;

  let r: api.ReportData;
  try {
    r = await api.getReport(s.info.id, s.filterId);
  } catch (err) {
    (backdrop.querySelector('#report-body') as HTMLElement).textContent =
      'Report failed: ' + (err as Error).message;
    return;
  }
  if (!backdrop.isConnected) return;
  const body = backdrop.querySelector('#report-body') as HTMLElement;
  const topTable = (title: string, rows: Array<{ name: string; count: number }>) =>
    `<div style="flex:1"><div style="font-weight:600;margin-bottom:4px">${title}</div>
     <table class="stats-table">${rows
       .map((x) => `<tr><td>${escapeHtml(x.name)}</td><td>${fmtNum(x.count)}</td></tr>`)
       .join('')}</table></div>`;
  body.innerHTML = `
    <div style="font-size:12px;color:var(--muted);margin-bottom:8px">
      ${fmtNum(r.total)} records · ${fmtFullTime(r.from)} → ${fmtFullTime(r.to)}
    </div>
    <canvas id="report-canvas" role="img" aria-label="Stacked level histogram across the selected time range" width="660" height="240" style="width:100%;border:1px solid var(--border-light);border-radius:3px"></canvas>
    <div style="display:flex;gap:6px;margin:6px 0 14px;font-size:11px">
      ${LEVEL_NAMES.map((n, i) => `<span><i style="display:inline-block;width:9px;height:9px;background:${LEVEL_COLORS[i]};border-radius:2px;margin-right:3px"></i>${n}</span>`).join('')}
    </div>
    <div style="font-weight:600;margin-bottom:4px">Level trend</div>
    <canvas id="report-lines" role="img" aria-label="Per-level trend lines across the selected time range" width="660" height="140" style="width:100%;border:1px solid var(--border-light);border-radius:3px"></canvas>
    <div style="display:flex;gap:20px;margin-top:14px">${topTable('Top loggers', r.topLoggers)}${topTable('Top threads', r.topThreads)}</div>
    <div style="font-weight:600;margin:14px 0 4px">Top messages</div>
    <table class="stats-table"><tr><th>Count</th><th>Template</th><th>Example</th></tr>${r.topMessages
      .map(
        (m) =>
          `<tr><td>${fmtNum(m.count)}</td><td><code>${escapeHtml(m.template)}</code></td><td style="color:var(--muted)">${escapeHtml(m.example)}</td></tr>`
      )
      .join('')}</table>`;

  const canvas = body.querySelector('#report-canvas') as HTMLCanvasElement;
  const ctx = canvas.getContext('2d')!;
  const W = canvas.width;
  const H = canvas.height;
  const max = Math.max(1, ...r.buckets.map((b) => b.counts.reduce((a, c) => a + c, 0)));
  const bw = W / r.buckets.length;
  r.buckets.forEach((b, k) => {
    let y = H;
    for (let lv = 0; lv < 6; lv++) {
      const c = b.counts[lv];
      if (!c) continue;
      const hpx = (c / max) * (H - 8);
      y -= hpx;
      ctx.fillStyle = LEVEL_COLORS[lv];
      ctx.fillRect(k * bw + 0.5, y, Math.max(1, bw - 1), hpx);
    }
  });

  // Per-level trend: one polyline per level, same colors as the histogram.
  const lines = body.querySelector('#report-lines') as HTMLCanvasElement;
  const lctx = lines.getContext('2d')!;
  const LW = lines.width;
  const LH = lines.height;
  const lmax = Math.max(1, ...r.series.flat());
  for (let lv = 0; lv < 6; lv++) {
    const s = r.series[lv];
    if (!s || !s.length) continue;
    lctx.strokeStyle = LEVEL_COLORS[lv];
    lctx.beginPath();
    s.forEach((c, k) => {
      const x = (k + 0.5) * (LW / s.length);
      const y = LH - 4 - (c / lmax) * (LH - 8);
      if (k === 0) lctx.moveTo(x, y);
      else lctx.lineTo(x, y);
    });
    lctx.stroke();
  }
}

// ---- Source lifecycle -----------------------------------------------------------

function addSource(info: SourceInfo) {
  if (!state.sources.has(info.id)) {
    state.sources.set(info.id, {
      info,
      criteria: emptyCriteria(),
      filterId: null,
      viewCount: info.count,
      viewStats: [...info.stats],
      bookmarks: new Set(),
      filterRevision: 0,
    });
    ws.sub(info.id);
  } else {
    state.sources.get(info.id)!.info = info;
  }
}

async function selectSource(id: string) {
  const s = state.sources.get(id);
  if (!s) return;
  state.activeId = id;
  el('app').classList.remove('sidebar-open');
  el('tb-sidebar').setAttribute('aria-expanded', 'false');
  el('welcome').hidden = true;
  grid.fetchPage = async (start, count) => {
    const cur = active();
    if (!cur) return [];
    return (await api.getEntries(cur.info.id, start, count, cur.filterId)).entries;
  };
  grid.bookmarks = s.bookmarks;
  grid.reset(s.viewCount);
  applyGridRules();
  if (state.follow) grid.scrollToBottom();
  renderTree();
  renderStats();
  syncToolbar();
  updateStatus();
  refreshMinimap();
  // A ?pattern= query applies a custom parser to the first opened source.
  if (pendingPattern && (s.info.kind === 'file' || s.info.kind === 'stream')) {
    const pattern = pendingPattern;
    pendingPattern = null;
    api
      .setParser(id, pattern)
      .then((info) => {
        s.info = info;
        if (state.activeId === id) updateStatus();
      })
      .catch((err) => {
        if (state.activeId === id) el('status-left').textContent = 'Pattern failed: ' + (err as Error).message;
      });
  }
  // Refresh bookmarks from the server in the background.
  api
    .getBookmarks(id)
    .then((r) => {
      s.bookmarks = new Set(r.indices);
      if (state.activeId === id) {
        grid.bookmarks = s.bookmarks;
        grid.render();
        renderStats();
      }
    })
    .catch(() => {});
}

async function closeSource(id: string) {
  const s = state.sources.get(id);
  if (!s) return;
  s.filterRevision++;
  ws.unsub(id);
  state.sources.delete(id);
  if (s.filterId) await api.deleteFilter(id, s.filterId).catch(() => {});
  if (s.info.kind !== 'stream') await api.closeLog(id).catch(() => {});
  // Server cascades merged views that depended on this source; drop them here too.
  try {
    const { sources } = await api.listLogs();
    const alive = new Set(sources.map((x) => x.id));
    for (const sid of [...state.sources.keys()]) {
      if (!alive.has(sid)) {
        ws.unsub(sid);
        state.sources.delete(sid);
      }
    }
  } catch {
    /* offline */
  }
  if (!state.activeId || !state.sources.has(state.activeId)) {
    state.activeId = null;
    const next = state.sources.keys().next();
    if (!next.done) await selectSource(next.value);
    else {
      grid.reset(0);
      el('welcome').hidden = false;
      renderStats();
      updateStatus();
      refreshMinimap();
    }
  }
  renderTree();
}

async function openPath(path: string, start?: number, end?: number) {
  const info =
    start !== undefined || end !== undefined ? await api.openLogChunk(path, start ?? 0, end) : await api.openLog(path);
  addSource(info);
  await selectSource(info.id);
}

async function openStream(channel: string) {
  const info = await api.openStream(channel);
  addSource(info);
  await selectSource(info.id);
  setFollow(true);
}

async function mergeOpenLogs() {
  const ids = [...state.sources.values()].filter((s) => s.info.kind !== 'merged').map((s) => s.info.id);
  if (ids.length < 2) {
    alert('Open at least two logs to merge them.');
    return;
  }
  const info = await api.mergeLogs(ids);
  addSource(info);
  await selectSource(info.id);
}

// ---- Filtering -------------------------------------------------------------------

function buildServerCriteria(c: UICriteria): Criteria {
  const out: Criteria = {};
  if (c.levels.size > 0 && c.levels.size < 6) out.levels = [...c.levels];
  if (c.text) out.text = c.text;
  if (c.threads.size) out.threads = [...c.threads];
  if (c.loggers.size) out.loggers = [...c.loggers];
  if (c.timeFrom !== null) out.timeFrom = c.timeFrom;
  if (c.timeTo !== null) out.timeTo = c.timeTo;
  return out;
}

async function applyCriteria() {
  const s = active();
  if (!s) return;
  const revision = ++s.filterRevision;
  const sourceId = s.info.id;
  const c = buildServerCriteria(s.criteria);
  const oldFilter = s.filterId;
  const anchor = state.activeId === sourceId ? grid.captureAnchor() : null;
  let nextFilter: string | null = null;
  let nextCount = s.info.count;
  let nextStats = [...s.info.stats];
  let anchorVi: number | null = null;
  try {
    if (Object.keys(c).length > 0) {
      const r = await api.createFilter(sourceId, c);
      nextFilter = r.filterId;
      nextCount = r.count;
      nextStats = r.stats;
    }
    // Same entry in the new view, or the nearest one by time.
    if (anchor) anchorVi = (await api.locate(sourceId, anchor.i, nextFilter).catch(() => null))?.vi ?? null;
  } catch (err) {
    if (revision === s.filterRevision && state.activeId === sourceId) {
      el('status-left').textContent = 'Filter failed: ' + (err as Error).message;
    }
    return;
  }
  if (revision !== s.filterRevision || state.sources.get(sourceId) !== s) {
    if (nextFilter) api.deleteFilter(sourceId, nextFilter).catch(() => {});
    return;
  }
  s.filterId = nextFilter;
  s.viewCount = nextCount;
  s.viewStats = nextStats;
  if (oldFilter && oldFilter !== nextFilter) api.deleteFilter(sourceId, oldFilter).catch(() => {});
  if (state.activeId !== sourceId) return;
  grid.reset(s.viewCount);
  if (anchor && anchorVi !== null) grid.restoreAnchor(anchorVi, anchor);
  else if (state.follow) grid.scrollToBottom();
  renderTree();
  renderStats();
  syncToolbar();
  updateStatus();
  refreshMinimap();
}

// ---- Save / load analysis -----------------------------------------------------------

interface AnalysisFile {
  v: 1;
  rules: Rule[];
  sources: Array<{
    kind: string; // 'file' | 'stream' | 'provider'
    path?: string;
    channel?: string;
    provider?: string;
    log?: string;
    criteria: Criteria;
    bookmarks: number[];
  }>;
}

async function saveAnalysis() {
  const doc: AnalysisFile = { v: 1, rules: state.rules, sources: [] };
  for (const s of state.sources.values()) {
    if (s.info.kind !== 'file' && s.info.kind !== 'stream' && s.info.kind !== 'provider') continue;
    doc.sources.push({
      kind: s.info.kind,
      path: s.info.path,
      channel: s.info.kind === 'stream' ? s.info.name : undefined,
      provider: s.info.provider?.id,
      log: s.info.provider?.log,
      criteria: buildServerCriteria(s.criteria),
      bookmarks: [...s.bookmarks].sort((a, b) => a - b),
    });
  }
  const blob = new Blob([JSON.stringify(doc, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'analysis.log-viewer.json';
  a.click();
  URL.revokeObjectURL(a.href);
}

async function loadAnalysis(file: File) {
  let doc: AnalysisFile;
  try {
    doc = JSON.parse(await file.text()) as AnalysisFile;
  } catch {
    alert('Not a valid analysis file.');
    return;
  }
  if (Array.isArray(doc.rules)) {
    state.rules = doc.rules;
    saveRules();
  }
  for (const src of doc.sources ?? []) {
    try {
      const info =
        src.kind === 'stream'
          ? await api.openStream(src.channel || 'demo')
          : src.kind === 'provider'
            ? await api.openProviderLog(src.provider!, src.log!)
            : await api.openLog(src.path!);
      addSource(info);
      const s = state.sources.get(info.id)!;
      const c = src.criteria ?? {};
      s.criteria = {
        levels: new Set(c.levels ?? []),
        text: c.text ?? '',
        threads: new Set(c.threads ?? []),
        loggers: new Set(c.loggers ?? []),
        timeFrom: c.timeFrom ?? null,
        timeTo: c.timeTo ?? null,
      };
      for (const b of src.bookmarks ?? []) {
        s.bookmarks.add(b);
        api.toggleBookmark(info.id, b).catch(() => {});
      }
      await selectSource(info.id);
      await applyCriteria();
    } catch (err) {
      console.warn('failed to restore source', src, err);
    }
  }
}

// ---- WebSocket updates --------------------------------------------------------------

function applyWsMessage(msg: WsAppendMsg) {
  const s = state.sources.get(msg.id);
  if (!s) return;
  s.info.count = msg.count;
  s.info.stats = msg.stats;
  if (s.filterId && msg.filters[s.filterId]) {
    s.viewCount = msg.filters[s.filterId].count;
    s.viewStats = msg.filters[s.filterId].stats;
  } else if (!s.filterId) {
    s.viewCount = msg.count;
    s.viewStats = [...msg.stats];
  }
  if (msg.id === state.activeId) {
    if (msg.type === 'reset') grid.reset(s.viewCount);
    else grid.setCount(s.viewCount);
    renderStats();
    updateStatus();
    refreshMinimap();
  }
}

function onWsMessage(msg: WsAppendMsg) {
  const previous = pendingWs.get(msg.id);
  pendingWs.set(msg.id, previous?.type === 'reset' && msg.type !== 'reset' ? { ...msg, type: 'reset' } : msg);
  if (wsFrame) return;
  wsFrame = requestAnimationFrame(() => {
    wsFrame = 0;
    const updates = [...pendingWs.values()];
    pendingWs.clear();
    for (const update of updates) applyWsMessage(update);
  });
}

// ---- File browser modal ----------------------------------------------------------------

// ---- Capabilities ---------------------------------------------------------------

let caps: Capabilities | null = null;
const hasFiles = () => !caps?.modules || !!caps.modules.files;
const hasCatalog = () => (caps?.modules?.providers?.providers.length ?? 0) > 0;

// Hides features the server doesn't offer. Servers that predate `modules`
// report nothing and keep every feature.
function applyCapabilities() {
  const m = caps?.modules;
  if (!m) return;
  const show = (id: string, on: boolean) => (el(id).hidden = !on);
  show('tb-open', hasFiles() || hasCatalog());
  show('menu-file', hasFiles() || hasCatalog());
  show('welcome-open', hasFiles() || hasCatalog());
  show('tb-stream', !!m.streams);
  show('tb-merge', !!m.merge);
  show('welcome-demo', !!m.streams?.demo);
  el('fm-tab-files').hidden = !hasFiles();
  el('fm-tab-catalog').hidden = !hasCatalog();
  if (!hasFiles()) el('welcome-open').textContent = 'Open log';
}

// ---- Open dialog: Files and Catalog tabs ---------------------------------------------

type OpenTab = 'files' | 'catalog';
let openTab: OpenTab = 'files';
let catalogCache: Array<{ provider: ProviderInfo; logs: CatalogLog[]; error?: string }> | null = null;

function openFileModal(tab?: OpenTab) {
  fileModalReturnFocus = document.activeElement as HTMLElement | null;
  el('modal-backdrop').hidden = false;
  showOpenTab(tab ?? (hasFiles() ? openTab : 'catalog'));
}

function showOpenTab(tab: OpenTab) {
  openTab = tab;
  const files = tab === 'files';
  el('fm-tab-files').setAttribute('aria-selected', String(files));
  el('fm-tab-catalog').setAttribute('aria-selected', String(!files));
  el('fm-files-bar').hidden = !files;
  el('fm-catalog-bar').hidden = files;
  const showTabs = hasFiles() && hasCatalog();
  (document.querySelector('.modal-tabs') as HTMLElement).hidden = !showTabs;
  if (files) {
    void loadDir();
    requestAnimationFrame(() => el<HTMLInputElement>('fm-path').focus());
  } else {
    void loadCatalog();
    requestAnimationFrame(() => el<HTMLInputElement>('fm-filter').focus());
  }
}

async function loadCatalog(fresh = false) {
  const list = el('fm-list');
  if (!catalogCache || fresh) {
    list.innerHTML = '<div class="tree-empty">Loading catalog…</div>';
    const providers = caps?.modules?.providers?.providers ?? [];
    catalogCache = await Promise.all(
      providers.map(async (provider) => {
        try {
          return { provider, logs: (await api.providerLogs(provider.id)).logs };
        } catch (err) {
          return { provider, logs: [], error: (err as Error).message };
        }
      })
    );
  }
  renderCatalog();
}

function renderCatalog() {
  const list = el('fm-list');
  const q = el<HTMLInputElement>('fm-filter').value.trim().toLowerCase();
  const matches = (l: CatalogLog) =>
    !q ||
    [l.id, l.name, l.description ?? '', ...Object.entries(l.labels ?? {}).map(([k, v]) => `${k}=${v}`)]
      .join(' ')
      .toLowerCase()
      .includes(q);
  const parts: string[] = [];
  for (const group of catalogCache ?? []) {
    const logs = group.logs.filter(matches);
    parts.push(`<div class="fm-group">${icon('database', 14)}<span>${escapeHtml(group.provider.name)}</span></div>`);
    if (group.error) parts.push(`<div class="fm-error">${escapeHtml(group.error)}</div>`);
    else if (!logs.length) parts.push('<div class="tree-empty">No matching logs.</div>');
    for (const l of logs) {
      const labels = Object.entries(l.labels ?? {})
        .map(([k, v]) => `<span class="fm-label">${escapeHtml(k)}=${escapeHtml(v)}</span>`)
        .join('');
      parts.push(
        `<button type="button" class="fm-item fm-log" data-provider="${escapeHtml(group.provider.id)}" data-log="${escapeHtml(l.id)}">` +
          `${icon('file')}<span class="fm-log-text"><span class="fm-log-name">${escapeHtml(l.name)}</span>` +
          (l.description ? `<span class="fm-log-desc">${escapeHtml(l.description)}</span>` : '') +
          `</span>${labels}${l.open ? '<span class="sb-chip">open</span>' : ''}</button>`
      );
    }
  }
  list.innerHTML = parts.join('') || '<div class="tree-empty">No providers configured.</div>';
  list.querySelectorAll<HTMLElement>('.fm-log').forEach((item) => {
    item.onclick = async () => {
      closeFileModal();
      try {
        const info = await api.openProviderLog(item.dataset.provider!, item.dataset.log!);
        addSource(info);
        await selectSource(info.id);
        setFollow(true);
        catalogCache = null;
      } catch (err) {
        alert('Failed to open: ' + (err as Error).message);
      }
    };
  });
}

function closeFileModal() {
  el('modal-backdrop').hidden = true;
  fileModalReturnFocus?.focus();
  fileModalReturnFocus = null;
}

function showChunkChooser(dirPath: string, file: { name: string; size: number }) {
  const list = el('fm-list');
  const full = dirPath + '/' + file.name;
  const parts: string[] = [
    `<button type="button" class="fm-item" data-whole="1">${icon('file')}<span>Open entire file (${fmtBytes(file.size)}). May take a while.</span></button>`,
  ];
  const n = Math.ceil(file.size / CHUNK_SIZE);
  for (let p = 0; p < n; p++) {
    const s = p * CHUNK_SIZE;
    const e = Math.min(file.size, (p + 1) * CHUNK_SIZE);
    parts.push(
      `<button type="button" class="fm-item" data-part="${p}">${icon('part')}<span>Part ${p + 1} (bytes ${fmtBytes(s)} – ${fmtBytes(e)})</span></button>`
    );
  }
  list.innerHTML = `<div class="modal-title" style="background:none">Open part of file <span class="modal-sub">${escapeHtml(file.name)}</span></div>` + parts.join('');
  list.querySelectorAll<HTMLElement>('.fm-item').forEach((item) => {
    item.onclick = async () => {
      closeFileModal();
      try {
        if (item.dataset.whole) await openPath(full);
        else {
          const p = Number(item.dataset.part);
          await openPath(full, p * CHUNK_SIZE, Math.min(file.size, (p + 1) * CHUNK_SIZE));
        }
      } catch (err) {
        alert('Failed to open: ' + (err as Error).message);
      }
    };
  });
}

async function loadDir(path?: string) {
  const list = el('fm-list');
  try {
    const r: BrowseResult = await api.browse(path);
    el<HTMLInputElement>('fm-path').value = r.path;
    el('fm-up').onclick = () => void loadDir(r.parent);
    el('fm-samples').onclick = () => void loadDir(r.samples);
    const parts: string[] = [];
    for (const d of r.dirs)
      parts.push(`<button type="button" class="fm-item" data-dir="${escapeHtml(d.name)}">${icon('folder')}<span>${escapeHtml(d.name)}</span></button>`);
    for (const f of r.files)
      parts.push(
        `<button type="button" class="fm-item" data-file="${escapeHtml(f.name)}" data-size="${f.size}">${icon('file')}<span>${escapeHtml(f.name)}</span><span class="size">${fmtBytes(f.size)}</span></button>`
      );
    list.innerHTML = parts.join('') || '<div class="tree-empty">Empty directory.</div>';
    list.querySelectorAll<HTMLElement>('.fm-item').forEach((item) => {
      item.onclick = async () => {
        if (item.dataset.dir) void loadDir(r.path + '/' + item.dataset.dir);
        else if (item.dataset.file) {
          const size = Number(item.dataset.size || 0);
          if (size > CHUNK_THRESHOLD) {
            showChunkChooser(r.path, { name: item.dataset.file, size });
            return;
          }
          closeFileModal();
          try {
            await openPath(r.path + '/' + item.dataset.file);
          } catch (err) {
            alert('Failed to open: ' + (err as Error).message);
          }
        }
      };
    });
  } catch (err) {
    list.innerHTML = `<div class="fm-error">${escapeHtml((err as Error).message)}</div>`;
  }
}

// ---- Boot -------------------------------------------------------------------------------

function init() {
  document.querySelector('.app-icon')!.innerHTML = logoMark(20);
  document.querySelector('.welcome-logo')!.innerHTML = logoMark(96);
  makeSplitter({ handle: el('split-sidebar'), pane: el('sidebar'), axis: 'x', min: 180, max: () => window.innerWidth * 0.5, key: 'sidebar' });
  makeSplitter({ handle: el('split-stats'), pane: el('stats-panel'), axis: 'y', paneAfter: true, min: 80, max: () => el('sidebar').clientHeight - 120, key: 'stats' });
  makeSplitter({ handle: el('split-detail'), pane: detailEl, axis: 'y', paneAfter: true, min: 60, max: () => el('main').clientHeight - 120, key: 'detail' });
  el('fm-up').innerHTML = icon('dirUp');
  buildToolbar();
  renderDetail(detailEl, null);
  grid.onSelect = (e) => renderDetail(detailEl, e);
  grid.onContextMenu = (_vi, e, x, y) => {
    if (e) showContextMenu(e, x, y);
  };
  state.rules = loadRules();
  applyGridRules();
  grid.setShowElapsed(true);

  const query = new URLSearchParams(location.search);
  api.setBase(api.deriveBase());
  api.setViewKey(query.get('viewKey') || '');
  pendingPattern = query.get('pattern');

  ws = api.wsConnect(onWsMessage);

  el('fm-cancel').onclick = () => closeFileModal();
  el('fm-tab-files').onclick = () => showOpenTab('files');
  el('fm-tab-catalog').onclick = () => showOpenTab('catalog');
  el('fm-filter').addEventListener('input', () => renderCatalog());
  el('fm-refresh').onclick = () => void loadCatalog(true);
  void api
    .capabilities()
    .then((c) => {
      caps = c;
      applyCapabilities();
    })
    .catch(() => {
      /* older server or no access: keep every feature */
    });
  el('fm-go').onclick = () => void loadDir(el<HTMLInputElement>('fm-path').value);
  el<HTMLInputElement>('fm-path').addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') void loadDir(el<HTMLInputElement>('fm-path').value);
  });
  el('modal-backdrop').addEventListener('click', (ev) => {
    if (ev.target === el('modal-backdrop')) closeFileModal();
  });

  el('menu-file').onclick = () => openFileModal();
  el('menu-filter').onclick = () => el<HTMLInputElement>('tb-search').focus();
  el('menu-tools').onclick = () => openRulesModal();
  el('menu-report').onclick = () => void openReportModal();
  el('menu-view').onclick = () => {
    const hidden = el('app').classList.toggle('detail-hidden');
    el('menu-view').setAttribute('aria-pressed', String(!hidden));
  };
  el('welcome-open').onclick = () => openFileModal();
  el('welcome-demo').onclick = () => void openStream('demo');

  document.addEventListener('click', hideContextMenu);
  document.addEventListener('keydown', (ev) => {
    if (!el('modal-backdrop').hidden) trapModalTab(el('file-modal'), ev);
    if (ev.key === 'Escape') {
      hideContextMenu();
      if (!el('modal-backdrop').hidden) closeFileModal();
      el('app').classList.remove('sidebar-open');
      el('tb-sidebar').setAttribute('aria-expanded', 'false');
    }
    if (ev.key === 'F3') {
      ev.preventDefault();
      void findNext(ev.shiftKey ? 'prev' : 'next');
    }
    if ((ev.ctrlKey || ev.metaKey) && ev.key.toLowerCase() === 'b') {
      ev.preventDefault();
      void toggleBookmark();
    }
  });

  window.addEventListener('resize', () => refreshMinimap());

  // Mirrors (remote, provider) report a connection state that changes
  // without new entries; refresh it now and then.
  setInterval(() => {
    for (const s of state.sources.values()) {
      if (s.info.connected === undefined) continue;
      api
        .getLog(s.info.id)
        .then((info) => {
          if (info.connected === s.info.connected && info.state === s.info.state) return;
          s.info.connected = info.connected;
          s.info.state = info.state;
          s.info.lastError = info.lastError;
          renderTree();
        })
        .catch(() => {});
    }
  }, 15_000);

  // Restore any sources the server already has open (page reload).
  void (async () => {
    try {
      const { sources } = await api.listLogs();
      for (const info of sources) {
        if (info.kind === 'stream') continue; // streams are opened explicitly
        addSource(info);
      }
      renderTree();
      if (state.sources.size > 0) {
        await selectSource(state.sources.keys().next().value!);
      } else {
        el('welcome').hidden = false;
      }
    } catch {
      el('welcome').hidden = false;
    }
  })();

  renderTree();
  updateStatus();
}

init();
