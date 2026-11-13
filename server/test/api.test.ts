import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, ChildProcess } from 'node:child_process';
import { createServer, AddressInfo } from 'node:net';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { gzipSync } from 'node:zlib';
import { WebSocket } from 'ws';

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

test('v1 stream API has explicit, authenticated and bounded lifecycle', { timeout: 15_000 }, async () => {
  const port = await availablePort();
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../src/index.ts')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(port),
      NODE_ENV: 'production',
      ENABLE_DEMO: 'false',
      ENABLE_SAMPLES: 'false',
      STREAM_KEY: 'test-secret',
      STREAM_MAX_SOURCES: '1',
      STREAM_MAX_ENTRIES: '10',
      STREAM_MAX_BYTES: '4096',
      STREAM_IDLE_TTL_SECONDS: '0',
      STREAM_MAX_PAYLOAD_BYTES: '1024',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const base = `http://127.0.0.1:${port}`;
  const request = (pathname: string, init?: RequestInit) => fetch(base + pathname, init);
  const keyedJson = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json', 'x-stream-key': 'test-secret' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  try {
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

    const capabilities = await request('/api/v1/capabilities');
    assert.equal(capabilities.status, 200);
    const contract = (await capabilities.json()) as { apiVersion: string; mutationAuth: string; limits: { maxSources: number } };
    assert.equal(contract.apiVersion, 'v1');
    assert.equal(contract.mutationAuth, 'x-stream-key');
    assert.equal(contract.limits.maxSources, 1);

    assert.equal((await request('/api/v1/streams/session-a')).status, 404);
    const before = (await (await request('/healthz')).json()) as { streams: number };
    assert.equal(before.streams, 0, 'a read must not create a stream');

    assert.equal((await request('/api/v1/streams/session-a', { method: 'PUT' })).status, 401);
    assert.equal((await request('/api/v1/streams/not%20safe', keyedJson('PUT'))).status, 400);
    assert.equal((await request('/api/v1/streams/session-a', keyedJson('PUT'))).status, 201);
    assert.equal((await request('/api/v1/streams/session-a', keyedJson('PUT'))).status, 200);

    const appended = await request(
      '/api/v1/streams/session-a/entries',
      keyedJson('POST', { lines: ['2026-07-13 10:00:00,000 [Main] INFO App - hello'] })
    );
    assert.equal(appended.status, 200);
    const info = (await appended.json()) as { id: string; count: number };
    assert.equal(info.id, 's:session-a');
    assert.equal(info.count, 1);

    const page = (await (await request('/api/logs/s%3Asession-a/entries?start=0&count=10')).json()) as {
      entries: Array<{ msg: string }>;
    };
    assert.deepEqual(page.entries.map((entry) => entry.msg), ['hello']);

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'sub', id: 's:session-a' }));
    const [snapshotData] = await once(ws, 'message');
    const snapshot = JSON.parse(String(snapshotData)) as { type: string; id: string; count: number };
    assert.equal(snapshot.type, 'reset');
    assert.equal(snapshot.id, 's:session-a');
    assert.equal(snapshot.count, 1);
    const closed = once(ws, 'close');
    ws.send(JSON.stringify({ padding: 'x'.repeat(2_000) }));
    const [closeCode] = await closed;
    assert.equal(closeCode, 1009, 'oversized WebSocket frames must be rejected');

    const afterOversizedFrame = await request('/healthz');
    assert.equal(afterOversizedFrame.status, 200, 'a rejected frame must not crash the service');

    const atCapacity = await request('/api/v1/streams/session-b', keyedJson('PUT'));
    assert.equal(atCapacity.status, 503);
    assert.equal(((await atCapacity.json()) as { code: string }).code, 'stream_capacity_reached');

    assert.equal((await request('/api/logs/s%3Asession-a', { method: 'DELETE' })).status, 401);
    const tooLarge = await request('/api/v1/streams/session-a/entries', keyedJson('POST', { lines: ['x'.repeat(2_000)] }));
    assert.equal(tooLarge.status, 413);

    const removed = await request('/api/v1/streams/session-a', keyedJson('DELETE'));
    assert.equal(removed.status, 200);
    assert.equal(((await removed.json()) as { deleted: boolean }).deleted, true);
    assert.equal((await request('/api/v1/streams/session-a')).status, 404);
  } finally {
    await stop(child);
  }
});

test('scoped stream tokens authorize mutations by channel prefix', { timeout: 15_000 }, async () => {
  const { child, request, port } = await startServer({ STREAM_TOKENS: 'abc=web-,def=job-' });
  const scopedJson = (key: string, method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json', 'x-stream-key': key },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  try {
    assert.equal((await request('/api/v1/streams/web-1', scopedJson('abc', 'PUT'))).status, 201);
    const appended = await request('/api/v1/streams/web-1/entries', scopedJson('abc', 'POST', { lines: ['hello'] }));
    assert.equal(appended.status, 200);

    const denied = await request('/api/v1/streams/job-1', scopedJson('abc', 'PUT'));
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'invalid or missing x-stream-key header' });
    assert.equal((await request('/api/v1/streams/web-2', scopedJson('nope', 'PUT'))).status, 401);
    assert.equal((await request('/api/v1/streams/web-3', { method: 'PUT' })).status, 401);
    assert.equal((await request('/api/v1/streams/job-1', scopedJson('def', 'PUT'))).status, 201);

    // WS publish honors the same scoped rule.
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await once(ws, 'open');
    ws.send(JSON.stringify({ type: 'publish', channel: 'web-live', key: 'abc', lines: ['via ws'] }));
    ws.send(JSON.stringify({ type: 'publish', channel: 'job-live', key: 'abc', lines: ['denied'] }));
    await new Promise((resolve) => setTimeout(resolve, 100));
    ws.close();

    const published = await request('/api/v1/streams/web-live');
    assert.equal(published.status, 200);
    assert.equal(((await published.json()) as { count: number }).count, 1);
    assert.equal((await request('/api/v1/streams/job-live')).status, 404);
  } finally {
    await stop(child);
  }
});

test('master stream key still authorizes any channel when scoped tokens exist', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ STREAM_KEY: 'master', STREAM_TOKENS: 'abc=web-' });
  const keyedJson = (key: string): RequestInit => ({ method: 'PUT', headers: { 'x-stream-key': key } });

  try {
    assert.equal((await request('/api/v1/streams/job-9', keyedJson('master'))).status, 201);
    assert.equal((await request('/api/v1/streams/job-10', keyedJson('abc'))).status, 401);
    assert.equal((await request('/api/v1/streams/web-9', keyedJson('abc'))).status, 201);
  } finally {
    await stop(child);
  }
});

test('stream mutations are open when no stream auth is configured', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({});

  try {
    assert.equal((await request('/api/v1/streams/free', { method: 'PUT' })).status, 201);
    const appended = await request('/api/v1/streams/free/entries', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lines: ['open'] }),
    });
    assert.equal(appended.status, 200);
    assert.equal((await request('/api/v1/streams/free', { method: 'DELETE' })).status, 200);
  } finally {
    await stop(child);
  }
});

test('view key guards read endpoints when configured', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ VIEW_KEY: 'viewer', STREAM_KEY: 'master' });

  try {
    const denied = await request('/api/logs');
    assert.equal(denied.status, 401);
    assert.deepEqual(await denied.json(), { error: 'invalid or missing x-view-key header' });
    assert.equal((await request('/api/v1/capabilities')).status, 401);

    assert.equal((await request('/api/logs', { headers: { 'x-view-key': 'viewer' } })).status, 200);
    assert.equal((await request('/api/logs?viewKey=viewer')).status, 200);
    assert.equal((await request('/api/logs', { headers: { 'x-stream-key': 'master' } })).status, 200);
    assert.equal((await request('/api/logs', { headers: { 'x-view-key': 'wrong' } })).status, 401);

    assert.equal((await request('/healthz')).status, 200);

    // Mutations keep their own auth and are not satisfied by the view key.
    assert.equal((await request('/api/v1/streams/s1', { method: 'PUT', headers: { 'x-view-key': 'viewer' } })).status, 401);
    assert.equal((await request('/api/v1/streams/s1', { method: 'PUT', headers: { 'x-stream-key': 'master' } })).status, 201);
  } finally {
    await stop(child);
  }
});

test('search finds next/prev matches over block-scanned file sources', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-search-'));
  const file = path.join(dir, 'search.log');
  const lines: string[] = [];
  for (let k = 0; k < 100; k++) {
    const needle = k === 10 || k === 90 ? ' needle' : '';
    lines.push(`2026-07-13 10:00:${String(k % 60).padStart(2, '0')},000 [T${k % 3}] INFO App - line ${k}${needle}`);
    if (k === 50) lines.push('   at needle.Stack(Frame.java:1)');
    else if (k % 10 === 0) lines.push('   continuation ' + k);
  }
  fs.writeFileSync(file, lines.join('\n') + '\n');

  try {
    const opened = await request('/api/logs/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
    });
    assert.equal(opened.status, 200);
    const { id } = (await opened.json()) as { id: string };
    const search = async (q: string, from: number, dir: string, extra = '') => {
      const res = await request(
        `/api/logs/${encodeURIComponent(id)}/search?q=${encodeURIComponent(q)}&from=${from}&dir=${dir}${extra}`
      );
      assert.equal(res.status, 200);
      return (await res.json()) as { vi: number | null; capped?: boolean };
    };

    // next: matches at entries 10, 50 (continuation line), 90.
    assert.equal((await search('needle', -1, 'next')).vi, 10);
    assert.equal((await search('needle', 10, 'next')).vi, 50);
    assert.equal((await search('needle', 50, 'next')).vi, 90);
    const exhausted = await search('needle', 90, 'next');
    assert.equal(exhausted.vi, null);
    assert.equal(exhausted.capped, false);
    // prev: nearest match before the cursor.
    assert.equal((await search('needle', 91, 'prev')).vi, 90);
    assert.equal((await search('needle', 90, 'prev')).vi, 50);
    assert.equal((await search('needle', 50, 'prev')).vi, 10);
    assert.equal((await search('needle', 10, 'prev')).vi, null);
    assert.equal((await search('needle', 0, 'prev')).vi, null);
    // Case sensitivity and regex flags are unchanged.
    assert.equal((await search('NEEDLE', -1, 'next')).vi, 10);
    assert.equal((await search('NEEDLE', -1, 'next', '&cs=1')).vi, null);
    assert.equal((await search('need.e', -1, 'next', '&regex=1')).vi, 10);
    const badRegex = await request(
      `/api/logs/${encodeURIComponent(id)}/search?q=${encodeURIComponent('[')}&from=-1&dir=next&regex=1`
    );
    assert.equal(badRegex.status, 400);
  } finally {
    await stop(child);
  }
});

test('correlate extracts ids and scans the whole source', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({});
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const correlate = async (id: string, qs: string) => {
    const res = await request(`/api/logs/${encodeURIComponent(id)}/correlate?${qs}`);
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  try {
    assert.equal((await request('/api/v1/streams/corr', json('PUT'))).status, 201);
    const appended = await request(
      '/api/v1/streams/corr/entries',
      json('POST', {
        lines: [
          '2026-07-13 10:00:00,000 [T1] INFO App - accepted requestId=abc123',
          '2026-07-13 10:00:01,000 [T1] INFO App - no id here',
          '2026-07-13 10:00:02,000 [T2] INFO App - working requestId: abc123',
          '2026-07-13 10:00:03,000 [T1] INFO App - done {"traceId":"xyz789"}',
          '2026-07-13 10:00:04,000 [T1] ERROR App - failed {"traceId":"xyz789"}',
        ],
      })
    );
    assert.equal(appended.status, 200);
    const id = 's:corr';

    // Default discovery: k=v form on the first entry.
    const kv = await correlate(id, 'i=0');
    assert.equal(kv.status, 200);
    assert.deepEqual(kv.body, { key: 'requestId', value: 'abc123', count: 2, indices: [0, 2] });

    // JSON "traceId":"xyz789" form; the error entry shares the trace id.
    const js = await correlate(id, 'i=3');
    assert.equal(js.status, 200);
    assert.deepEqual(js.body, { key: 'traceId', value: 'xyz789', count: 2, indices: [3, 4] });

    // Explicit key parameter; k: v form with a space after the colon.
    const keyed = await correlate(id, 'i=2&key=requestId');
    assert.equal(keyed.status, 200);
    assert.deepEqual(keyed.body, { key: 'requestId', value: 'abc123', count: 2, indices: [0, 2] });

    // Nothing extractable → 422, both by discovery and by explicit key.
    const none = await correlate(id, 'i=1');
    assert.equal(none.status, 422);
    assert.deepEqual(none.body, { error: 'no correlation id found' });
    assert.equal((await correlate(id, 'i=0&key=sessionId')).status, 422);

    // Bad index and unknown source.
    assert.equal((await correlate(id, 'i=99')).status, 400);
    assert.equal((await correlate('nope', 'i=0')).status, 404);

    // Correlation ignores filters: with a filter active on the source, the
    // indices still cover the whole source (entry 2 is outside the filter).
    const filter = await request(
      `/api/logs/${encodeURIComponent(id)}/filters`,
      json('POST', { criteria: { text: 'accepted' } })
    );
    assert.equal(filter.status, 200);
    const unfiltered = await correlate(id, 'i=0');
    assert.equal(unfiltered.status, 200);
    assert.deepEqual(unfiltered.body.indices, [0, 2]);
  } finally {
    await stop(child);
  }
});

test('custom parser re-indexes a file source and delete restores auto-detection', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-parser-'));
  const file = path.join(dir, 'custom.log');
  fs.writeFileSync(
    file,
    ['<INFO> [Main] App: first custom line', '<WARN> [T1] Db: second custom line', '   continuation text'].join('\n') + '\n'
  );
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  try {
    const opened = await request('/api/logs/open', json('POST', { path: file }));
    assert.equal(opened.status, 200);
    const info = (await opened.json()) as { id: string; format: string; pattern?: string };
    assert.equal(info.format, 'plain');
    assert.equal(info.pattern, undefined);

    const bad = await request(`/api/logs/${info.id}/parser`, json('POST', { pattern: '%d %' }));
    assert.equal(bad.status, 400);
    const missing = await request('/api/logs/nope/parser', json('POST', { pattern: '%m' }));
    assert.equal(missing.status, 404);

    const pattern = '<%p> [%t] %c: %m';
    const applied = await request(`/api/logs/${info.id}/parser`, json('POST', { pattern }));
    assert.equal(applied.status, 200);
    const custom = (await applied.json()) as { format: string; pattern?: string; count: number };
    assert.equal(custom.format, `custom (${pattern})`);
    assert.equal(custom.pattern, pattern);
    assert.equal(custom.count, 2);

    const listed = (await (await request('/api/logs')).json()) as { sources: Array<{ id: string; pattern?: string }> };
    assert.equal(listed.sources.find((s) => s.id === info.id)?.pattern, pattern);

    const page = (await (await request(`/api/logs/${info.id}/entries?start=0&count=10`)).json()) as {
      entries: Array<{ lv: number; th: string; lg: string; msg: string; raw: string }>;
    };
    assert.equal(page.entries.length, 2);
    assert.deepEqual(
      page.entries.map((e) => [e.lv, e.th, e.lg, e.msg]),
      [
        [2, 'Main', 'App', 'first custom line'],
        [3, 'T1', 'Db', 'second custom line'],
      ]
    );
    assert.ok(page.entries[1].raw.includes('continuation text'));

    const cleared = await request(`/api/logs/${info.id}/parser`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    const restored = (await cleared.json()) as { format: string; pattern?: string };
    assert.equal(restored.format, 'plain');
    assert.equal(restored.pattern, undefined);
    const reparsed = (await (await request(`/api/logs/${info.id}/entries?start=0&count=10`)).json()) as {
      entries: Array<{ lv: number; th: string }>;
    };
    assert.equal(reparsed.entries[0].lv, 2); // levelFromString default
    assert.equal(reparsed.entries[0].th, '');
  } finally {
    await stop(child);
  }
});

test('custom parser applies to stream sources and new appended lines', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({});
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  try {
    assert.equal((await request('/api/v1/streams/custom', json('PUT'))).status, 201);
    await request(
      '/api/v1/streams/custom/entries',
      json('POST', { lines: ['<INFO> [Main] App: hello', '<WARN> [T1] Db: slow'] })
    );
    const id = 's%3Acustom';

    const applied = await request(`/api/logs/${id}/parser`, json('POST', { pattern: '<%p> [%t] %c: %m' }));
    assert.equal(applied.status, 200);
    assert.equal(((await applied.json()) as { pattern?: string }).pattern, '<%p> [%t] %c: %m');

    // The pattern also governs lines appended after it was set.
    await request('/api/v1/streams/custom/entries', json('POST', { lines: ['<ERROR> [T2] Db: failed'] }));

    const page = (await (await request(`/api/logs/${id}/entries?start=0&count=10`)).json()) as {
      entries: Array<{ lv: number; th: string; lg: string; msg: string }>;
    };
    assert.deepEqual(
      page.entries.map((e) => [e.lv, e.th, e.lg, e.msg]),
      [
        [2, 'Main', 'App', 'hello'],
        [3, 'T1', 'Db', 'slow'],
        [4, 'T2', 'Db', 'failed'],
      ]
    );

    const cleared = await request(`/api/logs/${id}/parser`, { method: 'DELETE' });
    assert.equal(cleared.status, 200);
    const restored = (await cleared.json()) as { format: string; pattern?: string };
    assert.equal(restored.format, 'plain');
    assert.equal(restored.pattern, undefined);
  } finally {
    await stop(child);
  }
});

test('gzipped files open transparently: indexed, filterable, no tail, cleaned up', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-gzip-'));
  const file = path.join(dir, 'server.log.1.gz');
  const lines = [
    '2026-07-13 10:00:00,000 [Main] INFO App - starting',
    '2026-07-13 10:00:01,000 [T1] WARN Db - slow query',
    '2026-07-13 10:00:02,000 [Main] ERROR Db - deadlock',
  ];
  fs.writeFileSync(file, gzipSync(lines.join('\n') + '\n'));
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  try {
    // browse and stat work on the .gz path as-is.
    const stat = await request(`/api/stat?path=${encodeURIComponent(file)}`);
    assert.equal(stat.status, 200);
    assert.equal(((await stat.json()) as { isFile: boolean }).isFile, true);
    const browse = await request(`/api/browse?path=${encodeURIComponent(dir)}`);
    assert.equal(browse.status, 200);
    assert.ok(((await browse.json()) as { files: Array<{ name: string }> }).files.some((f) => f.name === 'server.log.1.gz'));

    // Byte ranges don't apply to compressed content.
    const ranged = await request('/api/logs/open', json('POST', { path: file, start: 10 }));
    assert.equal(ranged.status, 400);
    assert.match(((await ranged.json()) as { error: string }).error, /gzipped/);

    const opened = await request('/api/logs/open', json('POST', { path: file }));
    assert.equal(opened.status, 200);
    const info = (await opened.json()) as { id: string; name: string; path: string; gzipped?: boolean; count: number; format: string };
    assert.equal(info.gzipped, true);
    assert.equal(info.name, 'server.log.1.gz');
    assert.notEqual(info.path, file);
    assert.equal(info.count, 3);
    assert.notEqual(info.format, 'plain');

    // Re-opening the same .gz returns the existing source.
    const again = await request('/api/logs/open', json('POST', { path: file }));
    assert.equal(((await again.json()) as { id: string }).id, info.id);

    const page = await request(`/api/logs/${info.id}/entries?start=0&count=10`);
    assert.equal(page.status, 200);
    const entries = ((await page.json()) as { entries: Array<{ lv: number; th: string; lg: string; msg: string }> }).entries;
    assert.deepEqual(
      entries.map((e) => [e.lv, e.th, e.lg, e.msg]),
      [
        [2, 'Main', 'App', 'starting'],
        [3, 'T1', 'Db', 'slow query'],
        [4, 'Main', 'Db', 'deadlock'],
      ]
    );

    const filtered = await request(`/api/logs/${info.id}/filters`, json('POST', { criteria: { levels: [4] } }));
    assert.equal(filtered.status, 200);
    assert.deepEqual(await filtered.json(), { filterId: 'F1', count: 1, stats: [0, 0, 0, 0, 1, 0] });

    // Deleting the source removes the decompressed temp copy.
    const removed = await request(`/api/logs/${info.id}`, { method: 'DELETE' });
    assert.equal(removed.status, 200);
    assert.ok(!fs.existsSync(info.path), 'temp copy is deleted with the source');
    assert.ok(fs.existsSync(file), 'the original .gz file is untouched');

    // Shutdown cleans up temp copies of still-open gzipped sources.
    const reopened = await request('/api/logs/open', json('POST', { path: file }));
    const reopenedInfo = (await reopened.json()) as { path: string };
    await stop(child);
    assert.ok(!fs.existsSync(reopenedInfo.path), 'temp copy is deleted on server shutdown');
  } finally {
    await stop(child);
  }
});

test('gzipped open enforces the decompressed size cap', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir(), GZIP_MAX_BYTES: '64' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-gzip-cap-'));
  const file = path.join(dir, 'big.log.gz');
  fs.writeFileSync(file, gzipSync('x'.repeat(256) + '\n'));

  try {
    const opened = await request('/api/logs/open', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file }),
    });
    assert.equal(opened.status, 413);
    assert.match(((await opened.json()) as { error: string }).error, /gzip limit/);
    assert.equal((await (await request('/healthz')).json() as { sources: number }).sources, 0);
  } finally {
    await stop(child);
  }
});

test('entries report elapsed ms against the previous visible entry', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-elapsed-'));
  const fileA = path.join(dir, 'a.log');
  const fileB = path.join(dir, 'b.log');
  fs.writeFileSync(
    fileA,
    [
      '2026-07-13 10:00:00,000 [Main] INFO App - a0',
      '2026-07-13 10:00:01,000 [T1] WARN App - a1',
      '2026-07-13 10:00:03,000 [Main] INFO App - a2',
      '2026-07-13 10:00:05,500 [T1] ERROR App - a3',
    ].join('\n') + '\n'
  );
  fs.writeFileSync(
    fileB,
    ['2026-07-13 10:00:02,000 [Main] ERROR B - b0', '2026-07-13 10:00:04,000 [Main] WARN B - b1'].join('\n') + '\n'
  );
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const elapsedOf = async (id: string, qs: string) => {
    const res = await request(`/api/logs/${encodeURIComponent(id)}/entries?${qs}`);
    assert.equal(res.status, 200);
    return ((await res.json()) as { entries: Array<{ msg: string; elapsed: number | null }> }).entries.map((e) => [
      e.msg,
      e.elapsed,
    ]);
  };

  try {
    const idA = ((await (await request('/api/logs/open', json('POST', { path: fileA }))).json()) as { id: string }).id;
    const idB = ((await (await request('/api/logs/open', json('POST', { path: fileB }))).json()) as { id: string }).id;

    // Unfiltered: first entry null, deltas against the previous physical entry.
    assert.deepEqual(await elapsedOf(idA, 'start=0&count=10'), [
      ['a0', null],
      ['a1', 1000],
      ['a2', 2000],
      ['a3', 2500],
    ]);
    // A mid-view window still compares its first row against the view entry
    // just above it (a1), so it is not null.
    assert.deepEqual(await elapsedOf(idA, 'start=2&count=2'), [
      ['a2', 2000],
      ['a3', 2500],
    ]);

    // Filtered to WARN+ERROR: a3's previous VISIBLE entry is a1 (4500 ms),
    // not the previous physical entry a2 (2500 ms); first visible is null.
    const filter = await request(`/api/logs/${idA}/filters`, json('POST', { criteria: { levels: [3, 4] } }));
    const { filterId } = (await filter.json()) as { filterId: string };
    assert.deepEqual(await elapsedOf(idA, `start=0&count=10&filter=${filterId}`), [
      ['a1', null],
      ['a3', 4500],
    ]);

    // Merged view: elapsed follows the time-ordered merge across children.
    const merged = await request('/api/logs/merge', json('POST', { ids: [idA, idB] }));
    const idM = ((await merged.json()) as { id: string }).id;
    assert.deepEqual(await elapsedOf(idM, 'start=0&count=10'), [
      ['a0', null],
      ['a1', 1000],
      ['b0', 1000],
      ['a2', 1000],
      ['b1', 1000],
      ['a3', 1500],
    ]);
    const mergedFilter = await request(`/api/logs/${idM}/filters`, json('POST', { criteria: { levels: [4] } }));
    const { filterId: fidM } = (await mergedFilter.json()) as { filterId: string };
    assert.deepEqual(await elapsedOf(idM, `start=0&count=10&filter=${fidM}`), [
      ['b0', null],
      ['a3', 3500],
    ]);
  } finally {
    await stop(child);
  }
});

interface RuleBody {
  id: string;
  name?: string;
  criteria: Record<string, unknown>;
  actions: { highlight?: string; bookmark?: boolean; webhook?: string };
  matchCount: number;
  webhookErrors: number;
}

test('rules: creation scan, append-time webhook/bookmark, source info, caps, validation', { timeout: 20_000 }, async () => {
  const { child, request } = await startServer({});
  // Test webhook receiver.
  const received: Array<{
    ruleId: string;
    ruleName?: string;
    source: string;
    sourceName: string;
    matched: number;
    sample: Array<{ i: number; t: number; lv: number; th: string; lg: string; msg: string }>;
  }> = [];
  const hook = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      received.push(JSON.parse(body));
      res.end('ok');
    });
  });
  hook.listen(0, '127.0.0.1');
  await once(hook, 'listening');
  const hookUrl = `http://127.0.0.1:${(hook.address() as AddressInfo).port}/hook`;
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const matchedTotal = () => received.reduce((sum, p) => sum + p.matched, 0);

  try {
    assert.equal((await request('/api/v1/streams/rl', json('PUT'))).status, 201);
    await request(
      '/api/v1/streams/rl/entries',
      json('POST', {
        entries: [
          { level: 'ERROR', message: 'pre boom' },
          { level: 'INFO', message: 'pre ok' },
        ],
      })
    );
    const id = 's%3Arl';

    // Validation: webhook must be an http(s) URL, highlight a hex color.
    const badScheme = await request(
      `/api/logs/${id}/rules`,
      json('POST', { criteria: { levels: [4] }, actions: { webhook: 'ftp://example/hook' } })
    );
    assert.equal(badScheme.status, 400);
    const badUrl = await request(
      `/api/logs/${id}/rules`,
      json('POST', { criteria: { levels: [4] }, actions: { webhook: 'not a url' } })
    );
    assert.equal(badUrl.status, 400);
    const badColor = await request(
      `/api/logs/${id}/rules`,
      json('POST', { criteria: { levels: [4] }, actions: { highlight: 'red' } })
    );
    assert.equal(badColor.status, 400);

    // Create the rule: existing entries are scanned (matchCount, bookmark) but
    // no webhook fires for them.
    const created = await request(
      `/api/logs/${id}/rules`,
      json('POST', {
        name: 'errors',
        criteria: { levels: [4] },
        actions: { highlight: '#ffe0e0', bookmark: true, webhook: hookUrl },
      })
    );
    assert.equal(created.status, 200);
    const rule = (await created.json()) as RuleBody;
    assert.equal(rule.name, 'errors');
    assert.equal(rule.matchCount, 1, 'creation scans existing entries');
    await sleep(150);
    assert.equal(received.length, 0, 'no retroactive webhook on create');
    const bmAtCreate = (await (await request(`/api/logs/${id}/bookmarks`)).json()) as { indices: number[] };
    assert.deepEqual(bmAtCreate.indices, [0], 'creation-time bookmark applied');

    // Append matching + non-matching entries: exactly the post-creation
    // matches are delivered.
    await request(
      '/api/v1/streams/rl/entries',
      json('POST', {
        entries: [
          { level: 'ERROR', message: 'post boom 1' },
          { level: 'INFO', message: 'post ok' },
          { level: 'ERROR', message: 'post boom 2' },
        ],
      })
    );
    for (let attempt = 0; attempt < 100 && matchedTotal() < 2; attempt++) await sleep(25);
    assert.equal(matchedTotal(), 2, 'webhook received exactly the post-creation matches');
    const payload = received[0];
    assert.equal(payload.ruleId, rule.id);
    assert.equal(payload.ruleName, 'errors');
    assert.equal(payload.source, 's:rl');
    assert.equal(payload.sourceName, 'rl');
    assert.deepEqual(
      payload.sample.map((e) => [e.i, e.lv, e.msg]),
      [
        [2, 4, 'post boom 1'],
        [4, 4, 'post boom 2'],
      ]
    );

    const bmAfterAppend = (await (await request(`/api/logs/${id}/bookmarks`)).json()) as { indices: number[] };
    assert.deepEqual(bmAfterAppend.indices, [0, 2, 4], 'rule bookmarked the appended matches');

    // Rules are listed with live counts and embedded in the source info.
    const listed = (await (await request(`/api/logs/${id}/rules`)).json()) as { rules: RuleBody[] };
    assert.equal(listed.rules.length, 1);
    assert.equal(listed.rules[0].matchCount, 3);
    assert.equal(listed.rules[0].webhookErrors, 0);
    const logs = (await (await request('/api/logs')).json()) as {
      sources: Array<{ id: string; rules?: RuleBody[] }>;
    };
    const infoRule = logs.sources.find((s) => s.id === 's:rl')?.rules?.[0];
    assert.equal(infoRule?.id, rule.id);
    assert.equal(infoRule?.matchCount, 3);
    assert.equal(infoRule?.actions.highlight, '#ffe0e0');

    // DELETE stops further webhooks; the bookmarks it created stay.
    assert.equal((await request(`/api/logs/${id}/rules/${rule.id}`, { method: 'DELETE' })).status, 200);
    await request('/api/v1/streams/rl/entries', json('POST', { entries: [{ level: 'ERROR', message: 'post boom 3' }] }));
    await sleep(150);
    assert.equal(matchedTotal(), 2, 'no webhook after the rule is deleted');
    const bmAfterDelete = (await (await request(`/api/logs/${id}/bookmarks`)).json()) as { indices: number[] };
    assert.deepEqual(bmAfterDelete.indices, [0, 2, 4], 'bookmarks survive rule deletion');

    // Cap: 20 rules per source, the 21st is rejected.
    for (let k = 0; k < 20; k++) {
      const res = await request(`/api/logs/${id}/rules`, json('POST', { criteria: {}, actions: {} }));
      assert.equal(res.status, 200, `rule ${k + 1} within the cap`);
    }
    const over = await request(`/api/logs/${id}/rules`, json('POST', { criteria: {}, actions: {} }));
    assert.equal(over.status, 400);
    assert.equal(((await over.json()) as { code: string }).code, 'rule_limit_reached');
  } finally {
    hook.close();
    await stop(child);
  }
});

test('report returns per-level series, normalized top messages and CSV', { timeout: 15_000 }, async () => {
  const { child, request } = await startServer({ LOG_ROOT: os.tmpdir() });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-report-'));
  const file = path.join(dir, 'report.log');
  fs.writeFileSync(
    file,
    [
      '2026-07-13 10:00:00,000 [Main] INFO App - User 1234 logged in',
      '2026-07-13 10:00:01,000 [Main] INFO App - User 9876 logged in',
      '2026-07-13 10:00:02,000 [Main] WARN App - Retry "conn reset" for session 3f2a91c0',
      '2026-07-13 10:00:03,000 [Main] ERROR App - Request 550e8400-e29b-41d4-a716-446655440000 failed',
    ].join('\n') + '\n'
  );
  const json = (method: string, body?: unknown): RequestInit => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  try {
    const id = ((await (await request('/api/logs/open', json('POST', { path: file }))).json()) as { id: string }).id;
    const res = await request(`/api/logs/${encodeURIComponent(id)}/report?buckets=20`);
    assert.equal(res.status, 200);
    const r = (await res.json()) as {
      total: number;
      buckets: Array<{ t: number; counts: number[] }>;
      series: number[][];
      topMessages: Array<{ template: string; count: number; example: string }>;
    };
    assert.equal(r.total, 4);
    // series is the per-level transpose of the bucket counts.
    assert.equal(r.series.length, 6);
    for (let lv = 0; lv < 6; lv++) {
      assert.equal(r.series[lv].length, r.buckets.length);
      for (let b = 0; b < r.buckets.length; b++) assert.equal(r.series[lv][b], r.buckets[b].counts[lv]);
    }
    // Messages differing only in digits collapse into one template.
    const login = r.topMessages.find((m) => m.template === 'User ? logged in');
    assert.ok(login, `expected collapsed login template, got ${JSON.stringify(r.topMessages)}`);
    assert.equal(login.count, 2);
    assert.equal(login.example, 'User 1234 logged in');
    // Uuids and quoted strings are masked too.
    assert.ok(r.topMessages.some((m) => m.template === 'Request ? failed'));
    assert.ok(r.topMessages.some((m) => m.template === 'Retry ? for session ?'));

    // Same report as CSV: header + one row per bucket, ISO bucket start first.
    const csvRes = await request(`/api/logs/${encodeURIComponent(id)}/report?buckets=20&format=csv`);
    assert.equal(csvRes.status, 200);
    assert.match(csvRes.headers.get('content-type') || '', /^text\/csv/);
    const csvLines = (await csvRes.text()).trimEnd().split('\n');
    assert.equal(csvLines[0], 'bucket_start,trace,debug,info,warn,error,fatal');
    assert.equal(csvLines.length, r.buckets.length + 1);
    let csvTotal = 0;
    for (const line of csvLines.slice(1)) {
      const fields = line.split(',');
      assert.equal(fields.length, 7);
      assert.ok(!Number.isNaN(Date.parse(fields[0])), `ISO bucket start: ${fields[0]}`);
      for (const f of fields.slice(1)) assert.match(f, /^\d+$/);
      csvTotal += fields.slice(1).reduce((a, f) => a + Number(f), 0);
    }
    assert.equal(csvTotal, r.total);
  } finally {
    await stop(child);
  }
});
