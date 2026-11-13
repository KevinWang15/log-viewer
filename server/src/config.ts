function nonNegativeInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function positiveInteger(name: string, fallback: number): number {
  const parsed = nonNegativeInteger(name, fallback);
  return parsed > 0 ? parsed : fallback;
}

export interface ScopedStreamToken {
  token: string;
  prefix: string; // '' or '*' authorizes every channel
}

// STREAM_TOKENS: comma-separated token=channelPrefix entries, e.g. "abc=web-,def=job-".
export const STREAM_TOKENS: ScopedStreamToken[] = (process.env.STREAM_TOKENS || '')
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean)
  .map((entry) => {
    const eq = entry.indexOf('=');
    if (eq <= 0) return null;
    return { token: entry.slice(0, eq), prefix: entry.slice(eq + 1) };
  })
  .filter((entry): entry is ScopedStreamToken => entry !== null);

export const VIEW_KEY = process.env.VIEW_KEY || '';

// SPOOL_DIR: when set, stream entries are additionally appended to per-channel
// NDJSON files in this directory (see spool.ts), so streams survive restarts.
// Unset disables spooling entirely — behavior is then memory-only as before.
export const SPOOL_DIR = process.env.SPOOL_DIR || '';

// Cap on the decompressed size when opening a gzipped log: the whole file is
// inflated to disk, so an unbounded expansion could fill the temp volume.
export const GZIP_LIMITS = Object.freeze({
  maxBytes: positiveInteger('GZIP_MAX_BYTES', 4 * 1024 * 1024 * 1024),
});

// WATCH_GLOBS: comma-separated glob list (e.g. "**/*.log,**/*.log.gz"). When
// set, files under LOG_ROOT matching any glob are opened automatically by the
// directory monitor (polling, see watch.ts). Empty/unset disables the monitor.
export const WATCH_GLOBS: string[] = (process.env.WATCH_GLOBS || '')
  .split(',')
  .map((glob) => glob.trim())
  .filter(Boolean);

export const WATCH_INTERVAL_MS = positiveInteger('WATCH_INTERVAL_MS', 5_000);

// REMOTE_MAX_ENTRIES bounds the in-memory mirror held by each remote source
// (see RemoteSource in sources.ts). Once exceeded, the OLDEST entries are
// dropped — the mirror always keeps the latest N. 0 means unbounded.
export const REMOTE_MAX_ENTRIES = nonNegativeInteger('REMOTE_MAX_ENTRIES', 100_000);

export const STREAM_LIMITS = Object.freeze({
  maxEntries: nonNegativeInteger('STREAM_MAX_ENTRIES', 100_000),
  maxBytes: nonNegativeInteger('STREAM_MAX_BYTES', 32 * 1024 * 1024),
  maxSources: nonNegativeInteger('STREAM_MAX_SOURCES', 16),
  idleTtlSeconds: nonNegativeInteger('STREAM_IDLE_TTL_SECONDS', 60 * 60),
  maxPayloadBytes: positiveInteger('STREAM_MAX_PAYLOAD_BYTES', 2 * 1024 * 1024),
});
