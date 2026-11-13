// createLogViewer(): builds a self-contained log viewer (HTTP API, WebSocket
// live updates, optional web UI) from options. Nothing is global: several
// viewers can run in one process, mounted under any path of a host app.
//
//   const viewer = createLogViewer({ providers: [myProvider] });
//   app.use('/logs', viewer.handler);
//   viewer.attach(httpServer, { path: '/logs/ws' });
//   await viewer.start();
//
// or standalone: `await viewer.listen(5178)`.

import express, { NextFunction, Request, Response } from 'express';
import cors from 'cors';
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import { AuthAction, AuthContext, AuthDecision, Authorizer, denial, keyAuthorizer, STREAM_DENIED, VIEW_DENIED } from './auth';
import { DEFAULTS, ScopedStreamToken } from './config';
import type { LogSource } from './source-api';
import { Store, StoreCapacityError } from './store';
import { WsHub } from './ws-hub';
import type { ModuleContext, ViewerModule } from './module';
import { coreModule, ruleInfo } from './modules/core';
import { filesModule } from './modules/files';
import { streamsModule } from './modules/streams';
import { mergeModule } from './modules/merge';
import { remoteModule } from './modules/remote';
import { providersModule } from './modules/providers';
import type { FileOpener, FilesOptions, Logger, ProvidersApi, ProvidersOptions, RemoteOptions, StreamsApi, StreamsOptions } from './options';
import type { LogProvider } from './provider/spi';

export interface LogViewerOptions {
  // Built-in key scheme (see auth.ts). Ignored when `authorize` is given.
  auth?: { viewKey?: string; streamKey?: string; streamTokens?: ScopedStreamToken[] };
  // Replaces the key scheme with your own authorization.
  authorize?: Authorizer;
  // CORS for the API: false (default, same-origin only), true (any origin),
  // or an allow-list of origins ('*' allows any).
  cors?: boolean | { origins: string[] };
  // Max JSON body / WebSocket message size.
  maxPayloadBytes?: number;
  // Push streams (HTTP/WS/in-process ingestion). Enabled by default.
  streams?: false | StreamsOptions;
  // Local files. Disabled by default; requires a root directory.
  files?: false | FilesOptions;
  // Merged views over open sources. Enabled by default.
  merge?: boolean;
  // Mirrors of sources on peer log-viewer instances. Disabled by default.
  remote?: false | RemoteOptions;
  // Your log storage behind the provider SPI (see provider/spi.ts).
  providers?: LogProvider[];
  // Mirror limits, polling, catalog cache and auto-open for provider logs.
  providerOptions?: Omit<ProvidersOptions, 'providers'>;
  // Serve the web UI: true (default) uses the bundled build, or { dir }.
  ui?: boolean | { dir: string };
  // Reported as serviceVersion in capabilities.
  version?: string;
  logger?: Logger;
  // Id generator for opened sources ('f' files, 'm' merges, 'r' remotes).
  ids?: (prefix: string) => string;
}

export type RequestHandler = (req: http.IncomingMessage, res: http.ServerResponse, next?: (err?: unknown) => void) => void;

export interface LogViewer {
  // Mount in any Connect/Express-style app: app.use('/logs', viewer.handler).
  readonly handler: RequestHandler;
  // Serves live updates on `path` (default '/ws') of an existing HTTP server.
  // Mounted under a prefix, use '<prefix>/ws'.
  attach(server: http.Server, opts?: { path?: string }): void;
  // Standalone: creates an HTTP server, attaches, starts and listens.
  listen(port?: number, host?: string): Promise<{ server: http.Server; port: number; url: string }>;
  // Runs start hooks (spool recovery, watchers, demo). Idempotent.
  start(): Promise<void>;
  // Stops timers and sockets, closes all sources and the owned server.
  close(): Promise<void>;
  // Registers a source you created yourself (any LogSource implementation).
  addSource(src: LogSource, opts?: { alias?: string; origin?: string }): void;
  // In-process stream ingestion (when streams are enabled).
  readonly streams?: StreamsApi;
  // Programmatic file opening (when files are enabled).
  readonly files?: FileOpener;
  // Registers a provider after creation (its logs appear in the catalog).
  registerProvider(provider: LogProvider): void;
  // Opens (or returns) the live mirror of a provider log.
  openProviderLog(providerId: string, logId: string): Promise<LogSource>;
  /** @experimental The underlying store (sources, filters, rules, bookmarks). */
  readonly store: Store;
}

// Packaged UI (next to dist/ in the npm package), then the monorepo build.
function defaultUiDir(): string | null {
  for (const dir of [path.resolve(__dirname, '..', 'ui'), path.resolve(__dirname, '..', '..', 'web', 'dist')]) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

function credentialsOf(req: Request) {
  const header = req.get('x-view-key');
  return {
    viewKey: header ?? (typeof req.query.viewKey === 'string' ? req.query.viewKey : undefined),
    streamKey: req.get('x-stream-key'),
  };
}

function fallbackDenial(action: AuthAction) {
  if (action === 'read') return VIEW_DENIED;
  if (action === 'ingest' || action === 'configure') return STREAM_DENIED;
  return { status: 403, error: 'forbidden' };
}

export function createLogViewer(options: LogViewerOptions = {}): LogViewer {
  const logger = options.logger ?? console;
  const maxPayloadBytes = options.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes;
  const authorize = options.authorize ?? keyAuthorizer(options.auth);
  const store = new Store();
  store.logger = logger;
  const hub = new WsHub(store, authorize, maxPayloadBytes, logger);
  // An Express sub-application (not a bare Router) so req/res helpers exist
  // whether it is mounted in an Express app or used as a plain Node handler.
  const router = express();
  router.disable('x-powered-by');

  const counters = new Map<string, number>();
  const nextId =
    options.ids ??
    ((prefix: string) => {
      const n = (counters.get(prefix) ?? 0) + 1;
      counters.set(prefix, n);
      return prefix + n;
    });

  // Mounted under a prefix, the UI needs a trailing slash so its relative
  // asset URLs resolve inside the prefix.
  router.use((req, res, next) => {
    if (req.baseUrl && req.method === 'GET' && req.path === '/' && !req.originalUrl.split('?')[0].endsWith('/')) {
      const q = req.originalUrl.indexOf('?');
      res.redirect(301, req.baseUrl + '/' + (q === -1 ? '' : req.originalUrl.slice(q)));
      return;
    }
    next();
  });
  if (options.cors === true) router.use(cors());
  else if (options.cors && options.cors.origins.length) {
    const origins = options.cors.origins;
    router.use(
      cors({
        origin(origin, callback) {
          if (!origin || origins.includes('*') || origins.includes(origin)) callback(null, true);
          else callback(Object.assign(new Error('origin is not allowed by CORS policy'), { status: 403 }));
        },
      })
    );
  }
  router.use(express.json({ limit: maxPayloadBytes }));

  const authContext = (req: Request, action: AuthAction, target?: { source?: LogSource; channel?: string }): AuthContext => ({
    action,
    transport: 'http',
    source: target?.source ? { id: target.source.id, kind: target.source.kind, name: target.source.name } : undefined,
    channel: target?.channel,
    credentials: credentialsOf(req),
    headers: req.headers,
    req,
  });

  const ctx: ModuleContext = {
    router,
    store,
    hub,
    logger,
    nextId,
    sourceInfo: (src) => ({
      id: src.id,
      kind: src.kind,
      name: src.name,
      count: src.count,
      stats: src.stats,
      threads: src.threadList,
      loggers: src.loggerList,
      format: src.formatName,
      ...src.describe?.(),
      origin: store.originFor(src.id),
      rules: store.rulesFor(src.id).map(ruleInfo),
    }),
    check: async (req, action, target): Promise<AuthDecision> => authorize(authContext(req, action, target)),
    async allow(req, res, action, target) {
      const denied = denial(await authorize(authContext(req, action, target)), fallbackDenial(action));
      if (!denied) return true;
      res.status(denied.status).json({ error: denied.error, code: denied.code });
      return false;
    },
    checkWs: async (ws, action, target) =>
      authorize({
        action,
        transport: 'ws',
        source: target.source ? { id: target.source.id, kind: target.source.kind, name: target.source.name } : undefined,
        channel: target.channel,
        credentials: target.credentials,
        headers: ws.req.headers,
        req: ws.req,
      }),
    wrap: (fn) => (req, res, next) => {
      fn(req, res).catch(next);
    },
    sourceOr404(req, res) {
      const src = store.sources.get(req.params.id);
      if (!src) res.status(404).json({ error: 'unknown log ' + req.params.id });
      return src ?? null;
    },
  };

  // Every GET/HEAD API read goes through the authorizer, with the targeted
  // source (or stream channel) resolved from the path when there is one.
  router.use('/api', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const m = /^\/logs\/([^/]+)/.exec(req.path) ?? null;
    const s = /^\/v1\/streams\/([^/]+)/.exec(req.path) ?? null;
    const source = m ? store.sources.get(decodeURIComponent(m[1])) : s ? store.sources.get('s:' + decodeURIComponent(s[1])) : undefined;
    ctx
      .allow(req, res, 'read', { source, channel: s ? decodeURIComponent(s[1]) : undefined })
      .then((ok) => ok && next())
      .catch(next);
  });

  const modules: ViewerModule[] = [coreModule(ctx)];
  const streams =
    options.streams === false
      ? undefined
      : streamsModule(ctx, {
          ...options.streams,
          maxPayloadBytes,
          mutationAuth: options.authorize
            ? 'custom'
            : options.auth?.streamKey || options.auth?.streamTokens?.length
              ? 'x-stream-key'
              : 'none',
        });
  if (streams) modules.push(streams);
  const files = options.files ? filesModule(ctx, options.files) : undefined;
  if (files) modules.push(files);
  if (options.merge !== false) modules.push(mergeModule(ctx));
  if (options.remote) modules.push(remoteModule(ctx, options.remote));
  const providers: ViewerModule & ProvidersApi = providersModule(ctx, { ...options.providerOptions, providers: options.providers });
  modules.push(providers);

  router.get('/api/v1/capabilities', (_req, res) => {
    res.setHeader('cache-control', 'no-store');
    const mods: Record<string, unknown> = {};
    for (const mod of modules) if (mod.name !== 'core') mods[mod.name] = mod.capabilities?.() ?? {};
    const streamCaps = streams?.capabilities?.() as { lifecycle: unknown; mutationAuth: string; limits: unknown } | undefined;
    res.json({
      service: 'log-viewer',
      serviceVersion: options.version || '0.1.0',
      apiVersion: 'v1',
      // Top-level stream fields predate `modules` and are kept for clients.
      streamLifecycle: streamCaps?.lifecycle,
      mutationAuth: streamCaps?.mutationAuth ?? (options.authorize ? 'custom' : 'none'),
      limits: streamCaps?.limits ?? { maxPayloadBytes },
      modules: mods,
    });
  });

  router.get('/healthz', (_req, res) => {
    const health: Record<string, unknown> = { ok: true, uptime: process.uptime(), sources: store.sources.size };
    for (const mod of modules) Object.assign(health, mod.health?.());
    res.json(health);
  });

  const uiDir = options.ui === false ? null : typeof options.ui === 'object' ? path.resolve(options.ui.dir) : defaultUiDir();
  if (uiDir) router.use(express.static(uiDir));

  router.use((err: Error & { status?: number; type?: string; code?: string }, _req: Request, res: Response, _next: NextFunction) => {
    logger.error(err);
    const status = err instanceof StoreCapacityError ? err.status : err.status || (err.type === 'entity.too.large' ? 413 : 500);
    const message = status >= 500 && !(err instanceof StoreCapacityError) ? 'internal server error' : err.message;
    res.status(status).json({ error: message, code: err instanceof StoreCapacityError ? err.code : undefined });
  });

  const handler = router as unknown as RequestHandler;

  let started: Promise<void> | null = null;
  let ownedServer: http.Server | null = null;
  let closed = false;

  const viewer: LogViewer = {
    handler,
    store,
    streams,
    files,
    attach: (server, opts) => hub.attach(server, opts?.path ?? '/ws'),
    start() {
      started ??= (async () => {
        for (const mod of modules) await mod.start?.();
      })();
      return started;
    },
    async listen(port = 0, host) {
      await viewer.start();
      const server = http.createServer(handler);
      ownedServer = server;
      hub.attach(server, '/ws');
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.off('error', reject);
          resolve();
        });
      });
      server.on('error', (err) => logger.error('HTTP server error:', err));
      const addr = server.address();
      const actual = typeof addr === 'object' && addr ? addr.port : port;
      return { server, port: actual, url: `http://${host && host !== '0.0.0.0' ? host : 'localhost'}:${actual}` };
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const mod of [...modules].reverse()) await mod.stop?.();
      await hub.close();
      // Spool files stay on disk (dropSpool: false); pending writes are flushed.
      for (const id of [...store.sources.keys()]) await store.removeSource(id, { dropSpool: false }).catch(() => {});
      await (streams as unknown as { flush?: () => Promise<void> } | undefined)?.flush?.();
      if (ownedServer) {
        const server = ownedServer;
        ownedServer = null;
        server.closeAllConnections?.();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
    registerProvider: (p) => providers.register(p),
    openProviderLog: (pid, logId) => providers.open(pid, logId),
    addSource(src, opts) {
      store.addSource(src, opts?.alias);
      if (opts?.origin) store.setOrigin(src.id, opts.origin);
    },
  };
  return viewer;
}
