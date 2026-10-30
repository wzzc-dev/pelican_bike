#!/usr/bin/env node
/**
 * scripts/package-web-app.mjs
 *
 * Package a MoonBit web app (web_wasm) for GitHub Pages.
 *
 * By default this packages the pelican_bike web_wasm app:
 *   - Ensures the optimized wasm-gc build exists under
 *     _build/wasm-gc/release/build/web_wasm/ (debug builds are ~2.7x larger and
 *     noticeably slower, so the site always ships the release artifact)
 *   - Copies the web_wasm source tree (index.html, abi.mbt, main.mbt, moon.pkg)
 *     into <out>/web_wasm/
 *   - Copies the built web_wasm.wasm to <out>/web_wasm.wasm so the page can load
 *     it as a sibling of its HTML file
 *   - Promotes the package index.html to <out>/index.html so the site entry point
 *     is served from the repo root
 *   - Copies the browser runtime assets (moui_web_renderer/runtime.js and its
 *     moui browser runtime dependency) so the site is self-contained
 *   - Rewrites the promoted index.html so it loads ./web_wasm.wasm and
 *     ./moui_web_renderer/runtime.js instead of local dev paths
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

import { mkdir, readdir, stat, copyFile, rm, readFile, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join, dirname, basename, resolve } from 'node:path';
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

const mooncakesDir = join(projectRoot, '.mooncakes');

// A workspace build (moon.work) writes _build/<target>/release/build/<module>/
// web_wasm/, a standalone build writes _build/<target>/release/build/web_wasm/.
// Both can be on disk at once, so pick the newest artifact instead of the first
// path that exists -- the other one is stale.
async function newest(paths) {
  let best = null;
  for (const path of paths) {
    const s = await stat(path).catch(() => null);
    if (s?.isFile() && (!best || s.mtimeMs > best.mtimeMs)) {
      best = { path, mtimeMs: s.mtimeMs };
    }
  }
  return best?.path ?? null;
}

function moduleName() {
  for (const manifest of ['moon.mod', 'moon.mod.json']) {
    const text = readFileSync(join(projectRoot, manifest), 'utf8');
    const name = text.match(/^\s*name\s*=\s*"([^"]+)"/m)?.[1];
    if (name) return name;
  }
  return null;
}

const releaseBuildDir = join(projectRoot, `_build/${target}/release/build`);
const wasmFile = await newest([
  join(releaseBuildDir, 'web_wasm/web_wasm.wasm'),
  ...(moduleName()
    ? [join(releaseBuildDir, `${moduleName()}/web_wasm/web_wasm.wasm`)]
    : []),
]);
const wasmBuildDir = wasmFile ? dirname(wasmFile) : join(releaseBuildDir, 'web_wasm');

// Browser runtime modules imported by the page at runtime. They live in the
// mooncakes checkout, or in the vendored workspace member when moon.work
// overrides the module, so the packaged site must carry a copy of whichever one
// was actually compiled.
function workspaceMember(name) {
  const text = readFileSync(join(projectRoot, 'moon.work'), 'utf8');
  const block = text.match(/members\s*=\s*\[([^\]]*)\]/)?.[1] ?? '';
  for (const quoted of block.match(/"[^"]+"/g) ?? []) {
    const dir = resolve(projectRoot, quoted.slice(1, -1));
    if (basename(dir) === name) return dir;
  }
  return null;
}

function depFile(name, relativePath) {
  const member = workspaceMember(name);
  return member
    ? join(member, relativePath)
    : join(mooncakesDir, 'wzzc-dev', name, relativePath);
}

const runtimeAssets = [
  {
    src: depFile('moui_web_renderer', 'runtime.js'),
    dest: join(outDir, 'moui_web_renderer/runtime.js'),
  },
  {
    src: depFile('moui_web_renderer', 'canvas2d_runtime.js'),
    dest: join(outDir, 'moui_web_renderer/canvas2d_runtime.js'),
  },
  {
    src: depFile('moui', 'backend/web/browser_runtime.js'),
    dest: join(outDir, 'moui/backend/web/browser_runtime.js'),
  },
];

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

async function copyAsset({ src, dest }) {
  const exists = await stat(src).then(s => s.isFile()).catch(() => false);
  if (!exists) {
    console.error(`runtime asset not found: ${src}`);
    console.error('Run `moon build --target wasm-gc --release ./web_wasm` first so deps are resolved.');
    process.exit(3);
  }
  await mkdir(dirname(dest), { recursive: true });
  await copyFile(src, dest);
  console.log(`  copied ${dest}`);
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

if (!wasmFile) {
  console.error('built wasm not found under either expected output dir:');
  console.error(`  ${join(releaseBuildDir, 'web_wasm')}`);
  console.error(`  ${join(releaseBuildDir, moduleName() ?? '<module>', 'web_wasm')}`);
  console.error('Run: moon build --target wasm-gc --release ./web_wasm');
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
// Copy the runtime JS the page imports, then promote a rewritten index.html to
// the output root so the entry point is served from the site root and resolves
// ./web_wasm.wasm and ./moui_web_renderer/runtime.js.
for (const asset of runtimeAssets) {
  await copyAsset(asset);
}

if (await stat(htmlFile).then(s => s.isFile()).catch(() => false)) {
  const sourceHtml = await readFile(htmlFile, 'utf8');
  const runtimeImport = /from\s+"[^"]*moui_web_renderer\/runtime\.js"/;
  const wasmUrl = /new URL\(\s*"[^"]*web_wasm\.wasm"\s*,\s*import\.meta\.url\s*,?\s*\)/;

  if (!runtimeImport.test(sourceHtml) || !wasmUrl.test(sourceHtml)) {
    console.error(`could not rewrite asset paths in ${htmlFile}`);
    console.error('Expected a moui_web_renderer/runtime.js import and a web_wasm.wasm URL.');
    process.exit(4);
  }

  const siteHtml = sourceHtml
    .replace(runtimeImport, 'from "./moui_web_renderer/runtime.js"')
    .replace(wasmUrl, 'new URL("./web_wasm.wasm", import.meta.url)');

  await writeFile(topHtmlFile, siteHtml);
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
