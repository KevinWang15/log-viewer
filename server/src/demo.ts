// Keeps a live "demo" stream channel emitting log lines so the embedded
// widget has something to show out of the box.

import type { StreamRegistry } from './streams';
import { randomLogLine } from './sample';

export function startDemoStream(streams: StreamRegistry, channel = 'demo'): { stop(): void } {
  const src = streams.getOrCreate(channel);
  let seed = Date.now() % 100000;
  const rnd = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed % 100000) / 100000;
  };
  const tick = () => {
    const n = 1 + Math.floor(rnd() * 3);
    const lines: string[] = [];
    for (let i = 0; i < n; i++) lines.push(randomLogLine(rnd, new Date()));
    src.appendLines(lines);
  };
  const timer = setInterval(tick, 700);
  timer.unref();
  // Seed with a little history so the widget isn't empty on first load.
  for (let i = 0; i < 40; i++) tick();
  return { stop: () => clearInterval(timer) };
}
