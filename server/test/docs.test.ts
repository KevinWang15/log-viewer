// Keeps the reference docs in step with the code: every env var the CLI
// reads is documented, and every HTTP route appears in the OpenAPI spec.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ENV_VARS } from '../src/config';
import { createLogViewer } from '../src/viewer';

const docs = path.resolve(__dirname, '../../docs');

test('every env var is documented in docs/configuration.md', () => {
  const text = fs.readFileSync(path.join(docs, 'configuration.md'), 'utf8');
  const missing = ENV_VARS.filter((name) => !new RegExp(`\\b${name}\\b`).test(text));
  assert.deepEqual(missing, [], `undocumented env vars: ${missing.join(', ')}`);
});

test('every route is in docs/openapi.yaml', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-docs-'));
  const viewer = createLogViewer({ files: { root }, remote: {}, ui: false, logger: { log() {}, warn() {}, error() {} } });
  const stack = (viewer.handler as unknown as { _router: { stack: Array<{ route?: { path: string; methods: Record<string, boolean> } }> } })
    ._router.stack;
  const spec = fs.readFileSync(path.join(docs, 'openapi.yaml'), 'utf8');
  // Path keys at two-space indent, each followed by its operations.
  const paths = new Map<string, Set<string>>();
  let current: string | null = null;
  for (const line of spec.split('\n')) {
    const p = /^  (\/[^:\s]*):\s*$/.exec(line);
    if (p) {
      current = p[1];
      paths.set(current, new Set());
      continue;
    }
    if (/^\S/.test(line)) current = null;
    const op = /^    (get|put|post|delete|patch|head):/.exec(line);
    if (current && op) paths.get(current)!.add(op[1]);
  }
  const missing: string[] = [];
  for (const layer of stack) {
    if (!layer.route) continue;
    const openapiPath = layer.route.path.replace(/:([A-Za-z]+)/g, '{$1}');
    for (const method of Object.keys(layer.route.methods)) {
      if (!paths.get(openapiPath)?.has(method)) missing.push(`${method.toUpperCase()} ${openapiPath}`);
    }
  }
  assert.deepEqual(missing, [], `routes missing from openapi.yaml: ${missing.join(', ')}`);
});
