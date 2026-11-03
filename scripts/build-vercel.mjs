// Builds ProtocolIQ in Vercel's Build Output API format (.vercel/output):
//   static/                    the Vite client build
//   functions/api/index.func/  the Express API bundled into one Node.js serverless function
// Vercel deploys .vercel/output as-is when the build command produces it.
import { nodeFileTrace } from '@vercel/nft';
import { build } from 'esbuild';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, '.vercel', 'output');
const func = path.join(out, 'functions', 'api', 'index.func');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(func, { recursive: true });

execSync('npx vite build', { cwd: root, stdio: 'inherit' });
fs.cpSync(path.join(root, 'dist'), path.join(out, 'static'), { recursive: true });

const entry = path.join(func, 'index.mjs');
await build({
  entryPoints: [path.join(root, 'server', 'vercel.ts')],
  outfile: entry,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  packages: 'external',
  logLevel: 'warning',
});

// Copy the node_modules files the bundle actually uses. pdfmake is loaded with createRequire and reads its fonts from
// disk, which static tracing cannot see, so it and its font files are listed explicitly.
const require = createRequire(import.meta.url);
const fontDir = path.dirname(require.resolve('pdfmake/fonts/Roboto.js'));
const { fileList, warnings } = await nodeFileTrace([entry, require.resolve('pdfmake'), require.resolve('pdfmake/fonts/Roboto.js')], { base: root });
fs.cpSync(fontDir, path.join(func, path.relative(root, fontDir)), { recursive: true });
for (const w of warnings) if (!String(w.message).includes('Failed to resolve dependency node:')) console.warn('trace:', w.message);
let copied = 0;
for (const file of fileList) {
  if (!file.startsWith('node_modules/')) continue;
  const src = path.join(root, file);
  if (!fs.statSync(src).isFile()) continue;
  fs.mkdirSync(path.dirname(path.join(func, file)), { recursive: true });
  fs.copyFileSync(src, path.join(func, file));
  copied++;
}

fs.writeFileSync(
  path.join(func, '.vc-config.json'),
  JSON.stringify({ runtime: 'nodejs22.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, maxDuration: 60 }, null, 2),
);
fs.writeFileSync(
  path.join(out, 'config.json'),
  JSON.stringify(
    {
      version: 3,
      routes: [
        { src: '^/api/(.*)$', dest: '/api/index?__path=$1' },
        { src: '^/assets/(.*)$', headers: { 'cache-control': 'public, max-age=31536000, immutable' }, continue: true },
        { handle: 'filesystem' },
        { src: '/(.*)', dest: '/index.html' },
      ],
    },
    null,
    2,
  ),
);

const size = (dir) => fs.readdirSync(dir, { recursive: true }).reduce((n, f) => n + (fs.statSync(path.join(dir, f)).isFile() ? fs.statSync(path.join(dir, f)).size : 0), 0);
console.log(`Vercel output ready: function ${(size(func) / 1024 / 1024).toFixed(1)} MB (${copied} dependency files), static ${(size(path.join(out, 'static')) / 1024 / 1024).toFixed(1)} MB`);
