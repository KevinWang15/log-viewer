// Push streams: named in-memory channels fed by producers over HTTP/WS (or
// in-process). The registry owns creation, the per-instance source cap,
// spool attachment and idle expiry; the store only sees ordinary sources.

import { StreamSource } from './sources';
import { Store, StoreCapacityError } from './store';
import type { StreamSpooler } from './spool';
import type { LogSource } from './source-api';
import { DEFAULTS } from './config';

export interface StreamLimits {
  maxSources: number; // 0 = unlimited
  maxEntries: number;
  maxBytes: number;
}

export const STREAM_ID_PREFIX = 's:';

export class StreamRegistry {
  readonly limits: StreamLimits;

  constructor(
    private readonly store: Store,
    limits: Partial<StreamLimits> = {},
    private readonly spooler?: StreamSpooler
  ) {
    this.limits = {
      maxSources: limits.maxSources ?? DEFAULTS.streamMaxSources,
      maxEntries: limits.maxEntries ?? DEFAULTS.streamMaxEntries,
      maxBytes: limits.maxBytes ?? DEFAULTS.streamMaxBytes,
    };
    // Deleting a stream deletes its spool file, unless the caller keeps it
    // (shutdown keeps spool files so streams come back on restart).
    store.onSourceRemoved(async (src, opts) => {
      if (src instanceof StreamSource && opts?.dropSpool !== false) await this.spooler?.remove(src.name);
    });
  }

  private *streams(): Iterable<StreamSource> {
    for (const src of this.store.sources.values()) if (src instanceof StreamSource) yield src;
  }

  get count(): number {
    let n = 0;
    for (const _ of this.streams()) n++;
    return n;
  }

  get bytes(): number {
    let bytes = 0;
    for (const src of this.streams()) bytes += src.bytes;
    return bytes;
  }

  get(channel: string, touch = true): StreamSource | undefined {
    const src = this.store.sources.get(STREAM_ID_PREFIX + channel);
    if (!(src instanceof StreamSource)) return undefined;
    if (touch) src.touch();
    return src;
  }

  getOrCreate(channel: string): StreamSource {
    const existing = this.get(channel);
    if (existing) return existing;
    if (this.limits.maxSources > 0 && this.count >= this.limits.maxSources) {
      throw new StoreCapacityError(this.limits.maxSources);
    }
    const src = new StreamSource(STREAM_ID_PREFIX + channel, channel, this.limits.maxEntries, this.limits.maxBytes);
    this.spooler?.attach(src);
    this.store.addSource(src);
    return src;
  }

  async remove(channel: string): Promise<boolean> {
    const src = this.get(channel, false);
    if (!src) return false;
    await this.store.removeSource(src.id);
    return true;
  }

  async removeIdle(idleForMs: number, now = Date.now()): Promise<number> {
    if (idleForMs <= 0) return 0;
    const expired: string[] = [];
    for (const src of this.streams()) if (now - src.lastActivityAt >= idleForMs) expired.push(src.id);
    for (const id of expired) await this.store.removeSource(id);
    return expired.length;
  }

  isStream(src: LogSource | undefined): src is StreamSource {
    return src instanceof StreamSource;
  }
}
