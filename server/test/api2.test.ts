import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

async function availablePort(): Promise<number> {
  const socket = createServer();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const address = socket.address();
  assert.ok(address && typeof address === 'object');
  const port = address.port;
  socket.close();
  await once(socket, 'close');
  return port;
}

async function stop(child: ChildProcess) {
  if (child.exitCode !== null) return;
  child.kill('SIGTERM');
  const timeout = new Promise((resolve) => {
    const timer = setTimeout(resolve, 2_000);
    timer.unref();
  });
  await Promise.race([once(child, 'exit'), timeout]);
  if (child.exitCode === null) child.kill('SIGKILL');
}

async function startServer(extraEnv: Record<string, string>) {
  const port = await availablePort();
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../src/index.ts')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      ENABLE_DEMO: 'false',
      ENABLE_SAMPLES: 'false',
      STREAM_IDLE_TTL_SECONDS: '0',
      STREAM_KEY: '',
      STREAM_TOKENS: '',
      VIEW_KEY: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const request = (pathname: string, init?: RequestInit) => fetch(base + pathname, init);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    if (child.exitCode !== null) throw new Error(`server exited before startup:\n${output}`);
    try {
      const response = await request('/healthz');
      if (response.ok) {
        ready = true;
        break;
      }
    } catch {
      // Startup is still in progress.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(ready, `server did not become ready:\n${output}`);
  return { child, request, port };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

async function openFile(request: (p: string, i?: RequestInit) => Promise<Response>, file: string): Promise<string> {
  const opened = await request('/api/logs/open', json('POST', { path: file }));
  assert.equal(opened.status, 200);
  return ((await opened.json()) as { id: string }).id;
}

test('filters: create/view/delete lifecycle with combined criteria over HTTP', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-filters-'));
  const file = path.join(dir, 'filters.log');
  fs.writeFileSync(
    file,
    [
      '2026-07-13 10:00:00,000 [T1] INFO App - alpha boot',
      '2026-07-13 10:00:01,000 [T2] WARN App - beta slow',
      '2026-07-13 10:00:02,000 [T1] ERROR Db - gamma failed',
      '2026-07-13 10:00:03,000 [T2] INFO Db - beta retry',
      '2026-07-13 10:00:04,000 [T1] ERROR App - alpha crash',
    ].join('\n') + '\n'
  );

  try {
    const id = await openFile(request, file);
    const post = async (target: string, criteria: unknown) => {
      const res = await request(`/api/logs/${encodeURIComponent(target)}/filters`, json('POST', { criteria }));
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    // Unknown source cannot be filtered.
    const missing = await post('nope', {});
    assert.equal(missing.status, 404);
    assert.match(missing.body.error as string, /unknown log/);

    // An invalid regex in text criteria is a 400, not a 500.
    const badRegex = await post(id, { text: '([unclosed', regex: true });
    assert.equal(badRegex.status, 400);
    assert.match(badRegex.body.error as string, /invalid regex/);

    // Read back entry timestamps so the time-range criteria is timezone-proof.
    const page = (await (await request(`/api/logs/${id}/entries?start=0&count=10`)).json()) as {
      entries: Array<{ t: number }>;
    };
    const ts = page.entries.map((e) => e.t);

    // Combined criteria: levels AND text AND time range (bounds inclusive).
    // WARN/ERROR entries in [ts[1], ts[3]] containing 'a' → indices 1 and 2.
    const combo = await post(id, { levels: [3, 4], text: 'a', timeFrom: ts[1], timeTo: ts[3] });
    assert.equal(combo.status, 200);
    assert.deepEqual(combo.body, { filterId: 'F1', count: 2, stats: [0, 0, 0, 1, 1, 0] });

    const comboView = (await (
      await request(`/api/logs/${id}/entries?start=0&count=10&filter=F1`)
    ).json()) as { entries: Array<{ msg: string }> };
    assert.deepEqual(comboView.entries.map((e) => e.msg), ['beta slow', 'gamma failed']);

    // Exclude inverts the match: everything without 'beta' in the raw text.
    const excluded = await post(id, { text: 'beta', exclude: true });
    assert.equal(excluded.status, 200);
    assert.deepEqual(excluded.body, { filterId: 'F2', count: 3, stats: [0, 0, 1, 0, 2, 0] });
    const excludedView = (await (
      await request(`/api/logs/${id}/entries?start=0&count=10&filter=F2`)
    ).json()) as { entries: Array<{ msg: string }> };
    assert.deepEqual(excludedView.entries.map((e) => e.msg), ['alpha boot', 'gamma failed', 'alpha crash']);

    // Deleting a filter mid-use: subsequent reads against it 404, and the
    // surviving filter is unaffected.
    const removed = await request(`/api/logs/${id}/filters/F1`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.deepEqual(await removed.json(), { ok: true });
    const stale = await request(`/api/logs/${id}/entries?start=0&count=10&filter=F1`);
    assert.equal(stale.status, 404);
    assert.match(((await stale.json()) as { error: string }).error, /unknown filter/);
    const alive = await request(`/api/logs/${id}/entries?start=0&count=10&filter=F2`);
    assert.equal(alive.status, 200);

    // Delete is idempotent: unknown filter ids still return ok.
    const again = await request(`/api/logs/${id}/filters/F999`, { method: 'DELETE' });
    assert.equal(again.status, 200);
    assert.deepEqual(await again.json(), { ok: true });
  } finally {
    await stop(child);
  }
});

test('search, export and bookmark mutations 404 on unknown sources', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({});

  try {
    assert.equal((await request('/api/logs/nope/search?q=x&from=-1&dir=next')).status, 404);
    assert.equal((await request('/api/logs/nope/export')).status, 404);
    assert.equal((await request('/api/logs/nope/bookmarks', json('PUT', { index: 0 }))).status, 404);
    assert.equal((await request('/api/logs/nope/bookmarks/next?from=-1')).status, 404);
    for (const res of [
      await request('/api/logs/nope/search?q=x'),
      await request('/api/logs/nope/bookmarks/next'),
    ]) {
      assert.match(((await res.json()) as { error: string }).error, /unknown log/);
    }
  } finally {
    await stop(child);
  }
});

test('bookmarks: toggle, list, next/prev navigation and filter interaction', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-bookmarks-'));
  const file = path.join(dir, 'bookmarks.log');
  fs.writeFileSync(
    file,
    [
      '2026-07-13 10:00:00,000 [T1] INFO App - m0',
      '2026-07-13 10:00:01,000 [T1] WARN App - m1',
      '2026-07-13 10:00:02,000 [T1] INFO App - m2',
      '2026-07-13 10:00:03,000 [T1] ERROR App - m3',
      '2026-07-13 10:00:04,000 [T1] WARN App - m4',
      '2026-07-13 10:00:05,000 [T1] INFO App - m5',
    ].join('\n') + '\n'
  );

  try {
    const id = await openFile(request, file);
    const list = async () =>
      ((await (await request(`/api/logs/${id}/bookmarks`)).json()) as { indices: number[] }).indices;
    const next = async (qs: string) => {
      const res = await request(`/api/logs/${id}/bookmarks/next?${qs}`);
      assert.equal(res.status, 200);
      return ((await res.json()) as { vi: number | null }).vi;
    };

    // Invalid indices are rejected against the source size.
    assert.equal((await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: -1 }))).status, 400);
    assert.equal((await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: 6 }))).status, 400);

    // PUT toggles when `on` is omitted and honors an explicit `on`.
    const on1 = await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: 2 }));
    assert.deepEqual(await on1.json(), { index: 2, on: true, total: 1 });
    const off = await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: 2 }));
    assert.deepEqual(await off.json(), { index: 2, on: false, total: 0 });
    const explicit = await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: 4, on: true }));
    assert.deepEqual(await explicit.json(), { index: 4, on: true, total: 1 });
    const idem = await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: 4, on: true }));
    assert.deepEqual(await idem.json(), { index: 4, on: true, total: 1 });
    await request(`/api/logs/${id}/bookmarks`, json('PUT', { index: 1, on: true }));
    assert.deepEqual(await list(), [1, 4]);

    // Navigation is strictly past `from` in the given direction: next from a
    // bookmarked row moves to the following bookmark; exhaustion is null in
    // both directions (no wraparound).
    assert.equal(await next('from=-1'), 1);
    assert.equal(await next('from=0'), 1);
    assert.equal(await next('from=1'), 4);
    assert.equal(await next('from=2'), 4);
    assert.equal(await next('from=4'), null, 'no wraparound past the last bookmark');
    assert.equal(await next('from=5'), null);
    assert.equal(await next('from=6&dir=prev'), 4, 'prev from past the end lands on the last bookmark');
    assert.equal(await next('from=5&dir=prev'), 4);
    assert.equal(await next('from=4&dir=prev'), 1);
    assert.equal(await next('from=1&dir=prev'), null, 'no wraparound before the first bookmark');
    assert.equal(await next('from=0&dir=prev'), null);

    // With a filter active, navigation is over view indices. WARN view = [1, 4].
    const filter = await request(`/api/logs/${id}/filters`, json('POST', { criteria: { levels: [3] } }));
    assert.equal(((await filter.json()) as { filterId: string }).filterId, 'F1');
    assert.equal(await next('from=-1&filter=F1'), 0, 'entry 1 is view index 0 under the filter');
    assert.equal(await next('from=0&filter=F1'), 1);
    assert.equal(await next('from=1&filter=F1'), null);
    assert.equal(await next('from=2&dir=prev&filter=F1'), 1);

    // Bookmarks are source-scoped: creating and deleting filters leaves them
    // untouched, and navigation without the filter still sees the full view.
    assert.equal((await request(`/api/logs/${id}/filters/F1`, { method: 'DELETE' })).status, 200);
    assert.deepEqual(await list(), [1, 4]);
    assert.equal(await next('from=-1'), 1);
  } finally {
    await stop(child);
  }
});

test('export streams the raw view as text/plain and honors the filter param', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-export-'));
  const file = path.join(dir, 'export.log');
  const lines = [
    '2026-07-13 10:00:00,000 [Main] INFO App - starting up',
    '2026-07-13 10:00:01,000 [T1] WARN Db - slow query',
    '2026-07-13 10:00:02,000 [Main] ERROR Db - deadlock',
  ];
  const content = lines.join('\n') + '\n';
  fs.writeFileSync(file, content);

  try {
    const id = await openFile(request, file);
    const res = await request(`/api/logs/${id}/export`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type') || '', /^text\/plain/);
    assert.equal(res.headers.get('content-disposition'), 'attachment; filename="export.log-view.log"');
    assert.equal(await res.text(), content, 'unfiltered export reproduces the file bytes');

    // Filtered export contains only the matching raw lines.
    const filter = await request(`/api/logs/${id}/filters`, json('POST', { criteria: { levels: [4] } }));
    assert.equal(filter.status, 200);
    const filtered = await request(`/api/logs/${id}/export?filter=F1`);
    assert.equal(filtered.status, 200);
    assert.equal(await filtered.text(), lines[2] + '\n');
  } finally {
    await stop(child);
  }
});

test('browse and stat are confined to LOG_ROOT and report file metadata', { timeout: 15_000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-browse-'));
  const { child, request } = await startServer({ LOG_ROOT: root });
  fs.mkdirSync(path.join(root, 'sub'));
  fs.writeFileSync(path.join(root, 'a.log'), 'aaa\n');
  fs.writeFileSync(path.join(root, 'b.log'), 'bbbb\n');
  fs.writeFileSync(path.join(root, '.hidden'), 'secret\n');

  try {
    const browse = await request(`/api/browse?path=${encodeURIComponent(root)}`);
    assert.equal(browse.status, 200);
    const listing = (await browse.json()) as {
      path: string;
      root: string;
      dirs: Array<{ name: string }>;
      files: Array<{ name: string; size: number; mtime: number }>;
    };
    assert.equal(listing.path, root);
    assert.equal(listing.root, root);
    assert.deepEqual(listing.dirs.map((d) => d.name), ['sub']);
    assert.deepEqual(
      listing.files.map((f) => [f.name, f.size]),
      [
        ['a.log', 4],
        ['b.log', 5],
      ]
    );
    assert.ok(listing.files.every((f) => f.mtime > 0));

    // Descending into a subdirectory reports the parent chain.
    const sub = (await (
      await request(`/api/browse?path=${encodeURIComponent(path.join(root, 'sub'))}`)
    ).json()) as { parent: string; dirs: unknown[]; files: unknown[] };
    assert.equal(sub.parent, root);
    assert.deepEqual(sub.dirs, []);
    assert.deepEqual(sub.files, []);

    // Path traversal outside LOG_ROOT is rejected, whether it escapes via
    // '..' segments or names an absolute outside path.
    for (const p of [path.join(root, '..', 'escape'), '/etc']) {
      const denied = await request(`/api/browse?path=${encodeURIComponent(p)}`);
      assert.equal(denied.status, 403, `browse escapes root: ${p}`);
      assert.match(((await denied.json()) as { error: string }).error, /outside allowed root/);
      const deniedStat = await request(`/api/stat?path=${encodeURIComponent(p)}`);
      assert.equal(deniedStat.status, 403, `stat escapes root: ${p}`);
    }

    // stat distinguishes files from directories inside the root.
    const fileStat = (await (
      await request(`/api/stat?path=${encodeURIComponent(path.join(root, 'a.log'))}`)
    ).json()) as { path: string; size: number; isFile: boolean };
    assert.equal(fileStat.isFile, true);
    assert.equal(fileStat.size, 4);
    const dirStat = (await (
      await request(`/api/stat?path=${encodeURIComponent(path.join(root, 'sub'))}`)
    ).json()) as { isFile: boolean };
    assert.equal(dirStat.isFile, false);

    // Missing paths are 404, not 500.
    const missing = path.join(root, 'nope.log');
    assert.equal((await request(`/api/stat?path=${encodeURIComponent(missing)}`)).status, 404);
    assert.equal(
      (await request(`/api/browse?path=${encodeURIComponent(path.join(root, 'no-such-dir'))}`)).status,
      404
    );
  } finally {
    await stop(child);
  }
});
