#!/usr/bin/env node
// dshweb build script
// Steps:
//   1. tsc: src/**/*.ts -> lib/**/*.js (+ .d.ts)   [vendored typescript]
//   2. esbuild: src/client/index.jsx -> lib/client.raw.js  (bundle, cjs, react external)
//   3. wrap lib/client.raw.js into window.__ModuleLoader__.load({id:"dshweb",factory}) -> lib/client.js
//   4. copy assets/pwa-icons + pwa-manifest.json into lib/
//   5. [OPTIONAL] physically copy install to local profile directories
//
// Modes (see scripts/README.md「发版必须同步本机」):
//   (default)          compile (1-4) only, PORTABLE, never touches any machine path
//   --deploy           compile (1-4) + copy install (5)   [full, needs a normal shell]
//   --deploy-only      skip compile, copy CURRENT lib/ -> targets (5)  [no spawn: sandbox-safe]
//   --deploy-check     READ-ONLY: compare targets vs source, exit 2 on drift
//
// Design notes:
// - Default build is PORTABLE: it only regenerates lib/ and never touches any
//   machine/personal path. This makes it safe as an npm `prepare` hook for
//   GitHub/git dependencies and CI on any platform.
// - The local "copy install into ~/.dsh/..." loop is opt-in via `--deploy` /
//   `--deploy-only` or DSHWEB_DEPLOY=1 (see `npm run deploy` / `deploy:local`).
//   Targets can be overridden with DSHWEB_DEPLOY_DIRS (semicolon/comma separated).
// - `--deploy-only` deliberately avoids spawning tsc/esbuild: in DSH's
//   workspace-write sandbox a nested process spawn fails with EPERM. It copies
//   the already-committed lib/ verbatim, so releases compiled on a normal
//   machine (or via top-level tsc) can still be synced locally in one command.
// - `--deploy-check` is strictly read-only, safe to run in any sandbox, and is
//   the guard that catches "GitHub/npm say 0.1.1 but the running copy is old".
// - `--prepare` mode (used by npm git-install) tolerates a missing toolchain:
//   if the vendored compiler is unavailable but lib/ artifacts are already
//   committed, it keeps those instead of failing the whole install.
// - IMPORTANT: the GUI status version comes from routes/api.ts and is loaded at
//   DSH startup. Even after a perfect disk sync, the running process keeps the
//   old value until DSH is restarted. deploy:check validates DISK, not memory.
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname + '/..';
const LIB = path.join(ROOT, 'lib');
const SRC = path.join(ROOT, 'src');

const PREPARE = process.argv.includes('--prepare');
const DEPLOY_ONLY = process.argv.includes('--deploy-only');
const DEPLOY_CHECK = process.argv.includes('--deploy-check');
const DEPLOY_ENABLED =
  process.argv.includes('--deploy') ||
  process.env.DSHWEB_DEPLOY === '1' ||
  DEPLOY_ONLY;
const WRAP_ONLY = process.argv.includes('--wrap-only');
const SKIP_COMPILE = DEPLOY_ONLY || DEPLOY_CHECK; // 只复制 / 只校验：不 spawn 编译，沙箱安全

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

  wrapClient();
}

// ---- 3) wrap client.raw.js -> client.js ----
// 宿主用 package.json 的 name 作浏览器模块 id（ClientModuleRegistry.reconcilePackage ->
// graphRow(packageName, ...)），而 __ModuleLoader__.load 必须注册同一个 id，否则该行永远
// 物化不出来：控制台报 loaded without registering "<pkg>" via __ModuleLoader__.load，
// 表现就是「插件已启用，但设置里没有『远程连接』」。
// 仓库里的 name 是裸名 dshweb（本机 file: 模式依赖它），npm 发布时改名为 @zwkit/dshweb，
// 安装后 package.json 的 name 就变成作用域名。因此这里按别名表把两种 id 都注册一遍，
// 让同一份产物在任何安装名下都能对上宿主期望的 id。
const CLIENT_ID_ALIASES = ['dshweb', '@zwkit/dshweb'];
function clientIds() {
  const ids = [];
  const add = (id) => {
    if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id);
  };
  try { add(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).name); } catch (e) {}
  CLIENT_ID_ALIASES.forEach(add);
  return ids;
}

function wrapClient() {
  const raw = fs.readFileSync(path.join(LIB, 'client.raw.js'), 'utf8');
  const ids = clientIds();
  const wrapped =
    '/**\n * dshweb 客户端运行时 Bundle（自动生成，勿手改）\n *\n' +
    ' * 同一个 factory 按多个模块 id 各注册一次（见 scripts/build.cjs 的 clientIds()）：\n' +
    ' * 宿主以 package.json 的 name 作为启动图行 id，裸名安装是 dshweb，作用域名安装是\n' +
    ' * @zwkit/dshweb。只注册一个 id 会让另一种安装方式的客户端行永远物化失败。\n */\n\n' +
    '(function () {\n' +
    '  // 正文只出现一次：两个模块 id 共享同一个 factory（宿主各自调用一次，互不干扰）。\n' +
    '  function dshwebFactory(require) {\n' +
    '    var module = { exports: {} };\n' +
    '    var exports = module.exports;\n' +
    raw +
    '\n    return module.exports;\n' +
    '  }\n' +
    ids.map((id) => '  window.__ModuleLoader__.load({ id: ' + JSON.stringify(id) + ', factory: dshwebFactory });\n').join('') +
    '})();\n';
  fs.writeFileSync(path.join(LIB, 'client.js'), wrapped, 'utf8');
  log('✓ client.js 包装完成 (' + Buffer.byteLength(wrapped) + 'B, ids: ' + ids.join(', ') + ')');
}

// ---- 5) deploy manifest ----
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

// Enumerate every file that SHOULD exist in a deploy target, deduped by
// forward-slash relative destination. Used by both copy-install (self-check)
// and --deploy-check (drift report).
function deployPlan() {
  const map = new Map();
  const norm = (p) => p.replace(/\\/g, '/');
  for (const f of COPY_FILES) {
    const srcAbs = path.join(ROOT, f);
    if (fs.existsSync(srcAbs)) map.set(norm(f), { destRel: norm(f), srcAbs });
  }
  for (const [sDir, dDir] of COPY_DIRS) {
    const s = path.join(ROOT, sDir);
    if (!fs.existsSync(s)) continue;
    const rels = [];
    (function walk(dir, base) {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = base ? base + '/' + e.name : e.name;
        if (e.isDirectory()) walk(abs, rel);
        else if (e.isFile()) rels.push(rel);
      }
    })(s, '');
    for (const rel of rels) {
      const destRel = norm(path.join(dDir, rel));
      map.set(destRel, { destRel, srcAbs: path.join(s, rel) });
    }
  }
  return [...map.values()];
}

function buffersEqual(a, b) {
  try {
    const x = fs.readFileSync(a), y = fs.readFileSync(b);
    return x.length === y.length && x.equals(y);
  } catch (e) { return false; }
}

function copyToTarget(target) {
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
}

// Compare every target against the source lib/. Returns the number of drifted
// targets. quiet=true prints one concise line per target (post-copy self-check).
function checkTargets(quiet) {
  const plan = deployPlan();
  const targets = deployTargets();
  let srcVer = '(读取失败)';
  try { srcVer = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; }
  catch (e) { /* leave as-is */ }
  let drift = 0;
  for (const target of targets) {
    let ver = '(缺失)';
    try { ver = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')).version; }
    catch (e) { /* leave as-is */ }
    const link = fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink();
    const missing = [], diff = [];
    for (const { destRel, srcAbs } of plan) {
      const d = path.join(target, destRel);
      if (!fs.existsSync(d)) missing.push(destRel);
      else if (!buffersEqual(srcAbs, d)) diff.push(destRel);
    }
    const ok = ver === srcVer && !link && missing.length === 0 && diff.length === 0;
    if (!ok) drift++;
    if (quiet) {
      console.log('· 自检 ' + target + ' -> ' + (ok ? '一致' : '漂移(ver=' + ver + ', 缺失=' + missing.length + ', 不一致=' + diff.length + ')'));
    } else {
      console.log('\n· 目标: ' + target);
      console.log('  源码版本=' + srcVer + '  已部署版本=' + ver + '  ' + (ver === srcVer ? '✓' : '✗ 版本漂移'));
      console.log('  链接目录=' + (link ? '是 ✗（应为物理目录）' : '否 ✓'));
      console.log('  应部署文件=' + plan.length + '  缺失=' + missing.length + '  内容不一致=' + diff.length);
      if (missing.length) console.log('    缺失示例: ' + missing.slice(0, 8).join(', ') + (missing.length > 8 ? ' …' : ''));
      if (diff.length) console.log('    不一致示例: ' + diff.slice(0, 8).join(', ') + (diff.length > 8 ? ' …' : ''));
      console.log('  结论: ' + (ok ? '✅ 一致' : '❌ 需同步'));
    }
  }
  return drift;
}

function main() {
  // --deploy-check: strictly read-only, no writes anywhere. Highest priority.
  if (DEPLOY_CHECK) {
    const drift = checkTargets(false);
    if (drift > 0) {
      console.error('\n⚠️  本机安装与源码不一致：' + drift + ' 处目标存在漂移。运行 `npm run deploy:local`（或 `npm run deploy`）同步，必要时重启 DSH。');
      process.exit(2);
    }
    console.log('\n✅ 本机安装与源码一致（' + deployTargets().length + ' 处，逐字节 + 版本号）。');
    console.log('   提示：GUI 显示的版本来自启动时加载的 routes/api.ts，若刚同步请重启 DSH 才能看到新号。');
    return;
  }

  // ---- 3) --wrap-only: re-wrap the committed client.raw.js, no toolchain needed ----
  if (WRAP_ONLY) {
    log('⏭  --wrap-only：只重包装 lib/client.raw.js -> lib/client.js');
    wrapClient();
    log('✅ 包装完成');
    return;
  }

  // ---- 1-3) compile (skipped in --deploy-only / --deploy-check) ----
  if (SKIP_COMPILE) {
    log('⏭  --deploy-only：跳过编译（tsc/esbuild），沿用已提交的 lib/ 产物（不 spawn 子进程，受限沙箱安全）');
  } else if (!toolsAvailable()) {
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
  // --deploy-check 必须严格只读，跳过本步；--deploy-only 仍刷新 assets -> lib/。
  if (!DEPLOY_CHECK) {
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
  }

  // ---- 5) [optional] copy install to local profile dirs ----
  if (!DEPLOY_ENABLED) {
    log('⏭  跳过复制安装（默认可移植构建；本机同步用 `npm run deploy:local`，校验用 `npm run deploy:check`）');
  } else {
    const targets = deployTargets();
    for (const target of targets) {
      try { copyToTarget(target); }
      catch (e) { fail('复制安装失败: ' + e.message + ' (' + target + ')'); }
    }
    log('🔄 复制安装完成（' + targets.length + ' 处，全部物理文件，无链接）');
    // 复制后自检：复用 --deploy-check 的逐字节比对，任何漂移直接失败。
    const drift = checkTargets(true);
    if (drift > 0) fail('复制后自检失败：' + drift + ' 处目标仍与源码不一致');
    log('✓ 复制后自检通过（版本 + 逐字节一致）');
  }
  log('✅ 构建完成');
}

main();
