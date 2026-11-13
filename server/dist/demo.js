"use strict";
// Keeps a live "demo" stream channel emitting log lines so the embedded
// widget has something to show out of the box.
Object.defineProperty(exports, "__esModule", { value: true });
exports.startDemoStream = startDemoStream;
const sample_1 = require("./sample");
function startDemoStream(store, channel = 'demo') {
    const src = store.getOrCreateStream(channel);
    let seed = Date.now() % 100000;
    const rnd = () => {
        seed = (seed * 16807) % 2147483647;
        return (seed % 100000) / 100000;
    };
    const tick = () => {
        const n = 1 + Math.floor(rnd() * 3);
        const lines = [];
        for (let i = 0; i < n; i++)
            lines.push((0, sample_1.randomLogLine)(rnd, new Date()));
        src.appendLines(lines);
    };
    setInterval(tick, 700).unref();
    // Seed with a little history so the widget isn't empty on first load.
    for (let i = 0; i < 40; i++)
        tick();
}
