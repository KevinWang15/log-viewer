import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryProvider } from '../src/provider/memory';
import { ProviderSource, recordToEntry } from '../src/provider/source';
import { CursorExpiredError, defineProvider, LogProvider, ProviderError, WatchEvent } from '../src/provider/spi';
import { checkProvider } from '../src/provider/conformance';
import { Store } from '../src/store';
import type { AppendEvent } from '../src/source-api';
import { createLogViewer } from '../src/viewer';

const quiet = { log() {}, warn() {}, error() {} };
const fast = { pollIntervalMs: 20, batchMs: 5, backoffMinMs: 10, backoffMaxMs: 40, logger: quiet };
const T0 = Date.parse('2026-07-13T10:00:00Z');

function rec(k: number, level = 'INFO') {
  return { time: T0 + k * 1000, level, thread: 'main', logger: 'app', message: `record ${k}` };
}

async function until(pred: () => boolean, ms = 3000, what = 'condition') {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out waiting for ' + what);
    await new Promise((r) => setTimeout(r, 5));
  }
}

function events(src: ProviderSource) {
  const log: Array<{ type: 'append'; ev: AppendEvent } | { type: 'reset' }> = [];
  src.on('append', (ev: AppendEvent) => log.push({ type: 'append', ev }));
  src.on('reset', () => log.push({ type: 'reset' }));
  return log;
}

function memory(opts: ConstructorParameters<typeof MemoryProvider>[1] = {}, n = 5) {
  const mem = new MemoryProvider('mem', opts);
  mem.addLog({ id: 'app', name: 'App', labels: { env: 'test' } });
  mem.push('app', Array.from({ length: n }, (_, k) => rec(k)));
  return mem;
}

const desc = { id: 'app', name: 'App' };

test('initial load uses tail() and caps to maxEntries', async () => {
  const mem = memory({}, 50);
  const src = await ProviderSource.open(mem, desc, { ...fast, maxEntries: 10 });
  try {
    assert.equal(src.count, 10);
    assert.equal((await src.getEntries([0]))[0].msg, 'record 40');
    assert.equal(mem.calls.tail, 1);
    assert.equal(src.describe().provider.id, 'mem');
  } finally {
    await src.close();
  }
});

test('initial load pages list() when tail() is missing, keeping the newest', async () => {
  const mem = memory({ tail: false }, 25);
  const src = await ProviderSource.open(mem, desc, { ...fast, maxEntries: 7, pageLimit: 4 });
  try {
    assert.equal(src.count, 7);
    assert.equal((await src.getEntries([0]))[0].msg, 'record 18');
    assert.ok(mem.calls.list >= 7, 'paged through the log');
  } finally {
    await src.close();
  }
});

test('watch batches become one append with the right startIdx', async () => {
  const mem = memory();
  const src = await ProviderSource.open(mem, desc, fast);
  const log = events(src);
  try {
    await until(() => src.state === 'live', 3000, 'live');
    mem.push('app', [rec(5), rec(6), rec(7)]);
    await until(() => src.count === 8, 3000, 'appended');
    const appends = log.filter((e) => e.type === 'append');
    assert.equal(appends.length, 1, 'coalesced into one batch');
    const ev = (appends[0] as { ev: AppendEvent }).ev;
    assert.equal(ev.startIdx, 5);
    assert.equal(ev.added, 3);
    assert.deepEqual(ev.entries!.map((e) => e.i), [5, 6, 7]);
  } finally {
    await src.close();
  }
});

test('polling follows new records when watch() is missing, re-polling while more', async () => {
  const mem = memory({ watch: false });
  const src = await ProviderSource.open(mem, desc, { ...fast, pageLimit: 2 });
  try {
    await until(() => src.state === 'polling', 3000, 'polling');
    mem.push('app', [rec(5), rec(6), rec(7), rec(8), rec(9)]);
    await until(() => src.count === 10, 3000, 'polled');
    assert.equal((await src.getEntries([9]))[0].msg, 'record 9');
  } finally {
    await src.close();
  }
});

test('provider reset event reloads the mirror and emits reset', async () => {
  const mem = memory();
  const src = await ProviderSource.open(mem, desc, fast);
  const log = events(src);
  try {
    await until(() => src.state === 'live');
    mem.truncate('app', 2);
    mem.emitReset('app');
    await until(() => log.some((e) => e.type === 'reset'), 3000, 'reset');
    await until(() => src.count === 2, 3000, 'reloaded');
  } finally {
    await src.close();
  }
});

test('expired cursor during polling triggers a reload', async () => {
  const mem = memory({ watch: false });
  const src = await ProviderSource.open(mem, desc, fast);
  const log = events(src);
  try {
    await until(() => src.state === 'polling');
    mem.push('app', [rec(5), rec(6), rec(7)]);
    mem.truncate('app', 1); // the source's cursor (5) is now before retention
    await until(() => log.some((e) => e.type === 'reset'), 3000, 'reset');
    assert.equal(src.count, 1);
    assert.equal((await src.getEntries([0]))[0].msg, 'record 7');
  } finally {
    await src.close();
  }
});

test('retention eviction emits reset and keeps exactly the newest entries', async () => {
  const mem = memory();
  const src = await ProviderSource.open(mem, desc, { ...fast, maxEntries: 5 });
  const log = events(src);
  try {
    await until(() => src.state === 'live');
    mem.push('app', [rec(5), rec(6)]);
    await until(() => log.some((e) => e.type === 'reset'), 3000, 'reset');
    assert.equal(src.count, 5);
    assert.equal((await src.getEntries([0]))[0].msg, 'record 2');
  } finally {
    await src.close();
  }
});

test('transient errors back off and recover; data stays readable', async () => {
  const mem = memory({ watch: false });
  const src = await ProviderSource.open(mem, desc, fast);
  try {
    await until(() => src.state === 'polling');
    mem.failNext(2);
    await until(() => src.state === 'reconnecting', 3000, 'reconnecting');
    assert.equal(src.count, 5, 'mirror still readable');
    assert.match(src.lastError ?? '', /injected failure/);
    mem.push('app', [rec(5)]);
    await until(() => src.count === 6 && src.state === 'polling', 3000, 'recovered');
    assert.equal(src.lastError, undefined);
  } finally {
    await src.close();
  }
});

test('non-retryable errors mark the source failed', async () => {
  const mem = memory({ watch: false });
  const src = await ProviderSource.open(mem, desc, fast);
  try {
    await until(() => src.state === 'polling');
    mem.failNext(1, false);
    await until(() => src.state === 'failed', 3000, 'failed');
    assert.equal(src.describe().connected, false);
  } finally {
    await src.close();
  }
});

test('a watch that ends is resumed after catching up with list()', async () => {
  let watches = 0;
  const records = Array.from({ length: 3 }, (_, k) => ({ ...rec(k), cursor: String(k + 1) }));
  const provider = defineProvider({
    id: 'ending',
    logs: async () => [desc],
    list: async (_id, req) => {
      const from = req.after === null ? 0 : Number(req.after);
      return { records: records.slice(from, from + req.limit) };
    },
    watch: async function* (): AsyncIterable<WatchEvent> {
      watches++;
      yield { type: 'heartbeat' };
    },
  });
  const src = await ProviderSource.open(provider, desc, fast);
  try {
    await until(() => watches >= 2, 3000, 'second watch');
    records.push({ ...rec(3), cursor: '4' });
    await until(() => src.count === 4, 3000, 'caught up');
  } finally {
    await src.close();
  }
});

test('close() aborts a watch that never yields and leaves no timers', async () => {
  let aborted = false;
  const provider = defineProvider({
    id: 'stuck',
    logs: async () => [desc],
    list: async () => ({ records: [] }),
    watch: async function* (_id, req): AsyncIterable<WatchEvent> {
      await new Promise<void>((resolve) =>
        req.signal.addEventListener('abort', () => {
          aborted = true;
          resolve();
        })
      );
    },
  });
  const src = await ProviderSource.open(provider, desc, fast);
  await until(() => src.state === 'live');
  const t0 = Date.now();
  await src.close();
  assert.ok(aborted, 'watch saw the abort');
  assert.ok(Date.now() - t0 < 500, 'close was prompt');
  assert.equal(src.state, 'closed');
});

test('records are normalized; records without cursor or message are dropped', async () => {
  assert.equal(recordToEntry({ cursor: '1', message: 'x', time: '2026-07-13T10:00:00Z' })!.t, T0);
  assert.equal(recordToEntry({ cursor: '1', message: 'x', time: new Date(T0) })!.t, T0);
  assert.equal(recordToEntry({ cursor: '1', message: 'x', level: 'warning' })!.lv, 3);
  assert.equal(recordToEntry({ cursor: '1', message: 'x', level: 9 })!.lv, 5);
  assert.equal(recordToEntry({ cursor: '1', message: 'line 1\nline 2' })!.msg, 'line 1');
  assert.equal(recordToEntry({ cursor: '', message: 'x' }), null);
  assert.equal(recordToEntry({ message: 'x' } as never), null);
  const provider = defineProvider({
    id: 'mixed',
    logs: async () => [desc],
    list: async (_id, req) => ({ records: req.after === null ? [{ cursor: '1', message: 'ok' }, { message: 'no cursor' } as never] : [] }),
  });
  const src = await ProviderSource.open(provider, desc, fast);
  try {
    assert.equal(src.count, 1);
    assert.equal(src.dropped, 1);
  } finally {
    await src.close();
  }
});

test('unknown apiVersion is rejected', async () => {
  const bad = { ...memory(), apiVersion: 2 } as unknown as LogProvider;
  await assert.rejects(ProviderSource.open(bad, desc, fast), /API version 2/);
});

test('filters, rules and bookmarks work on provider sources', async () => {
  const mem = memory();
  const store = new Store();
  const src = await ProviderSource.open(mem, desc, fast);
  store.addSource(src);
  try {
    await until(() => src.state === 'live');
    const errors = await store.createFilter(src, { levels: [4] });
    assert.equal(errors.indices.length, 0);
    const rule = await store.createRule(src, { text: 'boom' }, { bookmark: true });
    mem.push('app', [{ ...rec(5, 'ERROR'), message: 'boom' }]);
    await until(() => errors.indices.length === 1, 3000, 'filter updated');
    assert.deepEqual(errors.indices, [5]);
    await until(() => rule.matchCount === 1, 3000, 'rule matched');
    assert.ok(store.bookmarksFor(src.id).has(5));
    assert.deepEqual(store.locate(src, errors, 4), { vi: 0, exact: false });
  } finally {
    await store.removeSource(src.id);
  }
});

test('conformance: MemoryProvider passes with and without watch', async () => {
  for (const opts of [{}, { watch: false }, { tail: false }]) {
    const mem = memory(opts);
    let k = 100;
    const report = await checkProvider(mem, {
      logId: 'app',
      insert: async (n) => void mem.push('app', Array.from({ length: n }, () => rec(k++))),
    });
    assert.ok(report.ok, JSON.stringify(opts) + ': ' + report.failures.join('; '));
  }
});

test('conformance: broken providers fail specific checks', async () => {
  const base = Array.from({ length: 6 }, (_, k) => ({ ...rec(k), cursor: String(k + 1) }));
  const make = (list: (after: string | null, limit: number) => typeof base) =>
    defineProvider({ id: 'broken', logs: async () => [desc], list: async (_id, req) => ({ records: list(req.after, req.limit) }) });
  // Includes the `after` record itself (not strictly after).
  const inclusive = make((after, limit) => {
    const from = after === null ? 0 : Number(after) - 1;
    return base.slice(from, from + limit);
  });
  let report = await checkProvider(inclusive, { logId: 'app' });
  assert.ok(!report.ok);
  assert.ok(report.failures.some((f) => /duplicate cursor|different records/.test(f)), report.failures.join('; '));
  // Ignores the limit.
  const unlimited = make((after) => base.slice(after === null ? 0 : Number(after)));
  report = await checkProvider(unlimited, { logId: 'app' });
  assert.ok(report.failures.some((f) => /exceeds limit/.test(f)), report.failures.join('; '));
});

test('viewer: provider catalog, open, entries, live append over the API', async () => {
  const mem = memory();
  const viewer = createLogViewer({ providers: [mem], providerOptions: fast, logger: quiet, ui: false });
  const { url } = await viewer.listen(0, '127.0.0.1');
  try {
    const caps = await (await fetch(url + '/api/v1/capabilities')).json();
    assert.equal(caps.modules.providers.providers[0].id, 'mem');
    const cat = await (await fetch(url + '/api/v1/providers/mem/logs')).json();
    assert.deepEqual(cat.logs.map((l: { id: string }) => l.id), ['app']);
    const missing = await fetch(url + '/api/v1/providers/mem/logs/nope/open', { method: 'POST' });
    assert.equal(missing.status, 404);
    const info = await (await fetch(url + '/api/v1/providers/mem/logs/app/open', { method: 'POST' })).json();
    assert.equal(info.id, 'p:mem:app');
    assert.equal(info.kind, 'provider');
    assert.equal(info.count, 5);
    assert.deepEqual(info.labels, { env: 'test' });
    const again = await (await fetch(url + '/api/v1/providers/mem/logs/app/open', { method: 'POST' })).json();
    assert.equal(again.id, info.id, 'open is idempotent');
    mem.push('app', [rec(5, 'ERROR')]);
    await until(() => viewer.store.sources.get('p:mem:app')!.count === 6, 3000, 'live append');
    const page = await (await fetch(url + `/api/logs/${encodeURIComponent(info.id)}/entries?start=5&count=5`)).json();
    assert.equal(page.entries[0].lv, 4);
    const listed = await (await fetch(url + '/api/v1/providers/mem/logs')).json();
    assert.equal(listed.logs[0].open, true);
  } finally {
    await viewer.close();
  }
});

test('ProviderError status is used when opening fails', async () => {
  const provider = defineProvider({
    id: 'deny',
    logs: async () => [desc],
    list: async () => {
      throw new ProviderError('no access', { status: 403, retryable: false });
    },
  });
  const viewer = createLogViewer({ providers: [provider], logger: quiet, ui: false });
  const { url } = await viewer.listen(0, '127.0.0.1');
  try {
    const res = await fetch(url + '/api/v1/providers/deny/logs/app/open', { method: 'POST' });
    assert.equal(res.status, 403);
    assert.match((await res.json()).error, /no access/);
  } finally {
    await viewer.close();
  }
});

test('CursorExpiredError is exported for providers', () => {
  assert.ok(new CursorExpiredError() instanceof ProviderError);
});
