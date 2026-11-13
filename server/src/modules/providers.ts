// Providers: plug-in log storage (databases, services) behind the provider
// SPI. Lists each provider's log catalog and opens logs as live mirrors.

import { DEFAULTS } from '../config';
import { ProviderSource, providerSourceId, ProviderSourceOptions } from '../provider/source';
import { LogDescriptor, LogProvider, PROVIDER_API_VERSION, ProviderError } from '../provider/spi';
import type { ModuleContext, ViewerModule } from '../module';

export interface ProvidersOptions extends Omit<ProviderSourceOptions, 'logger'> {
  providers?: LogProvider[];
  // Max provider logs open at once (0 = unlimited).
  maxOpen?: number;
  // Logs opened at start().
  autoOpen?: Array<{ provider: string; log: string }>;
  // How long a provider's catalog is cached.
  catalogTtlMs?: number;
}

export interface ProvidersApi {
  register(provider: LogProvider): void;
  // Opens (or returns the already open) mirror of a provider log.
  open(providerId: string, logId: string): Promise<ProviderSource>;
}

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;

function httpError(status: number, message: string, code?: string) {
  return Object.assign(new Error(message), { status, code });
}

export function providersModule(ctx: ModuleContext, opts: ProvidersOptions = {}): ViewerModule & ProvidersApi {
  const { router: app, store, wrap, sourceInfo } = ctx;
  const providers = new Map<string, LogProvider>();
  const catalogs = new Map<string, { at: number; logs: Promise<LogDescriptor[]> }>();
  const opening = new Map<string, Promise<ProviderSource>>();
  const maxOpen = opts.maxOpen ?? DEFAULTS.providerMaxOpen;
  const ttl = opts.catalogTtlMs ?? 10_000;

  function register(provider: LogProvider) {
    if (provider.apiVersion !== PROVIDER_API_VERSION) {
      throw new Error(`provider ${provider.id}: unsupported apiVersion ${String(provider.apiVersion)} (expected ${PROVIDER_API_VERSION})`);
    }
    if (!ID_RE.test(provider.id)) throw new Error(`provider id ${JSON.stringify(provider.id)} must match [A-Za-z0-9._-]{1,64}`);
    if (providers.has(provider.id)) throw new Error(`provider ${provider.id} is already registered`);
    providers.set(provider.id, provider);
  }
  for (const p of opts.providers ?? []) register(p);

  function catalog(provider: LogProvider, fresh = false): Promise<LogDescriptor[]> {
    const hit = catalogs.get(provider.id);
    if (hit && !fresh && Date.now() - hit.at < ttl) return hit.logs;
    const logs = Promise.resolve(provider.listLogs()).then((list) => (Array.isArray(list) ? list : []));
    catalogs.set(provider.id, { at: Date.now(), logs });
    logs.catch(() => catalogs.delete(provider.id));
    return logs;
  }

  function openCount() {
    let n = 0;
    for (const src of store.sources.values()) if (src instanceof ProviderSource) n++;
    return n;
  }

  async function open(providerId: string, logId: string): Promise<ProviderSource> {
    const provider = providers.get(providerId);
    if (!provider) throw httpError(404, 'unknown provider ' + providerId);
    const id = providerSourceId(providerId, logId);
    const existing = store.sources.get(id);
    if (existing instanceof ProviderSource) return existing;
    const inflight = opening.get(id);
    if (inflight) return inflight;
    if (maxOpen > 0 && openCount() >= maxOpen) {
      throw httpError(429, `too many provider logs open (max ${maxOpen})`, 'provider_capacity_reached');
    }
    const task = (async () => {
      let desc = (await catalog(provider)).find((l) => l.id === logId);
      if (!desc) desc = (await catalog(provider, true)).find((l) => l.id === logId);
      if (!desc) throw httpError(404, `unknown log ${logId} in provider ${providerId}`);
      const src = await ProviderSource.open(provider, desc, { ...opts, logger: ctx.logger });
      store.addSource(src);
      return src;
    })();
    opening.set(id, task);
    try {
      return await task;
    } finally {
      opening.delete(id);
    }
  }

  app.get('/api/v1/providers', (_req, res) => {
    res.json({ providers: [...providers.values()].map((p) => ({ id: p.id, name: p.name ?? p.id, capabilities: p.capabilities ?? {} })) });
  });

  app.get(
    '/api/v1/providers/:pid/logs',
    wrap(async (req, res) => {
      const provider = providers.get(req.params.pid);
      if (!provider) {
        res.status(404).json({ error: 'unknown provider ' + req.params.pid });
        return;
      }
      let logs: LogDescriptor[];
      try {
        logs = await catalog(provider, req.query.fresh === '1');
      } catch (err) {
        res.status(502).json({ error: `provider ${provider.id} failed to list logs: ${(err as Error).message}` });
        return;
      }
      res.json({
        logs: logs.map((l) => ({ ...l, open: store.sources.has(providerSourceId(provider.id, l.id)) || undefined })),
      });
    })
  );

  app.post(
    '/api/v1/providers/:pid/logs/:logId/open',
    wrap(async (req, res) => {
      if (!(await ctx.allow(req, res, 'open'))) return;
      try {
        res.json(sourceInfo(await open(req.params.pid, req.params.logId)));
      } catch (err) {
        const e = err as Error & { status?: number; code?: string };
        const status = e instanceof ProviderError ? (e.status ?? 502) : (e.status ?? 500);
        if (status >= 500 && !(e instanceof ProviderError)) throw err;
        res.status(status).json({ error: e.message, code: (e as { code?: string }).code });
      }
    })
  );

  return {
    name: 'providers',
    register,
    open,
    capabilities: () => ({
      providers: [...providers.values()].map((p) => ({ id: p.id, name: p.name ?? p.id, capabilities: p.capabilities ?? {} })),
      maxOpen,
    }),
    health: () => ({ providerLogs: openCount() }),
    async start() {
      for (const { provider, log } of opts.autoOpen ?? []) {
        await open(provider, log).catch((err) => ctx.logger.error(`auto-open ${provider}/${log} failed:`, (err as Error).message));
      }
    },
    async stop() {
      // Close the mirrors (and their handles) before their providers.
      for (const src of [...store.sources.values()]) {
        if (src instanceof ProviderSource) await store.removeSource(src.id).catch(() => {});
      }
      for (const p of providers.values()) await p.close?.().catch(() => {});
    },
  };
}
