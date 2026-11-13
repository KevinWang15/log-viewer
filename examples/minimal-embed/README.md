# Embedding the viewer in an Express app

Mounts log-viewer under `/logs` of a host app, lets the host's own login
decide access through the `authorize` hook, and feeds it from the same
process (a stream and an in-memory provider).

```bash
node server.mjs
# open http://localhost:5181/login?user=alice
```

From the repo root, build first (`npm run build`). See [docs/library.md](../../docs/library.md).
