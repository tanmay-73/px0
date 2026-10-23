#!/usr/bin/env node
/**
 * scripts/build-web.js
 *
 * Bundles the frontend into web/dist/ with Bun (https://bun.sh), which is
 * needed for Monaco's ESM build and its CSS and font imports:
 *   web/src/main.js           -> web/dist/app.js, app.css, codicon-*.ttf  (the editor)
 *   Monaco's editor worker   -> web/dist/editor.worker.js
 *   web/src/workbench/main.js -> web/dist/workbench.js, workbench.css     (bare `px0`)
 * Text bundles are then gzipped (the server sends the .gz as is, see
 * handleStatic) so the Go binary stays small. Runs under Node or Bun.
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { genMonaco } from './gen-monaco.js';

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dist = path.join(rootDir, 'web', 'dist');
const ui = path.join(rootDir, 'web', 'src');

function bun() {
  for (const cmd of [process.env.BUN || 'bun', path.join(process.env.HOME || '', '.bun', 'bin', 'bun')]) {
    try { execFileSync(cmd, ['--version'], { stdio: 'ignore' }); return cmd; } catch {}
  }
  console.error('[build-web] Bun is required to bundle the editor (Monaco). Install it from https://bun.sh, then run `bun install`.');
  process.exit(1);
}

function build(bunCmd, entry, naming, extra = []) {
  execFileSync(bunCmd, ['build', entry, `--outdir=${dist}`, `--entry-naming=${naming}`, '--asset-naming=[name]-[hash].[ext]',
    '--target=browser', '--format=esm', '--minify', ...extra], { cwd: rootDir, stdio: ['ignore', 'ignore', 'inherit'] });
}

function compress() {
  let raw = 0, gz = 0;
  for (const f of fs.readdirSync(dist)) {
    const p = path.join(dist, f);
    if (!/\.(js|css|ttf|woff2?|svg|map)$/.test(f)) continue;
    const data = fs.readFileSync(p);
    const out = zlib.gzipSync(data, { level: 9 });
    fs.writeFileSync(p + '.gz', out);
    fs.unlinkSync(p);
    raw += data.length;
    gz += out.length;
  }
  return { raw, gz };
}

// Bun inlines small fonts in CSS. Serve them as same-origin assets instead,
// because px0's font-src policy deliberately excludes data: URLs.
function externalizeFonts() {
  for (const file of fs.readdirSync(dist).filter(f => f.endsWith('.css'))) {
    const p = path.join(dist, file);
    const css = fs.readFileSync(p, 'utf8').replace(/url\((["']?)data:font\/(woff2?|ttf|otf);base64,([A-Za-z0-9+/=]+)\1\)/g, (_, quote, ext, encoded) => {
      const data = Buffer.from(encoded, 'base64');
      const hash = createHash('sha256').update(data).digest('hex').slice(0, 12);
      const name = `font-${hash}.${ext}`;
      fs.writeFileSync(path.join(dist, name), data);
      return `url(./${name})`;
    });
    fs.writeFileSync(p, css);
  }
}

// Vendor assets (Mermaid) are fetched or dropped in as *.min.js; keep them gzipped too.
function compressVendor() {
  const dir = path.join(rootDir, 'web', 'vendor');
  if (!fs.existsSync(dir)) return;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.min.js')) continue;
    const p = path.join(dir, f);
    fs.writeFileSync(p + '.gz', zlib.gzipSync(fs.readFileSync(p), { level: 9 }));
    fs.unlinkSync(p);
  }
}

function run() {
  const start = Date.now();
  const bunCmd = bun();
  genMonaco();
  fs.rmSync(dist, { recursive: true, force: true });
  fs.mkdirSync(dist, { recursive: true });
  build(bunCmd, path.join(ui, 'main.js'), 'app.[ext]');
  build(bunCmd, path.join(rootDir, 'node_modules', 'monaco-editor', 'esm', 'vs', 'editor', 'editor.worker.js'), 'editor.worker.[ext]');
  build(bunCmd, path.join(ui, 'workbench', 'main.js'), 'workbench.[ext]');
  for (const f of ['app.js', 'editor.worker.js', 'workbench.js']) {
    if (!process.versions.bun) execFileSync(process.execPath, ['--input-type=module', '--check'], { input: fs.readFileSync(path.join(dist, f)), stdio: 'pipe' });
  }
  externalizeFonts();
  const { raw, gz } = compress();
  compressVendor();
  console.log(`[build-web] web/dist: ${(raw / 1048576).toFixed(2)} MB, ${(gz / 1048576).toFixed(2)} MB gzipped, in ${Date.now() - start}ms`);
}

run();
