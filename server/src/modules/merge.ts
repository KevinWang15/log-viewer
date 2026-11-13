// Merged views: one time-ordered view over several open sources.

import { MergedSource } from '../sources';
import type { LogSource } from '../source-api';
import type { ModuleContext, ViewerModule } from '../module';

export function mergeModule(ctx: ModuleContext): ViewerModule {
  const { router: app, store, wrap, sourceInfo } = ctx;

  app.post(
    '/api/logs/merge',
    wrap(async (req, res) => {
      const ids: string[] = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      const children = ids.map((id) => store.sources.get(id)).filter((s): s is LogSource => !!s);
      if (children.length < 2) {
        res.status(400).json({ error: 'merge requires at least 2 open sources' });
        return;
      }
      if (children.some((c) => c.kind === 'merged')) {
        res.status(400).json({ error: 'cannot merge a merged view' });
        return;
      }
      if (!(await ctx.allow(req, res, 'open'))) return;
      const src = new MergedSource(ctx.nextId('m'), req.body?.name || 'Merged Logs', children);
      store.addSource(src);
      res.json(sourceInfo(src));
    })
  );

  return { name: 'merge' };
}
