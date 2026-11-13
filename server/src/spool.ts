// Disk-backed stream spooling (SPOOL_DIR). Each stream channel gets one
// NDJSON file, `<sanitized-channel>.spool`, so stream entries survive a
// restart. The file starts with a header line carrying the original channel
// name (filenames are sanitized, so ':' and friends would be lost otherwise);
// every other line is one entry with its parsed fields, persisting them so
// recovery needs no re-parsing:
//
//   {"spool":1,"channel":"web"}
//   {"t":1752477600000,"lv":5,"th":"T1","lg":"Db","msg":"…","raw":"…"}
//
// Only the first line of an entry's raw text is persisted: entry text is
// reconstructable from raw lines + format, and continuation lines appended to
// the previous entry would already have been spooled. Recovery therefore
// restores single-line raws.
//
// Writes are fire-and-forget: appends are serialized to strings synchronously
// and pushed through a per-file promise chain; failures are logged and never
// break ingestion. When a file grows past ~2x STREAM_MAX_BYTES it is compacted
// (atomic tmp + rename) down to the entries currently retained in memory.
// Byte sizes are tracked by the spooler itself (bytes written minus
// compactions), so no stat calls happen on the append path.

import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { STREAM_LIMITS } from './config';
import { EntryOut, StreamSource } from './sources';

// The persisted entry shape. `raw` holds the first line only (see above).
export interface SpooledEntry {
  t: number;
  lv: number;
  th: string;
  lg: string;
  msg: string;
  raw: string;
}

interface SpoolState {
  chain: Promise<unknown>; // serializes appends/compactions for one file
  size: number; // tracked bytes on disk
  compacting: boolean;
  src?: StreamSource;
}

function serializeEntry(e: EntryOut): string {
  const nl = e.raw.indexOf('\n');
  const line: SpooledEntry = {
    t: e.t,
    lv: e.lv,
    th: e.th,
    lg: e.lg,
    msg: e.msg,
    raw: nl === -1 ? e.raw : e.raw.slice(0, nl),
  };
  return JSON.stringify(line);
}

function headerLine(channel: string): string {
  return JSON.stringify({ spool: 1, channel }) + '\n';
}

function isHeader(v: unknown): v is { spool: number; channel: string } {
  return (
    typeof v === 'object' &&
    v !== null &&
    (v as { spool?: unknown }).spool === 1 &&
    typeof (v as { channel?: unknown }).channel === 'string'
  );
}

function isEntry(v: unknown): v is SpooledEntry {
  return typeof v === 'object' && v !== null && typeof (v as { raw?: unknown }).raw === 'string';
}

export class StreamSpooler {
  private states = new Map<string, SpoolState>(); // channel -> file state

  constructor(readonly dir: string) {
    fs.mkdirSync(dir, { recursive: true });
  }

  // Channel names are nearly filenames already (see validChannel); everything
  // outside [A-Za-z0-9._-] becomes '_'. Collisions after sanitization (e.g.
  // 'a:b' vs 'a_b') share one file — avoid such channel pairs (documented in
  // docs/operations.md).
  fileFor(channel: string): string {
    return path.join(this.dir, channel.replace(/[^A-Za-z0-9._-]/g, '_') + '.spool');
  }

  attach(src: StreamSource) {
    const channel = src.name;
    let st = this.states.get(channel);
    if (!st) {
      st = { chain: Promise.resolve(), size: 0, compacting: false };
      this.states.set(channel, st);
    }
    st.src = src;
    src.spool = { append: (entries) => this.append(channel, entries) };
  }

  private append(channel: string, entries: EntryOut[]) {
    const st = this.states.get(channel);
    if (!st) return;
    let payload = st.size === 0 ? headerLine(channel) : '';
    for (const e of entries) payload += serializeEntry(e) + '\n';
    st.size += Buffer.byteLength(payload);
    const file = this.fileFor(channel);
    st.chain = st.chain
      .then(() => fsp.appendFile(file, payload))
      .catch((err) => console.error(`spool append failed for stream ${channel}:`, err));
    const max = STREAM_LIMITS.maxBytes;
    if (max > 0 && st.size > max * 2 && !st.compacting && st.src) {
      st.compacting = true;
      st.chain = st.chain
        .then(() => this.compact(channel, st))
        .catch((err) => console.error(`spool compaction failed for stream ${channel}:`, err))
        .finally(() => {
          st.compacting = false;
        });
    }
  }

  // Rewrites the file with just the entries the stream currently retains.
  private async compact(channel: string, st: SpoolState) {
    const src = st.src;
    if (!src) return;
    const idxs: number[] = [];
    for (let i = 0; i < src.count; i++) idxs.push(i);
    const entries = await src.getEntries(idxs);
    let payload = headerLine(channel);
    for (const e of entries) payload += serializeEntry(e) + '\n';
    const file = this.fileFor(channel);
    const tmp = file + '.tmp';
    await fsp.writeFile(tmp, payload);
    await fsp.rename(tmp, file);
    st.size = Buffer.byteLength(payload);
  }

  // Removes a stream's spool file (stream deleted or idle-expired).
  async remove(channel: string) {
    const st = this.states.get(channel);
    this.states.delete(channel);
    if (st) await st.chain;
    await fsp
      .rm(this.fileFor(channel), { force: true })
      .catch((err) => console.error(`spool removal failed for stream ${channel}:`, err));
  }

  // Awaits every queued write; called during graceful shutdown.
  async flush() {
    await Promise.all([...this.states.values()].map((st) => st.chain));
  }

  // Reads every spool file and returns the recoverable tail of each channel.
  // State sizes are seeded here so compaction accounting stays exact once the
  // streams are reattached. Leftover compaction temp files are dropped.
  async recover(): Promise<Array<{ channel: string; entries: SpooledEntry[] }>> {
    const out: Array<{ channel: string; entries: SpooledEntry[] }> = [];
    let names: string[];
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return out; // unreadable dir: nothing to recover
    }
    for (const name of names) {
      const file = path.join(this.dir, name);
      if (name.endsWith('.spool.tmp')) {
        await fsp.rm(file, { force: true }).catch(() => {});
        continue;
      }
      if (!name.endsWith('.spool')) continue;
      let text: string;
      let size = 0;
      try {
        const st = await fsp.stat(file);
        if (!st.isFile()) continue;
        size = st.size;
        text = await fsp.readFile(file, 'utf8');
      } catch (err) {
        console.error(`spool recovery skipped ${name}:`, err);
        continue;
      }
      let channel = name.slice(0, -'.spool'.length);
      const entries: SpooledEntry[] = [];
      let malformed = 0;
      for (const line of text.split('\n')) {
        if (!line) continue;
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          malformed++;
          continue;
        }
        if (isHeader(parsed)) {
          channel = parsed.channel;
        } else if (isEntry(parsed)) {
          entries.push(parsed);
        } else {
          malformed++;
        }
      }
      if (malformed) console.error(`spool ${name}: skipped ${malformed} malformed line(s)`);
      // The entry cap is applied here; StreamSource.restore's retention pass
      // applies the byte cap.
      const maxEntries = STREAM_LIMITS.maxEntries;
      const tail = maxEntries > 0 && entries.length > maxEntries ? entries.slice(entries.length - maxEntries) : entries;
      this.states.set(channel, { chain: Promise.resolve(), size, compacting: false });
      out.push({ channel, entries: tail });
    }
    return out;
  }
}
