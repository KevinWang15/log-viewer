export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

// Shared scratch Date: avoids allocating one per row per render. Only safe
// because formatting is synchronous and non-reentrant (pad never re-enters).
const scratchDate = new Date(0);

export function fmtTime(t: number): string {
  if (!t) return '';
  if (t < 86400000) {
    const ms = t % 1000;
    const sec = Math.floor(t / 1000);
    return `${pad(Math.floor(sec / 3600), 2)}:${pad(Math.floor(sec / 60) % 60, 2)}:${pad(sec % 60, 2)}.${pad(ms, 3)}`;
  }
  const d = scratchDate;
  d.setTime(t);
  return `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)}.${pad(d.getMilliseconds(), 3)}`;
}

export function fmtFullTime(t: number): string {
  if (!t) return '';
  if (t < 86400000) return fmtTime(t);
  const d = scratchDate;
  d.setTime(t);
  // Extract the date part before fmtTime reuses the same scratch instance.
  const date = `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  return `${date} ${fmtTime(t)}`;
}

// Compact gap between consecutive visible entries, for the elapsed column:
// +250ms, +1.2s, 1m 3s (null/undefined renders empty).
export function fmtElapsed(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return '';
  const a = Math.abs(ms);
  const sign = ms < 0 ? '-' : '+';
  if (a < 1000) return `${sign}${a}ms`;
  if (a < 60000) return `${sign}${(a / 1000).toFixed(1).replace(/\.0$/, '')}s`;
  const m = Math.floor(a / 60000);
  const s = Math.round((a % 60000) / 1000);
  return `${ms < 0 ? '-' : ''}${m}m ${s}s`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  if (n < 1024 * 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US');
}

export function throttle<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let last = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  return (...args: A) => {
    const now = Date.now();
    const run = () => {
      last = Date.now();
      timer = null;
      fn(...args);
    };
    if (now - last >= ms) run();
    else if (!timer) timer = setTimeout(run, ms - (now - last));
  };
}
