# Getting started

This guide runs log-viewer, opens a file, pushes a live stream, and connects the SQLite provider example. Each step takes a minute or two.

## Run it

Pick one of the three ways below. All of them serve the UI and the API on one port, 5178 by default.

### From the repository

```bash
git clone https://github.com/KevinWang15/log-viewer.git
cd log-viewer
npm install
npm run dev
```

`npm run dev` starts the backend on port 5178 and the Vite dev server on port 5173. Open http://localhost:5173. The dev server forwards `/api` and `/ws` to the backend.

For a production build, run `npm run build` and then `npm start`. The backend then serves the built UI itself on http://localhost:5178.

### With Docker

```bash
docker run --rm -p 5178:5178 -v /var/log:/logs:ro ghcr.io/kevinwang15/log-viewer:latest
```

The image sets `LOG_ROOT=/logs`, so the mounted directory is what you can browse. Open http://localhost:5178. For a production deployment (keys, loopback binding, limits), see [Operations](operations.md).

### With npx

```bash
LOG_ROOT=/var/log npx @kevinwang15/log-viewer
```

This needs Node.js 20 or later. The package installs a `log-viewer` command, so a global install (`npm install -g @kevinwang15/log-viewer`, then `log-viewer`) works the same way. `LOG_ROOT` defaults to your home directory and `PORT` to 5178. On first start the CLI writes sample logs into `./sample-logs` under the current directory; set `ENABLE_SAMPLES=false` to skip that. [Configuration](configuration.md) lists every env var.

## Open a file

1. Click **File** in the menu bar, or **Open log file** on the welcome screen.
2. Browse to a file under the root directory and click it. Click **Samples** to jump to the generated sample logs (`app.log`, `client.log`, `server.log`).
3. The file opens in the grid and appears in the source tree on the left, together with its active filters. The format is detected from the first lines.

Things to try next:

- Click the colored level dots in the toolbar to hide or show levels. Type in the **Filter text** box and press Enter to filter by text.
- Right-click a row to filter by its thread, logger, level, time or correlation id.
- Type in the **Find** box and press F3 to jump to the next match without filtering. Press Ctrl+B to bookmark the selected row.
- Turn on follow (the "Tail: follow new entries" button) to stick to the bottom as the file grows.
- Open a second file and click the "Merge all open logs by time" button to see both in one view.

Files larger than 128 MB open a part picker that splits the file into 100 MB parts. Gzipped files open like plain ones. See [Sources](sources.md#files) for details.

## Push a stream

A stream is a named live channel that producers write to. Create the channel, then append lines:

```bash
curl -X PUT http://localhost:5178/api/v1/streams/myapp

curl -X POST http://localhost:5178/api/v1/streams/myapp/entries \
  -H 'content-type: application/json' \
  -d '{"lines":["2026-07-13 10:00:00,000 [main] INFO App - hello world"]}'
```

Appends to a channel that was never created return `404`. Structured entries work too:

```bash
curl -X POST http://localhost:5178/api/v1/streams/myapp/entries \
  -H 'content-type: application/json' \
  -d '{"entries":[{"level":"WARN","logger":"Auth","message":"token expires soon"}]}'
```

To view the stream, click the **Open live stream** toolbar button and enter `myapp`, or open the compact widget at http://localhost:5178/embed.html?channel=myapp. The `demo` channel emits sample lines continuously when the demo is enabled, which the CLI does by default.

When the server sets `STREAM_KEY`, the `PUT` and `POST` calls need an `x-stream-key` header. See [Sources](sources.md#streams) for the full lifecycle and [Security](security.md) for keys.

## Connect the SQLite example

The SQLite example shows a provider that reads logs from a database table. It uses Node's built-in `node:sqlite` module, which needs Node.js 22.13 or later.

```bash
npm run build                      # from the repo root, once
cd examples/sqlite-provider
node seed.mjs logs.db              # creates the table and keeps inserting rows
node server.mjs logs.db            # in a second terminal
```

Open http://localhost:5180 and click **File**. The open dialog shows the **Catalog** tab, with one log per service (`api`, `billing`, `worker`). Pick one. New rows appear live because the viewer polls the provider for records after the last one it has.

[Database providers](providers-database.md) walks through the provider code. [Providers](providers.md) is the reference for writing your own.

## Embed the UI

You can show a stream inside another page with an iframe:

```html
<iframe src="http://localhost:5178/embed.html?channel=myapp"
        style="width:100%;height:400px;border:1px solid #ccc"></iframe>
```

[Embedding the UI](embedding-ui.md) covers the iframe parameters, the `<log-viewer>` web component, and the `postMessage` bridge.

## Next steps

- [Concepts](concepts.md) explains sources, filters, live updates and retention.
- [Library](library.md) shows how to mount log-viewer inside your own Node.js app with `createLogViewer()`.
- [Configuration](configuration.md) and [Operations](operations.md) cover deployment.
