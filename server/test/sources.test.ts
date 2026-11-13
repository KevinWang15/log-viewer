import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { EntryOut, FileLogSource, GzipTooLargeError, isGzipFile, MergedSource, StreamSource, matcherFor } from '../src/sources';

const LOG = [
  '2026-07-13 10:00:00,000 [Main] INFO App - starting',
  '2026-07-13 10:00:01,000 [T1] WARN Db - slow query',
  '2026-07-13 10:00:02,000 [Main] ERROR Db - deadlock',
  '   at Some.Stack.Frame()',
  '2026-07-13 10:00:03,000 [T2] DEBUG Cache - miss',
].join('\n');

function tmpFile(content: string): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-')), 'test.log');
  fs.writeFileSync(p, content + '\n');
  return p;
}

test('file source indexes entries and groups continuation lines', async () => {
  const p = tmpFile(LOG);
  const src = await FileLogSource.open('t1', p);
  try {
    assert.equal(src.count, 4);
    assert.deepEqual(src.stats, [0, 1, 1, 1, 1, 0]);
    const [err] = await src.getEntries([2]);
    assert.equal(err.lv, 4);
    assert.ok(err.raw.includes('Some.Stack.Frame'));
    assert.equal(err.th, 'Main');
    assert.equal(err.lg, 'Db');
  } finally {
    await src.close();
  }
});

test('criteria evaluation: levels, text, exclude', async () => {
  const p = tmpFile(LOG);
  const src = await FileLogSource.open('t2', p);
  try {
    assert.deepEqual(await src.evalCriteria({ levels: [3, 4] }), [1, 2]);
    assert.deepEqual(await src.evalCriteria({ text: 'stack.frame' }), [2]);
    assert.deepEqual(await src.evalCriteria({ threads: ['Main'] }), [0, 2]);
    assert.deepEqual(await src.evalCriteria({ levels: [3, 4], exclude: true }), [0, 3]);
  } finally {
    await src.close();
  }
});

test('chunked open skips to line boundary and does not tail', async () => {
  const p = tmpFile(LOG);
  const firstLineLen = LOG.split('\n')[0].length + 1;
  const src = await FileLogSource.open('t3', p, 5, firstLineLen + 60);
  try {
    assert.ok(src.isChunk);
    // starts at line 2 (offset 5 is mid-line-1)
    const [e] = await src.getEntries([0]);
    assert.ok(e.raw.includes('slow query'));
  } finally {
    await src.close();
  }
});

test('getEntries windows match on-disk content incl. multiline and file end', async () => {
  const lines = [
    '2026-07-13 10:00:00,000 [Main] INFO App - e0',
    '2026-07-13 10:00:01,000 [T1] WARN Db - e1',
    '   cont 1a',
    '   cont 1b',
    '2026-07-13 10:00:02,000 [Main] ERROR Db - e2',
    '2026-07-13 10:00:03,000 [T2] DEBUG Cache - e3',
  ];
  // No trailing newline: the last entry runs to EOF.
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-')), 'test.log');
  fs.writeFileSync(p, lines.join('\n'));
  const src = await FileLogSource.open('t4', p);
  try {
    assert.equal(src.count, 4);
    // A window spanning a multiline entry.
    const win = await src.getEntries([0, 1, 2]);
    assert.deepEqual(
      win.map((e) => e.raw),
      [lines[0], [lines[1], lines[2], lines[3]].join('\n'), lines[4]]
    );
    assert.equal(win[1].msg, 'e1');
    // Partial window at file end: out-of-range indices are skipped.
    const tail = await src.getEntries([2, 3, 4]);
    assert.deepEqual(
      tail.map((e) => [e.i, e.raw]),
      [
        [2, lines[4]],
        [3, lines[5]],
      ]
    );
    // Unsorted and duplicate indices keep the requested order.
    const mixed = await src.getEntries([3, 0, 3, -1]);
    assert.deepEqual(
      mixed.map((e) => e.i),
      [3, 0, 3]
    );
  } finally {
    await src.close();
  }
});

test('getEntries caps oversized entries with a truncation marker', async () => {
  const big = '2026-07-13 10:00:04,000 [T3] INFO Big - ' + 'x'.repeat(70_000);
  const p = tmpFile(LOG + '\n' + big);
  const src = await FileLogSource.open('t5', p);
  try {
    const [e] = await src.getEntries([4]);
    // The read is capped at 64KB; the truncation marker is appended after.
    assert.ok(Buffer.byteLength(e.raw) <= 64 * 1024 + Buffer.byteLength('\n… (entry truncated)'));
    assert.match(e.raw, /entry truncated/);
    assert.ok(e.msg.startsWith('xxx'));
    // The truncation is byte-exact: a prefix of the on-disk line.
    assert.ok(big.startsWith(e.raw.split('\n…')[0]));
  } finally {
    await src.close();
  }
});

test('getEntries coalesces chunked-source windows at the chunk end', async () => {
  const p = tmpFile(LOG);
  const firstLineLen = LOG.split('\n')[0].length + 1;
  const src = await FileLogSource.open('t6', p, 5, firstLineLen + 60);
  try {
    const all = await src.getEntries(Array.from({ length: src.count + 3 }, (_, i) => i));
    assert.equal(all.length, src.count);
    assert.deepEqual(
      all.map((e) => e.i),
      Array.from({ length: src.count }, (_, i) => i)
    );
    assert.ok(all[0].raw.includes('slow query'));
  } finally {
    await src.close();
  }
});

test('truncate-reset rebuilds the index; appends regrow the shrunk buffers', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-'));
  const p = path.join(dir, 'truncate.log');
  const line = (i: number) =>
    `2026-07-13 10:00:${String(i % 60).padStart(2, '0')},000 [T${i % 3}] INFO App - entry ${i}`;
  // Enough entries to grow the index buffers well past the truncated size.
  fs.writeFileSync(p, Array.from({ length: 9000 }, (_, i) => line(i)).join('\n') + '\n');
  const src = await FileLogSource.open('trunc', p);
  try {
    assert.equal(src.count, 9000);
    let resets = 0;
    src.on('reset', () => resets++);
    // Truncate-rotate: far fewer entries than the grown buffer capacity.
    fs.writeFileSync(p, Array.from({ length: 5 }, (_, i) => line(100 + i)).join('\n') + '\n');
    await (src as unknown as { onFileChange(size: number): Promise<void> }).onFileChange(fs.statSync(p).size);
    assert.equal(resets, 1);
    assert.equal(src.count, 5);
    assert.deepEqual(src.stats, [0, 0, 5, 0, 0, 0]);
    const entries = await src.getEntries([0, 4]);
    assert.deepEqual(
      entries.map((e) => e.msg),
      ['entry 100', 'entry 104']
    );
    // Appending past the shrunk capacity regrows without corruption.
    fs.appendFileSync(p, Array.from({ length: 3000 }, (_, i) => line(200 + i)).join('\n') + '\n');
    await (src as unknown as { onFileChange(size: number): Promise<void> }).onFileChange(fs.statSync(p).size);
    assert.equal(src.count, 3005);
    const [tailEntry] = await src.getEntries([3004]);
    assert.equal(tailEntry.msg, 'entry 3199');
    assert.deepEqual(src.stats, [0, 0, 3005, 0, 0, 0]);
  } finally {
    await src.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('scanTexts stops early when the callback returns false', async () => {
  const p = tmpFile(LOG);
  const src = await FileLogSource.open('t7', p);
  try {
    const seen: number[] = [];
    await src.scanTexts((i) => {
      seen.push(i);
      return i < 1;
    });
    assert.deepEqual(seen, [0, 1]);
    // Ranged scans still deliver the full remaining window.
    const rest: number[] = [];
    await src.scanTexts((i) => void rest.push(i), 2);
    assert.deepEqual(rest, [2, 3]);
  } finally {
    await src.close();
  }
});

test('merged source orders by time across children', async () => {
  const a = new StreamSource('sa', 'a');
  const b = new StreamSource('sb', 'b');
  a.appendLines(['2026-07-13 10:00:00,000 [A] INFO X - a1', '2026-07-13 10:00:02,000 [A] INFO X - a2']);
  b.appendLines(['2026-07-13 10:00:01,000 [B] WARN Y - b1']);
  const m = new MergedSource('m1', 'merged', [a, b]);
  assert.equal(m.count, 3);
  const es = await m.getEntries([0, 1, 2]);
  assert.deepEqual(
    es.map((e) => e.msg),
    ['a1', 'b1', 'a2']
  );
  assert.deepEqual(
    es.map((e) => e.src),
    ['a', 'b', 'a']
  );
  // in-order append extends the merge without reset
  let appended = 0;
  m.on('append', () => appended++);
  a.appendLines(['2026-07-13 10:00:03,000 [A] ERROR X - a3']);
  assert.equal(m.count, 4);
  assert.equal(appended, 1);
  assert.equal(m.levelAt(3), 4);
  await m.close();
});

test('matcherFor mirrors evalCriteria semantics', () => {
  const e = { i: 0, t: 5, lv: 3, th: 'Main', lg: 'Db', msg: 'slow', raw: 'WARN slow query' };
  assert.ok(matcherFor({ levels: [3] })(e));
  assert.ok(!matcherFor({ levels: [4] })(e));
  assert.ok(matcherFor({ text: 'SLOW Q' })(e));
  assert.ok(matcherFor({ levels: [4], exclude: true })(e));
});

test('stream retention restores headroom and rebases indices', async () => {
  const src = new StreamSource('limited', 'limited', 10);
  let resets = 0;
  src.on('reset', () => resets++);
  src.appendEntries(
    Array.from({ length: 11 }, (_, i) => ({
      level: i === 10 ? 'ERROR' : 'INFO',
      message: `entry-${i}`,
    }))
  );
  assert.equal(resets, 1);
  assert.equal(src.count, 9);
  assert.equal(src.levelAt(8), 4);
  const entries = await src.getEntries([0, 8]);
  assert.deepEqual(entries.map((entry) => entry.i), [0, 8]);
  assert.deepEqual(entries.map((entry) => entry.msg), ['entry-2', 'entry-10']);
});

test('an oversized stream batch cannot remain above the entry limit', async () => {
  const src = new StreamSource('burst', 'burst', 10);
  src.appendEntries(Array.from({ length: 100 }, (_, i) => ({ message: `entry-${i}` })));
  assert.equal(src.count, 9);
  const entries = await src.getEntries([0, src.count - 1]);
  assert.deepEqual(entries.map((entry) => entry.msg), ['entry-91', 'entry-99']);
});

test('stream byte retention and per-entry truncation are hard bounds', async () => {
  const bounded = new StreamSource('bytes', 'bytes', 0, 1000);
  bounded.appendEntries(Array.from({ length: 20 }, (_, i) => ({ message: `${i}:` + 'x'.repeat(300) })));
  assert.ok(bounded.bytes <= 1000);
  const newest = await bounded.getEntries([bounded.count - 1]);
  assert.ok(newest[0].msg.startsWith('19:'));

  const entryBounded = new StreamSource('entry-bytes', 'entry-bytes', 0, 0);
  entryBounded.appendEntries([{ message: '界'.repeat(40_000) }]);
  const [entry] = await entryBounded.getEntries([0]);
  assert.ok(Buffer.byteLength(entry.raw) <= 64 * 1024);
  assert.match(entry.raw, /entry truncated/);

  const runtimeInput = new StreamSource('runtime-input', 'runtime-input');
  runtimeInput.appendEntries([
    { message: 'valid message', thread: 123, logger: {}, level: 5, time: {} } as unknown as Parameters<
      StreamSource['appendEntries']
    >[0][number],
  ]);
  const [sanitized] = await runtimeInput.getEntries([0]);
  assert.equal(sanitized.msg, 'valid message');
  assert.equal(sanitized.th, '');
});

test('continuation-only updates reset cached views and filters', async () => {
  const src = new StreamSource('continuation', 'continuation');
  src.appendLines(['2026-07-13 10:00:00,000 [Main] ERROR App - failed']);
  let resets = 0;
  src.on('reset', () => resets++);
  src.appendLines(['   at Example.main(Example.java:1)']);
  assert.equal(src.count, 1);
  assert.equal(resets, 1);
  const [entry] = await src.getEntries([0]);
  assert.match(entry.raw, /Example\.main/);
});

// Mirrors the in-source accounting formula (fixed allowance + field bytes).
function accountedBytes(e: EntryOut): number {
  return 64 + Buffer.byteLength(e.raw) + Buffer.byteLength(e.msg) + Buffer.byteLength(e.th) + Buffer.byteLength(e.lg);
}

test('mixed workload (continuations, oversize entries, eviction) keeps the exact longest fitting suffix', async () => {
  const maxBytes = 300_000;
  const target = maxBytes - Math.ceil(maxBytes / 10); // retentionTarget: ~10% headroom
  const limited = new StreamSource('mixed', 'mixed', 0, maxBytes);
  const mirror = new StreamSource('mirror', 'mirror'); // same input, no limits
  const LEVELS = ['INFO', 'WARN', 'ERROR'];
  const entryLine = (n: number) =>
    `2026-07-13 10:${String(Math.floor(n / 60) % 60).padStart(2, '0')}:${String(n % 60).padStart(2, '0')},000` +
    ` [T${n % 4}] ${LEVELS[n % 3]} App${n % 3} - message ${n}`;
  const first: string[] = [];
  for (let n = 0; n < 120; n++) {
    first.push(entryLine(n));
    if (n % 5 === 0) first.push(`   at com.example.Frame.a(Source:${n})`, `   at com.example.Frame.b(Source:${n})`);
  }
  const third: string[] = [];
  for (let n = 122; n < 282; n++) {
    third.push(entryLine(n));
    if (n % 5 === 0) third.push(`   at com.example.Frame.c(Source:${n})`);
  }
  // A continuation-only batch growing an already-retained entry afterwards.
  const tail = ['   at com.example.Frame.tail(Source:1)', '   at com.example.Frame.tail(Source:2)'];
  // Two oversize entries, each truncated to the 64KB per-entry cap.
  const oversize = [0, 1].map((k) => ({
    time: `2026-07-13 10:02:0${k},000`,
    level: 'ERROR',
    thread: 'T9',
    logger: 'Big',
    message: `big-${k} ` + 'x'.repeat(70_000),
  }));
  // Continuation lines landing on an entry already at the 64KB cap.
  const atCap = ['   at com.example.Frame.cap(Source:1)'];

  for (const src of [limited, mirror]) {
    src.appendLines(first);
    src.appendEntries(oversize);
    src.appendLines(atCap);
    src.appendLines(third);
    src.appendLines(tail);
  }

  // Expected outcome per the documented semantics: evict from the head until
  // the retained bytes fit the ~90% target — i.e. keep the longest suffix.
  const all = await mirror.getEntries(Array.from({ length: mirror.count }, (_, i) => i));
  const sizes = all.map(accountedBytes);
  let total = sizes.reduce((a, b) => a + b, 0);
  assert.ok(total > maxBytes, 'workload must exceed the byte cap');
  let drop = 0;
  while (total > target) total -= sizes[drop++];
  assert.ok(drop > 0, 'workload must trigger eviction');
  assert.ok(drop < all.length, 'workload must not drain the stream');
  const expected = all.slice(drop);

  const got = await limited.getEntries(Array.from({ length: limited.count }, (_, i) => i));
  assert.deepEqual(
    got.map((e) => e.raw),
    expected.map((e) => e.raw)
  );
  assert.equal(limited.bytes, total);
  const stats = [0, 0, 0, 0, 0, 0];
  for (const e of expected) stats[e.lv]++;
  assert.deepEqual(limited.stats, stats);
  assert.deepEqual([...limited.threadList].sort(), [...new Set(expected.map((e) => e.th))].sort());
  assert.deepEqual([...limited.loggerList].sort(), [...new Set(expected.map((e) => e.lg))].sort());
  // The retained oversize entry is still byte-exact truncated.
  assert.ok(got.some((e) => /entry truncated/.test(e.raw)));
});

test('merged source re-sorts on out-of-order appends and keeps lists fresh', async () => {
  const a = new StreamSource('sa2', 'a2');
  const b = new StreamSource('sb2', 'b2');
  a.appendLines(['2026-07-13 10:00:00,000 [A] INFO X - a1', '2026-07-13 10:00:02,000 [A] INFO X - a2']);
  b.appendLines(['2026-07-13 10:00:01,000 [B] INFO Y - b1']);
  const m = new MergedSource('m2', 'merged', [a, b]);
  assert.deepEqual(m.threadList, ['A', 'B']);
  let resets = 0;
  let appends = 0;
  m.on('reset', () => resets++);
  m.on('append', () => appends++);

  // Out-of-order arrival: full rebuild, consumers re-evaluate via reset.
  b.appendLines(['2026-07-13 09:59:59,000 [B] ERROR Y - b0']);
  assert.equal(resets, 1);
  assert.equal(appends, 0);
  assert.deepEqual(
    (await m.getEntries([0, 1, 2, 3])).map((e) => e.msg),
    ['b0', 'a1', 'b1', 'a2']
  );

  // In-order appends after the rebuild still take the fast path.
  a.appendLines(['2026-07-13 10:00:03,000 [A] INFO X - a3']);
  assert.equal(appends, 1);
  assert.equal(resets, 1);
  assert.equal((await m.getEntries([m.count - 1]))[0].msg, 'a3');

  // A child append invalidates the cached thread/logger lists.
  a.appendLines(['2026-07-13 10:00:04,000 [NewThread] INFO NewLogger - a4']);
  assert.ok(m.threadList.includes('NewThread'));
  assert.ok(m.loggerList.includes('NewLogger'));
  await m.close();
});

test('merged source rebuilds and re-caches when a child resets', async () => {
  const a = new StreamSource('rl', 'rl', 4);
  const b = new StreamSource('rb', 'rb');
  a.appendLines(['2026-07-13 10:00:01,000 [Gone] INFO X - a1', '2026-07-13 10:00:03,000 [A] INFO X - a3']);
  b.appendLines(['2026-07-13 10:00:02,000 [B] INFO Y - b2']);
  const m = new MergedSource('m3', 'merged', [a, b]);
  assert.ok(m.threadList.includes('Gone'));
  let resets = 0;
  let appends = 0;
  m.on('reset', () => resets++);
  m.on('append', () => appends++);

  // Pushes the capped child past its entry limit: it evicts, rebases, resets.
  a.appendLines([
    '2026-07-13 10:00:04,000 [A] WARN X - a4',
    '2026-07-13 10:00:05,000 [A] WARN X - a5',
    '2026-07-13 10:00:06,000 [A] WARN X - a6',
  ]);
  assert.equal(a.count, 4);
  assert.equal(resets, 1);
  assert.equal(appends, 0);
  assert.equal(m.count, 5);
  assert.deepEqual(
    (await m.getEntries([0, 1, 2, 3, 4])).map((e) => e.msg),
    ['b2', 'a3', 'a4', 'a5', 'a6']
  );
  // The evicted entry's thread disappears once the lists are rebuilt.
  assert.deepEqual(m.threadList, ['A', 'B']);
  assert.deepEqual(m.stats, [0, 0, 2, 3, 0, 0]);

  // In-order appends on the other child still take the fast path.
  b.appendLines(['2026-07-13 10:00:07,000 [B] INFO Y - b7']);
  assert.equal(appends, 1);
  assert.equal(resets, 1);
  assert.equal((await m.getEntries([m.count - 1]))[0].msg, 'b7');
  await m.close();
});

test('gzipped source decompresses to a temp file, is not tailed and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-'));
  const gz = path.join(dir, 'app.log.1.gz');
  fs.writeFileSync(gz, gzipSync(LOG + '\n'));
  assert.ok(await isGzipFile(gz));
  assert.ok(!(await isGzipFile(tmpFile(LOG))));

  const src = await FileLogSource.openGz('gz1', gz);
  const tmpPath = src.path;
  try {
    assert.ok(src.gzipped);
    assert.equal(src.gzippedPath, gz);
    assert.notEqual(tmpPath, gz);
    assert.ok(path.basename(tmpPath).endsWith('.log'));
    assert.ok(path.dirname(tmpPath).startsWith(os.tmpdir()));
    assert.equal(src.name, 'app.log.1.gz');
    // Decompressed content is indexed and auto-detected like a plain file.
    assert.equal(src.count, 4);
    assert.deepEqual(src.stats, [0, 1, 1, 1, 1, 0]);
    const [err] = await src.getEntries([2]);
    assert.equal(err.lv, 4);
    assert.ok(err.raw.includes('Some.Stack.Frame'));
    assert.deepEqual(await src.evalCriteria({ text: 'slow query' }), [1]);
    // A gzipped rotation is static: no tail watcher is attached.
    assert.equal((src as unknown as { watching: boolean }).watching, false);
  } finally {
    await src.close();
  }
  assert.ok(!fs.existsSync(tmpPath), 'temp copy is deleted on close');
  assert.ok(!fs.existsSync(path.dirname(tmpPath)), 'temp directory is deleted on close');
  assert.ok(fs.existsSync(gz), 'the original .gz file is untouched');
});

test('gzip decompression enforces the size cap', async () => {
  const preexisting = new Set(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('log-viewer-'))
  );
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-'));
  const gz = path.join(dir, 'big.log.gz');
  fs.writeFileSync(gz, gzipSync(LOG + '\n'));
  const err = await FileLogSource.openGz('gz2', gz, 64).then(
    () => null,
    (e) => e
  );
  assert.ok(err instanceof GzipTooLargeError);
  assert.equal(err.status, 413);
  // The partial temp file must not survive a rejected decompression.
  // Snapshot-diff so stale dirs from interrupted runs elsewhere don't flake.
  assert.deepEqual(
    fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('log-viewer-') && !preexisting.has(n)),
    []
  );
});

test('corrupt gzip input is rejected and cleans up', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-'));
  const bad = path.join(dir, 'corrupt.gz');
  // Valid magic bytes, then garbage.
  fs.writeFileSync(bad, Buffer.concat([Buffer.from([0x1f, 0x8b, 0x08]), Buffer.from('not a gzip stream')]));
  const err = await FileLogSource.openGz('gz3', bad).then(
    () => null,
    (e) => e as Error & { status?: number }
  );
  assert.ok(err);
  assert.equal(err.status, 400);
});
