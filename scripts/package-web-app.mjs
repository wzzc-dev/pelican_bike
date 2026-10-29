#!/usr/bin/env node
/**
 * scripts/package-web-app.mjs
 *
 * Package a MoonBit web app (web_wasm) for GitHub Pages.
 *
 * By default this packages the pelican_bike web_wasm app:
 *   - Ensures the wasm-gc build exists under _build/wasm-gc/debug/build/web_wasm/
 *   - Copies the web_wasm source tree (index.html, abi.mbt, main.mbt, moon.pkg)
 *     into <out>/web_wasm/
 *   - Copies the built web_wasm.wasm to <out>/web_wasm.wasm so the page can load
 *     it as a sibling of its HTML file
 *   - Promotes the package index.html to <out>/index.html so the site entry point
 *     is served from the repo root
 *   - Creates .br siblings where brotli is available
 *   - Writes <out>/bundle-size.json
 *
 * Usage:
 *   node scripts/package-web-app.mjs web_wasm --out dist/pages
 *   node scripts/package-web-app.mjs examples/showcase/web_wasm --out dist/pages/showcase
 *
 * This is a minimal replacement for the full website packaging pipeline used by the
 * reference deploy workflow. In particular, it does *not* yet handle:
 *   - showcase/web_wasm
 *   - playground packaging
 *   - docs sync
 * Those remain TODO until the corresponding scripts/action exist.
 */

import { mkdir, readdir, stat, copyFile, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = join(__dirname, '..');
const args = process.argv.slice(2);

function usage() {
  console.error(
    `Usage: node scripts/package-web-app.mjs <web-wasm-source-dir> [--out <dir>] [--target <target>]

Defaults:
  web-wasm-source-dir: web_wasm
  --out: dist/pages
  --target: wasm-gc
`
  );
  process.exit(1);
}

if (args.length < 1) {
  usage();
}

const sourceDir = join(projectRoot, args[0]);
let outDir = join(projectRoot, 'dist/pages');
let target = 'wasm-gc';

for (let i = 1; i < args.length; i++) {
  if (args[i] === '--out' && i + 1 < args.length) {
    outDir = join(projectRoot, args[++i]);
  } else if (args[i] === '--target' && i + 1 < args.length) {
    target = args[++i];
  } else {
    usage();
  }
}

const wasmBuildDir = join(projectRoot, `_build/${target}/debug/build/web_wasm`);
const wasmFile = join(wasmBuildDir, 'web_wasm.wasm');

async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

async function compressBrotli(src, dest) {
  try {
    execSync(`brotli -f -q 9 "${src}" -o "${dest}"`, {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    return true;
  } catch (err) {
    console.warn(`brotli compression failed for ${src}: ${err.message}`);
    return false;
  }
}

async function copyTree(src, dest) {
  await ensureDir(dest);
  const entries = await readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    const s = await stat(srcPath);
    if (s.isDirectory()) {
      await copyTree(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}

async function fileSizeBytes(filePath) {
  try {
    const s = await stat(filePath);
    return s.size;
  } catch {
    return null;
  }
}

async function moveFile(src, dest) {
  await ensureDir(dest);
  await copyFile(src, dest);
}

console.log(`packaging web_wasm`);
console.log(`  source: ${sourceDir}`);
console.log(`  wasm build dir: ${wasmBuildDir}`);
console.log(`  out: ${outDir}`);

try {
  const sourceStat = await stat(sourceDir);
  if (!sourceStat.isDirectory()) {
    console.error(`source path is not a directory: ${sourceDir}`);
    process.exit(1);
  }
} catch {
  console.error(`source dir not found: ${sourceDir}`);
  process.exit(1);
}

await ensureDir(outDir);

const pkgOut = join(outDir, 'web_wasm');

// Clean previous package output so incremental runs don't leave stale files.
try {
  await rm(pkgOut, { recursive: true, force: true });
} catch {}

if (!(await stat(wasmFile).then(s => s.isFile()).catch(() => false))) {
  console.error(`built wasm not found: ${wasmFile}`);
  console.error('Expected moon build output at:');
  console.error(`  ${wasmFile}`);
  console.error('Run: moon build --target wasm-gc ./web_wasm');
  process.exit(2);
}

// Copy the source package tree into the output under web_wasm/.
await copyTree(sourceDir, pkgOut);

// Place the built wasm next to its HTML entrypoint, as a sibling of web_wasm/.
// Many browser-hosted loaders expect ./web_wasm.wasm relative to the HTML file.
const topWasm = join(outDir, 'web_wasm.wasm');
await copyFile(wasmFile, topWasm);

const htmlFile = join(pkgOut, 'index.html');
const abiFile = join(pkgOut, 'abi.mbt');
const topHtmlFile = join(outDir, 'index.html');

// Brotli-compress the most important static assets.
if (await stat(topWasm).then(s => s.isFile()).catch(() => false)) {
  const br = topWasm + '.br';
  if (await compressBrotli(topWasm, br)) {
    console.log(`  wrote ${br}`);
  }
}
if (await stat(htmlFile).then(s => s.isFile()).catch(() => false)) {
  const br = htmlFile + '.br';
  if (await compressBrotli(htmlFile, br)) {
    console.log(`  wrote ${br}`);
  }// Promote the package index.html to the output root so the site entry point
// is served from the repo root rather than web_wasm/index.html.
  // Move first, then compress the promoted copy if brotli is available.
  await copyFile(htmlFile, topHtmlFile);
  try {
    await rm(join(pkgOut, 'index.html'));
  } catch {}
  const topHtmlBr = topHtmlFile + '.br';
  if (await compressBrotli(topHtmlFile, topHtmlBr)) {
    console.log(`  wrote ${topHtmlBr}`);
  }
}
if (await stat(abiFile).then(s => s.isFile()).catch(() => false)) {
  const br = abiFile + '.br';
  if (await compressBrotli(abiFile, br)) {
    console.log(`  wrote ${br}`);
  }
}

// Emit a stable bundle-size.json for CI assertions.
const bundleSize = {
  generated_by: 'scripts/package-web-app.mjs (minimal replacement)',
  target,
  files: {
    'web_wasm.wasm': await fileSizeBytes(topWasm),
    'web_wasm.wasm.br': await fileSizeBytes(topWasm + '.br'),
    'index.html': await fileSizeBytes(topHtmlFile),
    'index.html.br': await fileSizeBytes(topHtmlFile + '.br'),
    'web_wasm/index.html': await fileSizeBytes(htmlFile),
    'web_wasm/index.html.br': await fileSizeBytes(htmlFile + '.br'),
    'web_wasm/abi.mbt': await fileSizeBytes(abiFile),
    'web_wasm/abi.mbt.br': await fileSizeBytes(abiFile + '.br'),
  },
};

await writeFile(
  join(outDir, 'bundle-size.json'),
  JSON.stringify(bundleSize, null, 2) + '\n'
);

console.log(`packaged web_wasm -> ${outDir}`);
