import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { BaseSource, FileLogSource, StreamSource } from '../src/sources';
import { FilterEntry, MAX_TEMPLATE_LENGTH, messageTemplate, Store } from '../src/store';

// Reference implementations: the original per-request full scans, kept here to
// prove the cached Store views stay byte-identical across appends, filter
// changes, bookmark toggles and resets.
function freshMinimap(store: Store, src: BaseSource, f: FilterEntry | null, buckets: number) {
  const n = f ? f.indices.length : src.count;
  const out = new Array<number>(buckets).fill(-1);
  const bm = new Array<boolean>(buckets).fill(false);
  const bmSet = store.bookmarksFor(src.id);
  if (n > 0) {
    for (let b = 0; b < buckets; b++) {
      const s = Math.floor((b * n) / buckets);
      const e = Math.max(s + 1, Math.floor(((b + 1) * n) / buckets));
      let mx = -1;
      for (let k = s; k < Math.min(e, n); k++) {
        const gi = f ? f.indices[k] : k;
        const lv = src.levelAt(gi);
        if (lv > mx) mx = lv;
        if (bmSet.size && bmSet.has(gi)) bm[b] = true;
      }
      out[b] = mx;
    }
  }
  return { buckets: out, bookmarks: bm, count: n };
}

async function freshReport(src: BaseSource, f: FilterEntry | null, buckets: number) {
  const n = f ? f.indices.length : src.count;
  const at = (k: number) => (f ? f.indices[k] : k);
  let tmin = Infinity;
  let tmax = -Infinity;
  for (let k = 0; k < n; k++) {
    const t = src.timeAt(at(k));
    if (t) {
      if (t < tmin) tmin = t;
      if (t > tmax) tmax = t;
    }
  }
  if (!Number.isFinite(tmin)) {
    tmin = 0;
    tmax = 1;
  }
  const span = Math.max(1, tmax - tmin);
  const hist = Array.from({ length: buckets }, (_, b) => ({
    t: tmin + (span * b) / buckets,
    counts: [0, 0, 0, 0, 0, 0],
  }));
  const loggerCounts = new Map<string, number>();
  const threadCounts = new Map<string, number>();
  const msgTemplates = new Map<string, { count: number; example: string }>();
  for (let k = 0; k < n; k++) {
    const gi = at(k);
    const t = src.timeAt(gi);
    const b = t ? Math.min(buckets - 1, Math.floor(((t - tmin) / span) * buckets)) : 0;
    hist[b].counts[src.levelAt(gi)]++;
    const lg = src.loggerAt(gi);
    if (lg) loggerCounts.set(lg, (loggerCounts.get(lg) || 0) + 1);
    const th = src.threadAt(gi);
    if (th) threadCounts.set(th, (threadCounts.get(th) || 0) + 1);
  }
  const MSG_BATCH = 1000;
  for (let s = 0; s < n; s += MSG_BATCH) {
    const idxs: number[] = [];
    for (let k = s; k < Math.min(n, s + MSG_BATCH); k++) idxs.push(at(k));
    const entries = await src.getEntries(idxs);
    for (const e of entries) {
      const template = messageTemplate(e.msg);
      const rec = msgTemplates.get(template);
      if (rec) rec.count++;
      else
        msgTemplates.set(template, {
          count: 1,
          example: e.msg.length > MAX_TEMPLATE_LENGTH ? e.msg.slice(0, MAX_TEMPLATE_LENGTH - 1) + '…' : e.msg,
        });
    }
  }
  const top = (m: Map<string, number>) =>
    [...m.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([name, count]) => ({ name, count }));
  return {
    from: tmin,
    to: tmax,
    total: n,
    buckets: hist,
    series: [0, 1, 2, 3, 4, 5].map((lv) => hist.map((b) => b.counts[lv])),
    topLoggers: top(loggerCounts),
    topThreads: top(threadCounts),
    topMessages: [...msgTemplates.entries()]
      .sort((a, b) => b[1].count - a[1].count)
      .slice(0, 10)
      .map(([template, rec]) => ({ template, count: rec.count, example: rec.example })),
  };
}

const BASE = Date.parse('2026-07-13T10:00:00.000Z');
const LEVELS = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'];

function lines(fromSeq: number, count: number, base = BASE): string[] {
  return Array.from({ length: count }, (_, k) => {
    const seq = fromSeq + k;
    const t = new Date(base + seq * 1000).toISOString().replace('T', ' ').replace('Z', '');
    return `${t} [T${seq % 4}] ${LEVELS[seq % 6]} L${seq % 7} - message ${seq}`;
  });
}

test('cached minimap/report match fresh full scans across appends, filters, bookmarks and resets', async () => {
  const store = new Store();
  const src = new StreamSource('v1', 'views');
  store.addSource(src);
  const assertViews = async (f: FilterEntry | null) => {
    // Cold and warm (cache-hit) calls must both equal a fresh full scan.
    for (let repeat = 0; repeat < 2; repeat++) {
      assert.deepEqual(store.minimapFor(src, f, 400), freshMinimap(store, src, f, 400));
      assert.deepEqual(await store.reportFor(src, f, 60), await freshReport(src, f, 60));
    }
  };
  const nextBroadcast = (type: string) =>
    new Promise<void>((resolve) => {
      const prev = store.broadcast;
      store.broadcast = (msg) => {
        prev(msg);
        if (msg.type === type) resolve();
      };
    });

  await assertViews(null); // empty source

  src.appendLines(lines(0, 300));
  const levelFilter = await store.createFilter(src, { levels: [4, 5] });
  await assertViews(null);
  await assertViews(levelFilter);

  // Append inside the existing time range: report folds incrementally.
  src.appendLines(lines(100, 10));
  await assertViews(null);
  await assertViews(levelFilter);

  // Append beyond the time range: report bucket boundaries move, recompute.
  src.appendLines(lines(300, 50));
  await assertViews(null);
  await assertViews(levelFilter);

  // Bookmark toggles invalidate the minimap but not the report.
  store.setBookmark(src.id, 3, true);
  store.setBookmark(src.id, 300, true);
  await assertViews(null);
  await assertViews(levelFilter);
  store.setBookmark(src.id, 3, false);
  await assertViews(null);

  // Text filters get their own cache entries; deleting drops them.
  const textFilter = await store.createFilter(src, { text: 'message 1' });
  await assertViews(textFilter);
  store.removeFilter(textFilter.id);
  await assertViews(null);
  const recreated = await store.createFilter(src, { text: 'message 1' });
  await assertViews(recreated);

  // A reset (re-parse) rebases nothing here but must invalidate all caches.
  const reset = nextBroadcast('reset');
  src.setFormat(null);
  await reset;
  await assertViews(null);
  await assertViews(levelFilter);
  await assertViews(recreated);
});

test('large tail append updates a text filter incrementally without a full re-read', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-tail-'));
  const file = path.join(dir, 'tail.log');
  const line = (i: number) => `${lines(i, 1)[0]}${i % 500 === 0 ? ' needle' : ''}`;
  fs.writeFileSync(file, Array.from({ length: 6000 }, (_, i) => line(i)).join('\n') + '\n');
  const src = await FileLogSource.open('big', file);
  const store = new Store();
  store.addSource(src);
  const appended = new Promise<void>((resolve) => {
    store.broadcast = (msg) => {
      if (msg.type === 'append') resolve();
    };
  });
  try {
    const filter = await store.createFilter(src, { text: 'needle' });
    assert.equal(filter.indices.length, 12); // 0, 500, …, 5500

    // Count bytes read back through the file handle from here on.
    const fh = (src as unknown as { fh: fsp.FileHandle }).fh;
    const origRead = fh.read.bind(fh);
    let bytesRead = 0;
    (fh as { read: unknown }).read = (buf: Buffer, off: number, len: number, pos: number) => {
      bytesRead += len;
      return origRead(buf, off, len, pos);
    };

    // 2100 new entries (> the old 2000-entry cliff) with the text filter active.
    const tail = Array.from({ length: 2100 }, (_, k) => line(6000 + k)).join('\n') + '\n';
    fs.appendFileSync(file, tail);
    await (src as unknown as { onFileChange(size: number): Promise<void> }).onFileChange(fs.statSync(file).size);
    await appended;

    const expected: number[] = [];
    for (let i = 0; i < 8100; i++) if (i % 500 === 0) expected.push(i);
    assert.deepEqual(filter.indices, expected);
    const expectedStats = [0, 0, 0, 0, 0, 0];
    for (const i of expected) expectedStats[i % 6]++; // entry i has level LEVELS[i % 6]
    assert.deepEqual(filter.stats, expectedStats);

    // Only the appended byte range may be read back for the text scan;
    // a full re-evaluation would have re-read the whole (~4x larger) file.
    const appendedBytes = Buffer.byteLength(tail);
    assert.ok(
      bytesRead <= appendedBytes * 1.5,
      `expected an incremental read of ~${appendedBytes} bytes, got ${bytesRead}`
    );
  } finally {
    await store.removeSource(src.id);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
