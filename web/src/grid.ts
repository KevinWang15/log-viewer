// Virtualized log grid. Only the visible rows exist in the DOM; entry pages
// are fetched on demand from the backend and cached per page.
// Also owns: bookmark gutter, custom color rules, keyboard navigation and
// column resizing.

import type { EntryOut, Rule } from './types';
import { LEVEL_NAMES } from './types';
import { escapeHtml, fmtElapsed, fmtFullTime, fmtTime } from './util';

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

  private viewport: HTMLElement;
  private root: HTMLElement;
  private spacer: HTMLElement;
  private rowsEl: HTMLElement;
  private headerEl: HTMLElement;
  private count = 0;
  private gen = 0;
  private cache = new Map<number, EntryOut[] | 'loading'>();
  private selectedVi = -1;
  private selectedEntry: EntryOut | null = null;
  private rules: CompiledRule[] = [];
  // Lowercase raw text per entry object, computed at most once no matter how
  // many text rules or re-renders touch it. Entries are immutable snapshots
  // from the backend, so keying on the object is safe.
  private rawLowerCache = new WeakMap<EntryOut, string>();
  private widths = { time: 105, el: 70, th: 100, lv: 60, lg: 110 };
  private renderFrame = 0;
  private lastFirst = -1;
  private lastEnd = -1;

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

    this.viewport.addEventListener('scroll', () => this.scheduleViewportRender(), { passive: true });
    new ResizeObserver(() => this.scheduleViewportRender()).observe(this.viewport);

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

  // Full reset: new source or new filter.
  reset(count: number) {
    this.gen++;
    this.cache.clear();
    this.selectedVi = -1;
    this.selectedEntry = null;
    this.onSelect?.(null);
    this.count = count;
    this.lastFirst = -1;
    this.lastEnd = -1;
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
      this.cache.delete(Math.floor((this.count - 1) / this.pageSize));
    }
    this.count = count;
    this.spacer.style.height = count * this.rowH + 'px';
    this.root.setAttribute('aria-rowcount', String(count + 1));
    if (this.follow) this.scrollToBottom();
    this.render();
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
      // Late-firing selection: the selected row's page just arrived.
      if (this.selectedVi >= 0 && !this.selectedEntry && Math.floor(this.selectedVi / this.pageSize) === p) {
        this.selectedEntry = entries[this.selectedVi % this.pageSize] ?? null;
        if (this.selectedEntry) this.onSelect?.(this.selectedEntry);
      }
      this.render();
    } catch {
      if (gen === this.gen) this.cache.delete(p);
    }
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
    const parts: string[] = [];
    for (let vi = first; vi < end; vi++) {
      const e = this.entryAt(vi);
      if (e) parts.push(this.rowHtml(vi, e));
      else
        parts.push(
          `<div id="lg-row-${vi}" class="lg-row lg-cols lg-loading" style="height:${this.rowH}px" data-vi="${vi}" role="row" aria-rowindex="${vi + 2}"><span class="c-bm" role="gridcell"></span><span class="c-time" role="gridcell"></span><span class="c-el" role="gridcell"></span><span class="c-th" role="gridcell"></span><span class="c-lv" role="gridcell"></span><span class="c-lg" role="gridcell"></span><span class="c-msg" role="gridcell">Loading…</span></div>`
        );
    }
    this.rowsEl.style.transform = `translateY(${first * this.rowH}px)`;
    this.rowsEl.innerHTML = parts.join('');
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
    const srcTip = e.src ? ` — ${escapeHtml(e.src)}` : '';
    return (
      `<div id="lg-row-${vi}" class="lg-row lg-cols lv-${e.lv}${sel ? ' lg-sel' : ''}"${style} data-vi="${vi}" role="row" aria-rowindex="${vi + 2}" aria-selected="${sel}">` +
      `<span class="c-bm" role="gridcell">${bm}</span>` +
      `<span class="c-time" role="gridcell" title="${fmtFullTime(e.t)}${srcTip}">${fmtTime(e.t)}</span>` +
      `<span class="c-el" role="gridcell">${fmtElapsed(e.elapsed)}</span>` +
      `<span class="c-th" role="gridcell">${escapeHtml(e.th)}</span>` +
      `<span class="c-lv" role="gridcell">${LEVEL_NAMES[e.lv] ?? ''}</span>` +
      `<span class="c-lg" role="gridcell">${escapeHtml(e.lg)}</span>` +
      `<span class="c-msg" role="gridcell">${multi}${escapeHtml(e.msg)}</span></div>`
    );
  }
}
