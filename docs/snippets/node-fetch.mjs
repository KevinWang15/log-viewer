// Producer snippet: push structured entries and raw lines to a log-viewer
// stream from Node.js 18+ (global fetch, no dependencies).
//
//   LOG_VIEWER_BASE=http://127.0.0.1:5178 \
//   LOG_VIEWER_SERVICE_KEY=… \
//   node node-fetch.mjs <channel>
//
// The stream key is a server-to-server credential — keep it in your secret
// store, never in browser code or embed URLs. See docs/api.md.

const BASE = (process.env.LOG_VIEWER_BASE || 'http://127.0.0.1:5178').replace(/\/$/, '');
const KEY = process.env.LOG_VIEWER_SERVICE_KEY || '';
const channel = process.argv[2] || 'myapp';

const headers = {
  'content-type': 'application/json',
  ...(KEY ? { 'x-stream-key': KEY } : {}),
};

async function req(method, path, body) {
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

// 1. Create the stream (idempotent; 201 created, 200 already exists).
const created = await req('PUT', `/api/v1/streams/${encodeURIComponent(channel)}`);
console.log('stream:', created.id, 'created:', created.created);

// 2a. Append raw lines — parsed with the stream's detected/custom format.
await req('POST', `/api/v1/streams/${encodeURIComponent(channel)}/entries`, {
  lines: ['2026-07-13 10:00:00,000 [Main] INFO App - service ready'],
});

// 2b. Append structured entries (only the mapped fields are retained).
const ack = await req('POST', `/api/v1/streams/${encodeURIComponent(channel)}/entries`, {
  entries: [
    {
      time: new Date().toISOString(),
      level: 'WARN',
      thread: 'Main',
      logger: 'App',
      message: 'slow response requestId=abc123',
    },
  ],
});
console.log('ack:', ack.count, 'entries,', ack.stats, 'per-level totals');

// 3. On shutdown, release the stream (idempotent).
// await req('DELETE', `/api/v1/streams/${encodeURIComponent(channel)}`);
