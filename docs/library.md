# Library

`createLogViewer()` builds a complete log viewer (HTTP API, WebSocket live
updates and the web UI) inside your Node.js process. You can mount it under
any path of an existing app, decide access with your own authorization, and
feed it from the same process. A runnable example is in
[examples/minimal-embed](../examples/minimal-embed/).

## Install

```bash
npm install @kevinwang15/log-viewer
```

The package needs Node.js 20 or later. It depends on `express`, `ws` and
`cors`, and it includes the built web UI, so there is no separate frontend
build. TypeScript declarations are included.

| Import path | Contents |
| --- | --- |
| `@kevinwang15/log-viewer` | `createLogViewer`, the provider SPI, `MemoryProvider`, `keyAuthorizer`, `BaseSource`, types, `DEFAULTS`, `configFromEnv` |
| `@kevinwang15/log-viewer/provider` | The provider SPI only (`defineProvider`, `ProviderError`, `CursorExpiredError`, types) |
| `@kevinwang15/log-viewer/testing` | `checkProvider` for provider conformance tests |

## Quick start

```js
import { createLogViewer } from '@kevinwang15/log-viewer';

const viewer = createLogViewer();
const { url } = await viewer.listen(5178, '127.0.0.1');
viewer.streams.append('app', ['2026-07-13 10:00:00,000 [main] INFO App - started']);
console.log(`log viewer on ${url}`);
```

Open the URL and select the `app` stream.

## Options

`createLogViewer(options)` accepts `LogViewerOptions`. Every option is
optional.

| Option | Type | Default | Meaning |
| --- | --- | --- | --- |
| `auth` | `{ viewKey?, streamKey?, streamTokens? }` | no keys | Built-in key scheme. Ignored when `authorize` is set. See [Security](security.md). |
| `authorize` | `Authorizer` | `keyAuthorizer(auth)` | Your own authorization for every protected operation. |
| `cors` | `boolean \| { origins: string[] }` | `false` | `false`: same-origin only. `true`: any origin. `{ origins }`: an allow-list; `'*'` allows any. |
| `maxPayloadBytes` | `number` | 2 MiB | Max JSON body and WebSocket message size. |
| `streams` | `false \| StreamsOptions` | enabled | Push streams over HTTP, WebSocket and `viewer.streams`. |
| `files` | `false \| FilesOptions` | disabled | Browse and open files under a root directory. |
| `merge` | `boolean` | `true` | Merged views over several open sources. |
| `remote` | `false \| RemoteOptions` | disabled | Mirrors of sources on other log-viewer instances. |
| `providers` | `LogProvider[]` | `[]` | Your log storage. See [Providers](providers.md). |
| `providerOptions` | `ProvidersOptions` without `providers` | see [Providers](providers.md#registration) | Mirror limits, polling, `maxOpen`, `autoOpen`, catalog cache. |
| `ui` | `boolean \| { dir: string }` | `true` | `true` serves the bundled UI, `{ dir }` serves your own build, `false` serves the API only. |
| `version` | `string` | package version | Reported as `serviceVersion` in `GET /api/v1/capabilities`. |
| `logger` | `{ log, warn, error }` | `console` | Where the viewer writes its messages. |
| `ids` | `(prefix: string) => string` | `f1`, `f2`, ... per instance | Id generator for opened files (`'f'`), merged views (`'m'`) and remote mirrors (`'r'`). Streams (`s:<channel>`) and provider logs (`p:<provider>:<log>`) have fixed ids. |

`StreamsOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `maxSources` | 16 | Max streams. 0 means unlimited. Creating one more fails with 503 `stream_capacity_reached`. |
| `maxEntries` | 100000 | Entries kept per stream. 0 means unlimited. |
| `maxBytes` | 32 MiB | Bytes kept per stream. 0 means unlimited. |
| `idleTtlSeconds` | 3600 | Streams with no producer activity and no subscriber for this long are removed. 0 means never. |
| `spoolDir` | none | Persist stream entries as per-channel NDJSON files here and recover them on `start()`. |
| `demo` | `false` | Keep a `demo` channel emitting sample lines. |

`FilesOptions`:

| Option | Default | Meaning |
| --- | --- | --- |
| `root` | required | Directory users may browse and open files from. |
| `samples` | none | `true` generates sample logs into `<root>/sample-logs`; a string generates them into that directory (also browsable). |
| `watch` | none | `{ globs, intervalMs = 5000, maxSources = 16 }`: auto-open files under `root` that match any glob. |
| `gzipMaxBytes` | 4 GiB | Cap on the decompressed size of gzipped logs. |

`RemoteOptions`: `maxEntries` (default 100000, 0 means unbounded) entries kept
per remote mirror.

The library defaults differ from the CLI. A library viewer has files off,
remote mirrors off, CORS off, merged views on, streams on (without the demo
channel), and the UI on. The CLI turns on files (rooted at `LOG_ROOT`),
remote mirrors, sample logs and the demo stream, and allows CORS from any
origin unless `NODE_ENV=production` or `CORS_ORIGIN` is set. See
[Configuration](configuration.md) for the env vars that map to these
options.

If `ui: true` and the bundled UI is not found (for example when running from
a source checkout that was not built), the viewer serves the API only.

## The LogViewer handle

| Member | Meaning |
| --- | --- |
| `handler` | A Connect/Express-style request handler `(req, res, next?)`. Mount it in an app, or pass it to `http.createServer`. |
| `attach(server, { path? })` | Serves WebSocket live updates on `path` (default `'/ws'`) of an existing `http.Server`. Other upgrade paths are left to their owners. |
| `listen(port?, host?)` | Standalone mode: creates an HTTP server, attaches the WebSocket on `/ws`, calls `start()` and listens. Resolves `{ server, port, url }`. |
| `start()` | Runs start hooks. Idempotent. |
| `close()` | Stops the viewer and releases its resources. |
| `addSource(src, { alias?, origin? })` | Registers a source you built yourself. |
| `streams` | In-process stream ingestion. `undefined` when `streams: false`. |
| `files` | Programmatic file opening. `undefined` unless `files` is set. |
| `registerProvider(provider)` | Adds a provider after creation. Throws on an unsupported `apiVersion`, an invalid id or a duplicate id. |
| `openProviderLog(providerId, logId)` | Opens (or returns the open) mirror of a provider log. Rejects with an error carrying an HTTP `status`. |
| `store` | Experimental. The underlying store of sources, filters, rules and bookmarks. Its API may change in minor releases. |

`streams`:

- `append(channel, items)` appends to a channel, creating it when needed.
  `items` is either an array of strings (raw lines, parsed like any log
  file) or an array of entries `{ time?, level?, thread?, logger?, message }`.
  It returns the stream source (id `s:<channel>`). Channel names must match
  `[A-Za-z0-9][A-Za-z0-9._:-]{0,127}`; others throw.
- `delete(channel)` removes the stream and resolves `true` if it existed.
- `registry` is the underlying stream registry.

`files.open(filePath, range?, origin?)` opens a file, or returns the source
already open for the same path and range. `range` is `{ start?, end? }` in
bytes; byte ranges are rejected for gzipped files. Errors carry an HTTP
`status` (404 when the file does not exist). The root check applies only to
the HTTP routes, so validate paths yourself before passing user input.

## Mounting under a prefix

```js
import express from 'express';
import http from 'node:http';
import { createLogViewer } from '@kevinwang15/log-viewer';

const viewer = createLogViewer({ authorize: myAuthorizer });

const app = express();
app.use('/logs', viewer.handler);

const server = http.createServer(app);
viewer.attach(server, { path: '/logs/ws' });
await viewer.start();
server.listen(3000);
```

The pieces:

- The HTTP handler serves the UI and the API under the mount path, for
  example `/logs/api/v1/capabilities`.
- The UI derives its API base from its own URL, the directory of the page.
  Served at `/logs/`, it calls `/logs/api/...` and opens its WebSocket at
  `/logs/ws`. So the WebSocket path must be `<prefix>/ws`.
- `GET /logs` redirects with 301 to `/logs/` (keeping the query string), so
  the UI's relative asset URLs resolve inside the prefix.
- `attach` uses its own upgrade listener and ignores other paths. Your app's
  own WebSocket servers on other paths keep working on the same server.
- With `handler` and `attach`, you call `start()` yourself. `listen()` does it
  for you.

Behind a reverse proxy that strips the prefix, mount at the root instead and
let the proxy forward both HTTP and the WebSocket upgrade. See
[Operations](operations.md).

## Standalone

```js
const viewer = createLogViewer({ files: { root: '/var/log' } });
const { server, port, url } = await viewer.listen(5178, '127.0.0.1');
```

`listen()` with no port picks a free port. With no host, Node listens on all
interfaces; pass `'127.0.0.1'` to stay on loopback. `url` uses `localhost`
unless you pass a specific host. `close()` closes the server that `listen()`
created.

## Lifecycle

`start()` runs each module's start hook once and returns the same promise on
later calls:

- Streams: recover spooled entries from `spoolDir`, start the demo channel if
  enabled, and start the idle-stream sweep.
- Files: generate sample logs if enabled, and start the directory watch.
- Providers: open the `autoOpen` logs. Failures are logged, not thrown.

The HTTP routes work before `start()`, but spooled streams are not recovered
and idle streams are not removed until it runs.

`close()`:

1. Runs the stop hooks in reverse order. This stops the demo channel, the
   idle sweep and the directory watch, closes every provider mirror (calling
   each handle's `close()`), then calls each provider's `close()`.
2. Closes WebSocket connections and removes the viewer's upgrade listeners.
3. Removes all sources. Spool files stay on disk, and pending spool writes
   are flushed, so a later viewer with the same `spoolDir` recovers them.
4. Closes the HTTP server created by `listen()`, including open connections.
   A server you passed to `attach()` is left running.

`close()` never calls `process.exit`. A second call does nothing. Do not
reuse a closed viewer; create a new one.

```js
process.on('SIGTERM', async () => {
  await viewer.close(); // the viewer's sources, sockets and timers
  server.close();       // your own server, when you used attach()
});
```

## In-process ingestion

Producers in the same process can write directly, with no HTTP round trip
and no stream key:

```js
viewer.streams.append('checkout', [
  { level: 'INFO', logger: 'checkout', message: 'order 42 placed' },
  { time: '2026-07-13T10:00:01Z', level: 'WARN', message: 'payment retry' },
]);
viewer.streams.append('worker', ['2026-07-13 10:00:02,000 [w-1] ERROR Job - failed']);
```

Entries without `time` get the current time. Stream retention, capacity and
idle limits from `StreamsOptions` apply as for HTTP producers. If you only
ingest in-process, deny the `ingest` action in your authorizer so HTTP and
WebSocket producers cannot write, as
[examples/minimal-embed](../examples/minimal-embed/server.mjs) does.

To serve your own storage instead of pushing copies of records, write a
[provider](providers.md).

## Custom sources

Any object that implements `LogSource` can be registered with `addSource`.
`BaseSource` implements the generic parts (events, `stats`, criteria
evaluation, `getMessages`, `statsOf`). A source is a dense list of entries
addressed `0..count-1`. It emits `'append'` when entries were added at the
end and `'reset'` when anything else changed.

```ts
import { BaseSource, createLogViewer, type AppendEvent, type EntryOut } from '@kevinwang15/log-viewer';

class ArraySource extends BaseSource {
  readonly kind = 'array';
  private entries: EntryOut[] = [];

  constructor(readonly id: string, readonly name: string) {
    super();
  }

  get count() { return this.entries.length; }
  get formatName() { return 'array'; }
  get threadList() { return [...new Set(this.entries.map((e) => e.th))]; }
  get loggerList() { return [...new Set(this.entries.map((e) => e.lg))]; }
  levelAt(i: number) { return this.entries[i].lv; }
  threadAt(i: number) { return this.entries[i].th; }
  loggerAt(i: number) { return this.entries[i].lg; }
  timeAt(i: number) { return this.entries[i].t; }

  async getEntries(idxs: number[]) {
    // Copies: the entries route adds an `elapsed` field to what it gets.
    return idxs.filter((i) => i >= 0 && i < this.count).map((i) => ({ ...this.entries[i] }));
  }
  async scanTexts(cb: (i: number, raw: string) => boolean | void, from = 0, to = this.count) {
    for (let i = Math.max(0, from); i < Math.min(to, this.count); i++) if (cb(i, this.entries[i].raw) === false) return;
  }
  async close() { this.entries = []; }

  push(e: Omit<EntryOut, 'i'>) {
    const entry = { ...e, i: this.count };
    this.entries.push(entry);
    this.stats[entry.lv]++;
    this.emit('append', { startIdx: entry.i, added: 1, entries: [entry] } satisfies AppendEvent);
  }
}

const viewer = createLogViewer();
const src = new ArraySource('a:jobs', 'Jobs');
viewer.addSource(src);
src.push({ t: Date.now(), lv: 2, th: 'main', lg: 'jobs', msg: 'started', raw: 'started' });
```

Source ids must be unique within the viewer; a source with an existing id
replaces the old one. Pick a prefix that does not collide with the built-in
ids (`f`, `m`, `r` followed by digits, `s:`, `p:`). `alias` registers a lookup
key (files use their path), and `origin` is reported in the source info.

## Several instances

Nothing in the viewer is global. Each `createLogViewer()` call has its own
sources, id counters, authorizer and WebSocket hub. Mount each instance under
its own prefix with its own WebSocket path:

```js
const internal = createLogViewer({ files: { root: '/var/log/app' } });
const partners = createLogViewer({ providers: [partnerProvider], authorize: partnerAuth });

app.use('/logs/internal', internal.handler);
app.use('/logs/partners', partners.handler);
internal.attach(server, { path: '/logs/internal/ws' });
partners.attach(server, { path: '/logs/partners/ws' });
await Promise.all([internal.start(), partners.start()]);
```

## TypeScript

All option, handle and SPI types are exported:

```ts
import {
  createLogViewer,
  type LogViewer,
  type LogViewerOptions,
  type Authorizer,
  type AuthContext,
  type LogProvider,
  type LogSource,
  type StreamsOptions,
  type FilesOptions,
  type ProvidersOptions,
} from '@kevinwang15/log-viewer';

const options: LogViewerOptions = { streams: { maxSources: 4 }, ui: false };
const viewer: LogViewer = createLogViewer(options);
viewer.streams?.append('app', ['hello']); // `streams` is optional in the type
```

The declarations do not require `@types/express`. `handler` is typed with
Node's `IncomingMessage` and `ServerResponse`, so it is accepted by Express,
Connect and `http.createServer`.

## See also

- [Providers](providers.md) for your own storage.
- [Security](security.md) for the `authorize` hook and deployment.
- [Embedding the UI](embedding-ui.md) for the iframe and web component.
- [HTTP and WebSocket API](api.md) for the routes the handler serves.
