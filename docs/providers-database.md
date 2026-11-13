# Database providers

This guide shows how to serve logs stored in a database table through the
[provider SPI](providers.md). It walks through the SQLite example in
[examples/sqlite-provider](../examples/sqlite-provider/), then sketches a
Postgres provider that uses `LISTEN/NOTIFY` for live updates.

## The SQLite example

The example uses Node's built-in `node:sqlite` module (Node 22.13 or later), so
it has no dependencies. Each distinct `service` value is one log, and the row
id is the cursor.

### Schema

```sql
CREATE TABLE IF NOT EXISTS logs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  service TEXT NOT NULL,
  ts      INTEGER NOT NULL,   -- epoch ms
  level   TEXT NOT NULL,
  thread  TEXT,
  logger  TEXT,
  message TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_service_id ON logs (service, id);
```

The composite index on `(service, id)` serves every query the provider runs.
`WHERE service = ? AND id > ? ORDER BY id` is a forward range scan of the
index, and `WHERE service = ? ORDER BY id DESC LIMIT n` is a backward scan
that stops after `n` rows. Neither query sorts or touches other services'
rows.

### Why the row id is a good cursor

A cursor must be totally ordered, and new records must always get a larger
cursor than records the viewer has already seen. The SQLite row id meets both
conditions:

- `AUTOINCREMENT` ids only grow and are never reused, even after deletes.
- SQLite allows one writer at a time, so ids become visible in the order they
  were assigned. A reader never sees id 102 while id 101 is still
  uncommitted.
- The id is unique, so "strictly after" has no ties.

### The catalog

```js
const services = db.prepare('SELECT DISTINCT service FROM logs ORDER BY service');

async listLogs() {
  return services.all().map((r) => ({ id: r.service, name: r.service, labels: { db: 'sqlite' } }));
}
```

The viewer caches this list for `catalogTtlMs` (10 seconds by default).

### list: records after a cursor

```js
const after = db.prepare('SELECT * FROM logs WHERE service = ? AND id > ? ORDER BY id LIMIT ?');

async list({ after: cursor, limit }) {
  const rows = after.all(service, cursor === null ? 0 : Number(cursor), limit + 1);
  return { records: rows.slice(0, limit).map(toRecord), more: rows.length > limit };
}
```

`cursor === null` means "from the beginning". Row ids start at 1, so `id > 0`
covers every row. The query asks for `limit + 1` rows. The extra row only
tells the viewer whether more records are available, and it is not returned.
This saves the extra empty query the viewer would otherwise make whenever a
page is exactly full.

`toRecord` maps a row to a `LogRecord`:

```js
const toRecord = (row) => ({
  cursor: String(row.id),
  time: row.ts,                      // epoch ms
  level: row.level,                  // 'INFO', 'WARN', ...
  thread: row.thread ?? undefined,
  logger: row.logger ?? undefined,
  message: row.message,
});
```

### tail: the newest records

```js
const newest = db.prepare('SELECT * FROM logs WHERE service = ? ORDER BY id DESC LIMIT ?');

async tail({ limit }) {
  return { records: newest.all(service, limit).reverse().map(toRecord) };
}
```

The query reads the newest `limit` rows in descending order, and `reverse()`
returns them in the ascending order the SPI requires. The viewer passes
`maxEntries` as the limit, so opening a log costs one indexed query instead of
paging through the whole table.

### Polling instead of watch

The example has no `watch`. SQLite has no cross-process change notification,
so the viewer polls `list({ after: lastCursor })` every `pollIntervalMs`
(1 second by default). Each poll is one index probe that usually returns no
rows. The source shows the state `polling`.

### Running it

From the repository root, build the package once so the example can import
`@kevinwang15/log-viewer`:

```bash
npm install
npm run build
cd examples/sqlite-provider
node seed.mjs logs.db       # creates the table, inserts 300 rows, then more every 500 ms
```

In a second terminal:

```bash
cd examples/sqlite-provider
node server.mjs logs.db     # serves the viewer on http://localhost:5180 (PORT overrides)
```

Open http://localhost:5180, choose File > Open > Catalog, and pick a service
(`api`, `billing` or `worker`). New rows appear about a second after
`seed.mjs` inserts them. `node seed.mjs logs.db --once` seeds without the
continuous inserts.

`server.mjs` creates the viewer with `providers: [createSqliteProvider(dbPath)]`
and `streams: false`. The repository test
`server/test/sqlite-example.test.ts` runs `checkProvider` against the same
provider.

## A Postgres sketch with LISTEN/NOTIFY

Postgres can tell a connected client when rows arrive. This sketch uses that
as a wake-up signal for `watch`. It is your code: log-viewer does not ship a
`pg` dependency, so install `pg` in your own project.

### Schema and trigger

```sql
CREATE TABLE logs (
  id      bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  service text NOT NULL,
  ts      timestamptz NOT NULL DEFAULT now(),
  level   text NOT NULL,
  thread  text,
  logger  text,
  message text NOT NULL
);
CREATE INDEX logs_service_id ON logs (service, id);

CREATE FUNCTION logs_notify() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('log_rows', NEW.service);
  RETURN NULL;
END
$$ LANGUAGE plpgsql;

CREATE TRIGGER logs_notify AFTER INSERT ON logs
  FOR EACH ROW EXECUTE FUNCTION logs_notify();
```

The trigger sends the service name as the payload. Postgres delivers
notifications when the inserting transaction commits, and it collapses
identical notifications from one transaction, so a batch insert produces one
notification per service.

### The provider

```js
// pg-provider.mjs
import pg from 'pg';

const COLUMNS = 'id, ts, level, thread, logger, message';
const PAGE = 1000;

const toRecord = (row) => ({
  cursor: String(row.id),            // bigint arrives as a string
  time: row.ts,                      // timestamptz arrives as a Date
  level: row.level,
  thread: row.thread ?? undefined,
  logger: row.logger ?? undefined,
  message: row.message,
});

export function createPgProvider(connectionString, { id = 'pg', name = 'Postgres logs' } = {}) {
  const pool = new pg.Pool({ connectionString, max: 5 });
  pool.on('error', (err) => console.error('pg pool error:', err.message));

  async function rowsAfter(service, cursor, limit) {
    const { rows } = await pool.query(
      `SELECT ${COLUMNS} FROM logs WHERE service = $1 AND id > $2 ORDER BY id LIMIT $3`,
      [service, cursor ?? '0', limit]
    );
    return rows;
  }

  // One dedicated connection per watched log. NOTIFY only wakes the loop;
  // the records always come from an `id > cursor` query.
  async function* watch(service, { after, signal }) {
    let cursor = after;
    let dirty = true; // query once right away
    let failure = null;
    let wake = () => {};
    const poke = () => wake();

    const client = new pg.Client({ connectionString });
    client.on('notification', (msg) => {
      if (msg.payload === service) {
        dirty = true;
        poke();
      }
    });
    // Without an 'error' listener a dropped connection would crash the process.
    client.on('error', (err) => {
      failure = err;
      poke();
    });
    client.on('end', () => {
      failure ??= new Error('LISTEN connection closed');
      poke();
    });
    signal.addEventListener('abort', poke);
    try {
      await client.connect();
      await client.query('LISTEN log_rows');
      while (!signal.aborted) {
        if (failure) throw failure; // the viewer backs off, catches up with list(), watches again
        if (!dirty) {
          await new Promise((resolve) => (wake = resolve));
          continue;
        }
        dirty = false;
        for (;;) {
          const rows = await rowsAfter(service, cursor, PAGE);
          if (!rows.length) break;
          cursor = String(rows[rows.length - 1].id);
          yield { type: 'records', records: rows.map(toRecord) };
          if (rows.length < PAGE) break;
        }
      }
    } finally {
      signal.removeEventListener('abort', poke);
      await client.end().catch(() => {});
    }
  }

  return {
    apiVersion: 1,
    id,
    name,
    async listLogs() {
      const { rows } = await pool.query('SELECT DISTINCT service FROM logs ORDER BY service');
      return rows.map((r) => ({ id: r.service, name: r.service, labels: { db: 'postgres' } }));
    },
    open(service) {
      return {
        async list({ after, limit }) {
          const rows = await rowsAfter(service, after, limit + 1);
          return { records: rows.slice(0, limit).map(toRecord), more: rows.length > limit };
        },
        async tail({ limit }) {
          const { rows } = await pool.query(
            `SELECT ${COLUMNS} FROM logs WHERE service = $1 ORDER BY id DESC LIMIT $2`,
            [service, limit]
          );
          return { records: rows.reverse().map(toRecord) };
        },
        watch: (req) => watch(service, req),
      };
    },
    async close() {
      await pool.end();
    },
  };
}
```

Register it like any provider:

```js
import { createLogViewer } from '@kevinwang15/log-viewer';
import { createPgProvider } from './pg-provider.mjs';

const viewer = createLogViewer({ providers: [createPgProvider(process.env.DATABASE_URL)] });
await viewer.listen(5178, '127.0.0.1');
```

### How it behaves

- **Notifications are hints.** The loop never reads records from the
  notification payload. It marks the log dirty and runs the same
  `id > cursor` query that `list` uses. A missed or duplicated notification
  only costs a delay or one empty query.
- **No gap at startup.** The viewer catches up with `list` before it calls
  `watch`, and `watch` queries once right after `LISTEN`. Rows inserted
  between the two queries are picked up by the second one.
- **Reconnects.** If the `LISTEN` connection fails, the generator throws. The
  viewer marks the log `reconnecting`, waits with jittered backoff (1 second
  doubling to 30 seconds), catches up with `list` through the pool, and calls
  `watch` again, which opens a new connection. Notifications sent while
  disconnected are lost, and the catch-up query covers them.
- **Shutdown.** When the user closes the log or the viewer shuts down, the
  signal aborts, the loop exits, and `finally` closes the connection.
- **Connections.** Each open log holds one dedicated connection, so up to
  `maxOpen` (16 by default) `LISTEN` connections, plus the pool. To use fewer
  connections, run one shared listener per provider and fan notifications
  out to the watchers by payload.
- **The catalog query.** `SELECT DISTINCT service` scans the index on large
  tables. Keep a separate `log_services` table, or a materialized list, when
  the table is big.

Test it with `checkProvider` from `@kevinwang15/log-viewer/testing`, passing
an `insert` callback that inserts rows for the log, so the watch checks run
too. See [Testing](providers.md#testing).

## Schema and index advice

**Use a monotonic cursor column.** The best cursor is a unique, increasing
integer assigned when the row becomes visible: an auto-increment id, a
sequence, or a log offset. Store it as a column and return it as a string.

**Watch commit order on concurrent writers.** In Postgres and MySQL, ids are
assigned at insert time but become visible at commit time. With several
concurrent writers, id 102 can commit before id 101. The viewer may then read
102, move its cursor past 101, and never show 101. Remedies:

- Write through a single writer, such as a log shipper that batches inserts.
- Serialize inserts with a lock taken before the id is assigned, for example
  `SELECT pg_advisory_xact_lock(42)` at the start of each inserting
  transaction.
- Only list rows older than a short settle window, for example
  `AND ts < now() - interval '2 seconds'`. This only works when no
  transaction stays open longer than the window.

SQLite has a single writer, so this does not affect it.

**Index `(log key, cursor)`.** One composite index on, for example,
`(service, id)` serves `list`, `tail` and the watch query. Without it, each
poll scans the table.

**Avoid timestamps as cursors.** Timestamps are not unique, so "strictly
after" either skips or repeats rows that share a timestamp. Clocks also move
backwards. If you must page by time, use a compound cursor such as
`"<ts>|<id>"` that you parse back, query with a row comparison
(`WHERE service = $1 AND (ts, id) > ($2, $3) ORDER BY ts, id`), and index
`(service, ts, id)`. This is still only safe when new rows always get a later
`ts` than rows already visible.

**Retention and deletes.** Deleting the oldest rows is fine with an id cursor,
because `id > cursor` still works when the cursor's row is gone. The mirror
keeps records that the database has already deleted until they age out of
the mirror. Signal a reset when history behind the cursor changes in other
ways:

- Throw `CursorExpiredError` from `list` when you can detect an invalid
  cursor, for example a cursor larger than the table's current maximum id
  after the table was recreated.
- Yield `{ type: 'reset' }` from `watch` after a backfill inserts older
  records, or after rows the viewer already shows were deleted or rewritten.

The viewer then reloads the log from `tail`.

## Multi-tenant and catalog advice

- **One log per service or tenant.** Map each value of the partition column to
  one `LogDescriptor`, as the examples do with `service`. Users then open the
  slice they need, and each mirror holds `maxEntries` records of one slice
  instead of a mix.
- **Use labels.** Put attributes such as `env`, `team`, `region` or `tenant`
  in `labels`. The catalog shows them as `key=value` chips and its search box
  matches them. Use `description` for a one-line summary.
- **Use stable ids.** The log id is part of the source id
  `p:<provider>:<log>` and of the open URL. Use the partition key itself, not
  a display string that may change.
- **Scope the catalog in your authorizer.** `listLogs()` receives no request
  context, so return every log and let the authorizer decide. The catalog
  route lists only logs whose `read` check passes, with `ctx.source.id` set to
  `p:<provider>:<log>`, and opening a log checks the same. See
  [Security](security.md#the-authorize-hook).

## Performance notes

- **Initial load.** `tail` is called with `limit = maxEntries` (100,000 by
  default), so opening a log reads up to that many rows in one query. Lower
  `providerOptions.maxEntries` if users only need recent history, or if rows
  are large. The mirror also stops at `maxBytes` (64 MiB per log).
- **Page size.** Catch-up and the paged initial load call `list` with
  `limit = pageLimit` (1000). Larger pages mean fewer round trips after an
  outage, and larger result sets per query.
- **Polling cost.** Without `watch`, every open log runs one `id > cursor`
  query per `pollIntervalMs` (1 second). With the default `maxOpen` of 16,
  that is at most 16 cheap index probes per second. Raise `pollIntervalMs`
  to reduce load, or implement `watch` so idle logs cost nothing.
- **Busy logs.** Records from `watch` are batched for `batchMs` (100 ms) or
  `batchMax` (1000) records. Once a mirror is full it evicts down to about
  90% of `maxEntries`, so clients get one reset per ~10% of new records.
- **Memory.** Plan for up to `maxOpen × maxBytes` of mirror data per viewer
  process.
