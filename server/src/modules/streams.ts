// Streams: named live channels that producers push into over HTTP
// (/api/v1/streams/*), WebSocket (`publish`) or in-process
// (viewer.streams.append). Optional disk spooling, idle expiry and a demo
// channel.

import * as path from 'node:path';
import type { Request, Response } from 'express';
import { DEFAULTS } from '../config';
import type { StreamEntryInput, StreamSource } from '../sources';
import { StreamSpooler } from '../spool';
import { StoreCapacityError } from '../store';
import { StreamRegistry } from '../streams';
import { startDemoStream } from '../demo';
import type { ModuleContext, ViewerModule } from '../module';

export interface StreamsOptions {
  maxSources?: number; // 0 = unlimited
  maxEntries?: number; // per stream, 0 = unlimited
  maxBytes?: number; // per stream, 0 = unlimited
  // Streams idle this long (no producer and no subscriber) are removed. 0 = never.
  idleTtlSeconds?: number;
  // Persist stream entries to per-channel NDJSON files here; recovered on start.
  spoolDir?: string;
  // Keep a `demo` channel emitting sample lines.
  demo?: boolean;
  // Reported in capabilities; set by createLogViewer.
  mutationAuth?: 'x-stream-key' | 'none' | 'custom';
  maxPayloadBytes?: number;
}

export interface StreamsApi {
  readonly registry: StreamRegistry;
  // Appends lines (auto-parsed) or structured entries to a channel, creating it.
  append(channel: string, items: string[] | StreamEntryInput[]): StreamSource;
  delete(channel: string): Promise<boolean>;
}

const CHANNEL_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export function streamsModule(ctx: ModuleContext, opts: StreamsOptions): ViewerModule & StreamsApi {
  const { router: app, store, wrap, sourceInfo, allow, hub } = ctx;
  const limits = {
    maxEntries: opts.maxEntries ?? DEFAULTS.streamMaxEntries,
    maxBytes: opts.maxBytes ?? DEFAULTS.streamMaxBytes,
    maxSources: opts.maxSources ?? DEFAULTS.streamMaxSources,
    idleTtlSeconds: opts.idleTtlSeconds ?? DEFAULTS.streamIdleTtlSeconds,
    maxPayloadBytes: opts.maxPayloadBytes ?? DEFAULTS.maxPayloadBytes,
  };
  const spooler = opts.spoolDir
    ? new StreamSpooler(path.resolve(opts.spoolDir), { maxEntries: limits.maxEntries, maxBytes: limits.maxBytes })
    : undefined;
  const registry = new StreamRegistry(store, limits, spooler);
  let demo: { stop(): void } | null = null;
  let idleSweep: NodeJS.Timeout | null = null;

  const streamAck = (src: StreamSource) => ({ ok: true, id: src.id, count: src.count, stats: src.stats, bytes: src.bytes });

  function validChannel(req: Request, res: Response): string | null {
    const channel = req.params.channel;
    if (!CHANNEL_RE.test(channel)) {
      res.status(400).json({ error: 'channel must be 1-128 URL-safe characters' });
      return null;
    }
    return channel;
  }

  function markLegacyStreamRoute(res: Response, successor: string) {
    res.setHeader('deprecation', 'true');
    res.setHeader('link', `<${successor}>; rel="successor-version"`);
  }

  function appendBody(src: StreamSource, body: Record<string, unknown> | undefined) {
    if (Array.isArray(body?.lines)) src.appendLines(body.lines.map(String));
    if (Array.isArray(body?.entries)) src.appendEntries(body.entries as StreamEntryInput[]);
  }

  app.get('/api/v1/streams/:channel', (req, res) => {
    const channel = validChannel(req, res);
    if (!channel) return;
    const src = registry.get(channel);
    if (!src) {
      res.status(404).json({ error: 'unknown stream ' + channel });
      return;
    }
    res.setHeader('cache-control', 'no-store');
    res.json(sourceInfo(src));
  });

  app.put(
    '/api/v1/streams/:channel',
    wrap(async (req, res) => {
      if (!(await allow(req, res, 'ingest', { channel: req.params.channel }))) return;
      const channel = validChannel(req, res);
      if (!channel) return;
      const existing = registry.get(channel);
      const src = existing ?? registry.getOrCreate(channel);
      res.status(existing ? 200 : 201).json({ ...streamAck(src), created: !existing });
    })
  );

  app.post(
    '/api/v1/streams/:channel/entries',
    wrap(async (req, res) => {
      if (!(await allow(req, res, 'ingest', { channel: req.params.channel }))) return;
      const channel = validChannel(req, res);
      if (!channel) return;
      const src = registry.get(channel);
      if (!src) {
        res.status(404).json({ error: 'unknown stream ' + channel });
        return;
      }
      appendBody(src, req.body);
      res.json(streamAck(src));
    })
  );

  app.delete(
    '/api/v1/streams/:channel',
    wrap(async (req, res) => {
      if (!(await allow(req, res, 'ingest', { channel: req.params.channel }))) return;
      const channel = validChannel(req, res);
      if (!channel) return;
      res.json({ ok: true, deleted: await registry.remove(channel) });
    })
  );

  // Deprecated pre-v1 routes (a GET creates the stream).
  app.get('/api/streams/:channel', (req, res) => {
    markLegacyStreamRoute(res, `/api/v1/streams/${encodeURIComponent(req.params.channel)}`);
    res.json(sourceInfo(registry.getOrCreate(req.params.channel)));
  });

  app.post(
    '/api/streams/:channel',
    wrap(async (req, res) => {
      if (!(await allow(req, res, 'ingest', { channel: req.params.channel }))) return;
      markLegacyStreamRoute(res, `/api/v1/streams/${encodeURIComponent(req.params.channel)}/entries`);
      const src = registry.getOrCreate(req.params.channel);
      appendBody(src, req.body);
      res.json(sourceInfo(src));
    })
  );

  // WS producers can push lines directly: {type:'publish', channel, lines, key}.
  hub.handle('publish', async (m, wsCtx) => {
    if (typeof m.channel !== 'string' || !Array.isArray(m.lines)) return;
    const decision = await ctx.checkWs(wsCtx, 'ingest', {
      channel: m.channel,
      credentials: { streamKey: typeof m.key === 'string' ? m.key : undefined },
    });
    if (decision !== true) return;
    if (!CHANNEL_RE.test(m.channel)) return;
    registry.getOrCreate(m.channel).appendLines(m.lines.map(String));
  });
  const prevHandlerError = hub.onHandlerError;
  hub.onHandlerError = (err, wsCtx) => {
    if (err instanceof StoreCapacityError) wsCtx.send({ type: 'error', code: err.code, error: err.message });
    else prevHandlerError(err, wsCtx);
  };
  const prevSubscribe = hub.onSubscribe;
  hub.onSubscribe = (id) => {
    store.sources.get(id)?.touch?.();
    prevSubscribe(id);
  };

  async function recoverSpool() {
    if (!spooler) return;
    try {
      const recovered = await spooler.recover();
      let streams = 0;
      let entries = 0;
      for (const { channel, entries: items } of recovered) {
        try {
          registry.getOrCreate(channel).restore(items);
          streams++;
          entries += items.length;
        } catch (err) {
          ctx.logger.error(`spool recovery skipped stream ${channel}:`, err);
        }
      }
      if (streams) ctx.logger.log(`recovered ${entries} spooled entries into ${streams} stream(s)`);
    } catch (err) {
      ctx.logger.error('spool recovery failed:', err);
    }
  }

  return {
    name: 'streams',
    registry,
    append(channel, items) {
      if (!CHANNEL_RE.test(channel)) throw new Error('channel must be 1-128 URL-safe characters');
      const src = registry.getOrCreate(channel);
      if (items.length && typeof items[0] === 'string') src.appendLines(items as string[]);
      else src.appendEntries(items as StreamEntryInput[]);
      return src;
    },
    delete: (channel) => registry.remove(channel),
    capabilities: () => ({
      lifecycle: {
        create: 'PUT /api/v1/streams/:channel',
        append: 'POST /api/v1/streams/:channel/entries',
        inspect: 'GET /api/v1/streams/:channel',
        delete: 'DELETE /api/v1/streams/:channel',
      },
      mutationAuth: opts.mutationAuth ?? 'none',
      limits,
      spool: !!spooler,
    }),
    health: () => ({ streams: registry.count, streamBytes: registry.bytes }),
    async start() {
      await recoverSpool();
      if (opts.demo) demo = startDemoStream(registry);
      if (limits.idleTtlSeconds > 0) {
        idleSweep = setInterval(
          () => {
            // A connected viewer is active even when the underlying producer is
            // temporarily quiet, so do not expire its stream beneath the iframe.
            for (const id of hub.subscribedIds()) store.sources.get(id)?.touch?.();
            registry
              .removeIdle(limits.idleTtlSeconds * 1000)
              .then((removed) => {
                if (removed) ctx.logger.log(`removed ${removed} idle stream${removed === 1 ? '' : 's'}`);
              })
              .catch((err) => ctx.logger.error('idle stream cleanup failed:', err));
          },
          Math.min(60_000, Math.max(5_000, (limits.idleTtlSeconds * 1000) / 2))
        );
        idleSweep.unref();
      }
    },
    async stop() {
      demo?.stop();
      demo = null;
      if (idleSweep) clearInterval(idleSweep);
      idleSweep = null;
    },
    // Called by the viewer after all sources were removed on close.
    async flush() {
      await spooler?.flush();
    },
  } as ViewerModule & StreamsApi & { flush(): Promise<void> };
}
