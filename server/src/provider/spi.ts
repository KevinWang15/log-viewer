// Provider SPI: plug your own log storage (a database, an object store, a
// log service) into log-viewer by implementing list + watch.
//
//   const provider: LogProvider = {
//     apiVersion: 1,
//     id: 'db',
//     async listLogs() { return [{ id: 'api', name: 'API service' }]; },
//     open(logId) {
//       return {
//         async list({ after, limit }) { ... return { records, more } },
//         async tail({ limit }) { ... },          // optional, recommended
//         async *watch({ after, signal }) { ... }, // optional; else polling
//       };
//     },
//   };
//
// The viewer keeps a bounded in-memory mirror of each opened log (the newest
// `maxEntries` records) and serves every feature from it: filters, search,
// minimap, reports, correlation, bookmarks, rules. See docs/providers.md.
//
// Stability: v1 only ever gains optional members. Members marked "reserved"
// are not called by this version; they are placeholders for query pushdown.

export const PROVIDER_API_VERSION = 1 as const;

// Opaque resume point, totally ordered within one log. list({ after: c })
// returns records strictly after c. Typically a row id, offset or sequence.
export type Cursor = string;

export interface LogRecord {
  cursor: Cursor;
  // Epoch ms, an ISO-8601 string, or a Date. Missing = no timestamp.
  time?: number | string | Date;
  // 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR' | 'FATAL' (and common
  // aliases like 'warning', 'err'), or 0..5.
  level?: string | number;
  thread?: string;
  logger?: string;
  // Full message text; the first line is shown in the grid.
  message: string;
  // Text used for search and text filters; defaults to `message`.
  raw?: string;
  // Reserved for structured fields (not used by v1).
  fields?: Record<string, string | number | boolean | null>;
}

export interface LogDescriptor {
  id: string;
  name: string;
  description?: string;
  labels?: Record<string, string>;
}

export interface ListRequest {
  // null = from the beginning.
  after: Cursor | null;
  limit: number;
  signal: AbortSignal;
}

export interface ListPage {
  // In cursor order, strictly after `after`, at most `limit`.
  records: LogRecord[];
  // More records are available right now. Default: records.length === limit.
  more?: boolean;
}

export interface TailRequest {
  // The newest `limit` records, returned in ascending cursor order.
  limit: number;
  signal: AbortSignal;
}

export interface WatchRequest {
  after: Cursor | null;
  signal: AbortSignal;
}

export type WatchEvent =
  | { type: 'records'; records: LogRecord[] }
  // History before the cursor changed (deletes, backfill, retention): the
  // viewer reloads the log.
  | { type: 'reset'; reason?: string }
  | { type: 'heartbeat' };

export interface LogHandle {
  list(req: ListRequest): Promise<ListPage>;
  // Strongly recommended for large logs: without it the initial load pages
  // through the whole log with list() and keeps the newest records.
  tail?(req: TailRequest): Promise<ListPage>;
  // Push notifications. Without it the viewer polls list() for new records.
  // Treated as a hint: after any reconnect the viewer catches up with list(),
  // so a watch that may drop events (e.g. Postgres NOTIFY) is fine.
  watch?(req: WatchRequest): AsyncIterable<WatchEvent>;
  close?(): Promise<void>;
  // Reserved (query pushdown, not called in v1): count?(), query?(), search?()
}

export interface ProviderCapabilities {
  // Reserved for query pushdown; ignored in v1.
  count?: boolean;
  query?: boolean;
  search?: boolean;
}

export interface LogProvider {
  readonly apiVersion: typeof PROVIDER_API_VERSION;
  // [A-Za-z0-9._-]{1,64}
  readonly id: string;
  readonly name?: string;
  readonly capabilities?: ProviderCapabilities;
  // The log catalog shown in the UI's Open dialog.
  listLogs(signal?: AbortSignal): Promise<LogDescriptor[]>;
  open(logId: string, ctx: { signal: AbortSignal }): Promise<LogHandle> | LogHandle;
  close?(): Promise<void>;
}

// Throw from provider methods. Errors are retried with backoff unless
// `retryable` is false (the log is then marked failed). `status` is used when
// the error happens while a user opens the log (e.g. 404 for unknown ids).
export class ProviderError extends Error {
  readonly status?: number;
  readonly retryable: boolean;
  constructor(message: string, opts: { status?: number; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = 'ProviderError';
    this.status = opts.status;
    this.retryable = opts.retryable ?? true;
  }
}

// The cursor is no longer valid (it fell out of retention, or history was
// rewritten). The viewer reloads the log instead of retrying.
export class CursorExpiredError extends ProviderError {
  constructor(message = 'cursor expired') {
    super(message, { status: 409, retryable: true });
    this.name = 'CursorExpiredError';
  }
}

export interface SimpleProviderSpec {
  id: string;
  name?: string;
  logs(signal?: AbortSignal): Promise<LogDescriptor[]>;
  list(logId: string, req: ListRequest): Promise<ListPage>;
  tail?(logId: string, req: TailRequest): Promise<ListPage>;
  watch?(logId: string, req: WatchRequest): AsyncIterable<WatchEvent>;
}

// Shorthand for providers written as plain functions of (logId, request).
export function defineProvider(spec: SimpleProviderSpec): LogProvider {
  return {
    apiVersion: PROVIDER_API_VERSION,
    id: spec.id,
    name: spec.name,
    listLogs: (signal) => spec.logs(signal),
    open: (logId) => ({
      list: (req) => spec.list(logId, req),
      tail: spec.tail ? (req) => spec.tail!(logId, req) : undefined,
      watch: spec.watch ? (req) => spec.watch!(logId, req) : undefined,
    }),
  };
}
