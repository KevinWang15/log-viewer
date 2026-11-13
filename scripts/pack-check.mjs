// Verifies the publishable package: builds a tarball of the server
// workspace, checks its file list, installs it into a temp project and smoke
// tests it (CommonJS require, ESM import, TypeScript types, listen/UI/API).
//
// Usage: npm run pack:check

import { execFileSync, execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'server/package.json'), 'utf8'));
const failures = [];
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lvw-pack-'));
const packJson = execSync(`npm pack -w server --json --pack-destination ${JSON.stringify(tmp)}`, {
  cwd: root,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
const [info] = JSON.parse(packJson.slice(packJson.indexOf('[')));
const files = info.files.map((f) => f.path);
const has = (p) => files.includes(p);
check('tarball name', info.filename.startsWith('kevinwang15-log-viewer-'), info.filename);
for (const required of ['package.json', 'README.md', 'LICENSE', 'dist/lib.js', 'dist/lib.d.ts', 'dist/index.js', 'dist/provider/spi.d.ts', 'dist/provider/conformance.js', 'ui/index.html', 'ui/embed.html']) {
  check(`contains ${required}`, has(required));
}
check('contains UI assets', files.some((f) => /^ui\/assets\/.+\.js$/.test(f)));
check('no tests, fixtures or caches', !files.some((f) => /^test\/|fixtures|__pycache__|\.pyc$|\.tgz$/.test(f)));
check(`size is reasonable`, info.size < 2_000_000, `${(info.size / 1024).toFixed(0)} KiB packed, ${files.length} files`);

// Install the tarball into a fresh project and use it like a consumer.
const app = path.join(tmp, 'app');
fs.mkdirSync(app);
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'pack-check-app', private: true, type: 'commonjs' }));
execSync(`npm install --no-audit --no-fund ${JSON.stringify(path.join(tmp, info.filename))}`, { cwd: app, stdio: 'inherit' });
const installed = path.join(app, 'node_modules', ...pkg.name.split('/'));
check('README links are absolute', !/\]\((?!https?:|#)/.test(fs.readFileSync(path.join(installed, 'README.md'), 'utf8')));
check('postpack cleaned the workspace', !fs.existsSync(path.join(root, 'server/ui')));

const node = (file, code) => {
  fs.writeFileSync(path.join(app, file), code);
  try {
    return { ok: true, out: execFileSync(process.execPath, [file], { cwd: app, encoding: 'utf8', timeout: 30_000 }) };
  } catch (err) {
    return { ok: false, out: String(err.stdout || '') + String(err.stderr || err.message) };
  }
};

let r = node(
  'cjs.js',
  `const lv = require('${pkg.name}');
   const testing = require('${pkg.name}/testing');
   const spi = require('${pkg.name}/provider');
   if (typeof lv.createLogViewer !== 'function' || typeof testing.checkProvider !== 'function' || spi.PROVIDER_API_VERSION !== 1) process.exit(1);
   console.log('ok');`
);
check('CommonJS require', r.ok && r.out.includes('ok'), r.ok ? '' : r.out.slice(0, 300));

r = node(
  'esm.mjs',
  `import { createLogViewer, MemoryProvider } from '${pkg.name}';
   const mem = new MemoryProvider('mem');
   mem.addLog({ id: 'a', name: 'A' });
   mem.push('a', [{ message: 'hello' }]);
   const viewer = createLogViewer({ providers: [mem] });
   const { url } = await viewer.listen(0, '127.0.0.1');
   const html = await (await fetch(url + '/')).text();
   const caps = await (await fetch(url + '/api/v1/capabilities')).json();
   const open = await (await fetch(url + '/api/v1/providers/mem/logs/a/open', { method: 'POST' })).json();
   await viewer.close();
   if (!html.includes('<div id="app">') || caps.apiVersion !== 'v1' || open.count !== 1) { console.log(JSON.stringify({ caps, open })); process.exit(1); }
   console.log('ok');`
);
check('ESM import, listen, bundled UI, provider open, close', r.ok && r.out.includes('ok'), r.ok ? '' : r.out.slice(0, 400));

// Types: compile a consumer against the published .d.ts files.
fs.writeFileSync(
  path.join(app, 'consumer.ts'),
  `import { createLogViewer, defineProvider, LogProvider, Authorizer } from '${pkg.name}';
   import { checkProvider } from '${pkg.name}/testing';
   const provider: LogProvider = defineProvider({
     id: 'db',
     logs: async () => [{ id: 'x', name: 'X' }],
     list: async (_log, req) => ({ records: [{ cursor: '1', message: String(req.limit) }] }),
   });
   const authorize: Authorizer = (ctx) => ctx.action !== 'ingest';
   const viewer = createLogViewer({ providers: [provider], authorize, files: false, streams: { maxEntries: 10 } });
   void viewer.listen(0).then(({ url }) => url.toUpperCase());
   void checkProvider(provider, { logId: 'x' }).then((r) => r.ok);
`
);
fs.writeFileSync(
  path.join(app, 'tsconfig.json'),
  JSON.stringify({
    compilerOptions: {
      strict: true,
      noEmit: true,
      module: 'node16',
      target: 'ES2022',
      moduleResolution: 'node16',
      types: ['node'],
      typeRoots: [path.join(root, 'node_modules/@types')],
    },
    files: ['consumer.ts'],
  })
);
try {
  execFileSync(process.execPath, [path.join(root, 'node_modules/typescript/bin/tsc'), '-p', 'tsconfig.json'], {
    cwd: app,
    encoding: 'utf8',
  });
  check('TypeScript consumer compiles against published types', true);
} catch (err) {
  check('TypeScript consumer compiles against published types', false, String(err.stdout || err.message).slice(0, 600));
}

r = { ok: true };
try {
  execFileSync(path.join(app, 'node_modules/.bin/log-viewer'), [], {
    cwd: app,
    env: { ...process.env, PORT: '0', ENABLE_SAMPLES: 'false', ENABLE_DEMO: 'false' },
    timeout: 3000,
    encoding: 'utf8',
  });
} catch (err) {
  // The CLI runs until killed; a timeout with the startup line printed is success.
  r = { ok: String(err.stdout || '').includes('log-viewer server listening'), out: String(err.stdout || '') + String(err.stderr || '') };
}
check('log-viewer CLI starts', r.ok, r.ok ? '' : String(r.out).slice(0, 300));

fs.rmSync(tmp, { recursive: true, force: true });
if (failures.length) {
  console.error(`\n${failures.length} pack check(s) failed`);
  process.exit(1);
}
console.log('\npack check: all good');
