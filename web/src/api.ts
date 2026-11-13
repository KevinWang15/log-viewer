import type { BrowseResult, Capabilities, CatalogLog, Criteria, EntryOut, FilterResult, SourceInfo, WsAppendMsg } from './types';

let BASE = '';
let VIEW_KEY = '';

export function setBase(base: string) {
  BASE = base.replace(/\/$/, '');
}

// The API base for a UI served by the viewer itself: the directory of the
// current page, so a viewer mounted under /logs/ talks to /logs/api.
export function deriveBase(): string {
  return new URL('.', location.href).pathname.replace(/\/$/, '');
}

export function setViewKey(key: string) {
  VIEW_KEY = key;
}

function withViewKey(path: string): string {
  if (!VIEW_KEY) return path;
  return path + (path.includes('?') ? '&' : '?') + 'viewKey=' + encodeURIComponent(VIEW_KEY);
}

async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(BASE + withViewKey(path), init);
  if (!res.ok) {
    let msg = res.statusText;
    try {
      msg = ((await res.json()) as { error?: string }).error || msg;
    } catch {
      /* non-json error body */
    }
    const err = new Error(msg) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

export const capabilities = () => req<Capabilities>('/api/v1/capabilities');

export const providerLogs = (providerId: string) =>
  req<{ logs: CatalogLog[] }>(`/api/v1/providers/${encodeURIComponent(providerId)}/logs`);

export const openProviderLog = (providerId: string, logId: string) =>
  req<SourceInfo>(
    `/api/v1/providers/${encodeURIComponent(providerId)}/logs/${encodeURIComponent(logId)}/open`,
    post({})
  );

export const browse = (path?: string) =>
  req<BrowseResult>('/api/browse' + (path ? '?path=' + encodeURIComponent(path) : ''));

export const openLog = (path: string) => req<SourceInfo>('/api/logs/open', post({ path }));
export const listLogs = () => req<{ sources: SourceInfo[] }>('/api/logs');
export const getLog = (id: string) => req<SourceInfo>('/api/logs/' + encodeURIComponent(id));
export const closeLog = (id: string) =>
  req<{ ok: boolean }>('/api/logs/' + encodeURIComponent(id), { method: 'DELETE' });

export const createFilter = (id: string, criteria: Criteria) =>
  req<FilterResult>(`/api/logs/${encodeURIComponent(id)}/filters`, post({ criteria }));
export const deleteFilter = (id: string, fid: string) =>
  req<{ ok: boolean }>(`/api/logs/${encodeURIComponent(id)}/filters/${encodeURIComponent(fid)}`, {
    method: 'DELETE',
  });

export const getEntries = (id: string, start: number, count: number, filterId?: string | null) =>
  req<{ entries: EntryOut[] }>(
    `/api/logs/${encodeURIComponent(id)}/entries?start=${start}&count=${count}` +
      (filterId ? '&filter=' + encodeURIComponent(filterId) : '')
  );

export const getMinimap = (id: string, buckets: number, filterId?: string | null) =>
  req<{ buckets: number[]; bookmarks?: boolean[]; count: number }>(
    `/api/logs/${encodeURIComponent(id)}/minimap?buckets=${buckets}` +
      (filterId ? '&filter=' + encodeURIComponent(filterId) : '')
  );

export const openStream = (channel: string) => req<SourceInfo>('/api/v1/streams/' + encodeURIComponent(channel));

export const openLogChunk = (path: string, start: number, end?: number) =>
  req<SourceInfo>('/api/logs/open', post({ path, start, end }));

export const statFile = (path: string) =>
  req<{ path: string; size: number; mtime: number }>('/api/stat?path=' + encodeURIComponent(path));

export const mergeLogs = (ids: string[], name?: string) => req<SourceInfo>('/api/logs/merge', post({ ids, name }));

export const setParser = (id: string, pattern: string) =>
  req<SourceInfo>(`/api/logs/${encodeURIComponent(id)}/parser`, post({ pattern }));

export const getBookmarks = (id: string) =>
  req<{ indices: number[] }>(`/api/logs/${encodeURIComponent(id)}/bookmarks`);
export const toggleBookmark = (id: string, index: number) =>
  req<{ index: number; on: boolean; total: number }>(`/api/logs/${encodeURIComponent(id)}/bookmarks`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ index }),
  });
export const nextBookmark = (id: string, from: number, dir: 'next' | 'prev', filterId?: string | null) =>
  req<{ vi: number | null }>(
    `/api/logs/${encodeURIComponent(id)}/bookmarks/next?from=${from}&dir=${dir}` +
      (filterId ? '&filter=' + encodeURIComponent(filterId) : '')
  );

export const locate = (id: string, i: number, filterId?: string | null) =>
  req<{ vi: number | null; exact: boolean }>(
    `/api/logs/${encodeURIComponent(id)}/locate?i=${i}` + (filterId ? '&filter=' + encodeURIComponent(filterId) : '')
  );

export const search = (id: string, q: string, from: number, dir: 'next' | 'prev', filterId?: string | null) =>
  req<{ vi: number | null; capped?: boolean }>(
    `/api/logs/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}&from=${from}&dir=${dir}` +
      (filterId ? '&filter=' + encodeURIComponent(filterId) : '')
  );

export interface CorrelateResult {
  key: string;
  value: string;
  count: number;
  indices: number[];
  truncated?: boolean;
}

export const correlate = (id: string, i: number, key?: string) =>
  req<CorrelateResult>(
    `/api/logs/${encodeURIComponent(id)}/correlate?i=${i}` + (key ? '&key=' + encodeURIComponent(key) : '')
  );

export interface ReportData {
  from: number;
  to: number;
  total: number;
  buckets: Array<{ t: number; counts: number[] }>;
  series: number[][]; // per level (TRACE..FATAL), one count per bucket
  topLoggers: Array<{ name: string; count: number }>;
  topThreads: Array<{ name: string; count: number }>;
  topMessages: Array<{ template: string; count: number; example: string }>;
}

export const getReport = (id: string, filterId?: string | null) =>
  req<ReportData>(
    `/api/logs/${encodeURIComponent(id)}/report?buckets=80` +
      (filterId ? '&filter=' + encodeURIComponent(filterId) : '')
  );

export const exportUrl = (id: string, filterId?: string | null) =>
  withViewKey(
    `${BASE}/api/logs/${encodeURIComponent(id)}/export` + (filterId ? '?filter=' + encodeURIComponent(filterId) : '')
  );

// ---- WebSocket with auto-reconnect and re-subscription ----------------------

export interface WsClient {
  sub(id: string): void;
  unsub(id: string): void;
  close(): void;
}

export type WsConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'closed';

export function wsConnect(
  onMsg: (msg: WsAppendMsg) => void,
  onStatus: (status: WsConnectionStatus) => void = () => {}
): WsClient {
  const subscribed = new Set<string>();
  let ws: WebSocket | null = null;
  let closed = false;
  let retry = 0;
  let retryTimer: number | null = null;

  const url = () => {
    const target = new URL((BASE || '') + '/ws', location.origin);
    target.protocol = target.protocol === 'https:' ? 'wss:' : 'ws:';
    return target.toString();
  };

  const subMsg = (id: string) => JSON.stringify({ type: 'sub', id, viewKey: VIEW_KEY || undefined });

  const connect = () => {
    if (closed) return;
    onStatus(retry ? 'reconnecting' : 'connecting');
    ws = new WebSocket(url());
    ws.onopen = () => {
      retry = 0;
      onStatus('connected');
      for (const id of subscribed) ws?.send(subMsg(id));
    };
    ws.onmessage = (ev) => {
      try {
        onMsg(JSON.parse(ev.data as string) as WsAppendMsg);
      } catch {
        /* ignore */
      }
    };
    ws.onclose = () => {
      ws = null;
      if (!closed) {
        onStatus('reconnecting');
        const delay = Math.min(10_000, 500 * 2 ** Math.min(retry++, 5));
        retryTimer = window.setTimeout(connect, delay);
      }
    };
  };
  connect();

  return {
    sub(id: string) {
      subscribed.add(id);
      if (ws?.readyState === WebSocket.OPEN) ws.send(subMsg(id));
    },
    unsub(id: string) {
      subscribed.delete(id);
      if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'unsub', id }));
    },
    close() {
      closed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      ws?.close();
      onStatus('closed');
    },
  };
}
