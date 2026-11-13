// Fills the example database and keeps inserting rows, so new lines appear
// live in the viewer. Usage: node seed.mjs [db-file] [--once]

import { DatabaseSync } from 'node:sqlite';
import { SCHEMA } from './provider.mjs';

const dbPath = process.argv[2] && !process.argv[2].startsWith('--') ? process.argv[2] : 'logs.db';
const once = process.argv.includes('--once');
const db = new DatabaseSync(dbPath);
db.exec(SCHEMA);
const insert = db.prepare(
  'INSERT INTO logs (service, ts, level, thread, logger, message, tenant, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
);
const TENANTS = ['acme', 'globex', 'initech'];

const SERVICES = ['api', 'billing', 'worker'];
const LEVELS = ['DEBUG', 'INFO', 'INFO', 'INFO', 'WARN', 'ERROR'];
const MESSAGES = [
  'GET /orders/{n} 200 in {ms} ms',
  'POST /checkout 201 in {ms} ms requestId={id}',
  'cache miss for customer:{n}',
  'payment provider timeout after {ms} ms requestId={id}',
  'job {n} finished',
  'retrying webhook delivery, attempt {k}',
];
let n = 0;
const line = () =>
  MESSAGES[n % MESSAGES.length]
    .replace('{n}', String(1000 + (n * 7) % 9000))
    .replace('{ms}', String(5 + (n * 13) % 900))
    .replace('{id}', 'req-' + (n % 50).toString(36))
    .replace('{k}', String(1 + (n % 4)));

function batch(count) {
  for (let k = 0; k < count; k++, n++) {
    const level = LEVELS[(Math.floor(n / 3) * 5) % LEVELS.length];
    const status = level === 'ERROR' ? 500 : level === 'WARN' ? 429 : 200;
    insert.run(SERVICES[n % 3], Date.now(), level, `worker-${n % 4}`, `com.example.${SERVICES[n % 3]}`, line(), TENANTS[Math.floor(n / 3) % 3], status);
  }
}

batch(300);
console.log(`seeded ${dbPath} with 300 rows`);
if (!once) {
  setInterval(() => batch(1 + (n % 3)), 500);
  console.log('inserting new rows every 500 ms (Ctrl+C to stop)');
}
