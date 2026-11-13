export interface EntryOut {
  i: number;
  t: number;
  lv: number;
  th: string;
  lg: string;
  msg: string;
  raw: string;
  src?: string;
  elapsed?: number | null;
}

export interface ServerRule {
  id: string;
  name?: string;
  criteria: Criteria;
  actions: { highlight?: string; bookmark?: boolean; webhook?: string };
  matchCount: number;
  webhookErrors: number;
}

export interface SourceInfo {
  id: string;
  // 'file' | 'stream' | 'merged' | 'remote' | 'provider', or a custom kind.
  kind: string;
  name: string;
  path?: string;
  remote?: { url: string; source: string };
  provider?: { id: string; name?: string; log: string };
  description?: string;
  labels?: Record<string, string>;
  // Live-follow state of mirrors (remote, provider).
  state?: string;
  connected?: boolean;
  lastError?: string;
  count: number;
  stats: number[];
  threads: string[];
  loggers: string[];
  format: string;
  bytes?: number;
  lastActivityAt?: number;
  rules?: ServerRule[];
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
}

export interface FilterResult {
  filterId: string;
  count: number;
  stats: number[];
}

export interface BrowseResult {
  path: string;
  parent: string;
  root: string;
  samples: string;
  dirs: Array<{ name: string }>;
  files: Array<{ name: string; size: number; mtime: number }>;
}

export interface WsAppendMsg {
  type: 'append' | 'reset';
  id: string;
  count: number;
  stats: number[];
  added?: number;
  filters: Record<string, { count: number; stats: number[] }>;
}

export interface Rule {
  id: string;
  name: string;
  text?: string;
  level?: number | null;
  fg?: string;
  bg?: string;
  bold?: boolean;
  enabled: boolean;
}

export const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;
// Swatch colors for dots, minimap and charts. Not used for text: row text
// colors live in styles.css and meet WCAG AA contrast.
export const LEVEL_COLORS = ['#94a3b8', '#64748b', '#3b82f6', '#f59e0b', '#ef4444', '#991b1b'] as const;

export interface CatalogLog {
  id: string;
  name: string;
  description?: string;
  labels?: Record<string, string>;
  open?: boolean;
}

export interface ProviderInfo {
  id: string;
  name: string;
  capabilities: Record<string, boolean>;
}

export interface Capabilities {
  service: string;
  serviceVersion: string;
  apiVersion: string;
  modules?: {
    files?: { root: string; samples?: string };
    streams?: { demo?: boolean };
    merge?: Record<string, unknown>;
    remote?: Record<string, unknown>;
    providers?: { providers: ProviderInfo[] };
  };
}
