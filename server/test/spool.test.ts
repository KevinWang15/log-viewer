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

async function startServer(extraEnv: Record<string, string>, port?: number) {
  const usePort = port ?? (await availablePort());
  const child = spawn(process.execPath, ['--import', 'tsx', path.resolve(__dirname, '../src/index.ts')], {
    cwd: path.resolve(__dirname, '..'),
    env: {
      ...process.env,
      PORT: String(usePort),
      NODE_ENV: 'production',
      ENABLE_DEMO: 'false',
      ENABLE_SAMPLES: 'false',
      STREAM_IDLE_TTL_SECONDS: '0',
      STREAM_KEY: '',
      STREAM_TOKENS: '',
      VIEW_KEY: '',
      SPOOL_DIR: '',
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout?.on('data', (chunk) => (output += String(chunk)));
  child.stderr?.on('data', (chunk) => (output += String(chunk)));
  const base = `http://127.0.0.1:${usePort}`;
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
  return { child, request, port: usePort, output: () => output };
}

const json = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: body === undefined ? undefined : JSON.stringify(body),
});

interface EntryOutDto {
  t: number;
  lv: number;
  th: string;
  lg: string;
  msg: string;
  raw: string;
}

async function fetchEntries(request: (p: string, i?: RequestInit) => Promise<Response>, channel: string) {
  const res = await request(`/api/v1/streams/${channel}`);
  assert.equal(res.status, 200);
  const info = (await res.json()) as { id: string; count: number; bytes: number };
  const page = await request(`/api/logs/${encodeURIComponent(info.id)}/entries?start=0&count=1000`);
  assert.equal(page.status, 200);
  const body = (await page.json()) as { entries: EntryOutDto[] };
  return { info, entries: body.entries };
}

// Fields that must survive a spool round trip unchanged.
const comparable = (entries: EntryOutDto[]) => entries.map((e) => ({ t: e.t, lv: e.lv, th: e.th, lg: e.lg, msg: e.msg }));

async function waitFor(cond: () => boolean, ms = 3_000): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (cond()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return cond();
}

test('spool: entries survive a restart with parsed fields intact', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-spool-'));
  const port = await availablePort();
  const first = await startServer({ SPOOL_DIR: dir }, port);
  let before: ReturnType<typeof comparable>;
  try {
    const created = await first.request('/api/v1/streams/persist', json('PUT'));
    assert.equal(created.status, 201);
    let res = await first.request(
      '/api/v1/streams/persist/entries',
      json('POST', {
        entries: [
          { time: '2026-07-13 10:00:00,000', level: 'ERROR', thread: 'T1', logger: 'Db', message: 'gamma failed' },
          { time: 1752477601000, level: 'INFO', logger: 'Db', message: 'beta retry' },
        ],
      })
    );
    assert.equal(res.status, 200);
    res = await first.request(
      '/api/v1/streams/persist/entries',
      json('POST', { lines: ['2026-07-13 10:00:02,000 [T2] WARN App - alpha slow'] })
    );
    assert.equal(res.status, 200);
    before = comparable((await fetchEntries(first.request, 'persist')).entries);
    assert.equal(before.length, 3);
  } finally {
    await stop(first.child);
  }
  assert.ok(fs.existsSync(path.join(dir, 'persist.spool')), 'spool file remains after shutdown');

  const second = await startServer({ SPOOL_DIR: dir }, port);
  try {
    const { info, entries } = await fetchEntries(second.request, 'persist');
    assert.equal(info.count, 3);
    assert.deepEqual(comparable(entries), before);
    // Recovered streams are still tailable.
    const res = await second.request(
      '/api/v1/streams/persist/entries',
      json('POST', { entries: [{ level: 'INFO', message: 'after restart' }] })
    );
    assert.equal(res.status, 200);
    assert.equal((await fetchEntries(second.request, 'persist')).info.count, 4);
  } finally {
    await stop(second.child);
  }
});

test('spool: compaction bounds the file while retention caps memory', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-spool-'));
  const maxBytes = 8192;
  const srv = await startServer({ SPOOL_DIR: dir, STREAM_MAX_BYTES: String(maxBytes) });
  const file = path.join(dir, 'bulk.spool');
  try {
    const created = await srv.request('/api/v1/streams/bulk', json('PUT'));
    assert.equal(created.status, 201);
    const filler = 'x'.repeat(80);
    // ~3x the byte cap worth of entries (224 estimated bytes per entry).
    for (let batch = 0; batch < 6; batch++) {
      const entries = Array.from({ length: 20 }, (_, k) => ({ message: `bulk ${batch * 20 + k} ${filler}` }));
      const res = await srv.request('/api/v1/streams/bulk/entries', json('POST', { entries }));
      assert.equal(res.status, 200);
    }
    const { info } = await fetchEntries(srv.request, 'bulk');
    assert.ok(info.count < 120, `retention should evict in memory, got ${info.count} entries`);
    assert.ok(info.bytes <= maxBytes, `retained bytes ${info.bytes} exceed cap ${maxBytes}`);
    assert.ok(await waitFor(() => fs.existsSync(file)), 'spool file was not created');
  } finally {
    await stop(srv.child); // shutdown flushes pending spool writes
  }
  const size = fs.statSync(file).size;
  assert.ok(
    size < maxBytes * 2.5,
    `spool file should stay bounded near 2x cap, got ${size} bytes (cap ${maxBytes})`
  );
});

test('spool: deleting a stream removes its spool file', { timeout: 15_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-spool-'));
  const srv = await startServer({ SPOOL_DIR: dir });
  const file = path.join(dir, 'gone.spool');
  try {
    const res = await srv.request('/api/v1/streams/gone/entries', json('POST', { entries: [{ message: 'hello' }] }));
    assert.equal(res.status, 404); // must exist first
    await srv.request('/api/v1/streams/gone', json('PUT'));
    await srv.request('/api/v1/streams/gone/entries', json('POST', { entries: [{ message: 'hello' }] }));
    assert.ok(await waitFor(() => fs.existsSync(file) && fs.statSync(file).size > 0), 'spool file was not written');
    const del = await srv.request('/api/v1/streams/gone', json('DELETE'));
    assert.equal(del.status, 200);
    assert.ok(!fs.existsSync(file), 'spool file should be removed with the stream');
  } finally {
    await stop(srv.child);
  }
});

test('spool: malformed lines are skipped on recovery', { timeout: 20_000 }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-spool-'));
  const port = await availablePort();
  const first = await startServer({ SPOOL_DIR: dir }, port);
  try {
    await first.request('/api/v1/streams/mixed', json('PUT'));
    const res = await first.request(
      '/api/v1/streams/mixed/entries',
      json('POST', { entries: [{ level: 'WARN', message: 'one' }, { level: 'INFO', message: 'two' }] })
    );
    assert.equal(res.status, 200);
  } finally {
    await stop(first.child);
  }
  fs.appendFileSync(path.join(dir, 'mixed.spool'), 'this is not json\n{"lv":2\n[1,2,3]\n');

  const second = await startServer({ SPOOL_DIR: dir }, port);
  try {
    const { info, entries } = await fetchEntries(second.request, 'mixed');
    assert.equal(info.count, 2);
    assert.deepEqual(
      entries.map((e) => e.msg),
      ['one', 'two']
    );
    assert.match(second.output(), /skipped 3 malformed line/);
  } finally {
    await stop(second.child);
  }
});

test('spool: off by default; SPOOL_DIR is created recursively when set', { timeout: 20_000 }, async () => {
  const off = await startServer({});
  const serverPkg = path.resolve(__dirname, '..');
  try {
    const res = await off.request('/api/v1/streams/nospoon/entries', json('POST', { entries: [{ message: 'hi' }] }));
    assert.equal(res.status, 404);
    await off.request('/api/v1/streams/nospoon', json('PUT'));
    await off.request('/api/v1/streams/nospoon/entries', json('POST', { entries: [{ message: 'hi' }] }));
    assert.ok(
      fs.readdirSync(serverPkg).every((f) => !f.endsWith('.spool')),
      'no spool files should appear when SPOOL_DIR is unset'
    );
  } finally {
    await stop(off.child);
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-spool-'));
  const nested = path.join(dir, 'deep', 'spools');
  const on = await startServer({ SPOOL_DIR: nested });
  try {
    assert.ok(fs.existsSync(nested), 'SPOOL_DIR should be created recursively on boot');
  } finally {
    await stop(on.child);
  }
});
