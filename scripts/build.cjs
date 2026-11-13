#!/usr/bin/env node
// dshweb build script
// Steps:
//   1. tsc: src/**/*.ts -> lib/**/*.js (+ .d.ts)   [vendored typescript]
//   2. esbuild: src/client/index.jsx -> lib/client.raw.js  (bundle, cjs, react external)
//   3. wrap lib/client.raw.js into window.__ModuleLoader__.load({id:"dshweb",factory}) -> lib/client.js
//   4. copy assets/pwa-icons + pwa-manifest.json into lib/
//   5. [OPTIONAL] physically copy install to local profile directories
//
// Design notes:
// - Default build is PORTABLE: it only regenerates lib/ and never touches any
//   machine/personal path. This makes it safe as an npm `prepare` hook for
//   GitHub/git dependencies and CI on any platform.
// - The local "copy install into ~/.dsh/..." loop is opt-in via `--deploy` or
//   DSHWEB_DEPLOY=1 (see `npm run deploy`). Targets can be overridden with
//   DSHWEB_DEPLOY_DIRS (semicolon/comma separated).
// - `--prepare` mode (used by npm git-install) tolerates a missing toolchain:
//   if the vendored compiler is unavailable but lib/ artifacts are already
//   committed, it keeps those instead of failing the whole install.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname + '/..';
const LIB = path.join(ROOT, 'lib');
const SRC = path.join(ROOT, 'src');
const PREPARE = process.argv.includes('--prepare');
const DEPLOY_ENABLED =
  process.argv.includes('--deploy') || process.env.DSHWEB_DEPLOY === '1';

const HOME = os.homedir();
const DEFAULT_DEPLOY_DIRS = [
  path.join(HOME, '.dsh', 'dshweb-plugin'),
  path.join(HOME, '.dsh', 'profiles', 'desktop', 'node_modules', 'dshweb'),
];
function deployTargets() {
  const raw = process.env.DSHWEB_DEPLOY_DIRS;
  if (!raw) return DEFAULT_DEPLOY_DIRS;
  return raw.split(/[;,]/).map((s) => s.trim()).filter(Boolean);
}

function fail(msg) { console.error('❌ [dshweb] ' + msg); process.exit(1); }
function log(msg) { console.log('· ' + msg); }

const tscBin = path.join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
const esbuildDir = path.join(ROOT, 'node_modules', 'esbuild');
const toolsAvailable = () => fs.existsSync(tscBin) && fs.existsSync(esbuildDir);
const libCommitted = () => fs.existsSync(path.join(LIB, 'index.js'));

// ---- 1-3) compile src/ -> lib/ (needs the vendored toolchain) ----
function compile() {
  log('tsc: src/**/*.ts -> lib/');
  // typescript 7 发布的是原生 tsc 二进制（node_modules/@typescript/typescript-<platform>/lib/tsc.exe），
  // 不再暴露 createProgram/emit 的 JS API，因此这里直接调用 CLI 二进制。
  if (!fs.existsSync(tscBin)) throw new Error('构建工具缺失: ' + tscBin + '（请先 npm install，详见 README「开发」）');
  const tscRun = require('node:child_process').spawnSync(
    process.execPath,
    [tscBin, '-p', path.join(ROOT, 'tsconfig.json')],
    { cwd: ROOT, encoding: 'utf8' }
  );
  if (tscRun.status !== 0) {
    if (tscRun.stdout) process.stderr.write(tscRun.stdout);
    if (tscRun.stderr) process.stderr.write(tscRun.stderr);
    throw new Error('tsc 编译失败 (exit ' + tscRun.status + (tscRun.error ? ': ' + tscRun.error.message : '') + ')');
  }
  log('✓ tsc 完成');

  log('esbuild: src/client/index.jsx -> lib/client.raw.js');
  let esbuild;
  try { esbuild = require(esbuildDir); }
  catch (e) { throw new Error('构建工具缺失: ' + esbuildDir + '（请先 npm install，详见 README「开发」）'); }
  esbuild.buildSync({
    entryPoints: [path.join(SRC, 'client', 'index.jsx')],
    outfile: path.join(LIB, 'client.raw.js'),
    bundle: true,
    format: 'cjs',
    target: 'es2020',
    jsx: 'automatic',
    external: ['react', 'react/jsx-runtime'],
    logLevel: 'silent',
  });
  log('✓ esbuild 完成');

  const raw = fs.readFileSync(path.join(LIB, 'client.raw.js'), 'utf8');
  const wrapped =
    '/**\n * dshweb 客户端运行时 Bundle（自动生成，勿手改）\n */\n\n' +
    'window.__ModuleLoader__.load({\n' +
    '  id: "dshweb",\n' +
    '  factory: function(require) {\n' +
    '    var module = { exports: {} };\n' +
    '    var exports = module.exports;\n' +
    raw +
    '\n    return module.exports;\n' +
    '  }\n' +
    '});\n';
  fs.writeFileSync(path.join(LIB, 'client.js'), wrapped, 'utf8');
  log('✓ client.js 包装完成 (' + Buffer.byteLength(wrapped) + 'B)');
}

if (!toolsAvailable()) {
  if (PREPARE && libCommitted()) {
    log('⏭  prepare: 构建工具不可用，沿用仓库内已提交的 lib/ 产物');
  } else {
    fail('构建工具缺失（typescript / esbuild）。请先 npm install，详见 README「开发」。');
  }
} else {
  try {
    compile();
  } catch (e) {
    // git 依赖安装 / CI 上若工具链存在却不可用（平台二进制不匹配、受限沙箱
    // 禁止 spawn 等），只要 lib/ 产物已提交就沿用它们，避免让安装整体失败。
    if (PREPARE && libCommitted()) {
      log('⏭  prepare: 编译不可用（' + e.message + '），沿用仓库内已提交的 lib/ 产物');
    } else {
      fail(e.message);
    }
  }
}

// ---- 4) pwa assets (pure file copy, no toolchain needed) ----
const pwaSrc = path.join(ROOT, 'assets', 'pwa-icons');
const pwaDst = path.join(LIB, 'pwa-icons');
if (fs.existsSync(pwaSrc)) {
  fs.rmSync(pwaDst, { recursive: true, force: true });
  fs.cpSync(pwaSrc, pwaDst, { recursive: true });
  log('✓ assets/pwa-icons -> lib/pwa-icons');
}
// manifest 由网关自持（改写图标 URL 为带内容版本号的形式），随 lib 分发
const manifestSrc = path.join(ROOT, 'assets', 'pwa-manifest.json');
if (fs.existsSync(manifestSrc)) {
  fs.copyFileSync(manifestSrc, path.join(LIB, 'pwa-manifest.json'));
  log('✓ assets/pwa-manifest.json -> lib/pwa-manifest.json');
}

// ---- 5) [optional] copy install to local profile dirs ----
const COPY_FILES = [
  'package.json', 'icon.svg', 'cordis.patch.yml',
  'lib/index.js', 'lib/index.d.ts',
  'lib/pwa-manifest.json',
  'lib/store.js', 'lib/store.d.ts',
  'lib/client.js', 'lib/client.raw.js',
  'lib/connection-auth-state.js', 'lib/connection-auth-state.d.ts',
  'lib/auth/credentials.js', 'lib/auth/credentials.d.ts',
  'lib/auth/pair-code.js', 'lib/auth/pair-code.d.ts',
  'lib/gateway/server.js', 'lib/gateway/server.d.ts',
  'lib/gateway/cert.js', 'lib/gateway/cert.d.ts',
  'lib/routes/api.js', 'lib/routes/api.d.ts',
  'lib/routes/register.js', 'lib/routes/register.d.ts',
  'lib/styles/desktop.js', 'lib/styles/desktop.d.ts',
  'lib/styles/mobile.js', 'lib/styles/mobile.d.ts',
];
const COPY_DIRS = [
  ['lib/auth', 'lib/auth'],
  ['lib/gateway', 'lib/gateway'],
  ['lib/routes', 'lib/routes'],
  ['lib/styles', 'lib/styles'],
  ['lib/pwa-icons', 'lib/pwa-icons'],
];

function isLink(p) {
  try { return fs.lstatSync(p).isSymbolicLink() || fs.statSync(p).nlink > 1; } catch (e) { return false; }
}

if (!DEPLOY_ENABLED) {
  log('⏭  跳过复制安装（默认可移植构建；本地开发回路用 `npm run deploy` 或 DSHWEB_DEPLOY=1）');
} else {
  const targets = deployTargets();
  for (const target of targets) {
    try {
      if (isLink(target)) { fs.rmSync(target, { force: true }); log('已删除链接 ' + target); }
      fs.mkdirSync(target, { recursive: true });
      fs.mkdirSync(path.join(target, 'lib'), { recursive: true });
      for (const f of COPY_FILES) {
        const s = path.join(ROOT, f), d = path.join(target, f);
        if (!fs.existsSync(s)) continue;
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.copyFileSync(s, d);
      }
      for (const [sDir, dDir] of COPY_DIRS) {
        const s = path.join(ROOT, sDir);
        if (!fs.existsSync(s)) continue;
        const d = path.join(target, dDir);
        fs.rmSync(d, { recursive: true, force: true });
        fs.cpSync(s, d, { recursive: true });
      }
      log('✓ 物理副本 -> ' + target);
    } catch (e) {
      fail('复制安装失败: ' + e.message + ' (' + target + ')');
    }
  }
  log('🔄 复制安装完成（' + targets.length + ' 处，全部物理文件，无链接）');
}
log('✅ 构建完成');
