// Feature modules. Each built-in feature (core API, files, streams, merge,
// remote mirrors, providers) registers its own routes and WebSocket message
// types on a shared context and can contribute capabilities, health fields
// and start/stop hooks. createLogViewer() enables them from its options.

import type { Express, NextFunction, Request, Response } from 'express';
import type { AuthAction, AuthDecision } from './auth';
import type { LogSource } from './source-api';
import type { Store } from './store';
import type { WsHub, WsMessageContext } from './ws-hub';

import type { Logger } from './options';
export type { Logger };

// What an authorization request is about: a source (open or about to be
// opened, e.g. a provider log) and/or a stream channel.
export interface AuthTarget {
  source?: Pick<LogSource, 'id' | 'kind' | 'name'>;
  channel?: string;
}

export interface ModuleContext {
  router: Express;
  store: Store;
  hub: WsHub;
  logger: Logger;
  // Instance-scoped id generator: nextId('f') -> 'f1', 'f2', …
  nextId(prefix: string): string;
  // The JSON shape of a source (GET /api/logs/:id).
  sourceInfo(src: LogSource): Record<string, unknown>;
  // Asks the authorizer; on denial sends the error response and returns false.
  allow(req: Request, res: Response, action: AuthAction, target?: AuthTarget): Promise<boolean>;
  // Asks the authorizer without sending anything (e.g. to filter lists).
  check(req: Request, action: AuthAction, target?: AuthTarget): Promise<AuthDecision>;
  // Asks the authorizer on behalf of a WebSocket message.
  checkWs(
    ws: WsMessageContext,
    action: AuthAction,
    target: { source?: LogSource; channel?: string; credentials: { viewKey?: string; streamKey?: string } }
  ): Promise<AuthDecision>;
  // Adapts an async handler so rejections reach the error middleware.
  wrap(fn: (req: Request, res: Response) => Promise<unknown>): (req: Request, res: Response, next: NextFunction) => void;
  // Looks up :id; sends 404 and returns null when unknown.
  sourceOr404(req: Request, res: Response): LogSource | null;
}

export interface ViewerModule {
  name: string;
  // Merged into GET /api/v1/capabilities under modules[name].
  capabilities?(): Record<string, unknown>;
  // Extra top-level fields for GET /healthz.
  health?(): Record<string, unknown>;
  start?(): void | Promise<void>;
  stop?(): void | Promise<void>;
}
