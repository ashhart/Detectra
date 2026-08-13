// Detectra build script — bundles extension sources into extension/dist (loadable unpacked).
// Usage: node build.mjs [--watch] [--zip]
import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const ext = path.join(root, 'extension');
const dist = path.join(ext, 'dist');
const watch = process.argv.includes('--watch');
const zip = process.argv.includes('--zip');

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// 1) Static files (html/css/json/icons) + manifest
cpSync(path.join(ext, 'manifest.json'), path.join(dist, 'manifest.json'));
cpSync(path.join(ext, 'static'), dist, { recursive: true });

// 2) ONNX Runtime Web artifacts (wasm + loader) — pinned via package.json
const ortDist = path.join(root, 'node_modules', 'onnxruntime-web', 'dist');
const ortOut = path.join(dist, 'vendor', 'ort');
mkdirSync(ortOut, { recursive: true });
for (const f of readdirSync(ortDist)) {
  if (/^ort-wasm.*\.(wasm|mjs)$/.test(f)) cpSync(path.join(ortDist, f), path.join(ortOut, f));
}

// 3) Dev-only local model passthrough (extension/models/*.onnx → dist/models/)
const localModels = path.join(ext, 'models');
if (existsSync(localModels)) cpSync(localModels, path.join(dist, 'models'), { recursive: true });

// 4) Bundles
const common = {
  bundle: true,
  minify: false, // keep output human-auditable — this is a forensics tool
  sourcemap: false,
  target: ['chrome121'],
  logLevel: 'info',
  define: { 'import.meta.env.DEV': watch ? 'true' : 'false' },
};

const builds = [
  { entryPoints: [path.join(ext, 'src/background.js')], outfile: path.join(dist, 'background.js'), format: 'esm' },
  { entryPoints: [path.join(ext, 'src/content.js')], outfile: path.join(dist, 'content.js'), format: 'iife' },
  { entryPoints: [path.join(ext, 'src/popup.js')], outfile: path.join(dist, 'popup.js'), format: 'iife' },
  { entryPoints: [path.join(ext, 'src/lab.js')], outfile: path.join(dist, 'lab.js'), format: 'iife' },
];

if (watch) {
  const ctxs = await Promise.all(builds.map((b) => esbuild.context({ ...common, ...b })));
  await Promise.all(ctxs.map((c) => c.watch()));
  console.log('watching…');
} else {
  await Promise.all(builds.map((b) => esbuild.build({ ...common, ...b })));
  if (zip) {
    execSync(`cd ${JSON.stringify(dist)} && zip -qr ../../detectra-extension.zip .`, { stdio: 'inherit' });
    console.log('wrote detectra-extension.zip');
  }
  console.log('built → extension/dist');
}
