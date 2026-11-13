// The contract every log source implements. The store, HTTP routes and the
// WebSocket hub depend only on this interface; BaseSource (sources.ts) is a
// helper base class that implements the generic parts.
//
// Model: a source is a dense, time-ordered list of entries addressed 0..count-1.
// It emits
//   'append' (AppendEvent): entries were added at the end, starting at the old
//            count; existing indices are unchanged.
//   'reset':  anything else changed (eviction, rotation, re-parse, reload);
//            consumers re-read everything.
// Metadata accessors are synchronous: sources keep level/time/thread/logger
// for every retained entry in memory (text may stay on disk or remote).

import type { EventEmitter } from 'node:events';
import type { LogFormat } from './parser';

export interface EntryOut {
  i: number; // global entry index within the source
  t: number; // epoch ms, or ms-since-midnight for time-only stamps; 0 = missing
  lv: number; // 0..5 TRACE..FATAL
  th: string;
  lg: string;
  msg: string; // first-line message (grid display)
  raw: string; // full entry text incl. continuation lines (capped)
  // Structured key-value data (provider record fields, extra keys of
  // structured stream entries and JSON log lines). Values are strings.
  fields?: Record<string, string>;
  src?: string; // originating source name (merged views)
  // ms since the previous entry in the requested view; null for the first
  // visible entry or when either timestamp is missing. Set by the entries
  // endpoint, not stored.
  elapsed?: number | null;
}

export interface Criteria {
  levels?: number[];
  threads?: string[];
  loggers?: string[];
  text?: string;
  regex?: boolean;
  caseSensitive?: boolean;
  exclude?: boolean;
  timeFrom?: number;
  timeTo?: number;
  // Exact-match field filter: key -> accepted values. Values of one key are
  // alternatives (OR); different keys must all match (AND).
  fields?: Record<string, string[]>;
}

export interface AppendEvent {
  startIdx: number;
  added: number;
  // Parsed appended entries when the batch was small enough; null means the
  // consumer must re-evaluate the appended range itself.
  entries: EntryOut[] | null;
}

export interface LogSource extends Pick<EventEmitter, 'on' | 'off' | 'once' | 'emit' | 'removeAllListeners'> {
  readonly id: string;
  // Open set: 'file', 'stream', 'merged', 'remote', 'provider', or your own.
  readonly kind: string;
  readonly name: string;
  readonly count: number;
  readonly formatName: string;
  readonly stats: number[]; // per-level counts, index = level
  readonly threadList: string[];
  readonly loggerList: string[];

  levelAt(i: number): number;
  threadAt(i: number): string;
  loggerAt(i: number): string;
  timeAt(i: number): number;
  // Entries for the given indices; out-of-range indices are skipped.
  getEntries(idxs: number[]): Promise<EntryOut[]>;
  // EntryOut.msg for the given indices (aggregate scans).
  getMessages(idxs: number[]): Promise<string[]>;
  // Yields (index, raw text) for entries in [from, to); return false to stop.
  scanTexts(cb: (i: number, raw: string) => boolean | void, from?: number, to?: number): Promise<void>;
  // Indices in [from, to) matching the criteria. The hook for pushdown.
  evalCriteria(c: Criteria, from?: number, to?: number): Promise<number[]>;
  statsOf(indices: number[]): number[];
  close(): Promise<void>;

  // Optional hooks (replace kind-specific branching in the core):
  // Fields of entry i, for sources that keep them in memory (fast field
  // filters). Without it, field filters read entries with getEntries().
  fieldsAt?(i: number): Record<string, string> | undefined;
  // Extra fields merged into the source's info (GET /api/logs/:id).
  describe?(): Record<string, unknown>;
  // Ids of sources this one reads from; removing one of them removes this too.
  dependsOn?(): readonly string[];
  // Marks the source as in use (idle expiry of streams).
  touch?(now?: number): void;
  // Re-parses entries with a format; null restores auto-detection.
  setFormat?(format: LogFormat | null, pattern?: string): void | Promise<void>;
}
