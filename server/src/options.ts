// Public option and API types of the built-in feature modules. Kept free of
// Express types so the published declarations don't require @types/express.

import type { LogSource } from './source-api';
import type { StreamEntryInput, StreamSource } from './sources';
import type { StreamRegistry } from './streams';
import type { ProviderSource, ProviderSourceOptions } from './provider/source';
import type { LogProvider } from './provider/spi';

export type Logger = Pick<Console, 'log' | 'warn' | 'error'>;

export interface FilesOptions {
  // Directory users may browse and open files from.
  root: string;
  // Sample logs directory (also browsable): true = generate into
  // `<root>/sample-logs`, a string = generate into that directory.
  samples?: boolean | string;
  // Auto-open files under root matching any glob (polling).
  watch?: { globs: string[]; intervalMs?: number; maxSources?: number };
  // Cap on the decompressed size of gzipped logs.
  gzipMaxBytes?: number;
}

export interface FileOpener {
  // Opens (or returns the already open) source for a file path and optional
  // byte range. Errors carry an HTTP `status`.
  open(filePath: string, range?: { start?: number; end?: number }, origin?: string): Promise<LogSource>;
}

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

export interface RemoteOptions {
  // Entries kept per mirror (oldest dropped first). 0 = unbounded.
  maxEntries?: number;
}

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
