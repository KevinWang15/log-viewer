// Conformance checks for LogProvider implementations. Framework-agnostic:
//
//   import { checkProvider } from '@kevinwang15/log-viewer/testing';
//   const report = await checkProvider(myProvider, { logId: 'api', insert: (n) => seed(n) });
//   assert.ok(report.ok, report.failures.join('\n'));
//
// The log should contain at least a few records. Pass `insert` (appends n
// records to the log) to also check that new records are listed and watched.

import type { Cursor, LogHandle, LogProvider, LogRecord } from './spi';
import { PROVIDER_API_VERSION } from './spi';

export interface ConformanceOptions {
  logId: string;
  insert?: (n: number) => Promise<void>;
  timeoutMs?: number; // per watch expectation, default 3000
}

export interface ConformanceResult {
  name: string;
  ok: boolean;
  detail?: string;
}

export interface ConformanceReport {
  ok: boolean;
  results: ConformanceResult[];
  failures: string[];
}

async function listAll(handle: LogHandle, limit: number, signal: AbortSignal) {
  const pages: LogRecord[][] = [];
  let after: Cursor | null = null;
  for (let guard = 0; guard < 100_000; guard++) {
    const page = await handle.list({ after, limit, signal });
    pages.push(page.records);
    if (page.records.length) after = page.records[page.records.length - 1].cursor;
    const more = page.more ?? page.records.length >= limit;
    if (!more || page.records.length === 0) break;
  }
  return pages;
}

export async function checkProvider(provider: LogProvider, opts: ConformanceOptions): Promise<ConformanceReport> {
  const results: ConformanceResult[] = [];
  const timeoutMs = opts.timeoutMs ?? 3000;
  const ac = new AbortController();
  const check = async (name: string, fn: () => Promise<string | void> | string | void) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail || undefined });
    } catch (err) {
      results.push({ name, ok: false, detail: (err as Error)?.message ?? String(err) });
    }
  };
  const fail = (msg: string): never => {
    throw new Error(msg);
  };

  await check('declares apiVersion 1 and a valid id', () => {
    if (provider.apiVersion !== PROVIDER_API_VERSION) fail(`apiVersion is ${String(provider.apiVersion)}`);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(provider.id)) fail(`id ${JSON.stringify(provider.id)} must match [A-Za-z0-9._-]{1,64}`);
  });

  await check('listLogs includes the log with a name', async () => {
    const logs = await provider.listLogs(ac.signal);
    if (!Array.isArray(logs)) fail('listLogs must return an array');
    const log = logs.find((l) => l.id === opts.logId);
    if (!log) fail(`log ${opts.logId} not in listLogs`);
    if (typeof log!.name !== 'string' || !log!.name) fail('log descriptor needs a name');
  });

  let handle: LogHandle | null = null;
  await check('open returns a handle with list()', async () => {
    handle = await provider.open(opts.logId, { signal: ac.signal });
    if (!handle || typeof handle.list !== 'function') fail('handle.list is missing');
  });
  if (!handle) {
    ac.abort();
    return finish(results);
  }
  const h = handle as LogHandle;

  let all: LogRecord[] = [];
  await check('list pages are in order, strictly after the cursor, within limit, without duplicates', async () => {
    const pages = await listAll(h, 3, ac.signal);
    const seen = new Set<string>();
    for (const page of pages) {
      if (page.length > 3) fail(`page of ${page.length} records exceeds limit 3`);
      for (const r of page) {
        if (typeof r.cursor !== 'string' || !r.cursor) fail('every record needs a non-empty string cursor');
        if (typeof r.message !== 'string') fail('every record needs a string message');
        if (seen.has(r.cursor)) fail(`duplicate cursor ${r.cursor} across pages`);
        seen.add(r.cursor);
      }
    }
    all = pages.flat();
    if (all.length < 2) fail('the log needs at least 2 records for these checks');
    // The same records, fetched with one big page, in the same order.
    const big = await h.list({ after: null, limit: 100_000, signal: ac.signal });
    const a = big.records.map((r) => r.cursor).join(',');
    const b = all.map((r) => r.cursor).join(',');
    if (a !== b) fail('paging with limit 3 returns different records or order than one large page');
    return `${all.length} records`;
  });

  await check('list after the last cursor returns nothing new', async () => {
    if (!all.length) fail('no records');
    const page = await h.list({ after: all[all.length - 1].cursor, limit: 10, signal: ac.signal });
    if (page.records.length) fail(`got ${page.records.length} records after the last cursor`);
  });

  await check('list after a middle cursor returns exactly the later records', async () => {
    const mid = Math.floor(all.length / 2);
    const page = await h.list({ after: all[mid].cursor, limit: 100_000, signal: ac.signal });
    const expected = all.slice(mid + 1).map((r) => r.cursor).join(',');
    if (page.records.map((r) => r.cursor).join(',') !== expected) fail('records after a middle cursor do not match');
  });

  if (h.tail) {
    await check('tail returns the newest records in ascending order', async () => {
      const n = Math.min(2, all.length);
      const page = await h.tail!({ limit: n, signal: ac.signal });
      const expected = all.slice(all.length - n).map((r) => r.cursor).join(',');
      if (page.records.map((r) => r.cursor).join(',') !== expected) {
        fail(`tail(${n}) returned ${page.records.map((r) => r.cursor).join(',')}, expected ${expected}`);
      }
    });
  }

  if (opts.insert) {
    await check('records inserted later are listed after the previous last cursor', async () => {
      const last = all[all.length - 1].cursor;
      await opts.insert!(2);
      const page = await h.list({ after: last, limit: 100, signal: ac.signal });
      if (page.records.length < 2) fail(`expected >= 2 new records, got ${page.records.length}`);
      all = all.concat(page.records);
    });

    if (h.watch) {
      await check('watch delivers new records and stops on abort', async () => {
        const wac = new AbortController();
        const it = h.watch!({ after: all[all.length - 1].cursor, signal: wac.signal })[Symbol.asyncIterator]();
        const timeout = (what: string) =>
          new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`timed out: ${what}`)), timeoutMs).unref());
        const got = (async () => {
          for (;;) {
            const r = await it.next();
            if (r.done) fail('watch ended before delivering records');
            if (r.value.type === 'records' && r.value.records.length) return r.value.records;
          }
        })();
        await new Promise((r) => setTimeout(r, 50));
        await opts.insert!(1);
        const records = await Promise.race([got, timeout('watch did not deliver the inserted record')]);
        if (!records.length) fail('empty records event');
        wac.abort();
        const end = (async () => {
          for (;;) {
            const r = await it.next();
            if (r.done) return;
          }
        })();
        await Promise.race([end, timeout('watch did not end after abort')]);
      });
    }
  }

  ac.abort();
  await (h.close?.() ?? Promise.resolve()).catch(() => {});
  return finish(results);
}

function finish(results: ConformanceResult[]): ConformanceReport {
  const failures = results.filter((r) => !r.ok).map((r) => `${r.name}: ${r.detail}`);
  return { ok: failures.length === 0, results, failures };
}
