// MemoryProvider: an in-memory LogProvider. Useful for tests, demos and as a
// reference implementation of the SPI (list, tail, watch, reset, expiry).
//
//   const mem = new MemoryProvider('mem');
//   mem.addLog({ id: 'app', name: 'App' });
//   mem.push('app', [{ time: Date.now(), level: 'INFO', message: 'hello' }]);

import {
  CursorExpiredError,
  ListPage,
  ListRequest,
  LogDescriptor,
  LogHandle,
  LogProvider,
  LogRecord,
  PROVIDER_API_VERSION,
  ProviderError,
  TailRequest,
  WatchEvent,
  WatchRequest,
} from './spi';

interface MemoryLog {
  desc: LogDescriptor;
  records: LogRecord[]; // ascending; cursor = String(seq)
  seq: number; // last assigned sequence number
  firstSeq: number; // sequence number of records[0]
  notify: Set<(ev?: WatchEvent) => void>;
}

export interface MemoryProviderOptions {
  name?: string;
  // Offer watch(); false makes the viewer poll list().
  watch?: boolean;
  // Offer tail(); false makes the initial load page through list().
  tail?: boolean;
}

export class MemoryProvider implements LogProvider {
  readonly apiVersion = PROVIDER_API_VERSION;
  readonly name?: string;
  private readonly logs = new Map<string, MemoryLog>();
  private failures: Array<{ retryable: boolean }> = [];
  // Number of list/tail calls made, for tests.
  calls = { list: 0, tail: 0, watch: 0 };

  constructor(
    readonly id = 'memory',
    private readonly opts: MemoryProviderOptions = {}
  ) {
    this.name = opts.name;
  }

  addLog(desc: LogDescriptor) {
    if (!this.logs.has(desc.id)) this.logs.set(desc.id, { desc, records: [], seq: 0, firstSeq: 1, notify: new Set() });
  }

  // Appends records (cursors are assigned) and wakes watchers.
  push(logId: string, records: Array<Omit<LogRecord, 'cursor'>>): LogRecord[] {
    const log = this.mustGet(logId);
    const added = records.map((r) => ({ ...r, cursor: String(++log.seq) }) as LogRecord);
    log.records.push(...added);
    for (const n of log.notify) n();
    return added;
  }

  // Drops all but the newest `keep` records; older cursors expire.
  truncate(logId: string, keep: number) {
    const log = this.mustGet(logId);
    const drop = Math.max(0, log.records.length - keep);
    log.records.splice(0, drop);
    log.firstSeq += drop;
  }

  // Tells watchers that history changed (they reload).
  emitReset(logId: string) {
    for (const n of this.mustGet(logId).notify) n({ type: 'reset', reason: 'test' });
  }

  // Makes the next `n` list/tail calls throw.
  failNext(n = 1, retryable = true) {
    for (let k = 0; k < n; k++) this.failures.push({ retryable });
  }

  async listLogs(): Promise<LogDescriptor[]> {
    return [...this.logs.values()].map((l) => l.desc);
  }

  open(logId: string): LogHandle {
    const log = this.logs.get(logId);
    if (!log) throw new ProviderError(`unknown log ${logId}`, { status: 404, retryable: false });
    const handle: LogHandle = { list: (req) => this.list(log, req) };
    if (this.opts.tail !== false) handle.tail = (req) => this.tail(log, req);
    if (this.opts.watch !== false) handle.watch = (req) => this.watch(log, req);
    return handle;
  }

  private mustGet(logId: string): MemoryLog {
    const log = this.logs.get(logId);
    if (!log) throw new Error(`unknown log ${logId}`);
    return log;
  }

  private maybeFail() {
    const f = this.failures.shift();
    if (f) throw new ProviderError('injected failure', { retryable: f.retryable });
  }

  // Index of the first record strictly after `after`.
  private startIndex(log: MemoryLog, after: string | null): number {
    if (after === null) return 0;
    const seq = Number(after);
    if (!Number.isFinite(seq)) throw new ProviderError('bad cursor ' + after, { retryable: false });
    if (seq < log.firstSeq - 1) throw new CursorExpiredError();
    return Math.min(log.records.length, seq - log.firstSeq + 1);
  }

  private async list(log: MemoryLog, req: ListRequest): Promise<ListPage> {
    this.calls.list++;
    this.maybeFail();
    const from = this.startIndex(log, req.after);
    const records = log.records.slice(from, from + req.limit);
    return { records, more: from + records.length < log.records.length };
  }

  private async tail(log: MemoryLog, req: TailRequest): Promise<ListPage> {
    this.calls.tail++;
    this.maybeFail();
    return { records: log.records.slice(Math.max(0, log.records.length - req.limit)) };
  }

  private async *watch(log: MemoryLog, req: WatchRequest): AsyncIterable<WatchEvent> {
    this.calls.watch++;
    let after = req.after;
    for (;;) {
      if (req.signal.aborted) return;
      let from: number;
      try {
        from = this.startIndex(log, after);
      } catch {
        yield { type: 'reset', reason: 'cursor expired' };
        return;
      }
      if (from < log.records.length) {
        const records = log.records.slice(from);
        after = records[records.length - 1].cursor;
        yield { type: 'records', records };
        continue;
      }
      const ev = await new Promise<WatchEvent | undefined>((resolve) => {
        const n = (e?: WatchEvent) => {
          log.notify.delete(n);
          resolve(e);
        };
        log.notify.add(n);
        req.signal.addEventListener('abort', () => n(), { once: true });
      });
      if (ev) {
        yield ev;
        if (ev.type === 'reset') return;
      }
    }
  }
}
