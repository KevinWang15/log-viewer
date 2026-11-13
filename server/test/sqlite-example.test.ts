// Runs the examples/sqlite-provider provider through the conformance checks
// and a viewer. Skipped where node:sqlite is unavailable (Node < 22.13).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { checkProvider } from '../src/provider/conformance';
import { createLogViewer } from '../src/viewer';
import type { LogProvider } from '../src/provider/spi';

type Sqlite = { DatabaseSync: new (file: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void }; close(): void } };

async function load(): Promise<{ sqlite: Sqlite; createSqliteProvider: (file: string) => LogProvider } | null> {
  try {
    const sqlite = (await import('node:sqlite' as string)) as Sqlite;
    const mod = (await import(path.resolve(__dirname, '../../examples/sqlite-provider/provider.mjs'))) as {
      createSqliteProvider: (file: string) => LogProvider;
    };
    return { sqlite, createSqliteProvider: mod.createSqliteProvider };
  } catch {
    return null;
  }
}

const quiet = { log() {}, warn() {}, error() {} };

test('sqlite example provider: conformance and live viewing', async (t) => {
  const mods = await load();
  if (!mods) {
    t.skip('node:sqlite not available');
    return;
  }
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-sqlite-')), 'logs.db');
  const provider = mods.createSqliteProvider(file);
  const db = new mods.sqlite.DatabaseSync(file);
  const insert = db.prepare('INSERT INTO logs (service, ts, level, thread, logger, message) VALUES (?, ?, ?, ?, ?, ?)');
  let n = 0;
  const add = (count: number, service = 'api', level = 'INFO') => {
    for (let k = 0; k < count; k++, n++) insert.run(service, Date.UTC(2026, 6, 13, 10, 0, n), level, 'main', 'app', `row ${n}`);
  };
  add(6);
  add(2, 'worker');

  const report = await checkProvider(provider, { logId: 'api', insert: async (count) => add(count) });
  assert.ok(report.ok, report.failures.join('; '));

  const viewer = createLogViewer({ providers: [provider], providerOptions: { pollIntervalMs: 30 }, logger: quiet, ui: false });
  const { url } = await viewer.listen(0, '127.0.0.1');
  try {
    const cat = await (await fetch(url + '/api/v1/providers/sqlite/logs')).json();
    assert.deepEqual(cat.logs.map((l: { id: string }) => l.id), ['api', 'worker']);
    const info = await (await fetch(url + '/api/v1/providers/sqlite/logs/api/open', { method: 'POST' })).json();
    assert.equal(info.count, 8); // 6 seeded + 2 inserted by the conformance checks
    assert.equal(info.state, 'polling');
    const page = await (await fetch(url + `/api/logs/${encodeURIComponent(info.id)}/entries?start=0&count=3`)).json();
    assert.equal(page.entries[0].msg, 'row 0');

    const ws = new WebSocket(url.replace('http', 'ws') + '/ws');
    await once(ws, 'open');
    const frames: Array<Record<string, unknown>> = [];
    ws.on('message', (d) => frames.push(JSON.parse(String(d))));
    ws.send(JSON.stringify({ type: 'sub', id: info.id }));
    add(1, 'api', 'ERROR');
    const deadline = Date.now() + 3000;
    while (!frames.some((f) => f.type === 'append')) {
      if (Date.now() > deadline) throw new Error('no append frame: ' + JSON.stringify(frames));
      await new Promise((r) => setTimeout(r, 20));
    }
    const append = frames.find((f) => f.type === 'append')!;
    assert.equal(append.count, 9);
    assert.equal((append.stats as number[])[4], 1);
    ws.close();
  } finally {
    await viewer.close();
    db.close();
  }
});
