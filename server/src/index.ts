#!/usr/bin/env node
// CLI entry: configures a viewer from environment variables and listens.
// Library users import createLogViewer from the package instead (lib.ts).

import * as os from 'node:os';
import * as path from 'node:path';
import { configFromEnv } from './config';
import { createLogViewer } from './viewer';

const cfg = configFromEnv(process.env, os.homedir());
const ROOT = path.resolve(cfg.logRoot);
// Samples are generated next to the working directory (server/ in the repo
// and container), as before.
const SAMPLES_DIR = path.resolve(process.cwd(), 'sample-logs');

const viewer = createLogViewer({
  auth: { viewKey: cfg.viewKey, streamKey: cfg.streamKey, streamTokens: cfg.streamTokens },
  cors: cfg.corsOrigins.length ? { origins: cfg.corsOrigins } : !cfg.production,
  maxPayloadBytes: cfg.maxPayloadBytes,
  streams: {
    maxSources: cfg.streamMaxSources,
    maxEntries: cfg.streamMaxEntries,
    maxBytes: cfg.streamMaxBytes,
    idleTtlSeconds: cfg.streamIdleTtlSeconds,
    spoolDir: cfg.spoolDir || undefined,
    demo: cfg.enableDemo,
  },
  files: {
    root: ROOT,
    samples: cfg.enableSamples ? SAMPLES_DIR : false,
    watch: cfg.watchGlobs.length
      ? { globs: cfg.watchGlobs, intervalMs: cfg.watchIntervalMs, maxSources: cfg.streamMaxSources }
      : undefined,
    gzipMaxBytes: cfg.gzipMaxBytes,
  },
  merge: true,
  remote: { maxEntries: cfg.remoteMaxEntries },
  version: cfg.appVersion || undefined,
});

viewer
  .listen(cfg.port)
  .then(({ port }) => {
    console.log(`log-viewer server listening on http://localhost:${port}`);
    console.log(`  file browsing root: ${ROOT}`);
    console.log(`  sample logs:        ${cfg.enableSamples ? SAMPLES_DIR : 'disabled'}`);
    console.log(`  demo stream:        ${cfg.enableDemo ? 'GET /embed.html?channel=demo' : 'disabled'}`);
    console.log(
      `  stream limits:      ${cfg.streamMaxSources || 'unlimited'} sources, ${cfg.streamMaxEntries || 'unlimited'} entries/source, ${cfg.streamMaxBytes || 'unlimited'} bytes/source`
    );
    if (cfg.streamKey) console.log('  stream ingestion requires x-stream-key');
    if (cfg.viewKey) console.log('  read access requires x-view-key');
    if (cfg.spoolDir) console.log(`  stream spool dir:   ${path.resolve(cfg.spoolDir)}`);
    if (cfg.watchGlobs.length) console.log(`  directory watch:    ${cfg.watchGlobs.join(', ')} every ${cfg.watchIntervalMs} ms`);
  })
  .catch((err) => {
    console.error('HTTP server error:', err);
    process.exitCode = 1;
  });

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n${signal} received, shutting down…`);
  await viewer.close().catch((err) => console.error('shutdown failed:', err));
  process.exit(0);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
