import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fieldsCriteria, fieldsMatcher, MAX_FIELD_VALUE_LENGTH, MAX_FIELDS_PER_ENTRY, normalizeFields } from '../src/fields';
import { JSON_FORMAT } from '../src/parser';
import { FileLogSource, MergedSource, StreamSource } from '../src/sources';
import { Store } from '../src/store';
import { StreamSpooler } from '../src/spool';
import { MemoryProvider } from '../src/provider/memory';
import { ProviderSource } from '../src/provider/source';
import { createLogViewer } from '../src/viewer';

const quiet = { log() {}, warn() {}, error() {} };

async function until(pred: () => boolean, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > deadline) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

test('normalizeFields stringifies values and applies caps', () => {
  assert.deepEqual(normalizeFields({ a: 1, b: true, c: null, d: 'x', e: { nested: 1 }, f: undefined }), {
    a: '1',
    b: 'true',
    c: 'null',
    d: 'x',
    e: '{"nested":1}',
  });
  assert.equal(normalizeFields({}), undefined);
  assert.equal(normalizeFields(['a']), undefined);
  const many = Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`k${k}`, k]));
  assert.equal(Object.keys(normalizeFields(many)!).length, MAX_FIELDS_PER_ENTRY);
  assert.equal(normalizeFields({ long: 'x'.repeat(1000) })!.long.length, MAX_FIELD_VALUE_LENGTH);
  assert.deepEqual(normalizeFields({ a: 1, b: 2 }, new Set(['a'])), { b: '2' });
});

test('fieldsMatcher: values of a key are OR, keys are AND', () => {
  const m = fieldsMatcher({ status: ['500', '503'], tenant: ['acme'] })!;
  assert.equal(m({ status: '503', tenant: 'acme' }), true);
  assert.equal(m({ status: '200', tenant: 'acme' }), false);
  assert.equal(m({ status: '500' }), false);
  assert.equal(m(undefined), false);
  assert.equal(fieldsMatcher(undefined), null);
  assert.deepEqual(fieldsCriteria({ status: 500, tenant: ['acme', 'globex'], empty: [] }), {
    status: ['500'],
    tenant: ['acme', 'globex'],
  });
  assert.equal(fieldsCriteria('nope'), undefined);
});

test('JSON lines: unmapped keys become fields', () => {
  const p = JSON_FORMAT.parse('{"time":"2026-07-13T10:00:00Z","level":"warn","msg":"slow","status":503,"tenant":"acme","durationMs":1200}');
  assert.equal(p.message, 'slow');
  assert.equal(p.level, 'warn');
  assert.deepEqual(p.fields, { status: '503', tenant: 'acme', durationMs: '1200' });
  assert.equal(JSON_FORMAT.parse('{"message":"plain"}').fields, undefined);
});

test('streams keep fields from structured entries and JSON lines, and filter on them', async () => {
  const store = new Store();
  const src = new StreamSource('s:t', 't');
  store.addSource(src);
  src.appendEntries([
    { level: 'INFO', message: 'a', fields: { tenant: 'acme' }, status: 200 },
    { level: 'ERROR', message: 'b', fields: { tenant: 'acme' }, status: 500 },
    { level: 'ERROR', message: 'c', fields: { tenant: 'globex' }, status: 500 },
    { level: 'INFO', message: 'd' },
  ]);
  assert.deepEqual((await src.getEntries([1]))[0].fields, { status: '500', tenant: 'acme' });

  const f = await store.createFilter(src, { fields: { tenant: ['acme'], status: ['500'] } });
  assert.deepEqual(f.indices, [1]);
  const either = await store.createFilter(src, { fields: { tenant: ['acme', 'globex'] }, levels: [4] });
  assert.deepEqual(either.indices, [1, 2]);
  const excluded = await store.createFilter(src, { fields: { tenant: ['acme'] }, exclude: true });
  assert.deepEqual(excluded.indices, [2, 3]);

  // Live appends go through the in-memory matcher.
  src.appendEntries([{ message: 'e', fields: { tenant: 'acme', status: 500 } }]);
  await until(() => f.indices.length === 2);
  assert.deepEqual(f.indices, [1, 4]);

  const json = new StreamSource('s:j', 'j');
  store.addSource(json);
  json.appendLines(['{"level":"info","message":"x","region":"eu"}', '{"level":"info","message":"y","region":"us"}']);
  assert.deepEqual((await store.createFilter(json, { fields: { region: ['us'] } })).indices, [1]);
});

test('file sources: fields on read and field filters via the fallback path', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-fields-'));
  const file = path.join(dir, 'app.jsonl');
  const lines = Array.from({ length: 2500 }, (_, k) =>
    JSON.stringify({ time: Date.UTC(2026, 6, 13, 10, 0, k % 60), level: k % 10 ? 'info' : 'error', msg: `req ${k}`, status: k % 10 ? 200 : 500, shard: `s${k % 3}` })
  );
  fs.writeFileSync(file, lines.join('\n') + '\n');
  const src = await FileLogSource.open('f1', file);
  const store = new Store();
  store.addSource(src);
  try {
    assert.equal(src.fieldsAt, undefined, 'file sources read fields from disk');
    assert.deepEqual((await src.getEntries([10]))[0].fields, { status: '500', shard: 's1' });
    const f = await store.createFilter(src, { fields: { status: ['500'], shard: ['s0'] } });
    assert.deepEqual(f.indices, Array.from({ length: 2500 }, (_, k) => k).filter((k) => k % 10 === 0 && k % 3 === 0));
    const ranged = await src.evalCriteria({ fields: { status: ['500'] } }, 1000, 1100);
    assert.deepEqual(ranged, Array.from({ length: 10 }, (_, k) => 1000 + k * 10));

    // Merged with an in-memory stream: the merged view falls back to entries.
    const stream = new StreamSource('s:m', 'm');
    stream.appendEntries([{ message: 'from stream', fields: { status: 500, shard: 's0' } }]);
    const merged = new MergedSource('m1', 'merged', [src, stream]);
    assert.equal(merged.fieldsAt, undefined);
    assert.equal((await merged.evalCriteria({ fields: { status: ['500'], shard: ['s0'] } })).length, f.indices.length + 1);
  } finally {
    await src.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('merged views of in-memory sources filter fields directly', async () => {
  const a = new StreamSource('s:a', 'a');
  const b = new StreamSource('s:b', 'b');
  a.appendEntries([{ time: 1000, message: 'a1', fields: { k: '1' } }]);
  b.appendEntries([{ time: 2000, message: 'b1', fields: { k: '2' } }]);
  const merged = new MergedSource('m', 'm', [a, b]);
  assert.ok(merged.fieldsAt);
  assert.deepEqual(await merged.evalCriteria({ fields: { k: ['2'] } }), [1]);
});

test('provider record fields are kept and filterable', async () => {
  const mem = new MemoryProvider('mem');
  mem.addLog({ id: 'app', name: 'App' });
  mem.push('app', [
    { message: 'ok', fields: { status: 200, pod: 'web-1' } },
    { message: 'boom', fields: { status: 500, pod: 'web-2' } },
  ]);
  const src = await ProviderSource.open(mem, { id: 'app', name: 'App' }, { logger: quiet });
  const store = new Store();
  store.addSource(src);
  try {
    assert.deepEqual((await store.createFilter(src, { fields: { pod: ['web-2'] } })).indices, [1]);
  } finally {
    await store.removeSource(src.id);
  }
});

test('spool keeps fields across restore', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-spoolf-'));
  try {
    const spooler = new StreamSpooler(dir);
    const src = new StreamSource('s:sp', 'sp');
    spooler.attach(src);
    src.appendEntries([{ message: 'kept', fields: { tenant: 'acme' } }]);
    await spooler.flush();
    const [rec] = await new StreamSpooler(dir).recover();
    const restored = new StreamSource('s:sp', 'sp');
    restored.restore(rec.entries);
    assert.deepEqual((await restored.getEntries([0]))[0].fields, { tenant: 'acme' });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('API: field keys and values, field filters, entries with fields', async () => {
  const viewer = createLogViewer({ logger: quiet, ui: false });
  const { url } = await viewer.listen(0, '127.0.0.1');
  try {
    await fetch(url + '/api/v1/streams/api', { method: 'PUT' });
    const post = (body: unknown) =>
      fetch(url + '/api/v1/streams/api/entries', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await post({ entries: [{ message: 'a', status: 200, tenant: 'acme' }, { message: 'b', status: 500, tenant: 'acme' }, { message: 'c', status: 500, tenant: 'globex' }] });
    const keys = await (await fetch(url + '/api/logs/s:api/fields')).json();
    assert.deepEqual(keys, { keys: [{ key: 'status', count: 3 }, { key: 'tenant', count: 3 }], sampled: false });
    const values = await (await fetch(url + '/api/logs/s:api/values?key=status')).json();
    assert.deepEqual(values, { values: [{ value: '500', count: 2 }, { value: '200', count: 1 }], sampled: false });
    const narrowed = await (await fetch(url + '/api/logs/s:api/values?key=tenant&q=GLO')).json();
    assert.deepEqual(narrowed.values, [{ value: 'globex', count: 1 }]);
    const loggers = await (await fetch(url + '/api/logs/s:api/values?field=logger')).json();
    assert.deepEqual(loggers.values, [{ value: '', count: 3 }]);
    assert.equal((await fetch(url + '/api/logs/s:api/values')).status, 400);
    const f = await (
      await fetch(url + '/api/logs/s:api/filters', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ criteria: { fields: { status: '500', tenant: ['acme'] } } }),
      })
    ).json();
    assert.equal(f.count, 1);
    const page = await (await fetch(url + `/api/logs/s:api/entries?start=0&count=10&filter=${f.filterId}`)).json();
    assert.deepEqual(page.entries.map((e: { msg: string }) => e.msg), ['b']);
    assert.deepEqual(page.entries[0].fields, { status: '500', tenant: 'acme' });
    const rule = await fetch(url + '/api/logs/s:api/rules', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ criteria: { fields: { tenant: 'globex' } }, actions: { bookmark: true } }),
    });
    assert.equal((await rule.json()).matchCount, 1);
  } finally {
    await viewer.close();
  }
});
