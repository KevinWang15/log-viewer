// WebSocket transport: live append/reset notifications for subscribed sources
// plus message types contributed by modules (e.g. stream `publish`).
//
// Uses noServer mode and routes `upgrade` events by path, so the viewer can
// share an HTTP server with the host application's own WebSocket servers.

import type * as http from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import { WsBroadcaster } from './broadcast';
import { Authorizer, denial, WS_VIEW_DENIED } from './auth';
import type { Store } from './store';

export interface WsMessageContext {
  ws: WebSocket;
  // The HTTP upgrade request of this connection.
  req: http.IncomingMessage;
  send(frame: Record<string, unknown>): void;
}

export type WsHandler = (msg: Record<string, unknown>, ctx: WsMessageContext) => void | Promise<void>;

export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly subs = new Map<WebSocket, Set<string>>();
  private readonly broadcaster: WsBroadcaster;
  private readonly handlers = new Map<string, WsHandler>();
  private readonly attached: Array<{ server: http.Server; listener: (...args: unknown[]) => void }> = [];
  // Optional per-message error hook (e.g. capacity errors -> error frames).
  onHandlerError: (err: unknown, ctx: WsMessageContext) => void = () => {};
  // Called when a client subscribes to a source (e.g. touch a stream).
  onSubscribe: (id: string) => void = () => {};

  constructor(
    private readonly store: Store,
    private readonly authorize: Authorizer,
    maxPayload: number,
    private readonly logger: Pick<Console, 'error'>
  ) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload });
    this.wss.on('error', (err) => logger.error('WebSocket server error:', err));
    this.broadcaster = new WsBroadcaster((id) => this.snapshot(id));
    this.wss.on('connection', (ws, req: http.IncomingMessage) => this.onConnection(ws, req));
    store.broadcast = (msg) => {
      const s = JSON.stringify(msg);
      const id = String(msg.id);
      for (const [ws, set] of this.subs) {
        if (set.has(id) && ws.readyState === WebSocket.OPEN) this.broadcaster.send(ws, id, s);
      }
    };
  }

  handle(type: string, handler: WsHandler) {
    this.handlers.set(type, handler);
  }

  // Ids of sources with at least one live subscriber.
  subscribedIds(): Set<string> {
    const out = new Set<string>();
    for (const ids of this.subs.values()) for (const id of ids) out.add(id);
    return out;
  }

  attach(server: http.Server, path = '/ws') {
    const listener = (req: http.IncomingMessage, socket: Duplex, head: Buffer) => {
      const pathname = new URL(req.url || '/', 'http://localhost').pathname;
      if (pathname !== path) return; // someone else's upgrade
      this.wss.handleUpgrade(req, socket, head, (ws) => this.wss.emit('connection', ws, req));
    };
    server.on('upgrade', listener);
    this.attached.push({ server, listener: listener as (...args: unknown[]) => void });
  }

  async close() {
    for (const { server, listener } of this.attached) server.off('upgrade', listener);
    this.attached.length = 0;
    for (const ws of this.wss.clients) ws.close();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
  }

  snapshot(id: string) {
    const source = this.store.sources.get(id);
    if (!source) return null;
    const filters: Record<string, { count: number; stats: number[] }> = {};
    for (const filter of this.store.filters.values()) {
      if (filter.sourceId === id) filters[filter.id] = { count: filter.indices.length, stats: filter.stats };
    }
    return { type: 'reset', id, count: source.count, stats: source.stats, filters };
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage) {
    this.subs.set(ws, new Set());
    const send = (frame: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
    };
    const ctx: WsMessageContext = { ws, req, send };
    // Messages are handled in order (authorization may be async).
    let chain: Promise<void> = Promise.resolve();
    ws.on('message', (data) => {
      let m: Record<string, unknown>;
      try {
        m = JSON.parse(String(data));
      } catch {
        return; // ignore malformed frames
      }
      const set = this.subs.get(ws);
      if (!set || !m || typeof m !== 'object') return;
      const run = async () => {
        if (m.type === 'sub' && typeof m.id === 'string') {
          const id = m.id;
          const source = this.store.sources.get(id);
          const decision = await this.authorize({
            action: 'read',
            transport: 'ws',
            source: source ? { id: source.id, kind: source.kind, name: source.name } : undefined,
            credentials: {
              viewKey: typeof m.viewKey === 'string' ? m.viewKey : undefined,
              streamKey: typeof m.key === 'string' ? m.key : undefined,
            },
            headers: req.headers,
            req,
          });
          const denied = denial(decision, WS_VIEW_DENIED);
          if (denied) {
            send({ type: 'error', code: denied.code ?? 'view_auth_required', error: denied.error });
            return;
          }
          set.add(id);
          this.onSubscribe(id);
          const snapshot = this.snapshot(id);
          if (snapshot) send(snapshot);
        } else if (m.type === 'unsub' && typeof m.id === 'string') {
          set.delete(m.id);
        } else if (typeof m.type === 'string') {
          await this.handlers.get(m.type)?.(m, ctx);
        }
      };
      chain = chain.then(run).catch((err) => this.onHandlerError(err, ctx));
    });
    const forget = () => {
      this.subs.delete(ws);
      this.broadcaster.forget(ws);
    };
    ws.on('close', forget);
    ws.on('error', forget);
  }
}
