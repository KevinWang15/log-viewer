// Log format auto-detection and line parsing.
// A "format" knows how to recognize the first line of a log entry (isStart)
// and how to extract time / thread / level / logger / message from it.

import { normalizeFields } from './fields';

export const LEVEL_NAMES = ['TRACE', 'DEBUG', 'INFO', 'WARN', 'ERROR', 'FATAL'] as const;

export function levelFromString(s?: string): number {
  if (!s) return 2;
  const u = s.toUpperCase();
  if (u.startsWith('TRACE') || u === 'VERBOSE' || u === 'TRC' || u === 'VRB' || u === 'FINEST') return 0;
  if (u.startsWith('DEBUG') || u === 'DBG' || u === 'FINE' || u === 'FINER') return 1;
  if (u.startsWith('INFO') || u === 'INF' || u === 'NOTICE') return 2;
  if (u.startsWith('WARN') || u === 'WRN') return 3;
  if (u.startsWith('ERR') || u === 'SEVERE' || u === 'EROR') return 4;
  if (u.startsWith('FATAL') || u.startsWith('CRIT') || u === 'FTL') return 5;
  return 2;
}

export interface ParsedLine {
  time?: string;
  level?: string;
  thread?: string;
  logger?: string;
  message: string;
  // Structured fields (JSON lines: the keys not mapped above).
  fields?: Record<string, string>;
}

export interface LogFormat {
  name: string;
  isStart(line: string): boolean;
  parse(line: string): ParsedLine;
  // Combined start-test + parse: returns the parsed line when it starts an
  // entry, null otherwise. Saves a second regex exec on hot indexing paths;
  // defaults to isStart+parse via matchLine when not provided.
  match?(line: string): ParsedLine | null;
}

// Single-pass isStart+parse: null when the line does not start an entry.
export function matchLine(fmt: LogFormat, line: string): ParsedLine | null {
  if (fmt.match) return fmt.match(line);
  return fmt.isStart(line) ? fmt.parse(line) : null;
}

const TS_BODY = String.raw`(?:\d{4}[-/]\d{1,2}[-/]\d{1,2}[ T])?\d{1,2}:\d{2}:\d{2}(?:[.,]\d{1,6})?(?:Z|[+-]\d{2}:?\d{2})?`;
const TS = String.raw`(?<time>${TS_BODY})`;
const LVL = String.raw`(?<level>TRACE|VERBOSE|DEBUG|FINE|INFO|NOTICE|WARN|WARNING|ERROR|SEVERE|FATAL|CRITICAL|TRC|DBG|INF|WRN|ERR|FTL)`;
const LOGGER = String.raw`(?:(?<logger>[\w.$#\-]+)\s+[-–—:]\s+)?`;

function regexFormat(name: string, pattern: string): LogFormat {
  const re = new RegExp('^' + pattern + '$', 'i');
  const match = (line: string): ParsedLine | null => {
    const m = re.exec(line);
    if (!m) return null;
    if (!m.groups) return { message: line };
    const g = m.groups;
    return { time: g.time, level: g.level, thread: g.thread, logger: g.logger, message: g.message ?? '' };
  };
  return {
    name,
    isStart: (line) => re.test(line),
    parse: (line) => match(line) ?? { message: line },
    match,
  };
}

// Syslog PRI value → level name from LEVEL_NAMES vocabulary.
// pri % 8 is the severity: 0-3 ERROR, 4 WARN, 5-6 INFO, 7 DEBUG.
function levelFromPri(pri?: string): string | undefined {
  if (pri === undefined) return undefined;
  const sev = Number(pri) % 8;
  if (sev <= 3) return 'ERROR';
  if (sev === 4) return 'WARN';
  if (sev <= 6) return 'INFO';
  return 'DEBUG';
}

const SYSLOG_MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

// RFC 3164 stamps carry no year: assume the current year, but if that lands
// more than 24h in the future the entry is from the previous year.
function inferSyslogTimestamp(mon: string, day: string, hms: string): string | undefined {
  const month = SYSLOG_MONTHS[mon.toLowerCase()];
  if (month === undefined) return undefined;
  const [h, m, s] = hms.split(':').map(Number);
  const now = Date.now();
  let d = new Date(new Date().getFullYear(), month, +day, h, m, s);
  if (d.getTime() - now > 24 * 3600 * 1000) {
    d = new Date(d.getFullYear() - 1, month, +day, h, m, s);
  }
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(month + 1)}-${p(+day)}T${p(h)}:${p(m)}:${p(s)}`;
}

// RFC 3164: <34>Oct 11 22:14:15 mymachine su[123]: message
// host → logger (the log's source), tag[pid] → thread (the emitting process).
const SYSLOG_3164_RE = new RegExp(
  String.raw`^(?:<(?<pri>\d{1,3})>)?(?<mon>[A-Z][a-z]{2})\s+(?<day>\d{1,2})\s+(?<hms>\d{2}:\d{2}:\d{2})\s+(?<host>\S+)\s+(?:(?<tag>[\w./-]+)(?:\[(?<pid>\d+)\])?:\s+)?(?<message>.*)$`,
);

const SYSLOG_3164_MATCH = (line: string): ParsedLine | null => {
  const m = SYSLOG_3164_RE.exec(line);
  if (!m) return null;
  if (!m.groups) return { message: line };
  const g = m.groups;
  return {
    time: inferSyslogTimestamp(g.mon, g.day, g.hms),
    level: levelFromPri(g.pri),
    thread: g.tag ? (g.pid ? `${g.tag}[${g.pid}]` : g.tag) : undefined,
    logger: g.host,
    message: g.message ?? '',
  };
};

const SYSLOG_3164_FORMAT: LogFormat = {
  name: 'syslog (RFC 3164)',
  isStart: (line) => SYSLOG_3164_RE.test(line),
  parse: (line) => SYSLOG_3164_MATCH(line) ?? { message: line },
  match: SYSLOG_3164_MATCH,
};

// RFC 5424: <34>1 2003-10-11T22:14:15.003Z mymachine evntslog 1234 ID47 - message
const SYSLOG_5424_RE = new RegExp(
  String.raw`^(?:<(?<pri>\d{1,3})>)?(?<version>\d+)\s+(?<time>\S+)\s+(?<host>\S+)\s+(?<app>\S+)\s+(?<procid>\S+)\s+(?<msgid>\S+)\s+(?:-|(?:\[[^\]]*\])+)(?:\s+(?<message>.*))?$`,
);

const SYSLOG_5424_MATCH = (line: string): ParsedLine | null => {
  const m = SYSLOG_5424_RE.exec(line);
  if (!m) return null;
  if (!m.groups) return { message: line };
  const g = m.groups;
  const nil = (v?: string) => (v === '-' ? undefined : v);
  const app = nil(g.app);
  const procid = nil(g.procid);
  return {
    time: nil(g.time),
    level: levelFromPri(g.pri),
    thread: app ? (procid ? `${app}[${procid}]` : app) : undefined,
    logger: nil(g.host),
    message: g.message ?? '',
  };
};

const SYSLOG_5424_FORMAT: LogFormat = {
  name: 'syslog (RFC 5424)',
  isStart: (line) => SYSLOG_5424_RE.test(line),
  parse: (line) => SYSLOG_5424_MATCH(line) ?? { message: line },
  match: SYSLOG_5424_MATCH,
};

const CANDIDATES: LogFormat[] = [
  // 2022-01-12 10:36:43,544 [Thread_8] INFO PlotDecoration - message
  regexFormat('time [thread] level logger - message', String.raw`${TS}\s+\[(?<thread>[^\]]+)\]\s+${LVL}\s+${LOGGER}(?<message>.*)`),
  // 2022-01-12 10:36:43,544 INFO [Thread_8] PlotDecoration - message
  regexFormat('time level [thread] logger - message', String.raw`${TS}\s+${LVL}\s+\[(?<thread>[^\]]+)\]\s+${LOGGER}(?<message>.*)`),
  // [2022-01-12 10:36:43] [INFO] message
  regexFormat('[time] [level] message', String.raw`\[${TS}\]\s*\[?${LVL}\]?\s*:?\s*(?<message>.*)`),
  // 2022-01-12 10:36:43,544 INFO logger - message
  regexFormat('time level logger - message', String.raw`${TS}\s+${LVL}\s*[-:]?\s+${LOGGER}(?<message>.*)`),
  // 2022-01-12 10:36:43,544 message
  regexFormat('time message', String.raw`${TS}\s+(?<message>.*)`),
  // syslog variants are appended last so any score tie keeps favoring the
  // log4j-style formats; both have distinctive shapes that rarely collide.
  SYSLOG_5424_FORMAT,
  SYSLOG_3164_FORMAT,
];

const JSON_TIME_KEYS = ['time', 'date', 'timestamp', '@timestamp', 'ts', 'datetime'];
const JSON_MSG_KEYS = ['message', 'msg', 'text', 'body'];
const JSON_LEVEL_KEYS = ['level', 'severity', 'lvl', 'loglevel'];
const JSON_THREAD_KEYS = ['thread', 'threadName', 'tid'];
const JSON_LOGGER_KEYS = ['logger', 'name', 'loggerName', 'source', 'application', 'category'];

function pick(obj: Record<string, unknown>, keys: string[], used?: Set<string>): string | undefined {
  for (const k of keys) {
    for (const key of [k, k.toLowerCase(), k.toUpperCase()]) {
      const v = obj[key];
      if (v !== undefined && v !== null) {
        used?.add(key);
        return String(v);
      }
    }
  }
  return undefined;
}

const jsonIsStart = (line: string): boolean => {
  const t = line.trimStart();
  return t.startsWith('{') && t.trimEnd().endsWith('}');
};

const jsonParse = (line: string): ParsedLine => {
  try {
    const o = JSON.parse(line) as Record<string, unknown>;
    if (!o || typeof o !== 'object' || Array.isArray(o)) return { message: line };
    const used = new Set<string>();
    const parsed: ParsedLine = {
      time: pick(o, JSON_TIME_KEYS, used),
      level: pick(o, JSON_LEVEL_KEYS, used),
      thread: pick(o, JSON_THREAD_KEYS, used),
      logger: pick(o, JSON_LOGGER_KEYS, used),
      message: pick(o, JSON_MSG_KEYS, used) ?? line,
    };
    // Every other key is a field (status, tenant, durationMs, ...).
    const fields = normalizeFields(o, used);
    if (fields) parsed.fields = fields;
    return parsed;
  } catch {
    return { message: line };
  }
};

export const JSON_FORMAT: LogFormat = {
  name: 'json',
  isStart: jsonIsStart,
  parse: jsonParse,
  match: (line) => (jsonIsStart(line) ? jsonParse(line) : null),
};

export const PLAIN_FORMAT: LogFormat = {
  name: 'plain',
  isStart: () => true,
  parse: (line) => ({ message: line }),
  match: (line) => ({ message: line }),
};

// ---- User-defined conversion patterns --------------------------------------

const MAX_PATTERN_LENGTH = 500;
const REGEX_SPECIALS = /[.*+?^${}()|[\]\\]/g;

function escapeLiteral(s: string): string {
  return s.replace(REGEX_SPECIALS, '\\$&');
}

// Compiles a log4j/logback-style conversion pattern (e.g. "%d [%t] %-5p %c - %m")
// into a LogFormat. Supported specifiers: %d{...} time, %p level, %t thread,
// %c/%logger logger, %m/%msg/%message message (rest of line), %n (ignored),
// %% (literal %). Format modifiers such as %-5p or %c{1} are tolerated;
// left/right-justified width padding is matched as optional spaces. Unknown
// specifiers (%X{...}, %F, …) match a non-greedy token so they don't hard-fail.
// Literals are regex-escaped, so long literal runs cannot backtrack; the
// pattern length cap keeps the compiled regex linear in line length.
// Throws on patterns that cannot be compiled.
export function compilePattern(pattern: string): LogFormat {
  if (typeof pattern !== 'string' || !pattern.trim()) {
    throw new Error('pattern must be a non-empty string');
  }
  if (pattern.length > MAX_PATTERN_LENGTH) {
    throw new Error(`pattern is too long (max ${MAX_PATTERN_LENGTH} characters)`);
  }
  const used = new Set<string>();
  const named = (name: string, body: string): string => {
    if (used.has(name)) return `(?:${body})`;
    used.add(name);
    return `(?<${name}>${body})`;
  };
  let body = '';
  let specifiers = 0;
  let i = 0;
  while (i < pattern.length) {
    const at = pattern.indexOf('%', i);
    if (at === -1) {
      body += escapeLiteral(pattern.slice(i));
      break;
    }
    body += escapeLiteral(pattern.slice(i, at));
    let j = at + 1;
    if (pattern[j] === '%') {
      body += '%';
      i = j + 1;
      continue;
    }
    const m = /^(-)?(\d+)?(?:\.\d+)?([A-Za-z]+)(?:\{([^}]*)\})?/.exec(pattern.slice(j));
    if (!m) throw new Error(`invalid conversion specifier at index ${at}`);
    const [, left, width, word, hint] = m;
    i = j + m[0].length;
    specifiers++;
    const padL = !left && width ? ' *' : '';
    const padR = left && width ? ' *' : '';
    switch (word.toLowerCase()) {
      case 'd':
      case 'date':
        // The date-format hint is advisory: ISO8601 and yyyy-MM-dd HH:mm:ss,SSS
        // shapes are all covered by the generic stamp; UNIX hints get digits.
        body += named('time', hint && /unix/i.test(hint) ? String.raw`\d+` : TS_BODY);
        break;
      case 'p':
      case 'level':
        body += padL + named('level', String.raw`\w+`) + padR;
        break;
      case 't':
      case 'thread':
        body += padL + named('thread', String.raw`\S+`) + padR;
        break;
      case 'c':
      case 'logger':
        body += padL + named('logger', String.raw`[\w.$#-]+`) + padR;
        break;
      case 'm':
      case 'msg':
      case 'message':
        body += named('message', '.*');
        break;
      case 'n':
        break; // line separators are already consumed by line splitting
      default:
        // MDC values (%X{key}), caller data, markers, …: skip one token.
        body += String.raw`\S*?`;
    }
  }
  if (!specifiers) throw new Error('pattern must contain at least one conversion specifier');
  return regexFormat(`custom (${pattern})`, body);
}

export function detectFormat(lines: string[]): LogFormat {
  const sample = lines.filter((l) => l.trim().length > 0).slice(0, 300);
  if (sample.length === 0) return PLAIN_FORMAT;

  let jsonHits = 0;
  for (const l of sample) {
    if (JSON_FORMAT.isStart(l)) {
      try {
        JSON.parse(l);
        jsonHits++;
      } catch {
        /* not json */
      }
    }
  }
  if (jsonHits / sample.length > 0.6) return JSON_FORMAT;

  let best: LogFormat | null = null;
  let bestScore = 0;
  for (const cand of CANDIDATES) {
    let hits = 0;
    for (const l of sample) if (cand.isStart(l)) hits++;
    const score = hits / sample.length;
    if (score > bestScore) {
      bestScore = score;
      best = cand;
    }
  }
  // Multiline payloads (stack traces, XML) legitimately lower the ratio,
  // so accept a fairly low threshold.
  if (best && bestScore >= 0.2) return best;
  return PLAIN_FORMAT;
}

// Fast path for the most common stamp shape, `YYYY-MM-DD[ T]HH:MM:SS[.,]f…`
// in local time (no zone). Entries arrive in time order, so the epoch of the
// current minute is cached and only seconds/millis are added per line; this
// skips Date.parse on almost every line while indexing. Caching per minute
// (not per hour) keeps DST exact, since zone offsets change on minute
// boundaries. Returns NaN for anything else so the general path decides.
let minuteKey = '';
let minuteBase = 0;

const STAMP_DIGITS = [0, 1, 2, 3, 5, 6, 8, 9, 11, 12, 14, 15, 17, 18];

function isDigit(c: number) {
  return c >= 48 && c <= 57;
}

function fastLocalTimestamp(s: string): number {
  const len = s.length;
  if (len !== 19 && (len < 21 || len > 26)) return NaN;
  const sep = s.charCodeAt(10);
  if (
    s.charCodeAt(4) !== 45 || // -
    s.charCodeAt(7) !== 45 ||
    (sep !== 32 && sep !== 84) || // ' ' or T
    s.charCodeAt(13) !== 58 || // :
    s.charCodeAt(16) !== 58
  ) {
    return NaN;
  }
  for (const k of STAMP_DIGITS) if (!isDigit(s.charCodeAt(k))) return NaN;
  let ms = 0;
  if (len > 19) {
    const dot = s.charCodeAt(19);
    if (dot !== 46 && dot !== 44) return NaN; // . or ,
    for (let k = 20; k < len; k++) if (!isDigit(s.charCodeAt(k))) return NaN;
    // Millis from the first three fraction digits, right-padded (".5" = 500).
    for (let k = 20; k < 23; k++) ms = ms * 10 + (k < len ? s.charCodeAt(k) - 48 : 0);
  }
  const sec = (s.charCodeAt(17) - 48) * 10 + (s.charCodeAt(18) - 48);
  if (sec > 59) return NaN;
  const key = s.slice(0, 16);
  if (key !== minuteKey) {
    const base = Date.parse(s.slice(0, 10) + 'T' + s.slice(11, 16) + ':00');
    if (Number.isNaN(base)) return NaN;
    minuteKey = key;
    minuteBase = base;
  }
  return minuteBase + sec * 1000 + ms;
}

// Returns epoch millis, or millis-since-midnight (< 86400000) for time-only
// stamps, or 0 when unparseable.
export function parseTimestamp(s?: string): number {
  if (!s) return 0;
  const fast = fastLocalTimestamp(s);
  if (!Number.isNaN(fast)) return fast;
  let v = s.trim().replace(',', '.');
  const timeOnly = /^(\d{1,2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(v);
  if (timeOnly) {
    const ms = timeOnly[4] ? Number((timeOnly[4] + '00').slice(0, 3)) : 0;
    return ((+timeOnly[1] * 60 + +timeOnly[2]) * 60 + +timeOnly[3]) * 1000 + ms;
  }
  v = v.replace(/\//g, '-');
  let t = Date.parse(v.replace(' ', 'T'));
  if (Number.isNaN(t)) t = Date.parse(v);
  if (Number.isNaN(t)) {
    const asNum = Number(s);
    if (Number.isFinite(asNum) && asNum > 1e9) return asNum > 1e12 ? asNum : asNum * 1000;
    return 0;
  }
  return t;
}
