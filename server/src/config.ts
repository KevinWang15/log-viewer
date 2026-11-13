// Configuration: library defaults and the env-var mapping used by the CLI.
//
// Nothing here reads the environment at import time. Library users pass
// options to createLogViewer(); the CLI (index.ts) calls configFromEnv() once
// and turns the result into options. Every env var the CLI understands is
// listed in ENV_VARS (and documented in docs/configuration.md).

export interface ScopedStreamToken {
  token: string;
  prefix: string; // '' or '*' authorizes every channel
}

export const DEFAULTS = Object.freeze({
  port: 5178,
  streamMaxEntries: 100_000,
  streamMaxBytes: 32 * 1024 * 1024,
  streamMaxSources: 16,
  streamIdleTtlSeconds: 60 * 60,
  maxPayloadBytes: 2 * 1024 * 1024,
  // Cap on the decompressed size when opening a gzipped log: the whole file is
  // inflated to disk, so an unbounded expansion could fill the temp volume.
  gzipMaxBytes: 4 * 1024 * 1024 * 1024,
  // Bound on the in-memory mirror held by each remote source; the oldest
  // entries are dropped once exceeded. 0 means unbounded.
  remoteMaxEntries: 100_000,
  watchIntervalMs: 5_000,
  providerMaxEntries: 100_000,
  providerMaxBytes: 64 * 1024 * 1024,
  providerPollIntervalMs: 1_000,
  providerMaxOpen: 16,
});

export interface EnvConfig {
  port: number;
  logRoot: string;
  streamKey: string;
  streamTokens: ScopedStreamToken[];
  viewKey: string;
  corsOrigins: string[];
  production: boolean;
  enableDemo: boolean;
  enableSamples: boolean;
  appVersion: string;
  spoolDir: string;
  gzipMaxBytes: number;
  watchGlobs: string[];
  watchIntervalMs: number;
  remoteMaxEntries: number;
  streamMaxEntries: number;
  streamMaxBytes: number;
  streamMaxSources: number;
  streamIdleTtlSeconds: number;
  maxPayloadBytes: number;
}

// Every env var configFromEnv reads. A test checks each one is documented.
export const ENV_VARS = [
  'PORT',
  'LOG_ROOT',
  'STREAM_KEY',
  'STREAM_TOKENS',
  'VIEW_KEY',
  'CORS_ORIGIN',
  'NODE_ENV',
  'ENABLE_DEMO',
  'ENABLE_SAMPLES',
  'APP_VERSION',
  'SPOOL_DIR',
  'GZIP_MAX_BYTES',
  'WATCH_GLOBS',
  'WATCH_INTERVAL_MS',
  'REMOTE_MAX_ENTRIES',
  'STREAM_MAX_ENTRIES',
  'STREAM_MAX_BYTES',
  'STREAM_MAX_SOURCES',
  'STREAM_IDLE_TTL_SECONDS',
  'STREAM_MAX_PAYLOAD_BYTES',
] as const;

type Env = Record<string, string | undefined>;

function nonNegativeInteger(env: Env, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function positiveInteger(env: Env, name: string, fallback: number): number {
  const parsed = nonNegativeInteger(env, name, fallback);
  return parsed > 0 ? parsed : fallback;
}

function list(raw: string | undefined): string[] {
  return (raw || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// STREAM_TOKENS: comma-separated token=channelPrefix entries, e.g. "abc=web-,def=job-".
export function parseStreamTokens(raw: string | undefined): ScopedStreamToken[] {
  return list(raw)
    .map((entry) => {
      const eq = entry.indexOf('=');
      if (eq <= 0) return null;
      return { token: entry.slice(0, eq), prefix: entry.slice(eq + 1) };
    })
    .filter((entry): entry is ScopedStreamToken => entry !== null);
}

export function configFromEnv(env: Env, homeDir: string): EnvConfig {
  return {
    port: Number(env.PORT) || DEFAULTS.port,
    logRoot: env.LOG_ROOT || homeDir,
    streamKey: env.STREAM_KEY || '',
    streamTokens: parseStreamTokens(env.STREAM_TOKENS),
    viewKey: env.VIEW_KEY || '',
    corsOrigins: list(env.CORS_ORIGIN),
    production: env.NODE_ENV === 'production',
    enableDemo: !/^(?:0|false|no)$/i.test(env.ENABLE_DEMO || 'true'),
    enableSamples: !/^(?:0|false|no)$/i.test(env.ENABLE_SAMPLES || 'true'),
    appVersion: env.APP_VERSION || '',
    // When set, stream entries are also appended to per-channel NDJSON files
    // (see spool.ts) so streams survive restarts.
    spoolDir: env.SPOOL_DIR || '',
    gzipMaxBytes: positiveInteger(env, 'GZIP_MAX_BYTES', DEFAULTS.gzipMaxBytes),
    // Comma-separated globs (e.g. "**/*.log,**/*.log.gz"); files under
    // LOG_ROOT matching any glob are opened automatically (see watch.ts).
    watchGlobs: list(env.WATCH_GLOBS),
    watchIntervalMs: positiveInteger(env, 'WATCH_INTERVAL_MS', DEFAULTS.watchIntervalMs),
    remoteMaxEntries: nonNegativeInteger(env, 'REMOTE_MAX_ENTRIES', DEFAULTS.remoteMaxEntries),
    streamMaxEntries: nonNegativeInteger(env, 'STREAM_MAX_ENTRIES', DEFAULTS.streamMaxEntries),
    streamMaxBytes: nonNegativeInteger(env, 'STREAM_MAX_BYTES', DEFAULTS.streamMaxBytes),
    streamMaxSources: nonNegativeInteger(env, 'STREAM_MAX_SOURCES', DEFAULTS.streamMaxSources),
    streamIdleTtlSeconds: nonNegativeInteger(env, 'STREAM_IDLE_TTL_SECONDS', DEFAULTS.streamIdleTtlSeconds),
    maxPayloadBytes: positiveInteger(env, 'STREAM_MAX_PAYLOAD_BYTES', DEFAULTS.maxPayloadBytes),
  };
}
