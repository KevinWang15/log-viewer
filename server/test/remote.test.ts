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

async function startServer(extraEnv: Record<string, string>, fixedPort?: number) {
  const port = fixedPort ?? (await availablePort());
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
  return { child, request, port, base };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Polls until `fn` returns a truthy value and returns it.
async function eventually<T>(fn: () => Promise<T>, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(50);
  }
  return last!;
}

async function seedStream(request: (p: string, i?: RequestInit) => Promise<Response>, channel: string, lines: string[]) {
  assert.equal((await request(`/api/v1/streams/${channel}`, json('PUT'))).status, 201);
  const appended = await request(`/api/v1/streams/${channel}/entries`, json('POST', { lines }));
  assert.equal(appended.status, 200);
}

async function openRemote(
  request: (p: string, i?: RequestInit) => Promise<Response>,
  url: string,
  source: string,
  viewKey?: string
) {
  const res = await request('/api/logs/remote', json('POST', { url, source, viewKey }));
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

async function remoteEntries(request: (p: string, i?: RequestInit) => Promise<Response>, id: string, qs = 'start=0&count=100') {
  const res = await request(`/api/logs/${encodeURIComponent(id)}/entries?${qs}`);
  assert.equal(res.status, 200);
  return ((await res.json()) as { entries: Array<Record<string, unknown>> }).entries;
}

async function remoteInfo(request: (p: string, i?: RequestInit) => Promise<Response>, id: string) {
  const res = await request(`/api/logs/${encodeURIComponent(id)}`);
  assert.equal(res.status, 200);
  return (await res.json()) as Record<string, unknown>;
}

test('remote source mirrors a peer stream: load, tail, filter, search, delete', { timeout: 20_000 }, async () => {
  const peer = await startServer({});
  const main = await startServer({});
  await seedStream(peer.request, 'peer1', [
    '2026-07-13 10:00:00,000 [T1] INFO App - boot',
    '2026-07-13 10:00:01,000 [T2] WARN Db - slow query',
    '2026-07-13 10:00:02,000 [T1] ERROR Db - deadlock',
  ]);

  try {
    // Validation and peer-side failures map to HTTP statuses.
    assert.equal((await openRemote(main.request, '', 's:peer1')).status, 400);
    assert.equal((await openRemote(main.request, 'ftp://peer', 's:peer1')).status, 400);
    assert.equal((await openRemote(main.request, peer.base, 's:nope')).status, 404);
    const deadPort = await availablePort();
    const unreachable = await openRemote(main.request, `http://127.0.0.1:${deadPort}`, 's:peer1');
    assert.equal(unreachable.status, 502);

    const opened = await openRemote(main.request, peer.base, 's:peer1');
    assert.equal(opened.status, 200);
    assert.equal(opened.body.kind, 'remote');
    assert.deepEqual(opened.body.remote, { url: peer.base, source: 's:peer1' });
    assert.equal(opened.body.count, 3);
    assert.equal(opened.body.name, 'peer1 @ 127.0.0.1:' + peer.port);
    const id = String(opened.body.id);

    // The WS subscription is established asynchronously.
    const connected = await eventually(async () => (await remoteInfo(main.request, id)).connected === true);
    assert.ok(connected, 'remote source subscribes to the peer broadcast');

    // Mirrored entries keep the peer's parsed fields.
    const entries = await remoteEntries(main.request, id);
    assert.deepEqual(
      entries.map((e) => [e.lv, e.th, e.lg, e.msg]),
      [
        [2, 'T1', 'App', 'boot'],
        [3, 'T2', 'Db', 'slow query'],
        [4, 'T1', 'Db', 'deadlock'],
      ]
    );
    assert.ok(typeof entries[0].t === 'number' && entries[0].t > 0);

    // Filters and search run against the mirror through the generic paths.
    const filtered = await main.request(`/api/logs/${encodeURIComponent(id)}/filters`, json('POST', { criteria: { levels: [4] } }));
    assert.equal(filtered.status, 200);
    assert.deepEqual(await filtered.json(), { filterId: 'F1', count: 1, stats: [0, 0, 0, 0, 1, 0] });
    const found = await main.request(`/api/logs/${encodeURIComponent(id)}/search?q=slow&from=-1&dir=next`);
    assert.equal(((await found.json()) as { vi: number | null }).vi, 1);

    // A live append on the peer shows up on the mirror via WS.
    await peer.request('/api/v1/streams/peer1/entries', json('POST', { lines: ['2026-07-13 10:00:03,000 [T2] INFO App - live tail'] }));
    const tailed = await eventually(async () => {
      const page = await remoteEntries(main.request, id);
      return page.length === 4 ? page : null;
    });
    assert.equal(tailed[3].msg, 'live tail');
    // The append was folded into the open filter view too (no match here).
    const filteredAfter = await main.request(`/api/logs/${encodeURIComponent(id)}/entries?start=0&count=10&filter=F1`);
    assert.equal(((await filteredAfter.json()) as { entries: unknown[] }).entries.length, 1);

    // DELETE tears down the mirror; the peer's source is untouched.
    assert.equal((await main.request(`/api/logs/${encodeURIComponent(id)}`, { method: 'DELETE' })).status, 200);
    assert.equal((await main.request(`/api/logs/${encodeURIComponent(id)}`)).status, 404);
    assert.equal((await peer.request('/api/v1/streams/peer1')).status, 200);
  } finally {
    await stop(main.child);
    await stop(peer.child);
  }
});

test('remote open forwards the view key to a secured peer', { timeout: 20_000 }, async () => {
  const peer = await startServer({ VIEW_KEY: 'viewer' });
  const main = await startServer({});
  await seedStream(peer.request, 'guarded', ['2026-07-13 10:00:00,000 [T1] INFO App - secret line']);

  try {
    const denied = await openRemote(main.request, peer.base, 's:guarded');
    assert.equal(denied.status, 401);
    assert.match(String(denied.body.error), /view key/);

    const opened = await openRemote(main.request, peer.base, 's:guarded', 'wrong');
    assert.equal(opened.status, 401);

    const ok = await openRemote(main.request, peer.base, 's:guarded', 'viewer');
    assert.equal(ok.status, 200);
    const id = String(ok.body.id);
    assert.deepEqual((await remoteEntries(main.request, id)).map((e) => e.msg), ['secret line']);

    // Tailing works too: the key rides along in the WS sub frame.
    await peer.request('/api/v1/streams/guarded/entries', json('POST', { lines: ['2026-07-13 10:00:01,000 [T1] INFO App - keyed tail'] }));
    const tailed = await eventually(async () => {
      const page = await remoteEntries(main.request, id);
      return page.length === 2 ? page : null;
    });
    assert.equal(tailed[1].msg, 'keyed tail');
  } finally {
    await stop(main.child);
    await stop(peer.child);
  }
});

test('merged view interleaves a local file and a remote source by time', { timeout: 20_000 }, async () => {
  const peer = await startServer({});
  const main = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-remote-merge-'));
  const file = path.join(dir, 'local.log');
  fs.writeFileSync(
    file,
    [
      '2026-07-13 10:00:00,000 [Main] INFO App - local0',
      '2026-07-13 10:00:02,000 [Main] WARN App - local2',
      '2026-07-13 10:00:04,000 [Main] ERROR App - local4',
    ].join('\n') + '\n'
  );
  await seedStream(peer.request, 'rmerge', [
    '2026-07-13 10:00:01,000 [T9] INFO Peer - remote1',
    '2026-07-13 10:00:03,000 [T9] INFO Peer - remote3',
  ]);

  try {
    const localId = ((await (await main.request('/api/logs/open', json('POST', { path: file }))).json()) as { id: string }).id;
    const remote = await openRemote(main.request, peer.base, 's:rmerge');
    assert.equal(remote.status, 200);
    const remoteId = String(remote.body.id);

    const merged = await main.request('/api/logs/merge', json('POST', { ids: [localId, remoteId], name: 'x-instance' }));
    assert.equal(merged.status, 200);
    const mergedId = String(((await merged.json()) as { id: string }).id);
    const entries = await remoteEntries(main.request, mergedId);
    assert.deepEqual(
      entries.map((e) => [e.msg, e.src]),
      [
        ['local0', 'local.log'],
        ['remote1', 'rmerge @ 127.0.0.1:' + peer.port],
        ['local2', 'local.log'],
        ['remote3', 'rmerge @ 127.0.0.1:' + peer.port],
        ['local4', 'local.log'],
      ]
    );

    // A live remote append lands in the merged view in time order.
    await peer.request('/api/v1/streams/rmerge/entries', json('POST', { lines: ['2026-07-13 10:00:05,000 [T9] INFO Peer - remote5'] }));
    const tailed = await eventually(async () => {
      const page = await remoteEntries(main.request, mergedId);
      return page.length === 6 ? page : null;
    });
    assert.equal(tailed[5].msg, 'remote5');
  } finally {
    await stop(main.child);
    await stop(peer.child);
  }
});

test('remote source stays readable while the peer is down and resyncs after a restart', { timeout: 30_000 }, async () => {
  const peerPort = await availablePort();
  let peer = await startServer({}, peerPort);
  const main = await startServer({});
  await seedStream(peer.request, 'live', ['2026-07-13 10:00:00,000 [T1] INFO App - before outage']);

  try {
    const opened = await openRemote(main.request, peer.base, 's:live');
    assert.equal(opened.status, 200);
    const id = String(opened.body.id);
    await eventually(async () => (await remoteInfo(main.request, id)).connected === true);

    // Peer down: the mirror keeps serving its stale entries and reports
    // connected: false once the socket drops.
    await stop(peer.child);
    const disconnected = await eventually(async () => {
      const info = await remoteInfo(main.request, id);
      return info.connected === false ? info : null;
    });
    assert.equal(disconnected.count, 1);
    assert.deepEqual((await remoteEntries(main.request, id)).map((e) => e.msg), ['before outage']);

    // Peer back on the same port (stream state is in-memory: re-seed it):
    // the mirror reconnects with backoff and reloads from the reset snapshot.
    peer = await startServer({}, peerPort);
    await seedStream(peer.request, 'live', [
      '2026-07-13 10:00:00,000 [T1] INFO App - before outage',
      '2026-07-13 10:00:01,000 [T1] INFO App - after restart',
    ]);
    const resynced = await eventually(
      async () => {
        const info = await remoteInfo(main.request, id);
        return info.connected === true && info.count === 2 ? info : null;
      },
      20_000
    );
    assert.equal(resynced.count, 2);
    assert.deepEqual((await remoteEntries(main.request, id)).map((e) => e.msg), ['before outage', 'after restart']);
  } finally {
    await stop(main.child);
    await stop(peer.child);
  }
});

test('remote mirror keeps only the latest REMOTE_MAX_ENTRIES', { timeout: 20_000 }, async () => {
  const peer = await startServer({});
  const main = await startServer({ REMOTE_MAX_ENTRIES: '5' });
  await seedStream(
    peer.request,
    'capped',
    Array.from({ length: 8 }, (_, k) => `2026-07-13 10:00:${String(k).padStart(2, '0')},000 [T1] INFO App - entry ${k}`)
  );

  try {
    const opened = await openRemote(main.request, peer.base, 's:capped');
    assert.equal(opened.status, 200);
    assert.equal(opened.body.count, 5);
    const id = String(opened.body.id);
    assert.deepEqual((await remoteEntries(main.request, id)).map((e) => e.msg), [
      'entry 3',
      'entry 4',
      'entry 5',
      'entry 6',
      'entry 7',
    ]);

    // Live appends past the cap evict the oldest and rebase via reset.
    await peer.request(
      '/api/v1/streams/capped/entries',
      json('POST', { lines: ['2026-07-13 10:00:08,000 [T1] INFO App - entry 8', '2026-07-13 10:00:09,000 [T1] INFO App - entry 9'] })
    );
    const tailed = await eventually(async () => {
      const page = await remoteEntries(main.request, id);
      return page.length === 5 && page[4].msg === 'entry 9' ? page : null;
    });
    assert.deepEqual(tailed.map((e) => e.msg), ['entry 5', 'entry 6', 'entry 7', 'entry 8', 'entry 9']);
  } finally {
    await stop(main.child);
    await stop(peer.child);
  }
});
