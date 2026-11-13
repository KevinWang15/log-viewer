// Winston transport that ships logs to a log-viewer stream.
//
// Plain JavaScript, global fetch (Node.js 18+), no extra dependencies — it
// implements the winston-transport contract (a writable objectMode stream
// emitting 'logged'/'error') directly instead of importing the package.
//
//   const winston = require('winston');
//   const LogViewerTransport = require('./winston-transport');
//   const logger = winston.createLogger({
//     transports: [new LogViewerTransport({
//       base: 'http://127.0.0.1:5178',
//       channel: 'myapp',
//       streamKey: process.env.LOG_VIEWER_SERVICE_KEY, // server-side only!
//     })],
//   });
//
// Entries are batched and flushed every `flushMs` or when `batchSize`
// entries are pending. The stream is created (idempotently) on first flush.

const { Writable } = require('node:stream');

const LEVELS = {
  emerg: 'FATAL',
  alert: 'FATAL',
  crit: 'FATAL',
  error: 'ERROR',
  warning: 'WARN',
  warn: 'WARN',
  notice: 'INFO',
  info: 'INFO',
  debug: 'DEBUG',
  trace: 'TRACE',
  silly: 'TRACE',
};

class LogViewerTransport extends Writable {
  constructor({ base, channel, streamKey = '', batchSize = 100, flushMs = 1000, loggerName = 'app' }) {
    super({ objectMode: true });
    if (!base || !channel) throw new Error('LogViewerTransport requires base and channel');
    this.base = base.replace(/\/$/, '');
    this.channel = channel;
    this.streamKey = streamKey;
    this.batchSize = batchSize;
    this.flushMs = flushMs;
    this.loggerName = loggerName;
    this.pending = [];
    this.timer = null;
    this.ready = false;
  }

  _write(info, _enc, callback) {
    // info: winston log entry { level, message, ...meta }
    this.pending.push({
      time: new Date().toISOString(),
      level: LEVELS[info.level] || 'INFO',
      thread: 'main',
      logger: info.logger || this.loggerName,
      message: typeof info.message === 'string' ? info.message : JSON.stringify(info.message),
    });
    if (this.pending.length >= this.batchSize) this._flushSoon(0);
    else this._flushSoon(this.flushMs);
    this.emit('logged', info);
    callback();
  }

  _flushSoon(delay) {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this._flush().catch((err) => this.emit('error', err));
    }, delay);
    this.timer.unref?.();
  }

  async _request(method, path, body) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(this.streamKey ? { 'x-stream-key': this.streamKey } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
    return res.json();
  }

  async _flush() {
    const entries = this.pending.splice(0, this.pending.length);
    if (!entries.length) return;
    const ch = encodeURIComponent(this.channel);
    if (!this.ready) {
      await this._request('PUT', `/api/v1/streams/${ch}`); // idempotent create
      this.ready = true;
    }
    await this._request('POST', `/api/v1/streams/${ch}/entries`, { entries });
  }

  _final(callback) {
    this._flush().then(() => callback(), callback);
  }
}

module.exports = LogViewerTransport;
