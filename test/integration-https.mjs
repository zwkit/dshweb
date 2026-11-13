/**
 * 端到端装配测试：加载完整 lib/index.js 的 apply()，验证
 *   settings.json(httpsEnabled) → buildTls(纯 Node 自签) → HTTP/HTTPS 双监听 →
 *   status 路由 → 真实 HTTPS 握手 → config 开关触发 soft-restart。
 *
 * 这条「装配缝隙」是 gateway.mjs / routes-api.mjs 等单元测试覆盖不到的：
 * 它们各自 mock 掉上下游，无法证明 index.ts 真的把 store 选项传给了
 * GatewayServer、证书真的能用于 TLS、两个监听真的共存。
 *
 * 用 port=0 / httpsPort=0 让系统分配临时端口，全程 HOME 隔离，不碰用户配置，
 * 不占用 3180/3181，可与其它测试并行。
 */
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, dshwebDir } from './_home.mjs';

const HOME = isolateHome('dshweb-e2e-https');
const dir = dshwebDir(HOME);
fs.mkdirSync(dir, { recursive: true });

// 关键点：port=0 / httpsPort=0 → Node 分配临时端口；apply 里 `?? 3180` 不会把 0 替换掉。
// 故意不写 httpsEnabled 字段：m01467 用户确认「默认开启」，缺省即应启用 HTTPS 共存。
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  port: 0,
  httpsPort: 0,
  passwordSalt: 'aa',
  passwordHash: 'bb',
}));

// 假上游核心
let corePort = 0;
const core = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!DOCTYPE html><html><head></head><body>core</body></html>');
});
await new Promise((r) => core.listen(0, '127.0.0.1', () => { corePort = core.address().port; r(); }));

// 捕获注册到 ctx.webServer 的路由；ctx.effect 会调用工厂并保存 disposer
const routes = [];
const disposers = [];
const ctx = {
  logger: { info() {}, warn() {}, error() {} },
  webServer: {
    port: corePort,
    register(route) { routes.push(route); return () => {}; },
  },
  get(name) {
    if (name === 'connection') {
      // 提供可被接管的 connection → connectionAuthAttached=true → 不启动兜底定时器
      return { browserAuth: { isAuthenticated: () => false } };
    }
    return undefined;
  },
  inject() {},
  effect(factory) {
    const d = typeof factory === 'function' ? factory() : factory;
    if (typeof d === 'function') disposers.push(d);
    return () => {};
  },
  on() {},
};

const { apply } = await import('../lib/index.js');
apply(ctx, {});

// 找到 status 路由并轮询到 running
function fakeRes() {
  return {
    code: 0, headers: {}, body: '',
    writeHead(c, h) { this.code = c; this.headers = h || {}; },
    end(b) { this.body = b; },
  };
}
const statusRoute = routes.find((r) => r.path === '/api/dshweb/status');
function readStatus() {
  const res = fakeRes();
  statusRoute.handler({}, res);
  return JSON.parse(res.body);
}
let st = null;
for (let i = 0; i < 40; i++) {
  st = readStatus();
  if (st.running && st.httpsRunning) break;
  await new Promise((r) => setTimeout(r, 100));
}

const results = [];
const check = (name, cond, extra) => { results.push({ name, ok: Boolean(cond), extra }); };

check('settings.json 缺省 httpsEnabled 字段（验证默认开启）',
  !Object.prototype.hasOwnProperty.call(
    JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')), 'httpsEnabled'));
check('apply 注册了 /api/dshweb/status 路由', Boolean(statusRoute));
check('缺省配置下 HTTPS 监听 running=true（默认开启）', st && st.httpsRunning === true, st && JSON.stringify(st));
check('status.httpsEnabled=true', st && st.httpsEnabled === true);
check('status.tls=true', st && st.tls === true);
check('status.httpsPort 为临时端口(>0)', st && st.httpsPort > 0, st && st.httpsPort);
check('status.lanUrl 用 http 协议', st && st.lanUrl.startsWith('http://'), st && st.lanUrl);
check('status.httpsLanUrl 用 https 协议', st && st.httpsLanUrl.startsWith('https://'), st && st.httpsLanUrl);
check('HTTP 与 HTTPS 端口不同', st && st.port !== st.httpsPort, st && `${st.port} vs ${st.httpsPort}`);
check('证书文件已生成(纯 Node 自签)', fs.existsSync(path.join(dir, 'tls.cert.pem')) && fs.existsSync(path.join(dir, 'tls.key.pem')));

// 真实 HTTPS 握手到该端口
async function httpsGet(port) {
  return new Promise((resolve, reject) => {
    const req = https.request({ host: '127.0.0.1', port, path: '/api/dshweb/status', method: 'GET', rejectUnauthorized: false, agent: false }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => resolve({ code: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.setTimeout(3000, () => { req.destroy(); reject(new Error('https timeout')); });
    req.end();
  });
}
let httpsResp = null;
try { httpsResp = await httpsGet(st.httpsPort); } catch (e) { httpsResp = { err: e.message }; }
check('HTTPS 端口可真实握手并返回 200', httpsResp && httpsResp.code === 200, JSON.stringify(httpsResp));
check('HTTPS status 与 HTTP status 一致(httpsRunning)', httpsResp && httpsResp.body && JSON.parse(httpsResp.body).httpsRunning === true, httpsResp && httpsResp.body);

// 经 config 路由关闭 HTTPS，验证 softRestart 后 httpsRunning=false
const configRoute = routes.find((r) => r.path === '/api/dshweb/config');
async function postConfig(body) {
  const { Readable } = await import('node:stream');
  const stream = Readable.from([JSON.stringify(body)]);
  stream.headers = { 'content-type': 'application/json', host: `127.0.0.1:${corePort}`, origin: `http://127.0.0.1:${corePort}` };
  const res = fakeRes();
  await configRoute.handler(stream, res);
  return JSON.parse(res.body);
}
let cfgResp = null;
try { cfgResp = await postConfig({ httpsEnabled: false }); } catch (e) { cfgResp = { err: e.stack }; }
check('config {httpsEnabled:false} 返回 ok', cfgResp && cfgResp.ok === true, JSON.stringify(cfgResp));
let st2 = null;
for (let i = 0; i < 40; i++) {
  st2 = readStatus();
  if (!st2.httpsRunning) break;
  await new Promise((r) => setTimeout(r, 100));
}
check('关闭后 status.httpsRunning=false', st2 && st2.httpsRunning === false, st2 && JSON.stringify(st2));
check('关闭后 status.lanUrl 仍是 http', st2 && st2.lanUrl.startsWith('http://'), st2 && st2.lanUrl);

// 清理
try { for (const d of disposers) { try { d(); } catch {} } } catch {}
try { await new Promise((r) => core.close(r)); } catch {}

for (const x of results) {
  console.log(`  ${x.ok ? 'PASS' : 'FAIL'}  ${x.name}${x.ok || x.extra === undefined ? '' : '  <-- ' + String(x.extra)}`);
}
const passed = results.filter((x) => x.ok).length;
console.log(`\n${passed}/${results.length} PASS`);
if (passed !== results.length) process.exit(1);
process.exit(0);
