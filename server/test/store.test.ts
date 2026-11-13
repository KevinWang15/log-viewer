import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_RULES_PER_SOURCE, RuleLimitError, Store, StoreCapacityError } from '../src/store';
import { StreamRegistry } from '../src/streams';

test('store caps stream sources and expires idle channels', async () => {
  const store = new Store();
  const streams = new StreamRegistry(store, { maxSources: 1 });
  const source = streams.getOrCreate('first');
  assert.throws(() => streams.getOrCreate('second'), StoreCapacityError);

  source.touch(1_000);
  assert.equal(await streams.removeIdle(500, 1_499), 0);
  assert.equal(await streams.removeIdle(500, 1_500), 1);
  assert.equal(streams.count, 0);
  assert.equal(streams.get('first'), undefined);
});

test('rules scan on create, match appends incrementally, bookmark, webhook only post-creation', async () => {
  const store = new Store();
  const src = new StreamRegistry(store).getOrCreate('ch');
  src.appendEntries([
    { level: 'ERROR', message: 'pre boom' },
    { level: 'INFO', message: 'pre ok' },
  ]);
  const sent: Array<{ url: string; payload: Record<string, unknown> }> = [];
  store.webhookSender = async (url, payload) => {
    sent.push({ url, payload });
  };

  const rule = await store.createRule(
    src,
    { levels: [4] },
    { bookmark: true, webhook: 'http://127.0.0.1/hook' },
    'errors'
  );
  assert.equal(rule.matchCount, 1, 'creation scans existing entries like a filter');
  assert.equal(sent.length, 0, 'no retroactive webhook on create');
  assert.deepEqual([...store.bookmarksFor(src.id)], [0], 'creation-time bookmark applied');

  src.appendEntries([
    { level: 'ERROR', message: 'post boom 1' },
    { level: 'INFO', message: 'post ok' },
    { level: 'ERROR', message: 'post boom 2' },
  ]);
  assert.equal(rule.matchCount, 3);
  assert.deepEqual([...store.bookmarksFor(src.id)].sort((a, b) => a - b), [0, 2, 4]);
  assert.equal(sent.length, 1, 'one webhook per append batch');
  assert.equal(sent[0].url, 'http://127.0.0.1/hook');
  const payload = sent[0].payload as {
    ruleId: string;
    ruleName: string;
    source: string;
    sourceName: string;
    matched: number;
    sample: Array<{ i: number; lv: number; msg: string }>;
  };
  assert.equal(payload.ruleId, rule.id);
  assert.equal(payload.ruleName, 'errors');
  assert.equal(payload.source, 's:ch');
  assert.equal(payload.sourceName, 'ch');
  assert.equal(payload.matched, 2);
  assert.deepEqual(
    payload.sample.map((e) => [e.i, e.lv, e.msg]),
    [
      [2, 4, 'post boom 1'],
      [4, 4, 'post boom 2'],
    ]
  );

  store.removeRule(rule.id);
  src.appendEntries([{ level: 'ERROR', message: 'after delete' }]);
  assert.equal(sent.length, 1, 'no webhook after the rule is deleted');
  assert.equal(rule.matchCount, 3, 'deleted rule no longer counts');
  assert.deepEqual(
    [...store.bookmarksFor(src.id)].sort((a, b) => a - b),
    [0, 2, 4],
    'bookmarks created by the rule are kept'
  );
});

test('webhook delivery errors are swallowed and counted on the rule', async () => {
  const store = new Store();
  const src = new StreamRegistry(store).getOrCreate('err');
  store.webhookSender = async () => {
    throw new Error('connection refused');
  };
  const rule = await store.createRule(src, { text: 'boom' }, { webhook: 'http://127.0.0.1/hook' });
  src.appendEntries([{ message: 'boom happened' }]);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rule.matchCount, 1);
  assert.equal(rule.webhookErrors, 1);
  assert.equal(src.count, 1, 'a failing webhook never affects the append path');
});

test('rules are capped per source', async () => {
  const store = new Store();
  const src = new StreamRegistry(store).getOrCreate('capped');
  for (let k = 0; k < MAX_RULES_PER_SOURCE; k++) await store.createRule(src, {}, {});
  await assert.rejects(() => store.createRule(src, {}, {}), RuleLimitError);
  // The cap is per source, not global.
  const other = new StreamRegistry(store).getOrCreate('other');
  await store.createRule(other, {}, {});
  assert.equal(store.rulesFor('s:capped').length, MAX_RULES_PER_SOURCE);
  assert.equal(store.rulesFor('s:other').length, 1);
});

test('locate maps an entry to the same or nearest-in-time row of a filtered view', async () => {
  const store = new Store();
  const src = new StreamRegistry(store).getOrCreate('loc');
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  // Entry index: 0 INFO@0s, 1 ERROR@1s, 2 INFO@2s, 3 INFO@9s, 4 ERROR@10s
  src.appendEntries([
    { time: t0, level: 'INFO', message: 'a' },
    { time: t0 + 1000, level: 'ERROR', message: 'b' },
    { time: t0 + 2000, level: 'INFO', message: 'c' },
    { time: t0 + 9000, level: 'INFO', message: 'd' },
    { time: t0 + 10000, level: 'ERROR', message: 'e' },
  ]);
  const errors = await store.createFilter(src, { levels: [4] });
  assert.deepEqual(errors.indices, [1, 4]);

  assert.deepEqual(store.locate(src, errors, 4), { vi: 1, exact: true }, 'kept entry maps exactly');
  assert.deepEqual(store.locate(src, errors, 2), { vi: 0, exact: false }, '2s is closer to 1s than to 10s');
  assert.deepEqual(store.locate(src, errors, 3), { vi: 1, exact: false }, '9s is closer to 10s than to 1s');
  assert.deepEqual(store.locate(src, errors, 0), { vi: 0, exact: false }, 'before the first kept entry');
  assert.deepEqual(store.locate(src, null, 3), { vi: 3, exact: true }, 'unfiltered view is the identity');

  const none = await store.createFilter(src, { levels: [5] });
  assert.equal(store.locate(src, none, 2), null, 'empty view has no position');
});
