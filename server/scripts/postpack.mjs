// Runs after `npm pack` / `npm publish`: removes the files prepack copied in
// (ui/, README.md, LICENSE), so a stale bundled UI never shadows the fresh
// web/dist build during development.

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
for (const name of ['ui', 'README.md', 'LICENSE']) fs.rmSync(path.join(server, name), { recursive: true, force: true });
