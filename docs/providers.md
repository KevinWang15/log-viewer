# Providers

A provider connects your own log storage (a database table, an object store, a
log service) to log-viewer. This page is the reference for the provider SPI.
For a step-by-step database example, see
[Database providers](providers-database.md).

## What a provider is

A provider follows the Kubernetes list + watch pattern. It answers a few
questions about each log:

- Which logs exist (`listLogs`).
- Which records come after a cursor (`list`).
- Which records are the newest (`tail`, optional).
- When new records arrive (`watch`, optional).

When a user opens a provider log, the viewer loads the newest `maxEntries`
records (100,000 by default) into an in-memory mirror and keeps it up to date.
Every feature (filters, search, minimap, reports, correlation, bookmarks,
rules, export) runs against that mirror. The provider is never asked to
filter or search. Your storage only needs to answer ordered range queries by
cursor.

Records older than the mirror window are not visible in the viewer. The mirror
holds the newest records, like `tail -n`.

## A minimal provider

`defineProvider` builds a provider from plain functions of `(logId, request)`.
This one serves a single log from an array:

```ts
import { createLogViewer } from '@kevinwang15/log-viewer';
import { defineProvider, type LogRecord } from '@kevinwang15/log-viewer/provider';

// Record n has cursor String(n) and sits at rows[n - 1].
const rows: LogRecord[] = [];
export function add(message: string, level = 'INFO') {
  rows.push({ cursor: String(rows.length + 1), time: Date.now(), level, message });
}

const provider = defineProvider({
  id: 'demo',
  name: 'Demo storage',
  logs: async () => [{ id: 'app', name: 'App', labels: { env: 'dev' } }],
  // Records strictly after `after`, oldest first, at most `limit`.
  list: async (_logId, { after, limit }) => {
    const from = after === null ? 0 : Number(after);
    const records = rows.slice(from, from + limit);
    return { records, more: from + records.length < rows.length };
  },
  // The newest `limit` records, oldest first.
  tail: async (_logId, { limit }) => ({ records: rows.slice(-limit) }),
});

const viewer = createLogViewer({ providers: [provider] });
await viewer.listen(5178, '127.0.0.1');
```

This provider has no `watch`, so the viewer polls `list` once per second for
new records. Open the UI and pick the log under File > Open > Catalog.

### The full object form

Implement `LogProvider` directly when you need `close()`, per-log setup in
`open()`, or a `watch()`. This version serves several logs from memory and
pushes new records through `watch`:

```ts
import { EventEmitter } from 'node:events';
import {
  CursorExpiredError,
  ProviderError,
  type ListPage,
  type LogHandle,
  type LogProvider,
  type LogRecord,
} from '@kevinwang15/log-viewer/provider';

const logs = new Map<string, LogRecord[]>([['app', []], ['worker', []]]);
const inserted = new EventEmitter(); // emits the log id after every insert

export function insert(logId: string, message: string, level = 'INFO') {
  const rows = logs.get(logId)!;
  rows.push({ cursor: String(rows.length + 1), time: Date.now(), level, message });
  inserted.emit('insert', logId);
}

function page(rows: LogRecord[], after: string | null, limit: number): ListPage {
  const from = after === null ? 0 : Number(after);
  // A cursor we never handed out: history was rewritten, so the viewer reloads.
  if (!Number.isInteger(from) || from < 0 || from > rows.length) throw new CursorExpiredError();
  const records = rows.slice(from, from + limit);
  return { records, more: from + records.length < rows.length };
}

// Resolves on the next insert into logId, or when the signal aborts.
function nextInsert(logId: string, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = (id?: string) => {
      if (id !== undefined && id !== logId) return;
      inserted.off('insert', done);
      signal.removeEventListener('abort', onAbort);
      resolve();
    };
    const onAbort = () => done();
    inserted.on('insert', done);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

export const provider: LogProvider = {
  apiVersion: 1,
  id: 'memstore',
  name: 'In-memory store',
  async listLogs() {
    return [...logs.keys()].map((id) => ({ id, name: id }));
  },
  open(logId) {
    const rows = logs.get(logId);
    if (!rows) throw new ProviderError(`unknown log ${logId}`, { status: 404, retryable: false });
    const handle: LogHandle = {
      async list({ after, limit }) {
        return page(rows, after, limit);
      },
      async tail({ limit }) {
        return { records: rows.slice(Math.max(0, rows.length - limit)) };
      },
      async *watch({ after, signal }) {
        let cursor = after;
        while (!signal.aborted) {
          const { records } = page(rows, cursor, 1000);
          if (records.length) {
            cursor = records[records.length - 1].cursor;
            yield { type: 'records', records };
          } else {
            await nextInsert(logId, signal);
          }
        }
      },
      async close() {
        // Release per-log resources (connections, subscriptions) here.
      },
    };
    return handle;
  },
  async close() {
    // Release provider-wide resources (pools, clients) here.
  },
};
```

`MemoryProvider` (below) is a complete reference implementation of the same
ideas, including `reset` events and cursor expiry.

## Types reference

Import the SPI from `@kevinwang15/log-viewer/provider`. The package root
`@kevinwang15/log-viewer` re-exports the same names.

### LogProvider

| Member | Type | Required | Meaning |
| --- | --- | --- | --- |
| `apiVersion` | `1` | yes | SPI version. The viewer rejects any other value at registration. |
| `id` | `string` | yes | Unique per viewer. Must match `[A-Za-z0-9._-]{1,64}`. Appears in URLs and source ids. |
| `name` | `string` | no | Display name in the catalog. Defaults to `id`. |
| `capabilities` | `ProviderCapabilities` | no | Reserved for query pushdown. Ignored in v1. |
| `listLogs(signal?)` | `Promise<LogDescriptor[]>` | yes | The catalog shown in the UI's Catalog tab. |
| `open(logId, { signal })` | `LogHandle \| Promise<LogHandle>` | yes | Returns a handle for one log. Called once per opened log. |
| `close()` | `Promise<void>` | no | Called by `viewer.close()` after all of this provider's mirrors are closed. |

### LogDescriptor

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | `string` | Log id, unique within the provider. Used in URLs and the source id. |
| `name` | `string` | Display name. Also the source name once opened. |
| `description` | `string?` | Shown under the name in the catalog. |
| `labels` | `Record<string, string>?` | Shown as `key=value` chips. The catalog search matches them. |

A log must appear in `listLogs()` to be opened. The viewer looks the id up in
its cached catalog, and refetches the catalog once when the id is missing.

### LogHandle

| Method | Required | Meaning |
| --- | --- | --- |
| `list(req: ListRequest): Promise<ListPage>` | yes | Records strictly after `req.after`, in cursor order, at most `req.limit`. |
| `tail(req: TailRequest): Promise<ListPage>` | no, recommended | The newest `req.limit` records, in ascending cursor order. |
| `watch(req: WatchRequest): AsyncIterable<WatchEvent>` | no | Push notifications for records after `req.after`. Without it the viewer polls `list`. |
| `close(): Promise<void>` | no | Called when the mirror closes (the user closes the log, or the viewer shuts down). |

Without `tail`, the initial load pages through the whole log with `list` and
keeps the newest records. Implement `tail` for any log that can grow large.

### ListRequest and ListPage

```ts
interface ListRequest {
  after: Cursor | null; // null = from the beginning
  limit: number;
  signal: AbortSignal;
}

interface ListPage {
  records: LogRecord[]; // cursor order, strictly after `after`, at most `limit`
  more?: boolean;       // more records are available right now
}
```

When `more` is omitted, the viewer assumes there are more records if
`records.length === limit`. Return `more` explicitly when you can, for example
by fetching `limit + 1` rows. An omitted `more` costs one extra empty `list`
call whenever a page happens to be exactly full.

### TailRequest

```ts
interface TailRequest {
  limit: number; // the viewer passes maxEntries
  signal: AbortSignal;
}
```

`tail` returns a `ListPage`. Its `more` field is ignored.

### WatchRequest and WatchEvent

```ts
interface WatchRequest {
  after: Cursor | null; // the last cursor the viewer has
  signal: AbortSignal;  // aborted when the mirror closes
}

type WatchEvent =
  | { type: 'records'; records: LogRecord[] } // new records, in cursor order, after `after`
  | { type: 'reset'; reason?: string }        // history before the cursor changed: reload
  | { type: 'heartbeat' };                    // ignored by the viewer
```

Write `watch` as an async generator. Return from it when `signal` aborts. The
viewer also stops iterating on its own when it closes, so a watch that ignores
the signal cannot block shutdown.

### LogRecord

| Field | Type | Meaning |
| --- | --- | --- |
| `cursor` | `string` | Required, non-empty. The record's position in the log. |
| `message` | `string` | Required. Full message text. The first line is shown in the grid. |
| `time` | `number \| string \| Date` | Epoch milliseconds, an ISO-8601 string, or a `Date`. Missing or unparseable means no timestamp. |
| `level` | `string \| number` | `TRACE`, `DEBUG`, `INFO`, `WARN`, `ERROR`, `FATAL`, common aliases (`warning`, `err`, `severe`, `crit`, `verbose`, `fine`, ...), or a number 0 to 5. Missing or unknown means `INFO`. Numbers are truncated and clamped to 0..5. |
| `thread` | `string?` | Thread or worker name. Filterable. |
| `logger` | `string?` | Logger or component name. Filterable. |
| `raw` | `string?` | Text used for search, text filters, export and correlation. Defaults to `message`. |
| `fields` | `Record<string, string \| number \| boolean \| null>?` | Reserved for structured fields. Not used in v1. |

The viewer truncates `message` and `raw` to 64 KiB and `thread` and `logger`
to 4 KiB. Records without a cursor or without a string `message` are dropped
and counted, not shown. Numeric cursors are converted with `String()`, but
`checkProvider` requires strings.

### Cursor

`Cursor` is an opaque string. The viewer never parses it. It only stores the
last cursor it has seen and passes it back as `after`.

Cursors must be totally ordered within one log, and that order must match the
order in which records become visible to `list`. Good cursors are an
auto-increment row id, a sequence number, a log offset, or a
`(timestamp, id)` pair encoded as a string. See
[Database providers](providers-database.md#schema-and-index-advice) for
pitfalls.

## Contract rules

These rules are what `checkProvider` tests.

1. `list` returns records in cursor order.
2. `list({ after: c })` returns only records strictly after `c`. Returning `c`
   itself again creates a duplicate in the mirror.
3. `list` returns at most `limit` records.
4. Paging with a small limit returns the same records, in the same order, as
   one large page.
5. `tail({ limit: n })` returns the newest `n` records in ascending order.
6. `watch` yields records strictly after the cursor it was given, and after
   every record it already yielded, in cursor order. The viewer appends them
   without deduplication.
7. Treat `watch` as a hint. After any reconnect, error or ended watch, the
   viewer first catches up with `list(after)` and only then calls `watch`
   again. A watch that can miss events (for example Postgres `NOTIFY` while
   disconnected) is acceptable, because `list` fills the gap.
8. If history before the cursor changes (rows deleted and ids reused,
   backfill of older records, a table rebuilt with new ids), the provider
   must say so. Yield `{ type: 'reset' }` from `watch`, or throw
   `CursorExpiredError` from `list` or `watch`. The viewer then reloads the
   log from `tail`. Plain retention that removes the oldest records does not
   need a reset when `list(after)` still works for old cursors.

## How the mirror behaves

Each opened log becomes a source of kind `provider`. Its behavior:

**Initial load.** The viewer calls `provider.open(logId)`, then
`tail({ limit: maxEntries })`. Without `tail` (or with `maxEntries: 0`) it pages
through `list` from the beginning, `pageLimit` records at a time, and keeps
the newest `maxEntries`. If the open or initial load fails, the open request
fails and no source is created.

**Follow.** After the load, the viewer calls `list(after)` until it is caught
up. Then:

- With `watch`, it iterates `watch({ after })` and appends what it yields.
  When the watch ends, it catches up with `list` and watches again. A watch
  that ends within one second without delivering records is retried with
  backoff, so a broken watch cannot spin. Heartbeats do not count as
  delivered records.
- Without `watch`, it sleeps `pollIntervalMs` (1000 ms by default), then
  catches up with `list` again, and repeats.

**Batching.** Records from `watch` are buffered and flushed as one append
after `batchMs` (100 ms) or once `batchMax` (1000) records are pending,
whichever comes first. Each `list` page during catch-up is one append.

**Backoff.** A failed call puts the log in `reconnecting`. The viewer waits a
jittered delay (between half and all of the current delay), starting at 1
second and doubling up to 30 seconds (`backoffMinMs`, `backoffMaxMs`). The
delay resets after a successful catch-up. The mirror stays readable while the
viewer retries.

**States.** The source info (`GET /api/logs/:id`, and the source list) reports
`state`, `connected` and `lastError`:

| State | Meaning | `connected` |
| --- | --- | --- |
| `loading` | Opening and loading the newest records. | false |
| `live` | Following with `watch`. | true |
| `polling` | Following by polling `list`. | true |
| `reconnecting` | A call failed; retrying with backoff. `lastError` has the message. | false |
| `failed` | A non-retryable error stopped following. The mirror keeps its records. | false |
| `closed` | The mirror was closed. | false |

The UI shows an OFFLINE badge on a disconnected provider log and FAILED for
`failed`. The badge tooltip shows `lastError`.

**Retention.** The mirror keeps at most `maxEntries` records and `maxBytes`
(64 MiB) of entry data. When an append pushes it over either limit, the
oldest records are evicted down to about 90% of that limit, and the viewer
sends a `reset` to clients instead of an `append`, because entry indices
shifted. The headroom means a busy log resets once per ~10% of new records,
not on every batch. After a reset,
clients re-read their window, filters and rule match counts are recomputed,
and the log's bookmarks are cleared (their indices are no longer valid).

**Dropped records.** Records without a cursor or a string `message` are
skipped and counted on the source. The cursor does not advance past a dropped
record, so the next `list` returns it again. Never return such records.

The source info of a provider log also carries
`provider: { id, name, log }`, `description` and `labels` from the descriptor.

## Errors

Throw these from any provider method:

```ts
declare class ProviderError extends Error {
  constructor(message: string, opts?: { status?: number; retryable?: boolean; cause?: unknown });
  readonly status?: number;   // HTTP status used when the error happens while opening
  readonly retryable: boolean; // default true
}

declare class CursorExpiredError extends ProviderError {
  constructor(message?: string); // default 'cursor expired'; status 409, retryable
}
```

How the viewer handles them:

| Error | While opening (`POST .../open`) | While following |
| --- | --- | --- |
| `CursorExpiredError` | 409 | Reloads the log from `tail` and emits `reset`. No backoff. |
| `ProviderError` with `retryable: false` | Its `status`, else 502 | State becomes `failed`. Following stops. The error is logged. |
| `ProviderError` (retryable) or any other error | Its `status` if it is 400-599, else 502 | State becomes `reconnecting`, retried with backoff. |

Other responses from the open route:

| Status | Cause |
| --- | --- |
| 404 | Unknown provider id, or the log id is not in `listLogs()` (after one fresh refetch). |
| 429 | `maxOpen` provider logs are already open. Code `provider_capacity_reached`. |
| 401/403 | The authorizer denied the `open` action. |

Error messages from a failed open start with `cannot open <logId>:` (from
`provider.open`) or `cannot load <logId>:` (from the initial `tail` or `list`).
Use `status: 404` for unknown logs and `403` for permission errors, with
`retryable: false`.

A `failed` log does not recover by itself. Close it (`DELETE /api/logs/:id`,
or the close button in the UI) and open it again.

## Registration

Pass providers to `createLogViewer`, or register them later:

```ts
import { createLogViewer } from '@kevinwang15/log-viewer';

const viewer = createLogViewer({
  providers: [dbProvider],
  providerOptions: {
    maxEntries: 50_000,
    pollIntervalMs: 2_000,
    autoOpen: [{ provider: 'db', log: 'api' }],
  },
});
viewer.registerProvider(otherProvider); // throws on a bad apiVersion, bad id or duplicate id
await viewer.start();                   // opens the autoOpen logs

const source = await viewer.openProviderLog('db', 'billing'); // same as the HTTP open route
```

`providerOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `maxEntries` | 100000 | Newest records kept per opened log. Also the `tail` limit. 0 means unbounded (not recommended). |
| `maxBytes` | 64 MiB | Byte cap per mirror. 0 means unbounded. |
| `pollIntervalMs` | 1000 | Poll interval for handles without `watch`. |
| `pageLimit` | 1000 | `limit` passed to `list`. |
| `batchMs` | 100 | Watch batching window. |
| `batchMax` | 1000 | Flush a watch batch at this many records. |
| `backoffMinMs` | 1000 | First retry delay. |
| `backoffMaxMs` | 30000 | Largest retry delay. |
| `maxOpen` | 16 | Provider logs open at once, across all providers. 0 means unlimited. |
| `autoOpen` | `[]` | `{ provider, log }` pairs opened by `viewer.start()`. Failures are logged, not thrown. |
| `catalogTtlMs` | 10000 | How long each provider's `listLogs()` result is cached. |

Opening is idempotent. Opening a log that is already open returns the
existing mirror, and concurrent opens of the same log share one load.

### HTTP routes

| Route | Meaning |
| --- | --- |
| `GET /api/v1/providers` | `{ providers: [{ id, name, capabilities }] }` |
| `GET /api/v1/providers/:pid/logs` | `{ logs: LogDescriptor[] }`, each with `open: true` when already open. `?fresh=1` bypasses the catalog cache. 502 when `listLogs()` throws. |
| `POST /api/v1/providers/:pid/logs/:logId/open` | Opens the log (authorizer action `open`) and returns its source info. |

An opened log is a regular source with id `p:<providerId>:<logId>`, for example
`p:sqlite:api`. All source routes (`/api/logs/:id/entries`, filters, search,
report, WebSocket `sub`) work with it. URL-encode the id in paths. See
[HTTP and WebSocket API](api.md).

`GET /api/v1/capabilities` lists the providers under `modules.providers`
together with `maxOpen`, and `/healthz` reports `providerLogs`, the number of
open provider logs.

### The UI

When at least one provider is registered, the Open dialog has a Catalog tab.
It lists each provider's logs with descriptions and labels, filters them by
id, name, description and `key=value` labels, and marks logs that are already
open. The refresh button refetches with `?fresh=1`. Picking a log opens it and
follows the tail.

## Testing

### checkProvider

`checkProvider` runs the contract checks against a real provider. It does not
depend on a test framework:

```ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkProvider } from '@kevinwang15/log-viewer/testing';

test('my provider follows the SPI contract', async () => {
  const report = await checkProvider(myProvider, {
    logId: 'api',                     // must exist and hold at least 2 records
    insert: async (n) => seedRows(n), // optional: appends n records to that log
    timeoutMs: 3000,                  // optional: per watch expectation
  });
  assert.ok(report.ok, report.failures.join('\n'));
});
```

Checks, in order:

1. `apiVersion` is 1 and `id` matches `[A-Za-z0-9._-]{1,64}`.
2. `listLogs()` returns an array that includes `logId` with a non-empty name.
3. `open(logId)` returns a handle with `list()`.
4. Paging with `limit: 3` stays within the limit, every record has a non-empty
   string cursor and a string message, cursors do not repeat, and the pages
   match one large page in content and order. The log needs at least 2
   records.
5. `list` after the last cursor returns nothing.
6. `list` after a middle cursor returns exactly the later records.
7. If `tail` exists: `tail({ limit: 2 })` returns the last two records in
   ascending order.
8. If `insert` is given: two inserted records are listed after the previous
   last cursor.
9. If `insert` is given and `watch` exists: `watch` delivers a newly inserted
   record within `timeoutMs`, and ends within `timeoutMs` after its signal
   aborts.

If `open` fails, the remaining checks are skipped. The handle's `close()` is
called at the end.

The report:

```ts
interface ConformanceReport {
  ok: boolean;                 // true when every check passed
  results: Array<{ name: string; ok: boolean; detail?: string }>;
  failures: string[];          // "<check name>: <detail>" for each failed check
}
```

### MemoryProvider

`MemoryProvider` is an in-memory provider for tests and demos. Import it from
`@kevinwang15/log-viewer`.

```ts
import { createLogViewer, MemoryProvider } from '@kevinwang15/log-viewer';

const mem = new MemoryProvider('mem', { name: 'Test logs' }); // id defaults to 'memory'
mem.addLog({ id: 'app', name: 'App', labels: { env: 'test' } });
mem.push('app', [{ time: Date.now(), level: 'INFO', message: 'hello' }]); // assigns cursors

const viewer = createLogViewer({ providers: [mem], providerOptions: { pollIntervalMs: 20 } });
```

| Member | Meaning |
| --- | --- |
| `new MemoryProvider(id?, { name?, watch?, tail? })` | `watch: false` or `tail: false` removes that method, to test polling or the paged initial load. |
| `addLog(descriptor)` | Adds an empty log. |
| `push(logId, records)` | Appends records (without `cursor`), assigns cursors `"1"`, `"2"`, ..., wakes watchers. Returns the stored records. |
| `truncate(logId, keep)` | Drops all but the newest `keep` records. Older cursors then throw `CursorExpiredError`. |
| `emitReset(logId)` | Sends a `reset` event to active watchers. |
| `failNext(n = 1, retryable = true)` | Makes the next `n` `list` or `tail` calls throw a `ProviderError`. |
| `calls` | `{ list, tail, watch }` call counters. |

## Versioning

The SPI is version 1 (`PROVIDER_API_VERSION`). Version 1 only ever gains
optional members, so a provider written today keeps working with later 1.x
releases. A breaking change would bump `apiVersion`, and the viewer rejects
providers that declare a version it does not implement.

`count`, `query` and `search` are reserved, both as `ProviderCapabilities`
flags and as future optional `LogHandle` methods. They are placeholders for
query pushdown, where the viewer would ask the storage to count or search
instead of scanning the mirror. Version 1 never calls them, and the `fields`
record property is likewise reserved. Do not use these names for other
purposes.
