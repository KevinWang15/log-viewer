import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { Store } from '../src/store';
import { FileLogSource } from '../src/sources';
import { globToRegExp, makeFileOpener, startDirectoryWatch, OpenResult } from '../src/watch';

const LOG = '2024-01-01 00:00:00 INFO hello from watch test';

function tempRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-watch-'));
}

async function waitFor(cond: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function cleanup(store: Store, stop: () => void, dir: string) {
  stop();
  for (const id of [...store.sources.keys()]) await store.removeSource(id);
  fs.rmSync(dir, { recursive: true, force: true });
}

test('glob matcher: *, ** and ? against root-relative paths', () => {
  const anyLog = globToRegExp('**/*.log');
  assert.ok(anyLog.test('app.log'), '** crosses zero directories');
  assert.ok(anyLog.test('a/b/app.log'));
  assert.ok(!anyLog.test('app.txt'));
  const topOnly = globToRegExp('*.log');
  assert.ok(topOnly.test('app.log'));
  assert.ok(!topOnly.test('sub/app.log'), '* stays within a segment');
  const q = globToRegExp('app-?.log');
  assert.ok(q.test('app-1.log'));
  assert.ok(!q.test('app-12.log'));
});

test('watcher auto-opens new matching files with origin watch, ignores non-matching', async () => {
  const root = tempRoot();
  const store = new Store();
  let seq = 1;
  const watcher = startDirectoryWatch({
    root,
    globs: ['**/*.log'],
    intervalMs: 50,
    open: makeFileOpener(store, () => 'w' + seq++, 'watch'),
  });
  try {
    fs.writeFileSync(path.join(root, 'notes.txt'), LOG);
    fs.mkdirSync(path.join(root, 'sub'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(store.sources.size, 0, 'non-matching file ignored');

    fs.writeFileSync(path.join(root, 'app.log'), LOG);
    fs.writeFileSync(path.join(root, 'sub', 'server.log'), LOG);
    await waitFor(() => store.sources.size === 2);
    const sources = [...store.sources.values()];
    for (const src of sources) {
      assert.equal(src.kind, 'file');
      assert.equal(store.originFor(src.id), 'watch');
    }
    assert.deepEqual(
      sources.map((s) => s.name).sort(),
      ['app.log', 'server.log']
    );
  } finally {
    await cleanup(store, watcher.stop, root);
  }
});

test('watcher opens a glob-matched gzip rotation as a gzipped source', async () => {
  const root = tempRoot();
  const store = new Store();
  let seq = 1;
  const watcher = startDirectoryWatch({
    root,
    globs: ['**/*.log.gz'],
    intervalMs: 50,
    open: makeFileOpener(store, () => 'w' + seq++, 'watch'),
  });
  try {
    fs.writeFileSync(path.join(root, 'rotated.log.gz'), gzipSync(LOG + '\n'));
    await waitFor(() => store.sources.size === 1);
    const src = [...store.sources.values()][0];
    assert.ok(src instanceof FileLogSource && src.gzipped, 'gzip magic detected like the open route');
    assert.equal(src.count, 1);
    assert.equal(store.originFor(src.id), 'watch');
  } finally {
    await cleanup(store, watcher.stop, root);
  }
});

test('watcher does not duplicate an already-open path', async () => {
  const root = tempRoot();
  const store = new Store();
  let seq = 1;
  const open = makeFileOpener(store, () => 'w' + seq++, 'watch');
  const file = path.join(root, 'app.log');
  fs.writeFileSync(file, LOG);
  assert.equal(await open(file), 'opened');
  const watcher = startDirectoryWatch({ root, globs: ['**/*.log'], intervalMs: 50, open, log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(store.sources.size, 1, 'byPath dedup keeps a single source');
  } finally {
    await cleanup(store, watcher.stop, root);
  }
});

test('a file that fails to open is not retried until its mtime changes', async () => {
  const root = tempRoot();
  fs.writeFileSync(path.join(root, 'bad.log'), LOG);
  let attempts = 0;
  const open = async (): Promise<OpenResult> => {
    attempts++;
    return 'failed';
  };
  const watcher = startDirectoryWatch({ root, globs: ['**/*.log'], intervalMs: 50, open, log: () => {} });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(attempts, 1, 'no hot retry loop for a failing path');
    fs.utimesSync(path.join(root, 'bad.log'), new Date(), new Date(Date.now() + 5_000));
    await waitFor(() => attempts >= 2);
  } finally {
    watcher.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('watcher respects the source cap and warns once', async () => {
  const root = tempRoot();
  const store = new Store();
  let seq = 1;
  const warnings: string[] = [];
  const watcher = startDirectoryWatch({
    root,
    globs: ['**/*.log'],
    intervalMs: 50,
    open: makeFileOpener(store, () => 'w' + seq++, 'watch'),
    maxSources: 1,
    sourceCount: () => store.sources.size,
    log: (msg) => warnings.push(msg),
  });
  try {
    fs.writeFileSync(path.join(root, 'a.log'), LOG);
    fs.writeFileSync(path.join(root, 'b.log'), LOG);
    await waitFor(() => store.sources.size === 1);
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(store.sources.size, 1, 'cap stops further auto-opens');
    assert.equal(
      warnings.filter((w) => w.includes('source cap')).length,
      1,
      'cap warning logged once'
    );
  } finally {
    await cleanup(store, watcher.stop, root);
  }
});

test('scan errors are logged once per path and never crash the loop', async () => {
  const root = tempRoot();
  const store = new Store();
  let seq = 1;
  const warnings: string[] = [];
  const watcher = startDirectoryWatch({
    root: path.join(root, 'missing'), // readdir fails on every tick
    globs: ['**/*.log'],
    intervalMs: 50,
    open: makeFileOpener(store, () => 'w' + seq++, 'watch'),
    log: (msg) => warnings.push(msg),
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    assert.ok(warnings.length >= 1, 'scan error reported');
    assert.equal(
      warnings.filter((w) => w.includes('cannot scan')).length,
      1,
      'same path logged once'
    );
    assert.equal(store.sources.size, 0);
  } finally {
    await cleanup(store, watcher.stop, root);
  }
});
