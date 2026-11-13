// Virtualized log grid. Only the visible rows exist in the DOM; entry pages
// are fetched on demand from the backend and cached per page.
// Also owns: bookmark gutter, custom color rules, keyboard navigation and
// column resizing.

import type { EntryOut, Rule } from './types';
import { LEVEL_NAMES } from './types';
import { escapeHtml, fmtElapsed, fmtFullTime, fmtTime } from './util';

export interface ViewAnchor {
  i: number; // global entry index
  offset: number; // px from the viewport top
  select: boolean;
}

// A rendered row and the inputs it was built from; a row is rebuilt only when
// one of these changes.
interface RenderedRow {
  el: HTMLElement;
  e: EntryOut | null;
  sel: boolean;
  bm: boolean;
  label: string;
}

interface CompiledRule {
  test: (e: EntryOut) => boolean;
  style: string;
}

const COLS_KEY = 'lvw-col-widths';

export class LogGrid {
  readonly pageSize = 200;
  readonly maxCachedPages = 20;
  rowH = 21;
  follow = false;
  showLogger = true;
  showElapsed = false;
  bookmarks = new Set<number>();
  onSelect: ((e: EntryOut | null) => void) | null = null;
  onContextMenu: ((vi: number, e: EntryOut | null, x: number, y: number) => void) | null = null;
  fetchPage: ((start: number, count: number) => Promise<EntryOut[]>) | null = null;
  // Fired when the user's scrolling turns follow mode on or off.
  onFollowChange: ((on: boolean) => void) | null = null;

  private viewport: HTMLElement;
  private root: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  private headerEl: HTMLElement;
  private count = 0;
  private gen = 0;
  private cache = new Map<number, EntryOut[] | 'loading'>();
  // Cached pages that grew on append. They keep rendering their old rows while
  // a refetch is in flight, so live tailing doesn't blank the visible rows.
  private stalePages = new Set<number>();
  private refreshing = new Set<number>();
  private selectedVi = -1;
  private selectedEntry: EntryOut | null = null;
  private rules: CompiledRule[] = [];
  // Lowercase raw text per entry object, computed at most once no matter how
  // many text rules or re-renders touch it. Entries are immutable snapshots
  // from the backend, so keying on the object is safe.
  private rawLowerCache = new WeakMap<EntryOut, string>();
  private widths = { time: 105, el: 70, th: 100, lv: 72, lg: 110 };
  private renderFrame = 0;
  private lastFirst = -1;
  private lastEnd = -1;
  // Rows currently in the DOM, contiguous by view index from rowsFirst.
  private rows: RenderedRow[] = [];
  private rowsFirst = 0;
  private template = document.createElement('template');
  // Following, but the appended rows at the bottom haven't loaded yet.
  private stickPending = false;

  constructor(container: HTMLElement) {
    try {
      const saved = JSON.parse(localStorage.getItem(COLS_KEY) || 'null');
      if (saved) this.widths = { ...this.widths, ...saved };
    } catch {
      /* corrupt storage */
    }
    container.classList.add('lg-root');
    container.tabIndex = 0;
    container.setAttribute('role', 'grid');
    container.setAttribute('aria-label', 'Log entries');
    container.setAttribute('aria-rowcount', '1');
    container.setAttribute('aria-colcount', '7');
    container.innerHTML = `
      <div class="lg-header lg-cols" role="row" aria-rowindex="1">
        <span class="c-bm" role="columnheader" aria-label="Bookmark"></span>
        <span class="c-time" role="columnheader">Time<i class="col-rs" data-col="time"></i></span>
        <span class="c-el" role="columnheader">Elapsed<i class="col-rs" data-col="el"></i></span>
        <span class="c-th" role="columnheader">Thread<i class="col-rs" data-col="th"></i></span>
        <span class="c-lv" role="columnheader">Level<i class="col-rs" data-col="lv"></i></span>
        <span class="c-lg" role="columnheader">Logger<i class="col-rs" data-col="lg"></i></span>
        <span class="c-msg" role="columnheader">Message</span>
      </div>
      <div class="lg-viewport" role="presentation"><div class="lg-spacer"></div><div class="lg-rows" role="rowgroup"></div></div>`;
    this.root = container;
    this.viewport = container.querySelector('.lg-viewport') as HTMLElement;
    this.spacer = container.querySelector('.lg-spacer') as HTMLElement;
    this.rowsEl = container.querySelector('.lg-rows') as HTMLElement;
    this.headerEl = container.querySelector('.lg-header') as HTMLElement;
    this.applyColWidths(container);

    this.viewport.addEventListener(
      'scroll',
      () => {
        this.syncFollowToScroll();
        this.scheduleViewportRender();
      },
      { passive: true }
    );
    new ResizeObserver(() => {
      if (this.follow) this.scrollToBottom();
      this.scheduleViewportRender();
    }).observe(this.viewport);

    this.rowsEl.addEventListener('click', (ev) => {
      const row = (ev.target as HTMLElement).closest('.lg-row') as HTMLElement | null;
      if (!row || row.dataset.vi === undefined) return;
      this.selectVi(Number(row.dataset.vi));
      this.root.focus();
    });
    this.rowsEl.addEventListener('contextmenu', (ev) => {
      const row = (ev.target as HTMLElement).closest('.lg-row') as HTMLElement | null;
      if (!row || row.dataset.vi === undefined || !this.onContextMenu) return;
      ev.preventDefault();
      const vi = Number(row.dataset.vi);
      this.selectVi(vi);
      this.root.focus();
      this.onContextMenu(vi, this.selectedEntry, ev.clientX, ev.clientY);
    });

    this.root.addEventListener('keydown', (ev) => this.onKey(ev));
    this.headerEl.addEventListener('mousedown', (ev) => this.onColResizeStart(ev));
  }

  private applyColWidths(root?: HTMLElement) {
    const el = root ?? (this.viewport.parentElement as HTMLElement);
    const lg = this.showLogger ? `${this.widths.lg}px` : '0px';
    // Hidden elapsed column: drop both the track and the cells (a 0px track
    // would still show the cells' padding), like the narrow-viewport rule.
    el.classList.toggle('lg-no-el', !this.showElapsed);
    const cols = [
      '18px',
      `${this.widths.time}px`,
      ...(this.showElapsed ? [`${this.widths.el}px`] : []),
      `${this.widths.th}px`,
      `${this.widths.lv}px`,
      lg,
      '1fr',
    ];
    el.style.setProperty('--lg-cols', cols.join(' '));
  }

  // Stick-to-bottom: scrolling away from the bottom stops following, and
  // scrolling back to the bottom resumes it. Programmatic scrollToBottom()
  // lands exactly at the bottom, so it never unsticks.
  private syncFollowToScroll() {
    const gap = this.viewport.scrollHeight - this.viewport.clientHeight - this.viewport.scrollTop;
    const atBottom = gap <= this.rowH / 2;
    if (atBottom === this.follow) return;
    this.follow = atBottom;
    this.onFollowChange?.(atBottom);
  }

  // Scroll events can arrive much faster than a frame, and most of them stay
  // within the same row. Coalesce them and skip rebuilding an unchanged range.
  private scheduleViewportRender() {
    if (this.renderFrame) return;
    this.renderFrame = requestAnimationFrame(() => {
      this.renderFrame = 0;
      this.render(false);
    });
  }

  private onColResizeStart(ev: MouseEvent) {
    const handle = ev.target as HTMLElement;
    if (!handle.classList.contains('col-rs')) return;
    ev.preventDefault();
    const col = handle.dataset.col as keyof LogGrid['widths'];
    const startX = ev.clientX;
    const orig = this.widths[col];
    const move = (e: MouseEvent) => {
      this.widths[col] = Math.max(40, orig + (e.clientX - startX));
      this.applyColWidths();
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      localStorage.setItem(COLS_KEY, JSON.stringify(this.widths));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  }

  private onKey(ev: KeyboardEvent) {
    const visible = Math.max(1, Math.floor(this.viewport.clientHeight / this.rowH) - 1);
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown':
        this.selectVi(Math.min(this.count - 1, this.selectedVi + 1));
        break;
      case 'ArrowUp':
        this.selectVi(Math.max(0, this.selectedVi - 1));
        break;
      case 'PageDown':
        this.selectVi(Math.min(this.count - 1, this.selectedVi + visible));
        break;
      case 'PageUp':
        this.selectVi(Math.max(0, this.selectedVi - visible));
        break;
      case 'Home':
        this.selectVi(0);
        break;
      case 'End':
        this.selectVi(this.count - 1);
        break;
      case 'ContextMenu':
      case 'F10': {
        if (ev.key === 'F10' && !ev.shiftKey) {
          handled = false;
          break;
        }
        if (!this.onContextMenu || this.selectedVi < 0 || !this.selectedEntry) {
          handled = false;
          break;
        }
        const row = this.rowsEl.querySelector<HTMLElement>(`.lg-row[data-vi="${this.selectedVi}"]`);
        const rect = row?.getBoundingClientRect() ?? this.root.getBoundingClientRect();
        this.onContextMenu(this.selectedVi, this.selectedEntry, rect.left + 24, rect.top + this.rowH);
        break;
      }
      default:
        handled = false;
    }
    if (handled) ev.preventDefault();
  }

  get total() {
    return this.count;
  }
  get firstVisible() {
    return Math.max(0, Math.floor(this.viewport.scrollTop / this.rowH));
  }
  get selection(): { vi: number; entry: EntryOut | null } {
    return { vi: this.selectedVi, entry: this.selectedEntry };
  }

  setRules(rules: Rule[]) {
    this.rules = rules
      .filter((r) => r.enabled && (r.text || r.level !== null))
      .map((r) => {
        const needle = r.text ? r.text.toLowerCase() : null;
        const lv = r.level ?? null;
        const style =
          (r.fg ? `color:${r.fg};` : '') + (r.bg ? `background:${r.bg};` : '') + (r.bold ? 'font-weight:700;' : '');
        return {
          test: (e: EntryOut) => (lv === null || e.lv === lv) && (!needle || this.rawLower(e).includes(needle)),
          style,
        };
      });
    this.invalidateRows();
    this.render();
  }

  private rawLower(e: EntryOut): string {
    let lower = this.rawLowerCache.get(e);
    if (lower === undefined) {
      lower = e.raw.toLowerCase();
      this.rawLowerCache.set(e, lower);
    }
    return lower;
  }

  setShowLogger(on: boolean) {
    this.showLogger = on;
    this.applyColWidths();
    this.render();
  }

  setShowElapsed(on: boolean) {
    this.showElapsed = on;
    this.applyColWidths();
    this.render();
  }

  // Where the user is looking, for restoring the position after the view
  // changes (new filter, cleared filter). Prefers the selected entry; falls
  // back to the top visible row. `offset` is the row's distance from the
  // viewport top, so the restored row lands at the same height on screen.
  captureAnchor(): ViewAnchor | null {
    const top = this.viewport.scrollTop;
    const h = this.viewport.clientHeight;
    if (this.selectedEntry) {
      const y = this.selectedVi * this.rowH - top;
      const visible = y > -this.rowH && y < h;
      return { i: this.selectedEntry.i, offset: visible ? y : (h - this.rowH) / 2, select: true };
    }
    if (this.follow) return null;
    const vi = this.firstVisible;
    const e = this.entryAt(vi);
    return e ? { i: e.i, offset: vi * this.rowH - top, select: false } : null;
  }

  restoreAnchor(vi: number, a: ViewAnchor) {
    this.viewport.scrollTop = Math.max(0, vi * this.rowH - a.offset);
    if (a.select) this.selectVi(vi);
    else this.render();
  }

  // Full reset: new source or new filter.
  reset(count: number) {
    this.gen++;
    this.cache.clear();
    this.stalePages.clear();
    this.refreshing.clear();
    this.selectedVi = -1;
    this.selectedEntry = null;
    this.onSelect?.(null);
    this.count = count;
    this.lastFirst = -1;
    this.lastEnd = -1;
    this.stickPending = false;
    this.invalidateRows();
    this.spacer.style.height = count * this.rowH + 'px';
    this.root.setAttribute('aria-rowcount', String(count + 1));
    this.root.removeAttribute('aria-activedescendant');
    this.viewport.scrollTop = 0;
    if (this.follow) this.scrollToBottom();
    this.render();
  }

  // Append-safe count update (existing pages stay valid).
  setCount(count: number) {
    if (count === this.count) return;
    if (count < this.count) {
      this.reset(count);
      return;
    }
    if (this.count > 0 && this.count % this.pageSize !== 0) {
      const p = Math.floor((this.count - 1) / this.pageSize);
      if (this.cache.get(p) === 'loading') this.cache.delete(p);
      else if (this.cache.has(p)) this.stalePages.add(p);
    }
    this.count = count;
    this.spacer.style.height = count * this.rowH + 'px';
    this.root.setAttribute('aria-rowcount', String(count + 1));
    if (this.follow) {
      // Scroll once the appended rows have loaded (pageArrived), so tailing
      // paints each batch once and never shows blank rows.
      if (this.bottomLoaded()) this.scrollToBottom();
      else this.stickPending = true;
    }
    this.render();
  }

  // Whether the rows of a screen at the very bottom are loaded; requests the
  // missing pages as a side effect.
  private bottomLoaded(): boolean {
    const visible = Math.ceil(this.viewport.clientHeight / this.rowH) + 2;
    let loaded = true;
    for (let vi = Math.max(0, this.count - visible); vi < this.count; vi++) if (!this.entryAt(vi)) loaded = false;
    return loaded;
  }

  scrollToBottom() {
    this.viewport.scrollTop = this.viewport.scrollHeight;
  }

  scrollToIndex(vi: number) {
    this.viewport.scrollTop = Math.max(0, vi * this.rowH - this.viewport.clientHeight / 2);
  }

  isAtBottom(): boolean {
    return this.viewport.scrollTop + this.viewport.clientHeight >= this.viewport.scrollHeight - this.rowH * 2;
  }

  // Select a view index, scrolling it into view; onSelect fires once the
  // entry's page has loaded.
  selectVi(vi: number) {
    if (vi < 0 || vi >= this.count) return;
    this.selectedVi = vi;
    this.root.setAttribute('aria-activedescendant', `lg-row-${vi}`);
    this.selectedEntry = null;
    const top = vi * this.rowH;
    if (top < this.viewport.scrollTop || top + this.rowH > this.viewport.scrollTop + this.viewport.clientHeight) {
      this.scrollToIndex(vi);
    }
    const pageNumber = Math.floor(vi / this.pageSize);
    const page = this.cachedPage(pageNumber);
    if (Array.isArray(page)) {
      this.selectedEntry = page[vi % this.pageSize] ?? null;
      this.onSelect?.(this.selectedEntry);
    }
    this.render();
  }

  private entryAt(vi: number): EntryOut | null {
    const p = Math.floor(vi / this.pageSize);
    const page = this.cachedPage(p);
    if (page === undefined) {
      void this.ensurePage(p);
      return null;
    }
    if (page === 'loading') return null;
    if (this.stalePages.has(p)) void this.refreshPage(p);
    return page[vi % this.pageSize] ?? null;
  }

  private async ensurePage(p: number) {
    if (!this.fetchPage || this.cache.has(p)) return;
    this.cachePage(p, 'loading');
    const gen = this.gen;
    try {
      const entries = await this.fetchPage(p * this.pageSize, this.pageSize);
      if (gen !== this.gen) return;
      this.cachePage(p, entries);
      this.pageArrived(p, entries);
    } catch {
      if (gen === this.gen) this.cache.delete(p);
    }
  }

  // Refetch a stale page without dropping its cached rows. If more appends
  // land while the request is in flight, the page is marked stale again and
  // the next render refetches it. Only the tail is fetched: appends never
  // change earlier rows, so the request starts two rows before the end of the
  // cached ones. The last cached entry may have grown (continuation lines
  // tailed in) and is replaced; the one before it is dropped from the response
  // because the server computes `elapsed` per window, so the first row of a
  // window has none.
  private async refreshPage(p: number) {
    if (!this.fetchPage || this.refreshing.has(p)) return;
    this.stalePages.delete(p);
    this.refreshing.add(p);
    const gen = this.gen;
    const cached = this.cache.get(p);
    const have = Array.isArray(cached) ? cached.length : 0;
    const from = have >= 2 ? have - 2 : 0;
    try {
      const fresh = await this.fetchPage(p * this.pageSize + from, this.pageSize - from);
      if (gen !== this.gen) return;
      this.refreshing.delete(p);
      // Merge only into the array the request was based on.
      if (this.cache.get(p) !== cached) return;
      const entries = from && Array.isArray(cached) ? cached.slice(0, have - 1).concat(fresh.slice(1)) : fresh;
      this.cachePage(p, entries);
      this.pageArrived(p, entries);
    } catch {
      if (gen !== this.gen) return;
      this.refreshing.delete(p);
      if (this.cache.has(p)) this.stalePages.add(p);
    }
  }

  private pageArrived(p: number, entries: EntryOut[]) {
    // Late-firing selection: the selected row's page just arrived.
    if (this.selectedVi >= 0 && !this.selectedEntry && Math.floor(this.selectedVi / this.pageSize) === p) {
      this.selectedEntry = entries[this.selectedVi % this.pageSize] ?? null;
      if (this.selectedEntry) this.onSelect?.(this.selectedEntry);
    }
    if (this.stickPending && this.follow && this.bottomLoaded()) {
      this.stickPending = false;
      this.scrollToBottom();
    }
    this.render();
  }

  private cachedPage(p: number): EntryOut[] | 'loading' | undefined {
    const page = this.cache.get(p);
    if (page === undefined) return undefined;
    // Map insertion order doubles as a tiny LRU list.
    this.cache.delete(p);
    this.cache.set(p, page);
    return page;
  }

  private cachePage(p: number, page: EntryOut[] | 'loading') {
    this.cache.delete(p);
    this.cache.set(p, page);
    while (this.cache.size > this.maxCachedPages) {
      const oldest = this.cache.keys().next().value as number | undefined;
      if (oldest === undefined) break;
      this.cache.delete(oldest);
      this.stalePages.delete(oldest);
    }
  }

  render(force = true) {
    const h = this.viewport.clientHeight;
    let first = Math.floor(this.viewport.scrollTop / this.rowH);
    first = Math.max(0, Math.min(first, Math.max(0, this.count - 1)));
    const end = Math.min(this.count, first + Math.ceil(h / this.rowH) + 2);
    if (!force && first === this.lastFirst && end === this.lastEnd) return;
    this.lastFirst = first;
    this.lastEnd = end;
    if (this.selectedVi >= first && this.selectedVi < end) {
      this.root.setAttribute('aria-activedescendant', `lg-row-${this.selectedVi}`);
    } else {
      this.root.removeAttribute('aria-activedescendant');
    }
    this.rowsEl.style.transform = `translateY(${first * this.rowH}px)`;
    this.syncRows(first, end);
    // Prefetch the pages just above and below the screen, so smooth scrolling
    // reaches loaded rows instead of placeholders at page boundaries.
    if (this.count > 0) {
      const margin = end - first;
      this.prefetch(Math.max(0, first - margin));
      this.prefetch(Math.min(this.count - 1, end + margin));
    }
  }

  private prefetch(vi: number) {
    const p = Math.floor(vi / this.pageSize);
    if (!this.cache.has(p)) void this.ensurePage(p);
  }

  private invalidateRows() {
    this.rows = [];
    this.rowsEl.textContent = '';
  }

  private wantRow(vi: number): Omit<RenderedRow, 'el'> {
    const e = this.entryAt(vi);
    // Rows just appended to a cached page stay blank instead of showing
    // "Loading…"; they fill in a few milliseconds later.
    const label = e || Array.isArray(this.cache.get(Math.floor(vi / this.pageSize))) ? '' : 'Loading…';
    return { e, sel: vi === this.selectedVi, bm: !!e && this.bookmarks.has(e.i), label };
  }

  // Builds rows for consecutive view indices from `first`, or for the given
  // `vis`, with a single HTML parse.
  private buildRows(first: number, wants: Array<Omit<RenderedRow, 'el'>>, vis?: number[]): RenderedRow[] {
    this.template.innerHTML = wants
      .map((w, k) => {
        const vi = vis ? vis[k] : first + k;
        return w.e ? this.rowHtml(vi, w.e) : this.placeholderHtml(vi, w.label);
      })
      .join('');
    const els = Array.from(this.template.content.children) as HTMLElement[];
    return wants.map((w, k) => ({ ...w, el: els[k] }));
  }

  // Brings the DOM rows to [first, end) with as little DOM work as possible:
  // rows that stay on screen keep their node (and its computed style and
  // layout), rows that left are removed, rows whose inputs changed are
  // replaced in place, and only rows that scrolled in are created.
  private syncRows(first: number, end: number) {
    const curEnd = this.rowsFirst + this.rows.length;
    if (!this.rows.length || end <= this.rowsFirst || first >= curEnd) {
      const wants = [];
      for (let vi = first; vi < end; vi++) wants.push(this.wantRow(vi));
      this.rows = this.buildRows(first, wants);
      this.rowsFirst = first;
      this.rowsEl.replaceChildren(...this.rows.map((r) => r.el));
      return;
    }
    while (this.rowsFirst < first) {
      this.rows.shift()!.el.remove();
      this.rowsFirst++;
    }
    while (this.rowsFirst + this.rows.length > end) this.rows.pop()!.el.remove();
    const changed: number[] = [];
    const changedWants: Array<Omit<RenderedRow, 'el'>> = [];
    for (let k = 0; k < this.rows.length; k++) {
      const r = this.rows[k];
      const w = this.wantRow(this.rowsFirst + k);
      if (r.e !== w.e || r.sel !== w.sel || r.bm !== w.bm || r.label !== w.label) {
        changed.push(k);
        changedWants.push(w);
      }
    }
    if (changed.length) {
      const built = this.buildRows(0, changedWants, changed.map((k) => this.rowsFirst + k));
      changed.forEach((k, j) => {
        this.rows[k].el.replaceWith(built[j].el);
        this.rows[k] = built[j];
      });
    }
    if (first < this.rowsFirst) {
      const wants = [];
      for (let vi = first; vi < this.rowsFirst; vi++) wants.push(this.wantRow(vi));
      const added = this.buildRows(first, wants);
      this.rowsEl.prepend(...added.map((r) => r.el));
      this.rows.unshift(...added);
      this.rowsFirst = first;
    }
    const tail = this.rowsFirst + this.rows.length;
    if (tail < end) {
      const wants = [];
      for (let vi = tail; vi < end; vi++) wants.push(this.wantRow(vi));
      const added = this.buildRows(tail, wants);
      this.rowsEl.append(...added.map((r) => r.el));
      this.rows.push(...added);
    }
  }

  private placeholderHtml(vi: number, label: string): string {
    return `<div id="lg-row-${vi}" class="lg-row lg-cols lg-loading" style="height:${this.rowH}px" data-vi="${vi}" role="row" aria-rowindex="${vi + 2}"><span class="c-bm" role="gridcell"></span><span class="c-time" role="gridcell"></span><span class="c-el" role="gridcell"></span><span class="c-th" role="gridcell"></span><span class="c-lv" role="gridcell"></span><span class="c-lg" role="gridcell"></span><span class="c-msg" role="gridcell">${label}</span></div>`;
  }

  private rowHtml(vi: number, e: EntryOut): string {
    const sel = vi === this.selectedVi;
    let style = '';
    if (!sel) {
      for (const r of this.rules) {
        if (r.test(e)) {
          style = ` style="height:${this.rowH}px;${r.style}"`;
          break;
        }
      }
    }
    if (!style) style = ` style="height:${this.rowH}px"`;
    const bm = this.bookmarks.has(e.i) ? '<i class="bm-flag"></i>' : '';
    const multi = e.raw.includes('\n') ? '<span class="lg-more">▸</span>' : '';
    const srcTip = e.src ? ` · ${escapeHtml(e.src)}` : '';
    return (
      `<div id="lg-row-${vi}" class="lg-row lg-cols lv-${e.lv}${sel ? ' lg-sel' : ''}"${style} data-vi="${vi}" role="row" aria-rowindex="${vi + 2}" aria-selected="${sel}">` +
      `<span class="c-bm" role="gridcell">${bm}</span>` +
      `<span class="c-time" role="gridcell" title="${fmtFullTime(e.t)}${srcTip}">${fmtTime(e.t)}</span>` +
      `<span class="c-el" role="gridcell">${fmtElapsed(e.elapsed)}</span>` +
      `<span class="c-th" role="gridcell">${escapeHtml(e.th)}</span>` +
      `<span class="c-lv" role="gridcell"><b class="lv-tag">${LEVEL_NAMES[e.lv] ?? ''}</b></span>` +
      `<span class="c-lg" role="gridcell">${escapeHtml(e.lg)}</span>` +
      `<span class="c-msg" role="gridcell">${multi}${escapeHtml(e.msg)}</span></div>`
    );
  }
}
