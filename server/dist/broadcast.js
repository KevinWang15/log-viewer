"use strict";
// Backpressure-aware WebSocket broadcast helper. A slow client must not
// accumulate unbounded send buffers: once its bufferedAmount crosses the high
// water mark, frames for a source are dropped and the source is marked dirty.
// When the buffer drains below the low water mark (checked on the next
// broadcast for that source), a single snapshot reset is sent instead of the
// missed frames. A reset is always safe — subscribers re-snapshot their view.
Object.defineProperty(exports, "__esModule", { value: true });
exports.WsBroadcaster = exports.WS_LOW_WATER_BYTES = exports.WS_HIGH_WATER_BYTES = void 0;
exports.WS_HIGH_WATER_BYTES = 1024 * 1024;
exports.WS_LOW_WATER_BYTES = exports.WS_HIGH_WATER_BYTES / 4;
class WsBroadcaster {
    snapshot;
    // ws -> source ids that missed frames while the client was saturated.
    pendingResets = new Map();
    constructor(snapshot) {
        this.snapshot = snapshot;
    }
    forget(ws) {
        this.pendingResets.delete(ws);
    }
    // Sends the already-serialized `frame` about source `id`, or skips it when
    // the client is saturated. Never queues more than one pending reset per
    // client and source.
    send(ws, id, frame) {
        const pending = this.pendingResets.get(ws);
        if (pending?.has(id)) {
            // Still draining: drop the frame — the pending snapshot covers it.
            if (ws.bufferedAmount > exports.WS_LOW_WATER_BYTES)
                return;
            pending.delete(id);
            if (!pending.size)
                this.pendingResets.delete(ws);
            const snap = this.snapshot(id);
            if (snap)
                ws.send(JSON.stringify(snap));
            return;
        }
        if (ws.bufferedAmount > exports.WS_HIGH_WATER_BYTES) {
            if (pending)
                pending.add(id);
            else
                this.pendingResets.set(ws, new Set([id]));
            return;
        }
        ws.send(frame);
    }
}
exports.WsBroadcaster = WsBroadcaster;
