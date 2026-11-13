// Draggable pane dividers. Each splitter resizes one pane along one axis and
// persists the size in localStorage. Keyboard: arrow keys nudge, Home/End jump
// to the limits; double-click resets to the stylesheet default.

const STORE_KEY = 'lvw-pane-sizes';

interface SplitterOptions {
  handle: HTMLElement;
  pane: HTMLElement;
  axis: 'x' | 'y';
  // True when the pane sits after the handle (dragging toward it grows it).
  paneAfter?: boolean;
  min: number;
  // Maximum size, computed at drag time so it follows the window size.
  max: () => number;
  key: string;
}

function loadSizes(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(STORE_KEY) || '{}') ?? {};
  } catch {
    return {};
  }
}

export function makeSplitter(o: SplitterOptions) {
  const prop = o.axis === 'x' ? 'width' : 'height';
  const sizeOf = () => (o.axis === 'x' ? o.pane.offsetWidth : o.pane.offsetHeight);
  const clamp = (v: number) => Math.round(Math.max(o.min, Math.min(o.max(), v)));

  o.handle.setAttribute('role', 'separator');
  // A separator between side-by-side panes is a vertical line, and vice versa.
  o.handle.setAttribute('aria-orientation', o.axis === 'x' ? 'vertical' : 'horizontal');
  o.handle.tabIndex = 0;

  const apply = (v: number, persist: boolean) => {
    const size = clamp(v);
    o.pane.style[prop] = size + 'px';
    o.handle.setAttribute('aria-valuenow', String(size));
    o.handle.setAttribute('aria-valuemin', String(o.min));
    o.handle.setAttribute('aria-valuemax', String(Math.round(o.max())));
    if (persist) {
      const sizes = loadSizes();
      sizes[o.key] = size;
      localStorage.setItem(STORE_KEY, JSON.stringify(sizes));
    }
  };

  const saved = loadSizes()[o.key];
  if (typeof saved === 'number') apply(saved, false);

  o.handle.addEventListener('pointerdown', (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    const start = o.axis === 'x' ? ev.clientX : ev.clientY;
    const startSize = sizeOf();
    const sign = o.paneAfter ? -1 : 1;
    o.handle.setPointerCapture(ev.pointerId);
    document.body.classList.add(o.axis === 'x' ? 'resizing-x' : 'resizing-y');
    o.handle.classList.add('dragging');
    let frame = 0;
    let pending = startSize;
    let moved = false;
    const move = (e: PointerEvent) => {
      pending = startSize + sign * ((o.axis === 'x' ? e.clientX : e.clientY) - start);
      moved = true;
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          apply(pending, false);
        });
      }
    };
    const up = () => {
      if (frame) cancelAnimationFrame(frame);
      if (moved) apply(pending, true);
      o.handle.removeEventListener('pointermove', move);
      o.handle.removeEventListener('pointerup', up);
      o.handle.removeEventListener('pointercancel', up);
      document.body.classList.remove('resizing-x', 'resizing-y');
      o.handle.classList.remove('dragging');
    };
    o.handle.addEventListener('pointermove', move);
    o.handle.addEventListener('pointerup', up);
    o.handle.addEventListener('pointercancel', up);
  });

  o.handle.addEventListener('keydown', (ev) => {
    const grow = o.paneAfter ? -1 : 1;
    const step = ev.shiftKey ? 50 : 10;
    const back = o.axis === 'x' ? 'ArrowLeft' : 'ArrowUp';
    const fwd = o.axis === 'x' ? 'ArrowRight' : 'ArrowDown';
    let next: number | null = null;
    if (ev.key === fwd) next = sizeOf() + grow * step;
    else if (ev.key === back) next = sizeOf() - grow * step;
    else if (ev.key === 'Home') next = o.min;
    else if (ev.key === 'End') next = o.max();
    if (next === null) return;
    ev.preventDefault();
    apply(next, true);
  });

  o.handle.addEventListener('dblclick', () => {
    o.pane.style[prop] = '';
    const sizes = loadSizes();
    delete sizes[o.key];
    localStorage.setItem(STORE_KEY, JSON.stringify(sizes));
    o.handle.setAttribute('aria-valuenow', String(sizeOf()));
  });
}
