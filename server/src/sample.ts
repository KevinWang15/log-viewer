// Generates realistic sample log files on first boot so the app has something
// to open out of the box.

import * as fs from 'node:fs';
import * as path from 'node:path';

const LOGGERS = ['Client', 'Server', 'PriceService', 'OrderService', 'Db', 'Auth', 'Cache', 'Scheduler'];
const THREADS = ['Main', ...Array.from({ length: 14 }, (_, i) => `Thread_${i + 1}`)];
const NAMES = ['Alice', 'Bill', 'Carol', 'Dave', 'Erin', 'Frank'];

const INFO_MSGS = [
  "Client '{n}' transaction initiated.",
  "Client '{n}' transaction complete.",
  'Transaction placed successfully.',
  'Network connection established.',
  'Price information sent to client.',
  'Verifying network connection.',
  'Price for trade determined.',
  'Getting price service information.',
  'ESENT database transaction completed.',
  'Session cache refreshed.',
  'Order book snapshot delivered.',
];
const TRACE_MSGS = [
  'Process start client initiated.',
  'Executing SQL statements.',
  'Entering method PlaceOrder().',
  'Leaving method PlaceOrder().',
  'Heartbeat received from gateway.',
];
const DEBUG_MSGS = [
  'Getting price service for symbol {sym}.',
  'Cache miss for key session-{k}.',
  'Retrying request, attempt {k}.',
  'Connection pool size is {k}.',
];
const WARN_MSGS = [
  'Transaction time delayed significantly. This may effect available pricing.',
  'Price for trade determined using stale data.',
  'Slow query detected ({k} ms).',
  'Retry threshold approaching for gateway connection.',
];
const ERROR_MSGS = [
  'Invalid transaction details detected. Verifying with server.',
  'Error initializing price service.',
  'Failed to persist order: deadlock victim.',
  'Timeout while waiting for confirmation.',
];

const STACK = [
  '   at LogViewer.LogGenerator.Services.ServiceBase.Write(Context context, Int32 retries)',
  '   at LogViewer.LogGenerator.Services.PriceService.Process(Transaction tx)',
  '   at LogViewer.LogGenerator.Program.Main(String[] args)',
];

const XML_PAYLOAD = [
  'Transaction details:',
  '<?xml version="1.0" encoding="utf-8" ?>',
  '<SERIES-AND-CLASSES-CONTRACTS-DATA>',
  '  <MERGER-SERIES-AND-CLASSES-CONTRACTS>',
  '    <MERGER>',
  '      <SERIES OWNER-CIK="" SERIES-ID="" SERIES-NAME="">',
  '        <CLASS-CONTRACT CLASS-CONTRACT-ID="" CLASS-CONTRACT-NAME="" CLASS-CONTRACT-TICKER-SYMBOL="" />',
  '      </SERIES>',
  '    </MERGER>',
  '  </MERGER-SERIES-AND-CLASSES-CONTRACTS>',
  '</SERIES-AND-CLASSES-CONTRACTS-DATA>',
];

function pick<T>(arr: T[], rnd: () => number): T {
  return arr[Math.floor(rnd() * arr.length)];
}

function fill(msg: string, rnd: () => number): string {
  return msg
    .replace('{n}', pick(NAMES, rnd))
    .replace('{sym}', pick(['MSFT', 'AAPL', 'GOOG', 'AMZN'], rnd))
    .replace(/\{k\}/g, String(1 + Math.floor(rnd() * 900)));
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pad(n: number, w: number): string {
  return String(n).padStart(w, '0');
}

function fmtTs(d: Date): string {
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)} ` +
    `${pad(d.getHours(), 2)}:${pad(d.getMinutes(), 2)}:${pad(d.getSeconds(), 2)},${pad(d.getMilliseconds(), 3)}`
  );
}

export function randomLogLine(rnd: () => number, ts: Date): string {
  const r = rnd();
  let level: string;
  let msg: string;
  if (r < 0.06) {
    level = 'TRACE';
    msg = fill(pick(TRACE_MSGS, rnd), rnd);
  } else if (r < 0.36) {
    level = 'DEBUG';
    msg = fill(pick(DEBUG_MSGS, rnd), rnd);
  } else if (r < 0.9) {
    level = 'INFO';
    msg = fill(pick(INFO_MSGS, rnd), rnd);
  } else if (r < 0.97) {
    level = 'WARN';
    msg = fill(pick(WARN_MSGS, rnd), rnd);
  } else {
    level = 'ERROR';
    msg = fill(pick(ERROR_MSGS, rnd), rnd);
  }
  return `${fmtTs(ts)} [${pick(THREADS, rnd)}] ${level} ${pick(LOGGERS, rnd)} - ${msg}`;
}

function generateFile(filePath: string, entryCount: number, seed: number, start: Date) {
  const rnd = mulberry32(seed);
  const lines: string[] = [];
  const ts = new Date(start);
  for (let i = 0; i < entryCount; i++) {
    ts.setMilliseconds(ts.getMilliseconds() + Math.floor(rnd() * 400));
    const line = randomLogLine(rnd, ts);
    lines.push(line);
    if (line.includes(' ERROR ') && rnd() < 0.7) lines.push(...STACK);
    if (line.includes('Transaction details') || (line.includes(' INFO ') && rnd() < 0.01)) {
      lines.push(...XML_PAYLOAD.slice(1));
    }
    if (rnd() < 0.005) {
      lines.push(`${fmtTs(ts)} [Thread_8] INFO PlotDecoration - ${XML_PAYLOAD[0]}`);
      lines.push(...XML_PAYLOAD.slice(1));
    }
  }
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
}

export function ensureSampleLogs(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const startOfDay = new Date();
  startOfDay.setHours(9, 30, 0, 0);
  const files: Array<[string, number, number]> = [
    ['app.log', 30000, 42],
    ['client.log', 8000, 7],
    ['server.log', 12000, 99],
  ];
  for (const [name, count, seed] of files) {
    const p = path.join(dir, name);
    if (!fs.existsSync(p)) {
      console.log(`generating sample log ${p} (${count} entries)…`);
      generateFile(p, count, seed, startOfDay);
    }
  }
  return dir;
}
