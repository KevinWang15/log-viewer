import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePattern, detectFormat, levelFromString, parseTimestamp } from '../src/parser';
import { readFileSync } from 'node:fs';

test('detects log4j-style format and parses fields', () => {
  const lines = [
    '2022-01-12 10:36:43,544 [Thread_8] INFO PlotDecoration - Transaction details:',
    '2022-01-12 10:36:44,100 [Main] ERROR Db - deadlock victim',
  ];
  const fmt = detectFormat(lines);
  assert.ok(fmt.isStart(lines[0]));
  assert.ok(!fmt.isStart('   at Some.Stack.Frame()'));
  const p = fmt.parse(lines[0]);
  assert.equal(p.thread, 'Thread_8');
  assert.equal(p.level, 'INFO');
  assert.equal(p.logger, 'PlotDecoration');
  assert.equal(p.message, 'Transaction details:');
});

test('detects JSON lines format', () => {
  const lines = [
    '{"date":"2022-01-12 12:40:11,068","level":"TRACE","logger":"DAQChannelName","thread":"Thread_6","message":"Executing SQL statements."}',
    '{"date":"2022-01-12 12:40:12,000","level":"WARN","logger":"X","thread":"T1","message":"warn"}',
  ];
  const fmt = detectFormat(lines);
  assert.equal(fmt.name, 'json');
  const p = fmt.parse(lines[0]);
  assert.equal(p.level, 'TRACE');
  assert.equal(p.message, 'Executing SQL statements.');
});

test('falls back to plain format', () => {
  const fmt = detectFormat(['hello world', 'no structure here']);
  assert.equal(fmt.name, 'plain');
  assert.ok(fmt.isStart('anything'));
});

test('level normalization', () => {
  assert.equal(levelFromString('TRACE'), 0);
  assert.equal(levelFromString('warn'), 3);
  assert.equal(levelFromString('WARNING'), 3);
  assert.equal(levelFromString('SEVERE'), 4);
  assert.equal(levelFromString('CRITICAL'), 5);
  assert.equal(levelFromString(undefined), 2);
});

test('timestamp parsing', () => {
  const t = parseTimestamp('2022-01-12 10:36:43,544');
  assert.ok(t > 1_600_000_000_000);
  assert.equal(new Date(t).getMilliseconds(), 544);
  // time-only stamps become ms-of-day
  const tod = parseTimestamp('10:46:47.281');
  assert.equal(tod, ((10 * 60 + 46) * 60 + 47) * 1000 + 281);
  assert.equal(parseTimestamp('garbage'), 0);
});

test('parses RFC 3164 syslog with pri and tag[pid]', () => {
  const line = '<34>Oct 11 22:14:15 mymachine su[123]: password check failed';
  const fmt = detectFormat([line]);
  assert.equal(fmt.name, 'syslog (RFC 3164)');
  const p = fmt.parse(line);
  assert.equal(p.level, 'ERROR'); // 34 % 8 = 2 (crit)
  assert.equal(p.logger, 'mymachine');
  assert.equal(p.thread, 'su[123]');
  assert.equal(p.message, 'password check failed');
  assert.ok(parseTimestamp(p.time) > 0);
});

test('parses RFC 3164 syslog without pri or tag', () => {
  const line = 'Oct 11 22:14:15 mymachine just a plain message';
  const fmt = detectFormat([line]);
  assert.equal(fmt.name, 'syslog (RFC 3164)');
  const p = fmt.parse(line);
  assert.equal(p.level, undefined); // falls back to levelFromString default
  assert.equal(levelFromString(p.level), 2);
  assert.equal(p.logger, 'mymachine');
  assert.equal(p.thread, undefined);
  assert.equal(p.message, 'just a plain message');
});

test('parses RFC 3164 syslog with tag but no pid', () => {
  const p = detectFormat(['Nov  3 08:00:01 host cron: job done']).parse(
    'Nov  3 08:00:01 host cron: job done',
  );
  assert.equal(p.thread, 'cron');
  assert.equal(p.message, 'job done');
});

test('RFC 3164 timestamp gets a sane inferred year', () => {
  const p = detectFormat(['Oct 11 22:14:15 mymachine msg']).parse('Oct 11 22:14:15 mymachine msg');
  const t = parseTimestamp(p.time);
  assert.ok(t > 1_000_000_000_000);
  const now = Date.now();
  // inferred year must be current or previous year, never in the future
  const year = new Date(t).getFullYear();
  const thisYear = new Date(now).getFullYear();
  assert.ok(year === thisYear || year === thisYear - 1);
  assert.ok(t <= now + 24 * 3600 * 1000);
  assert.equal(new Date(t).getHours(), 22);
  assert.equal(new Date(t).getMinutes(), 14);
});

test('parses RFC 5424 syslog with nil structured data', () => {
  const line = '<34>1 2003-10-11T22:14:15.003Z mymachine evntslog 1234 ID47 - BOM message';
  const fmt = detectFormat([line]);
  assert.equal(fmt.name, 'syslog (RFC 5424)');
  const p = fmt.parse(line);
  assert.equal(p.level, 'ERROR');
  assert.equal(p.logger, 'mymachine');
  assert.equal(p.thread, 'evntslog[1234]');
  assert.equal(p.message, 'BOM message');
  assert.equal(parseTimestamp(p.time), Date.parse('2003-10-11T22:14:15.003Z'));
});

test('parses RFC 5424 syslog with structured data element', () => {
  const line =
    '<165>1 2003-08-24T05:14:15.000003-07:00 192.0.2.1 myproc 8710 - [exampleSDID@32473 iut="3" eventSource="Application" eventID="1011"] BOM message';
  const p = detectFormat([line]).parse(line);
  assert.equal(p.level, 'INFO'); // 165 % 8 = 5 (notice)
  assert.equal(p.logger, '192.0.2.1');
  assert.equal(p.thread, 'myproc[8710]');
  assert.equal(p.message, 'BOM message');
  assert.equal(parseTimestamp(p.time), Date.parse('2003-08-24T05:14:15.000003-07:00'));
});

test('detects syslog format for a syslog-shaped sample', () => {
  const fmt3164 = detectFormat([
    '<13>Oct 11 22:14:15 mymachine su[123]: hi',
    'Oct 11 22:15:00 mymachine cron[9]: tick',
    '\tcontinuation line attaches to previous entry',
  ]);
  assert.equal(fmt3164.name, 'syslog (RFC 3164)');
  assert.ok(!fmt3164.isStart('\tcontinuation line attaches to previous entry'));

  const fmt5424 = detectFormat([
    '<34>1 2003-10-11T22:14:15.003Z host app 1 ID47 - one',
    '<34>1 2003-10-11T22:14:16.000Z host app 1 ID47 - two',
  ]);
  assert.equal(fmt5424.name, 'syslog (RFC 5424)');
});

test('does not misdetect existing sample fixtures as syslog', () => {
  for (const f of ['app.log', 'client.log', 'server.log']) {
    const lines = readFileSync(new URL(`../sample-logs/${f}`, import.meta.url), 'utf8').split(/\r?\n/);
    const fmt = detectFormat(lines);
    assert.equal(fmt.name, 'time [thread] level logger - message');
  }
});

test('compilePattern handles log4j-style patterns with width padding', () => {
  const fmt = compilePattern('%d [%t] %-5p %c - %m');
  const line = '2022-01-12 10:36:43,544 [Thread_8] INFO  PlotDecoration - Transaction details:';
  assert.ok(fmt.isStart(line));
  assert.ok(!fmt.isStart('   at Some.Stack.Frame()'));
  const p = fmt.parse(line);
  assert.equal(p.thread, 'Thread_8');
  assert.equal(p.level, 'INFO');
  assert.equal(p.logger, 'PlotDecoration');
  assert.equal(p.message, 'Transaction details:');
  assert.ok(parseTimestamp(p.time) > 1_600_000_000_000);
});

test('compilePattern accepts date hints, precision and %n modifiers', () => {
  const fmt = compilePattern('%d{ISO8601} %-5p %c{1} - %m%n');
  const line = '2022-01-12 10:36:43,544 DEBUG A.B - hello';
  assert.ok(fmt.isStart(line));
  const p = fmt.parse(line);
  assert.equal(p.level, 'DEBUG');
  assert.equal(p.logger, 'A.B');
  assert.equal(p.message, 'hello');
});

test('compilePattern matches literal-heavy patterns', () => {
  const fmt = compilePattern('*** %p | thread=%t | %m ***');
  const p = fmt.parse('*** ERROR | thread=worker-1 | boom ***');
  assert.equal(p.level, 'ERROR');
  assert.equal(p.thread, 'worker-1');
  assert.equal(p.message, 'boom');
  assert.ok(!fmt.isStart('*** ERROR | thread=worker-1 | no trailing marker'));
});

test('compilePattern tolerates unknown specifiers as skipped tokens', () => {
  const fmt = compilePattern('%d %X{requestId} %-5p %m');
  const p = fmt.parse('2022-01-12 10:36:43,544 req-42 WARN  hello there');
  assert.equal(p.level, 'WARN');
  assert.equal(p.message, 'hello there');
  assert.ok(parseTimestamp(p.time) > 1_600_000_000_000);
});

test('compilePattern rejects invalid patterns', () => {
  assert.throws(() => compilePattern(''));
  assert.throws(() => compilePattern('   '));
  assert.throws(() => compilePattern('%'));
  assert.throws(() => compilePattern('%d %'));
  assert.throws(() => compilePattern('%! %m'));
  assert.throws(() => compilePattern('no specifiers here'));
  assert.throws(() => compilePattern('%m' + ' x'.repeat(500)));
});

// The pre-fast-path implementation, kept as the reference.
function referenceParseTimestamp(s?: string): number {
  if (!s) return 0;
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

test('parseTimestamp fast path matches the general parser', () => {
  const samples: string[] = [
    '2026-07-13 10:00:00', '2026-07-13T10:00:00', '2026-07-13 10:00:00.1', '2026-07-13 10:00:00,12',
    '2026-07-13 10:00:00.123', '2026-07-13 10:00:00.123456', '2026-07-13 23:59:59.999',
    // Invalid values must fall through and behave exactly as before.
    '2026-07-13 10:00:60', '2026-13-01 10:00:00', '2026-02-30 10:00:00', '2026-07-13 24:00:00',
    '2026-07-13 10:61:00', '2026-07-13 10:00:00.', '2026-07-13 10:00:00.1234567', '2026-07-13 10:00:00Z',
    '2026-07-13 10:00:00+02:00', '2026/07/13 10:00:00', ' 2026-07-13 10:00:00', '10:00:00.5', '1783908000',
    // DST transitions in common zones (spring-forward gap, fall-back overlap).
    '2026-03-08 01:59:59.999', '2026-03-08 02:30:00', '2026-03-08 03:00:00', '2026-11-01 01:30:00',
    '2026-03-29 02:30:00', '2026-10-25 02:30:00', '2026-04-05 01:45:00', '2026-10-04 02:15:00',
  ];
  // Plus a sweep of sequential stamps across minute/hour/day boundaries.
  const base = Date.UTC(2026, 2, 7, 22, 0, 0);
  for (let k = 0; k < 5000; k++) {
    const d = new Date(base + k * 37_123);
    const pad = (n: number, w = 2) => String(n).padStart(w, '0');
    samples.push(
      `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
    );
  }
  for (const s of samples) assert.equal(parseTimestamp(s), referenceParseTimestamp(s), s);
});
