// Embeds log-viewer in an existing Express app:
//  - mounted under /logs, live updates on /logs/ws
//  - the host's own session check guards everything (authorize hook)
//  - an in-memory provider plus in-process stream ingestion
//
// Usage: node server.mjs, then open http://localhost:5181/login?user=alice

import express from 'express';
import http from 'node:http';
import { createLogViewer, MemoryProvider } from '@kevinwang15/log-viewer';

// Your app's notion of a user: here a cookie set by /login. The UI's API
// calls and WebSocket upgrade carry it automatically.
const userOf = (req) => /(?:^|;\s*)user=([^;]+)/.exec(req.headers.cookie || '')?.[1];

const memory = new MemoryProvider('jobs', { name: 'Background jobs' });
memory.addLog({ id: 'nightly', name: 'Nightly export', labels: { team: 'data' } });

const viewer = createLogViewer({
  providers: [memory],
  // Every read, open and write goes through here.
  authorize: (ctx) => {
    const user = ctx.req ? userOf(ctx.req) : undefined;
    if (!user) return { status: 401, error: 'log in first' };
    if (ctx.action === 'ingest') return false; // ingestion only in-process
    return true;
  },
});

const app = express();
app.get('/', (_req, res) => res.send('<a href="/login?user=alice">Log in as alice</a>'));
app.get('/login', (req, res) => {
  res.cookie('user', String(req.query.user || 'guest'), { httpOnly: true, sameSite: 'lax' });
  res.redirect('/logs/');
});
app.use('/logs', viewer.handler);

const server = http.createServer(app);
viewer.attach(server, { path: '/logs/ws' });
await viewer.start();
const port = Number(process.env.PORT) || 5181;
server.listen(port, () => console.log(`host app on http://localhost:${port}`));

// Producers inside the same process write directly.
let n = 0;
setInterval(() => {
  n++;
  viewer.streams.append('checkout', [{ level: n % 7 ? 'INFO' : 'WARN', logger: 'checkout', message: `order ${n} placed` }]);
  memory.push('nightly', [{ time: Date.now(), level: 'INFO', message: `exported batch ${n}` }]);
}, 1000);
