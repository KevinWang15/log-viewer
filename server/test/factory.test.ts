import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { createLogViewer } from '../src/viewer';
import type { Authorizer } from '../src/auth';

const quiet = { log() {}, warn() {}, error() {} };

function tmpDir(prefix: string) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function listenHost(app: http.RequestListener) {
  const server = http.createServer(app);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  return { server, base: `http://127.0.0.1:${port}`, wsBase: `ws://127.0.0.1:${port}` };
}

function wsFrames(url: string) {
  const ws = new WebSocket(url);
  const frames: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  ws.on('message', (d) => {
    frames.push(JSON.parse(String(d)));
    waiters.splice(0).forEach((w) => w());
  });
  const next = async (pred: (f: Record<string, unknown>) => boolean, ms = 3000) => {
    const deadline = Date.now() + ms;
    for (;;) {
      const hit = frames.find(pred);
      if (hit) return hit;
      if (Date.now() > deadline) throw new Error('timed out waiting for frame; got ' + JSON.stringify(frames));
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { ws, frames, next, opened: once(ws, 'open') };
}

test('route inventory matches the pre-refactor server', () => {
  const root = tmpDir('lvw-routes-');
  const viewer = createLogViewer({ files: { root }, remote: {}, logger: quiet, ui: false });
  const stack = (viewer.handler as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })
    ._router.stack;
  const routes = new Set<string>();
  for (const layer of stack) {
    if (!layer.route) continue;
    for (const m of Object.keys(layer.route.methods)) routes.add(`${m.toUpperCase()} ${layer.route.path}`);
  }
  const expected: string[] = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'routes.json'), 'utf8'));
  for (const r of expected) assert.ok(routes.has(r), `missing route ${r}`);
});

test('mounts under a prefix with WS on a custom path next to a host WS server', async () => {
  const ui = tmpDir('lvw-ui-');
  fs.writeFileSync(path.join(ui, 'index.html'), '<!doctype html><title>lv</title>');
  const viewer = createLogViewer({ ui: { dir: ui }, logger: quiet });
  const app = express();
  app.get('/', (_req, res) => res.send('host home'));
  app.use('/logs', viewer.handler);
  const { server, base, wsBase } = await listenHost(app);
  viewer.attach(server, { path: '/logs/ws' });
  // The host's own WebSocket server on another path keeps working.
  const hostWss = new WebSocketServer({ noServer: true });
  server.on('upgrade', (req, socket, head) => {
    if (req.url === '/host-ws') hostWss.handleUpgrade(req, socket, head, (ws) => ws.send('hello from host'));
  });
  await viewer.start();
  try {
    const redirect = await fetch(base + '/logs', { redirect: 'manual' });
    assert.equal(redirect.status, 301);
    assert.equal(redirect.headers.get('location'), '/logs/');
    assert.match(await (await fetch(base + '/logs/')).text(), /<title>lv<\/title>/);
    assert.equal(await (await fetch(base + '/')).text(), 'host home');
    const caps = await (await fetch(base + '/logs/api/v1/capabilities')).json();
    assert.equal(caps.apiVersion, 'v1');
    assert.deepEqual(Object.keys(caps.modules).sort(), ['merge', 'providers', 'streams']);

    viewer.streams!.append('app', ['2026-07-13 10:00:00,000 [Main] INFO App - one']);
    const sub = wsFrames(wsBase + '/logs/ws');
    await sub.opened;
    sub.ws.send(JSON.stringify({ type: 'sub', id: 's:app' }));
    const snap = await sub.next((f) => f.type === 'reset');
    assert.equal(snap.count, 1);
    viewer.streams!.append('app', [{ level: 'WARN', message: 'two' }]);
    const appended = await sub.next((f) => f.type === 'append');
    assert.equal(appended.count, 2);
    sub.ws.close();

    const host = new WebSocket(wsBase + '/host-ws');
    const [msg] = await once(host, 'message');
    assert.equal(String(msg), 'hello from host');
    host.close();
  } finally {
    hostWss.close();
    await viewer.close();
    server.closeAllConnections();
    server.close();
  }
});

test('library defaults: no files, no remote, no CORS', async () => {
  const viewer = createLogViewer({ logger: quiet, ui: false });
  const { url: base } = await viewer.listen(0, '127.0.0.1');
  try {
    assert.equal((await fetch(base + '/api/browse')).status, 404);
    const remote = await fetch(base + '/api/logs/remote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.equal(remote.status, 404);
    const res = await fetch(base + '/api/logs', { headers: { origin: 'http://elsewhere.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  } finally {
    await viewer.close();
  }
});

test('custom authorizer scopes reads per source over HTTP and WS', async () => {
  // Readers with x-tenant: a may only see streams whose channel starts with "a-".
  const authorize: Authorizer = (ctx) => {
    if (ctx.action !== 'read') return true;
    const tenant = ctx.headers['x-tenant'];
    if (!tenant) return { status: 403, error: 'tenant required' };
    if (!ctx.source) return true;
    return ctx.source.name.startsWith(`${tenant}-`) || { status: 403, error: 'not your log', code: 'tenant_mismatch' };
  };
  const viewer = createLogViewer({ authorize, logger: quiet, ui: false });
  const { url } = await viewer.listen(0, '127.0.0.1');
  const base = url;
  try {
    viewer.streams!.append('a-web', ['hello a']);
    viewer.streams!.append('b-web', ['hello b']);
    const as = (tenant?: string) => ({ headers: tenant ? { 'x-tenant': tenant } : {} });
    assert.equal((await fetch(base + '/api/logs', as())).status, 403);
    const list = await (await fetch(base + '/api/logs', as('a'))).json();
    assert.deepEqual(list.sources.map((s: { name: string }) => s.name), ['a-web']);
    assert.equal((await fetch(base + '/api/logs/s:a-web/entries', as('a'))).status, 200);
    const denied = await fetch(base + '/api/logs/s:b-web/entries', as('a'));
    assert.equal(denied.status, 403);
    assert.deepEqual(await denied.json(), { error: 'not your log', code: 'tenant_mismatch' });
    const caps = await (await fetch(base + '/api/v1/capabilities', as('a'))).json();
    assert.equal(caps.mutationAuth, 'custom');

    const sub = wsFrames(url.replace('http', 'ws') + '/ws');
    await sub.opened;
    sub.ws.send(JSON.stringify({ type: 'sub', id: 's:b-web' }));
    const err = await sub.next((f) => f.type === 'error');
    assert.equal(err.code, 'view_auth_required');
    sub.ws.close();
  } finally {
    await viewer.close();
  }
});

test('two viewers in one process are independent', async () => {
  const rootA = tmpDir('lvw-a-');
  const rootB = tmpDir('lvw-b-');
  fs.writeFileSync(path.join(rootA, 'x.log'), '2026-07-13 10:00:00,000 [Main] INFO App - a\n');
  fs.writeFileSync(path.join(rootB, 'y.log'), '2026-07-13 10:00:00,000 [Main] INFO App - b\n');
  const a = createLogViewer({ files: { root: rootA }, logger: quiet, ui: false });
  const b = createLogViewer({ files: { root: rootB }, logger: quiet, ui: false });
  const [la, lb] = await Promise.all([a.listen(0, '127.0.0.1'), b.listen(0, '127.0.0.1')]);
  try {
    const open = (base: string, p: string) =>
      fetch(base + '/api/logs/open', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: p }),
      }).then((r) => r.json());
    const sa = await open(la.url, path.join(rootA, 'x.log'));
    const sb = await open(lb.url, path.join(rootB, 'y.log'));
    assert.equal(sa.id, 'f1');
    assert.equal(sb.id, 'f1', 'id counters are per instance');
    assert.equal((await open(la.url, path.join(rootB, 'y.log'))).error?.startsWith('path outside allowed root'), true);
    assert.equal(a.store.sources.size, 1);
    assert.equal(b.store.sources.size, 1);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
});
