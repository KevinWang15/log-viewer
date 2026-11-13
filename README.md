<p align="center"><img src="docs/logo.png" width="160" alt="log-viewer logo"></p>

# log-viewer

log-viewer is a browser-based log viewer with a Node.js backend. The server indexes, parses, filters and tails the logs; the browser only fetches the rows on screen, so multi-GB files stay responsive. It reads local files, live streams pushed over HTTP or WebSocket, mirrors of other log-viewer instances, and your own log storage (for example a database) through a small provider API. You can run it as a standalone app, embed its UI in another site, or mount it inside your own Node.js server.

## Ways to use it

| Mode | How | Guide |
|---|---|---|
| Standalone app | Docker image `ghcr.io/kevinwang15/log-viewer`, `npx @kevinwang15/log-viewer`, or the `log-viewer` CLI, configured with env vars | [Getting started](docs/getting-started.md) |
| Embedded UI | An iframe (`embed.html?channel=…`) or the `<log-viewer>` web component, driven over `postMessage` or DOM events | [Embedding the UI](docs/embedding-ui.md) |
| Library | `createLogViewer()` in your Node.js app, mounted under any path, with your own authorization | [Library](docs/library.md) |
| Data sources | Files, push streams, merged views, remote mirrors, and providers (for example a database) | [Sources](docs/sources.md), [Providers](docs/providers.md) |

## 60-second start

Docker, with your host's `/var/log` as the browsable root:

```bash
docker run --rm -p 5178:5178 -v /var/log:/logs:ro ghcr.io/kevinwang15/log-viewer:latest
# open http://localhost:5178
```

npx (Node.js 20 or later). The CLI is named `log-viewer` and reads env vars such as `LOG_ROOT` (default: your home directory) and `PORT` (default 5178):

```bash
LOG_ROOT=/var/log npx @kevinwang15/log-viewer
```

As a library, with an in-memory provider:

```js
import { createLogViewer, MemoryProvider } from '@kevinwang15/log-viewer';

const jobs = new MemoryProvider('jobs', { name: 'Background jobs' });
jobs.addLog({ id: 'nightly', name: 'Nightly export' });

const viewer = createLogViewer({ providers: [jobs] });
const { url } = await viewer.listen(5178);
console.log(`log viewer on ${url}`); // File ▸ Catalog ▸ Nightly export

jobs.push('nightly', [{ time: Date.now(), level: 'INFO', message: 'export started' }]);
```

To feed a database instead, see [examples/sqlite-provider](examples/sqlite-provider/) and [Database providers](docs/providers-database.md).

## Features

- **Parsing.** Auto-detects log4j-style layouts, JSON lines, syslog (RFC 3164 and RFC 5424) and plain text. A custom log4j-style conversion pattern (`%d [%t] %-5p %c - %m`) covers other layouts.
- **Multiline entries.** Stack traces and XML/JSON payloads stay grouped with the line that starts the entry.
- **Filters.** Combine levels, text, thread, logger and time range; the API also takes regex, case-sensitive and exclude options. Filters run on the server and update as new entries arrive.
- **Merge.** Combine open logs into one time-ordered view. Live appends flow through the merge.
- **Tail and follow.** New entries are indexed incrementally. Follow mode sticks to the bottom: scrolling up pauses it and scrolling back down resumes it. File truncation is detected and the file is re-indexed.
- **Large files.** The index keeps only numbers per entry and the text stays on disk. Files over 128 MB can be opened in 100 MB parts ("Open part of file").
- **Find.** F3 and Shift+F3 search the current view on the server without changing the filter.
- **Bookmarks.** Ctrl+B, gutter flags, and next/previous navigation.
- **Highlight rules.** Local rules color matching rows in your browser. Server rules can also highlight, bookmark, or call a webhook when new entries match.
- **Minimap.** A strip next to the grid shows warnings, errors and bookmarks across the whole view.
- **Report.** Level histogram over time, top loggers, threads and message templates. The API also returns the histogram as CSV.
- **Correlation.** Right-click an entry and choose "Filter by correlation" to see every entry that carries the same request, trace or session id.
- **Syntax highlighting.** XML and JSON payloads are pretty-printed and highlighted in the detail pane.
- **Save and load analysis.** Save open logs, filters, bookmarks and local rules to a file and load them later. Export the current view as plain text.
- **Gzip.** Gzipped logs (such as rotated `.log.gz` files) open transparently.
- **Directory watch.** Files under the root that match globs such as `**/*.log` open automatically.
- **Spooling.** With `SPOOL_DIR` set, stream entries are written to disk and restored after a restart.

## Documentation

| Document | Contents |
|---|---|
| [Getting started](docs/getting-started.md) | Run it, open a file, push a stream, connect the SQLite example |
| [Concepts](docs/concepts.md) | Sources, the entry index model, filters, live updates, rules, retention, modules, authorization |
| [Sources](docs/sources.md) | Files, streams, merged views, remote mirrors and providers, with a feature comparison |
| [Providers](docs/providers.md) | Provider SPI reference: `listLogs`, `list`, `tail`, `watch`, errors, conformance checks |
| [Database providers](docs/providers-database.md) | SQLite walkthrough and Postgres `LISTEN/NOTIFY` |
| [Library](docs/library.md) | `createLogViewer()`, mounting under a path, the `authorize` hook, lifecycle |
| [Embedding the UI](docs/embedding-ui.md) | Iframe, web component and the `postMessage` bridge |
| [HTTP and WebSocket API](docs/api.md) | Every route and message type |
| [OpenAPI spec](docs/openapi.yaml) | Machine-readable API description |
| [Configuration](docs/configuration.md) | All env vars and library options with defaults |
| [Operations](docs/operations.md) | Docker, reverse proxy, health checks, spooling, sizing |
| [Security](docs/security.md) | Keys, scoped tokens, deployment boundary |
| [Development](docs/development.md) | Building, tests, benchmarks |
| [Changelog](CHANGELOG.md) | Release notes |

Examples: [examples/sqlite-provider](examples/sqlite-provider/) (a provider backed by a SQLite table) and [examples/minimal-embed](examples/minimal-embed/) (log-viewer mounted in an Express app behind its login).

## License

MIT. See [LICENSE](LICENSE).
