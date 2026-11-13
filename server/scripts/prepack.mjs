// Runs before `npm pack` / `npm publish` of the server package: builds the
// web UI and the server, bundles the UI into ./ui, and copies the root
// README (with repo-relative links made absolute) and LICENSE.

import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const server = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = path.resolve(server, '..');
const REPO = 'https://github.com/KevinWang15/log-viewer/blob/master/';
const RAW = 'https://raw.githubusercontent.com/KevinWang15/log-viewer/master/';

const run = (cmd, cwd) => execSync(cmd, { cwd, stdio: 'inherit' });
run('npm run build -w web', root);
fs.rmSync(path.join(server, 'dist'), { recursive: true, force: true });
run('npx tsc -p .', server);

const ui = path.join(server, 'ui');
fs.rmSync(ui, { recursive: true, force: true });
fs.cpSync(path.join(root, 'web', 'dist'), ui, { recursive: true });

// Relative links work on GitHub but not on npmjs.com.
const readme = fs
  .readFileSync(path.join(root, 'README.md'), 'utf8')
  .replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_m, target) => `](${REPO}${target.replace(/^\.\//, '')})`)
  .replace(/src="(?!https?:)([^"]+)"/g, (_m, target) => `src="${RAW}${target.replace(/^\.\//, '')}"`);
fs.writeFileSync(path.join(server, 'README.md'), readme);
fs.copyFileSync(path.join(root, 'LICENSE'), path.join(server, 'LICENSE'));
console.log('prepack: bundled ui/, README.md, LICENSE');
