# SQLite provider example

A log-viewer provider backed by a SQLite table, using Node's built-in
`node:sqlite` (Node 22.13+; no dependencies). One log per service, the row id
is the cursor, `tail()` loads the newest rows and the viewer polls `list()`
for new ones.

```bash
node seed.mjs logs.db          # creates the table, inserts rows continuously
node server.mjs logs.db        # in another terminal
# open http://localhost:5180 → File ▸ Open ▸ Catalog → pick a service
```

From the repo root, build first (`npm run build`) so the package resolves.

See [`provider.mjs`](provider.mjs) and the
[database provider guide](../../docs/providers-database.md).
