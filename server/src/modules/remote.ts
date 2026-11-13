// Remote mirrors: a read-only copy of a source on a peer log-viewer
// instance, loaded over its HTTP API and tailed over its WebSocket.

import { DEFAULTS } from '../config';
import { RemoteSource } from '../sources';
import type { RemoteOptions } from '../options';
import type { ModuleContext, ViewerModule } from '../module';

export function remoteModule(ctx: ModuleContext, opts: RemoteOptions = {}): ViewerModule {
  const { router: app, store, wrap, sourceInfo } = ctx;
  const maxEntries = opts.maxEntries ?? DEFAULTS.remoteMaxEntries;

  // The peer's own view key is supplied as `viewKey` and forwarded on every fetch.
  app.post(
    '/api/logs/remote',
    wrap(async (req, res) => {
      const url = typeof req.body?.url === 'string' ? req.body.url : '';
      const source = typeof req.body?.source === 'string' ? req.body.source : '';
      if (!url || !source) {
        res.status(400).json({ error: 'url and source are required' });
        return;
      }
      if (!(await ctx.allow(req, res, 'open'))) return;
      const viewKey = typeof req.body?.viewKey === 'string' && req.body.viewKey ? req.body.viewKey : undefined;
      const src = await RemoteSource.open(ctx.nextId('r'), url, source, viewKey, maxEntries);
      store.addSource(src);
      res.json(sourceInfo(src));
    })
  );

  return { name: 'remote', capabilities: () => ({ maxEntries }) };
}
