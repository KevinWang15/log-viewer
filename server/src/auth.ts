// Authorization hook. Every protected operation asks the viewer's authorizer:
//
//   read        GET/HEAD API reads and WebSocket subscriptions
//   view-state  per-viewer state: filters, bookmarks
//   open        opening sources: files, merges, remote mirrors, provider logs
//   ingest      writing to a stream (create, append, delete, WS publish)
//   configure   changing a source: delete, custom parser, rules
//
// `source` is set when the request targets a known source, `channel` for
// stream ingestion. Return true to allow, false to deny with the default
// error, or { status, error, code? } to deny with your own response.
//
// keyAuthorizer() implements the built-in key scheme (VIEW_KEY, STREAM_KEY,
// STREAM_TOKENS); pass `authorize` to createLogViewer to replace it, e.g. to
// check a session cookie, or to restrict which sources a user may read.

import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import type { ScopedStreamToken } from './config';

export type AuthAction = 'read' | 'view-state' | 'open' | 'ingest' | 'configure';

export interface AuthContext {
  action: AuthAction;
  transport: 'http' | 'ws';
  source?: { id: string; kind: string; name: string };
  channel?: string;
  // Credentials as sent by the client: HTTP x-view-key / ?viewKey= /
  // x-stream-key, or the viewKey / key fields of a WebSocket message.
  credentials: { viewKey?: string; streamKey?: string };
  headers: IncomingHttpHeaders;
  req?: IncomingMessage;
}

export type AuthDecision = boolean | { status: number; error: string; code?: string };
export type Authorizer = (ctx: AuthContext) => AuthDecision | Promise<AuthDecision>;

export interface KeyAuthOptions {
  viewKey?: string;
  streamKey?: string;
  streamTokens?: ScopedStreamToken[];
}

export const VIEW_DENIED = { status: 401, error: 'invalid or missing x-view-key header' };
export const WS_VIEW_DENIED = { status: 401, error: 'invalid or missing viewKey', code: 'view_auth_required' };
export const STREAM_DENIED = { status: 401, error: 'invalid or missing x-stream-key header' };

// True when `key` may write to `channel` under the stream key scheme. With no
// keys configured, ingestion is open.
export function streamKeyAllows(opts: KeyAuthOptions, key: string | undefined, channel: string): boolean {
  const tokens = opts.streamTokens ?? [];
  if (!opts.streamKey && tokens.length === 0) return true;
  if (opts.streamKey && key === opts.streamKey) return true;
  if (!key) return false;
  return tokens.some(
    (scoped) => scoped.token === key && (scoped.prefix === '' || scoped.prefix === '*' || channel.startsWith(scoped.prefix))
  );
}

// The built-in scheme:
//  - read: the view key (or the master stream key) when a view key is set
//  - view-state, open: allowed (local viewer actions)
//  - ingest: the master stream key or a token scoped to the channel
//  - configure: like ingest for stream sources (by channel); allowed otherwise
export function keyAuthorizer(opts: KeyAuthOptions = {}): Authorizer {
  return (ctx) => {
    switch (ctx.action) {
      case 'read': {
        if (!opts.viewKey) return true;
        if (ctx.credentials.viewKey === opts.viewKey) return true;
        if (opts.streamKey && ctx.credentials.streamKey === opts.streamKey) return true;
        return ctx.transport === 'ws' ? WS_VIEW_DENIED : VIEW_DENIED;
      }
      case 'ingest':
        return streamKeyAllows(opts, ctx.credentials.streamKey, ctx.channel ?? '') || STREAM_DENIED;
      case 'configure':
        if (ctx.source?.kind !== 'stream') return true;
        return streamKeyAllows(opts, ctx.credentials.streamKey, ctx.source.name) || STREAM_DENIED;
      default:
        return true;
    }
  };
}

// Normalizes an authorizer result into "allowed" or a denial response.
export function denial(decision: AuthDecision, fallback: { status: number; error: string; code?: string }) {
  if (decision === true) return null;
  if (decision === false) return fallback;
  return decision;
}
