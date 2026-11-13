import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsBroadcaster, WS_HIGH_WATER_BYTES, WS_LOW_WATER_BYTES, WsSendTarget } from '../src/broadcast';

class FakeSocket implements WsSendTarget {
  bufferedAmount = 0;
  sent: string[] = [];
  send(data: string) {
    this.sent.push(data);
  }
}

const frame = (n: number) => JSON.stringify({ type: 'append', id: 's:a', count: n });

function makeBroadcaster(snapshots: Record<string, Record<string, unknown> | null> = {}) {
  const snapshotCalls: string[] = [];
  const broadcaster = new WsBroadcaster((id) => {
    snapshotCalls.push(id);
    return id in snapshots ? snapshots[id] : { type: 'reset', id, count: 42, stats: [0, 0, 0, 0, 0, 0], filters: {} };
  });
  return { broadcaster, snapshotCalls };
}

test('clients under the high water mark receive frames as-is', () => {
  const { broadcaster, snapshotCalls } = makeBroadcaster();
  const ws = new FakeSocket();
  broadcaster.send(ws, 's:a', frame(1));
  ws.bufferedAmount = WS_HIGH_WATER_BYTES; // at, not above, the threshold
  broadcaster.send(ws, 's:a', frame(2));
  assert.deepEqual(ws.sent, [frame(1), frame(2)]);
  assert.deepEqual(snapshotCalls, []);
});

test('saturated clients are skipped and get one reset once the buffer drains', () => {
  const { broadcaster, snapshotCalls } = makeBroadcaster();
  const ws = new FakeSocket();

  // Buffer blows past the high water mark: frames are dropped.
  ws.bufferedAmount = WS_HIGH_WATER_BYTES + 1;
  broadcaster.send(ws, 's:a', frame(1));
  broadcaster.send(ws, 's:a', frame(2));
  assert.deepEqual(ws.sent, []);

  // Still above the low water mark: keep dropping, no snapshot yet.
  ws.bufferedAmount = WS_LOW_WATER_BYTES + 1;
  broadcaster.send(ws, 's:a', frame(3));
  assert.deepEqual(ws.sent, []);
  assert.deepEqual(snapshotCalls, []);

  // Drained: a single snapshot reset replaces all the missed frames.
  ws.bufferedAmount = WS_LOW_WATER_BYTES;
  broadcaster.send(ws, 's:a', frame(4));
  assert.deepEqual(snapshotCalls, ['s:a']);
  assert.equal(ws.sent.length, 1);
  assert.equal(JSON.parse(ws.sent[0]).type, 'reset');

  // The client is healthy again: subsequent frames flow normally.
  broadcaster.send(ws, 's:a', frame(5));
  assert.deepEqual(ws.sent[1], frame(5));
});

test('pending resets are tracked per client and per source', () => {
  const { broadcaster } = makeBroadcaster();
  const slow = new FakeSocket();
  const fast = new FakeSocket();
  slow.bufferedAmount = WS_HIGH_WATER_BYTES + 1;
  broadcaster.send(slow, 's:a', frame(1));
  broadcaster.send(slow, 's:b', frame(1));

  // Other clients are unaffected by the slow one.
  broadcaster.send(fast, 's:a', frame(1));
  assert.deepEqual(fast.sent, [frame(1)]);

  // Draining resolves each subscribed source independently.
  slow.bufferedAmount = 0;
  broadcaster.send(slow, 's:a', frame(2));
  assert.equal(JSON.parse(slow.sent[0]).type, 'reset');
  broadcaster.send(slow, 's:b', frame(2));
  assert.equal(JSON.parse(slow.sent[1]).type, 'reset');
  assert.equal(slow.sent.length, 2);
});

test('a skipped client whose source vanished is dropped without a send', () => {
  const { broadcaster } = makeBroadcaster({ 's:gone': null });
  const ws = new FakeSocket();
  ws.bufferedAmount = WS_HIGH_WATER_BYTES + 1;
  broadcaster.send(ws, 's:gone', frame(1));
  ws.bufferedAmount = 0;
  broadcaster.send(ws, 's:gone', frame(2));
  assert.deepEqual(ws.sent, []);
  // State was cleared: the next frame is delivered normally again.
  broadcaster.send(ws, 's:gone', frame(3));
  assert.deepEqual(ws.sent, [frame(3)]);
});

test('forget discards pending state for disconnected clients', () => {
  const { broadcaster, snapshotCalls } = makeBroadcaster();
  const ws = new FakeSocket();
  ws.bufferedAmount = WS_HIGH_WATER_BYTES + 1;
  broadcaster.send(ws, 's:a', frame(1));
  broadcaster.forget(ws);
  ws.bufferedAmount = 0;
  broadcaster.send(ws, 's:a', frame(2));
  assert.deepEqual(ws.sent, [frame(2)]);
  assert.deepEqual(snapshotCalls, []);
});
