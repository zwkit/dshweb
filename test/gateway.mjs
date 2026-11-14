/**
 * 网关行为测试（src/gateway/server.ts → lib/gateway/server.js）
 *
 * 用一个假上游核心（本机 http server）代替真实 DSH 核心，验证：
 *   1. Host 白名单：直连 localhost/IP 放行，未知域名 400，加入白名单后放行
 *   2. 未登录：HTML 请求 302 到登录页，内部 API 401 JSON（不能匿名透传宿主路由）
 *   3. 登录后：HTML 注入 data-remote，mobile 额外注入 viewport/theme-color/CSS
 *   4. 写请求同源校验：跨站 Origin / sec-fetch-site 403
 *   5. 反代头改写：Host 恒为回环核心，同源 Origin/Referer 被洗白
 *   6. 重定向 Location 回环改写
 *   7. 保持登录 24 小时：勾选下发 Max-Age=86400 + 服务端 24h 绝对过期；
 *      未勾选为会话级 Cookie；过期会话被 getSession 拒绝且重启不复活。
 *
 * 全程 HOME 隔离，不碰真实 ~/.dsh/dshweb。
 */
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { isolateHome, createRunner, dshwebDir } from './_home.mjs';

const HOME = isolateHome('dshweb-gw');
const { WebStore } = await import('../lib/store.js');
const { GatewayServer, SESSION_COOKIE, injectRemoteResilience } = await import('../lib/gateway/server.js');
const { loadOrCreateTlsCredentials } = await import('../lib/gateway/cert.js');

const r = createRunner('网关行为');

/* ── 假上游核心 ──────────────────────────────────────────── *
 * 记录最后一次收到的请求头，供断言反代头改写；对 / 返回 HTML，
 * 对 /api/data 返回 JSON，对 /redir 返回 302 到回环地址。
 */
const seen = [];
let core;
let corePort;
function startCore() {
  return new Promise((resolve) => {
    core = http.createServer((req, res) => {
      seen.push({ url: req.url, headers: req.headers, method: req.method });
      if (req.url === '/redir') {
        res.writeHead(302, { Location: `http://127.0.0.1:${corePort}/target` });
        res.end();
        return;
      }
      if (req.url === '/api/data') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!DOCTYPE html><html><head><title>core</title></head><body>hi</body></html>');
    });
    core.listen(0, '127.0.0.1', () => {
      corePort = core.address().port;
      resolve();
    });
  });
}

function stopCore() {
  return new Promise((resolve) => core.close(() => resolve()));
}

/** 发一个经过网关 HTTPS 监听的请求（自签证书，测试里不做证书校验） */
function viaHttpsGateway(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { host: '127.0.0.1', port, path: p, method, headers, rejectUnauthorized: false },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

/** 发一个经过网关的请求，返回 {status, headers, body} */
function viaGateway(port, { method = 'GET', path: p = '/', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const store = new WebStore({
  devices: [],
  trustedHosts: [],
});
let gw;
let gwPort;

await r.run(async (check) => {
  await startCore();
  // 端口 0 = 随机可用端口，避免与本机其它服务冲突
  gw = new GatewayServer({ port: 0, host: '127.0.0.1', corePort, coreHost: '127.0.0.1' }, store, null);
  const started = await gw.start();
  gwPort = started.port;
  check('网关启动并返回端口', Number.isInteger(gwPort) && gwPort > 0, String(gwPort));
  check('网关状态为 running', gw.getStatus() === 'running', gw.getStatus());
  check('网关 boundPort 与 start() 一致', gw.getBoundPort() === gwPort);

  const H = (extra = {}) => ({ host: `127.0.0.1:${gwPort}`, ...extra });

  // ── 1. Host 校验 ────────────────────────────────────────
  {
    const res = await viaGateway(gwPort, { path: '/', headers: H() });
    check('Host=127.0.0.1 放行（IP 直连）', res.status === 302 || res.status === 200, `status=${res.status}`);

    const res2 = await viaGateway(gwPort, { path: '/', headers: { host: 'evil.example.com' } });
    check('未知域名 Host 返回 400', res2.status === 400, `status=${res2.status}`);
    const msg = JSON.parse(res2.body);
    check('400 文案提示配置域名白名单', /域名白名单/.test(msg.message || ''), msg.message);

    store.updateOptions({ trustedHosts: ['example.com'] });
    const res3 = await viaGateway(gwPort, { path: '/', headers: { host: 'example.com' } });
    check('加入白名单后该域名放行（不再 400）', res3.status !== 400, `status=${res3.status}`);

    const res4 = await viaGateway(gwPort, { path: '/', headers: { host: 'localhost' } });
    check('localhost 始终放行', res4.status !== 400, `status=${res4.status}`);
    store.updateOptions({ trustedHosts: [] });
  }

  // ── 2. 未登录：HTML 302、内部 API 401 ────────────────────
  {
    const res = await viaGateway(gwPort, { path: '/', headers: H({ accept: 'text/html' }) });
    check('未登录访问根路径 302 到登录页', res.status === 302, `status=${res.status}`);
    check('302 目标为 /api/dshweb/login', res.headers.location === '/api/dshweb/login', res.headers.location);

    // 关键安全断言：宿主路由（config）不能被匿名透传
    const res2 = await viaGateway(gwPort, {
      path: '/api/dshweb/config',
      method: 'POST',
      headers: H({ 'content-type': 'application/json' }),
      body: '{"port":1234}',
    });
    check('未登录 POST /api/dshweb/config 返回 401（不匿名透传）', res2.status === 401, `status=${res2.status}`);
    check('401 body 为 JSON', (() => { try { return JSON.parse(res2.body).error === 'Unauthorized'; } catch { return false; } })(), res2.body);
    check('未登录时端口未被改动', store.getOptions().port !== 1234, String(store.getOptions().port));
  }

  // ── 3. status 公开可读（无会话）────────────────────────
  {
    const res = await viaGateway(gwPort, { path: '/api/dshweb/status', headers: H() });
    check('status 无会话也可读', res.status === 200, `status=${res.status}`);
    const j = JSON.parse(res.body);
    check('status 返回 ok:true', j.ok === true);
    check('status 回显网关端口', j.port === gwPort, `${j.port} vs ${gwPort}`);
  }

  // ── 4. 登录页 GET ──────────────────────────────────────
  {
    const res = await viaGateway(gwPort, { path: '/api/dshweb/login', headers: H({ accept: 'text/html' }) });
    check('登录页 GET 返回 200 HTML', res.status === 200 && /text\/html/.test(res.headers['content-type'] || ''), `status=${res.status}`);
    check('登录页含口令输入', /password|口令/.test(res.body), res.body.slice(0, 120));
    check('登录页含「保持登录 24 小时」勾选框', res.body.includes('name="keep"') && /保持登录\s*24\s*小时/.test(res.body), res.body.slice(0, 400));
  }

  // ── 5. 登录成功 → Set-Cookie + 302，随后 HTML 注入 ──────
  {
    store.updateOptions({ passwordSalt: 'abcdef0123456789', passwordHash: (await import('../lib/auth/credentials.js')).hashPassword('secret123', 'abcdef0123456789') });
    store.updateOptions({ trustedHosts: [] });

    // 先确认错误口令被拒
    const bad = await viaGateway(gwPort, {
      path: '/api/dshweb/login',
      method: 'POST',
      headers: H({ 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }),
      body: 'password=wrongpass',
    });
    check('错误口令不返回 Set-Cookie', !bad.headers['set-cookie'], JSON.stringify(bad.headers['set-cookie']));

    const okRes = await viaGateway(gwPort, {
      path: '/api/dshweb/login',
      method: 'POST',
      headers: H({ 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }),
      body: 'password=secret123',
    });
    check('正确口令 302 回首页', okRes.status === 302, `status=${okRes.status}`);
    const setCookie = (okRes.headers['set-cookie'] || []).join(';');
    check('登录成功下发 SESSION_COOKIE', setCookie.includes(SESSION_COOKIE + '='), setCookie);
    check('cookie 为 HttpOnly', /HttpOnly/i.test(setCookie), setCookie);
    const token = (setCookie.match(new RegExp(SESSION_COOKIE + '=([^;]+)')) || [])[1];
    check('cookie 值非空', Boolean(token));
    // 不勾选保持登录 → 会话级 Cookie，绝不能带 Max-Age / Expires
    check('未勾选保持登录：Cookie 无 Max-Age/Expires（会话级）', !/Max-Age|Expires/i.test(setCookie), setCookie);

    // ── 5b. 勾选「保持登录 24 小时」 ─────────────────────────
    const keepRes = await viaGateway(gwPort, {
      path: '/api/dshweb/login',
      method: 'POST',
      headers: H({ 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html' }),
      body: 'password=secret123&keep=1',
    });
    const keepCookie = (keepRes.headers['set-cookie'] || []).join(';');
    check('勾选保持登录：登录成功 302', keepRes.status === 302, `status=${keepRes.status}`);
    check('勾选保持登录：Cookie 带 Max-Age=86400', /Max-Age=86400\b/i.test(keepCookie), keepCookie);
    check('勾选保持登录：Cookie 仍为 HttpOnly', /HttpOnly/i.test(keepCookie), keepCookie);
    const keepToken = (keepCookie.match(new RegExp(SESSION_COOKIE + '=([^;]+)')) || [])[1];
    check('勾选保持登录：cookie 值非空', Boolean(keepToken));
    // 服务端会话记录带 24h 绝对过期时间
    const keepSess = store.getSession(keepToken);
    check('勾选保持登录：会话带 expiresAt（约 24h 后）', Boolean(keepSess && keepSess.expiresAt && keepSess.expiresAt > Date.now() && keepSess.expiresAt <= Date.now() + 86400000 + 2000), JSON.stringify(keepSess));

    // 桌面 UA → data-remote="desktop"
    const html = await viaGateway(gwPort, {
      path: '/',
      headers: H({ accept: 'text/html', cookie: `${SESSION_COOKIE}=${token}`, 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120' }),
    });
    check('已登录 HTML 请求 200', html.status === 200, `status=${html.status}`);
    check('桌面端注入 data-remote="desktop"', html.body.includes('data-remote="desktop"'), html.body.slice(0, 200));
    check('HTML 响应带 Cache-Control: no-cache', /no-cache/i.test(html.headers['cache-control'] || ''), html.headers['cache-control']);

    // 手机 UA → mobile + 移动端 head 注入
    const mobileLogin = await viaGateway(gwPort, {
      path: '/api/dshweb/login',
      method: 'POST',
      headers: H({ 'content-type': 'application/x-www-form-urlencoded', accept: 'text/html', 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36' }),
      body: 'password=secret123',
    });
    const mCookie = (mobileLogin.headers['set-cookie'] || []).join(';');
    const mToken = (mCookie.match(new RegExp(SESSION_COOKIE + '=([^;]+)')) || [])[1];
    check('手机登录成功', Boolean(mToken));

    const mHtml = await viaGateway(gwPort, {
      path: '/',
      headers: H({ accept: 'text/html', cookie: `${SESSION_COOKIE}=${mToken}`, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile Safari/537.36' }),
    });
    check('手机端注入 data-remote="mobile"', mHtml.body.includes('data-remote="mobile"'), mHtml.body.slice(0, 200));
    check('手机端标记 data-dshweb="1"', /data-dshweb="1"/.test(mHtml.body), mHtml.body.slice(0, 200));
    check('手机端注入 viewport-fit=cover', /viewport-fit=cover/.test(mHtml.body), 'missing');
    check('手机端注入 dshweb-mobile 样式', /dshweb-mobile/.test(mHtml.body), 'missing');
    check('手机端不注入 desktop 样式', !/dshweb-desktop/.test(mHtml.body));

    // fontScale 生效
    store.updateOptions({ fontScale: 120 });
    const scaled = await viaGateway(gwPort, {
      path: '/',
      headers: H({ accept: 'text/html', cookie: `${SESSION_COOKIE}=${mToken}`, 'user-agent': 'Android Mobile' }),
    });
    check('fontScale=120 写入 --dshweb-font-scale: 1.2', /--dshweb-font-scale:\s*1\.2/.test(scaled.body), (scaled.body.match(/--dshweb-font-scale:[^;]*/) || [''])[0]);
    store.updateOptions({ fontScale: 100 });

    // 非 HTML（JSON）直通不注入
    const json = await viaGateway(gwPort, {
      path: '/api/data',
      headers: H({ accept: 'application/json', cookie: `${SESSION_COOKIE}=${token}` }),
    });
    check('JSON 请求直通不被注入', json.status === 200 && json.body === '{"ok":true}', json.body);
  }

  // ── 5c. 会话绝对过期语义 ─────────────────────────────────
  // 勾选「保持登录」的会话带 24h 绝对过期时间；Cookie 即使被人为留存，
  // 服务端也必须拒掉过期会话，且服务重启不得从 sessions.json 复活僵尸会话。
  {
    const fs = await import('node:fs');
    // 直接构造一个「保持登录」会话，再人为把 expiresAt 拨到过去
    const tExpired = store.createSession('desktop', true);
    check('持久会话创建后 getSession 可见', Boolean(store.getSession(tExpired)));
    store.sessions.get(tExpired).expiresAt = Date.now() - 1000;
    check('过期持久会话被 getSession 拒绝（返回 null）', store.getSession(tExpired) === null);
    check('过期持久会话被从内存清理', !store.sessions.has(tExpired));

    // 模拟服务重启：往 sessions.json 写入过期持久 / 未过期持久 / 会话级 / 旧记录
    const dir = dshwebDir(HOME);
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const fixtures = {
      expiredKeep: { remote: 'mobile', createdAt: now - 90000000, expiresAt: now - 1000 },
      freshKeep: { remote: 'mobile', createdAt: now, expiresAt: now + 86400000 },
      sessionOnly: { remote: 'desktop', createdAt: now, expiresAt: 0 },
      legacyNoField: { remote: 'desktop', createdAt: now },
    };
    fs.writeFileSync(path.join(dir, 'sessions.json'), JSON.stringify(fixtures, null, 2), 'utf8');
    const fresh = new WebStore({});
    check('重启：过期持久会话不复活', fresh.getSession('expiredKeep') === null);
    check('重启：未过期持久会话保留', Boolean(fresh.getSession('freshKeep')));
    check('重启：会话级会话保留（expiresAt=0）', Boolean(fresh.getSession('sessionOnly')));
    check('重启：旧记录无 expiresAt 按会话级保留', Boolean(fresh.getSession('legacyNoField')));

    // 网关自身的热重载兜底：即使宿主 store.js 仍是旧版（getSession 不过期），
    // 网关 getSession 也必须按 expiresAt 拒绝过期「保持登录」会话。
    const origGetSession = store.getSession.bind(store);
    const fakeTok = 'stub-expired-session';
    store.getSession = (tok) => (tok === fakeTok
      ? { remote: 'mobile', createdAt: Date.now(), expiresAt: Date.now() - 1000 }
      : origGetSession(tok));
    const expiredReq = { headers: { cookie: `${SESSION_COOKIE}=${fakeTok}` } };
    check('网关 getSession 拒掉过期持久会话（旧 store 兜底）', gw.getSession(expiredReq) === undefined);
    store.getSession = (tok) => (tok === fakeTok
      ? { remote: 'mobile', createdAt: Date.now(), expiresAt: Date.now() + 86400000 }
      : origGetSession(tok));
    check('网关 getSession 放行未过期持久会话', gw.getSession(expiredReq) === fakeTok);
    store.getSession = origGetSession;
  }

  // ── 6. 写请求同源校验 ───────────────────────────────────
  {
    const token = store.createSession('desktop');
    store.markSeen(token, 'devA');
    const cookie = `${SESSION_COOKIE}=${token}`;

    const cross = await viaGateway(gwPort, {
      path: '/api/dshweb/config',
      method: 'POST',
      headers: H({ cookie, origin: 'https://evil.example', 'content-type': 'application/json' }),
      body: '{"port":4321}',
    });
    check('跨站 Origin 的写请求返回 403', cross.status === 403, `status=${cross.status}`);
    check('403 文案为「跨站写请求被拒绝」', /跨站写请求被拒绝/.test(cross.body), cross.body);
    check('被拒后端口未改', store.getOptions().port !== 4321, String(store.getOptions().port));

    const secFetch = await viaGateway(gwPort, {
      path: '/api/dshweb/config',
      method: 'POST',
      headers: H({ cookie, 'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }),
      body: '{"port":4321}',
    });
    check('sec-fetch-site=cross-site 的写请求 403', secFetch.status === 403, `status=${secFetch.status}`);

    const same = await viaGateway(gwPort, {
      path: '/api/dshweb/config',
      method: 'POST',
      headers: H({ cookie, origin: `http://127.0.0.1:${gwPort}`, 'content-type': 'application/json' }),
      body: '{"fontFamily":"Consolas"}',
    });
    check('同源写请求放行（不同于 403）', same.status !== 403, `status=${same.status}`);

    const getReq = await viaGateway(gwPort, {
      path: '/api/dshweb/status',
      headers: H({ cookie, origin: 'https://evil.example' }),
    });
    check('GET 请求不做同源校验', getReq.status === 200, `status=${getReq.status}`);
  }

  // ── 6b. 域名/CDN 答案提交回归（远程端「选择弹窗提交无效、几秒后重现」）──
  // 隧道把 Host 改写成回环绑定地址、浏览器 Origin 仍是白名单公网域名时：
  // 统一写校验必须放行、反代必须照样把 Origin 洗白成回环核心（核心围栏要求
  // Origin.host === Host），否则 POST /api/$events/result 被 403 → 代际重置 →
  // pending waterfall 重新下发 → 选择窗再次弹出。第三方来源仍必须 403。
  {
    store.updateOptions({ trustedHosts: ['dsh.my-cloud.cn'] });
    const token = store.createSession('mobile');
    const cookie = `${SESSION_COOKIE}=${token}`;
    const answerBody = JSON.stringify({
      type: 'client-request', rpcId: 'reg-1', method: '$events/result',
      payload: { args: { clientId: 'c', eventId: 'e', outcome: { kind: 'result', value: {} } } },
    });

    // (a) Host 被 CDN 改写成回环、Origin 为白名单域名：写校验放行（不再是 403）。
    const rewritten = await viaGateway(gwPort, {
      path: '/api/$events/result',
      method: 'POST',
      headers: H({ cookie, host: `127.0.0.1:${gwPort}`, origin: 'https://dsh.my-cloud.cn',
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }),
      body: answerBody,
    });
    check('CDN 改写 Host + 白名单 Origin 的答案 POST 不再 403', rewritten.status !== 403, `status=${rewritten.status}`);

    // (b) 即便 CDN 注入 sec-fetch-site: cross-site，白名单 Origin 仍按同源放行。
    const crossInjected = await viaGateway(gwPort, {
      path: '/api/$events/result',
      method: 'POST',
      headers: H({ cookie, host: `127.0.0.1:${gwPort}`, origin: 'https://dsh.my-cloud.cn',
        'sec-fetch-site': 'cross-site', 'content-type': 'application/json' }),
      body: answerBody,
    });
    check('白名单 Origin + CDN 注入 cross-site 仍放行', crossInjected.status !== 403, `status=${crossInjected.status}`);

    // (c) 反代头：白名单 Origin 被虚拟化成回环核心（核心围栏要求）。
    seen.length = 0;
    await viaGateway(gwPort, {
      path: '/api/data',
      method: 'POST',
      headers: H({ cookie, host: `127.0.0.1:${gwPort}`, origin: 'https://dsh.my-cloud.cn',
        referer: 'https://dsh.my-cloud.cn/some/page', 'sec-fetch-site': 'cross-site',
        'content-type': 'application/json' }),
      body: '{}',
    });
    const hdr = seen[seen.length - 1];
    check('白名单域名 Origin 被洗白为回环核心', hdr.headers.origin === `http://127.0.0.1:${corePort}`, hdr.headers.origin);
    check('白名单域名 Referer 被洗白为回环核心', String(hdr.headers.referer || '').startsWith(`http://127.0.0.1:${corePort}/`), hdr.headers.referer);
    check('白名单域名 sec-fetch-site 被改为 same-origin', hdr.headers['sec-fetch-site'] === 'same-origin', hdr.headers['sec-fetch-site']);

    // (d) 安全底线：第三方来源无论 Host 如何都 403。
    const evil = await viaGateway(gwPort, {
      path: '/api/$events/result',
      method: 'POST',
      headers: H({ cookie, host: `127.0.0.1:${gwPort}`, origin: 'https://evil.example.com',
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }),
      body: answerBody,
    });
    check('第三方 Origin 的答案 POST 仍 403', evil.status === 403, `status=${evil.status}`);

    // (e) 答案回传与客户端断开解耦：客户端 abort 后核心仍收到完整 body。
    seen.length = 0;
    await new Promise((resolve) => {
      const req = http.request(
        { host: '127.0.0.1', port: gwPort, path: '/api/$events/result', method: 'POST',
          headers: H({ cookie, host: `127.0.0.1:${gwPort}`, origin: 'https://dsh.my-cloud.cn',
            'content-type': 'application/json' }) },
        () => resolve(),
      );
      req.on('error', () => resolve());
      req.write(answerBody);
      setImmediate(() => req.destroy());
      setTimeout(resolve, 600);
    });
    await new Promise((r) => setTimeout(r, 300));
    const got = seen.find((x) => x.url === '/api/$events/result');
    check('客户端 abort 后核心仍收到答案 POST（解耦）', Boolean(got), `seen=${seen.map((x) => x.url).join(',')}`);

    store.updateOptions({ trustedHosts: [] });
  }

  // ── 7. 反代头改写 ───────────────────────────────────────
  {
    const token = store.createSession('desktop');
    const cookie = `${SESSION_COOKIE}=${token}`;
    seen.length = 0;
    await viaGateway(gwPort, {
      path: '/api/data',
      headers: H({ cookie, origin: `http://127.0.0.1:${gwPort}`, referer: `http://127.0.0.1:${gwPort}/some/page` }),
    });
    const last = seen[seen.length - 1];
    check('转发请求的 Host 被改写为回环核心', last.headers.host === `127.0.0.1:${corePort}`, last.headers.host);
    check('保留外部真实 Host 到 x-ddsh-original-host', last.headers['x-ddsh-original-host'] === `127.0.0.1:${gwPort}`, last.headers['x-ddsh-original-host']);
    check('同源 Origin 被洗白为回环核心', last.headers.origin === `http://127.0.0.1:${corePort}`, last.headers.origin);
    check('同源 Referer 被改写', String(last.headers.referer || '').startsWith(`http://127.0.0.1:${corePort}/`), last.headers.referer);
    check('sec-fetch-site 被改为 same-origin', last.headers['sec-fetch-site'] === 'same-origin', last.headers['sec-fetch-site']);

    // 跨站 Origin 原样保留（让核心继续拦截），仅在写请求会先被网关 403，
    // 故用 GET 观察原始 Origin 透传行为
    seen.length = 0;
    await viaGateway(gwPort, {
      path: '/api/data',
      headers: H({ cookie, origin: 'https://third.party' }),
    });
    const last2 = seen[seen.length - 1];
    check('第三方 Origin 原样保留给核心', last2.headers.origin === 'https://third.party', last2.headers.origin);
  }

  // ── 7b. 反代链路「来源」头一律剥掉（域名/CDN 登录跳不回主页面的根因）──
  // DSH 核心 BrowserAuth 一见 x-forwarded-for / x-forwarded-host /
  // x-forwarded-proto / x-real-ip 就按「非本机直连」处理 → 401 要求设备配对。
  // Cloudflare / nginx 反代会自动加这些头，登录（公开路由）能过但登录后
  // 转发到核心的请求被 401 → 302 /auth。网关已自持会话鉴权，核心侧只需
  // 回环直连语义，故转发前必须删除，否则域名登录永远进不了主页面。
  {
    const token = store.createSession('desktop');
    const cookie = `${SESSION_COOKIE}=${token}`;
    seen.length = 0;
    await viaGateway(gwPort, {
      path: '/api/data',
      headers: H({
        cookie,
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-host': 'dshweb.ccwu.cc',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-real-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.9;proto=https',
        'cf-connecting-ip': '203.0.113.9',
        'cf-ray': '8abc-HKG',
        'cdn-loop': 'cloudflare',
      }),
    });
    const last = seen[seen.length - 1];
    for (const h of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded']) {
      check(`反代头 ${h} 转发到核心前被剥离`, last.headers[h] === undefined, `${h}=${last.headers[h]}`);
    }
    // 非「来源」类的 CDN 头不在黑名单里，允许透传（不影响核心鉴权）
    check('cf-ray 等 CDN 头不受影响（透传）', last.headers['cf-ray'] === '8abc-HKG', last.headers['cf-ray']);
    // 剥头后 Host 仍被正确改写为回环核心
    check('剥头后 Host 仍改写为回环核心', last.headers.host === `127.0.0.1:${corePort}`, last.headers.host);
  }

  // ── 8b. WS 升级 / https 域名(Cloudflare) 头形制回归 ──────────────
  // 「重新连接中」= 核心把 WS /api/remote.mux 升级挡回 403 / 数据流起不来。
  // Cloudflare 在 https 域名下自动补 x-forwarded-* / x-forwarded-proto:https /
  // cf-* 头，且浏览器 WS 的 Origin 是 https://<域名>。handleUpgrade 依赖的正是
  // buildProxyHeaders，这里直接锁死：来源头剥光、Origin 洗白成回环核心、Host
  // 改写、sec-fetch-site 归一，Upgrade/Connection 等协议头必须保留。
  {
    const fakeReq = {
      headers: {
        host: 'dshweb.ccwu.cc',
        origin: 'https://dshweb.ccwu.cc',
        'x-forwarded-for': '203.0.113.9',
        'x-forwarded-host': 'dshweb.ccwu.cc',
        'x-forwarded-proto': 'https',
        'x-forwarded-port': '443',
        'x-real-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.9;proto=https',
        'cf-ray': '8abc-HKG',
        'cf-connecting-ip': '203.0.113.9',
        'cdn-loop': 'cloudflare',
        'sec-fetch-site': 'cross-site',
        upgrade: 'websocket',
        connection: 'Upgrade',
        'sec-websocket-key': 'dGhlIHNhbXBsZSBub25jZQ==',
        'sec-websocket-version': '13',
      },
    };
    const h = gw.buildProxyHeaders(fakeReq, 'dshweb.ccwu.cc');
    for (const k of ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-forwarded-port', 'x-real-ip', 'forwarded']) {
      check(`WS 升级：来源头 ${k} 被剥离`, h[k] === undefined, `${k}=${h[k]}`);
    }
    check('WS 升级：https Origin 洗白为回环核心', h.origin === `http://127.0.0.1:${corePort}`, h.origin);
    check('WS 升级：Host 改写为回环核心', h.host === `127.0.0.1:${corePort}`, h.host);
    check('WS 升级：sec-fetch-site 归一为 same-origin', h['sec-fetch-site'] === 'same-origin', h['sec-fetch-site']);
    check('WS 升级：cf-ray 等 CDN 头不受影响（透传）', h['cf-ray'] === '8abc-HKG', h['cf-ray']);
    check('WS 升级：Upgrade/Connection 协议头保留', h.upgrade === 'websocket' && /upgrade/i.test(String(h.connection)), `${h.upgrade}/${h.connection}`);
  }

  // ── 8. 重定向 Location 回环改写 ─────────────────────────
  {
    const token = store.createSession('desktop');
    const res = await viaGateway(gwPort, {
      path: '/redir',
      headers: H({ cookie: `${SESSION_COOKIE}=${token}` }),
    });
    check('302 状态透传', res.status === 302, `status=${res.status}`);
    // 上游 Location 指向 127.0.0.1:<corePort>；rewriteRedirectLocation 只改写
    // 3000-3099 端口的回环地址，随机高位端口应保持原样（不误改）。
    check('非 30xx 回环地址不被误改', res.headers.location === `http://127.0.0.1:${corePort}/target`, res.headers.location);
  }

  // ── 9. 设备注册：登录后进入 devices 列表 ───────────────
  {
    const before = (store.getOptions().devices || []).length;
    const token = store.createSession('mobile');
    store.markSeen(token, 'devM');
    await viaGateway(gwPort, {
      path: '/',
      headers: H({ accept: 'text/html', cookie: `${SESSION_COOKIE}=${token}`, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile' }),
    });
    const after = (store.getOptions().devices || []).length;
    check('已登录请求会补登记设备（devices 增长或复用）', after >= before, `${before} -> ${after}`);
  }

  // ── 10. PWA 静态资源免登录 ─────────────────────────────
  {
    const res = await viaGateway(gwPort, { path: '/manifest.webmanifest', headers: H() });
    check('manifest 未登录也可取（非 302）', res.status !== 302, `status=${res.status}`);
    const icon = await viaGateway(gwPort, { path: '/favicon.ico', headers: H() });
    check('favicon.ico 未登录也可取（不再 404 → 避免回退地球图标）', icon.status === 200, `status=${icon.status}`);
    check('favicon.ico 内容为真 ICO（字节以 00 00 01 00 开头）',
      icon.status === 200 && icon.body.startsWith('\u0000\u0000\u0001\u0000'),
      `head=${icon.status === 200 ? JSON.stringify(icon.body.slice(0, 4)) : 'n/a'}`);
  }

  // ── 10b. PWA 图标版本化（旧「地球」缓存不再复用）──────
  {
    // manifest 由网关自持，图标 URL 必须带 ?v=<内容hash>
    const mf = await viaGateway(gwPort, { path: '/manifest.webmanifest', headers: H() });
    check('manifest 由网关返回 application/manifest+json',
      String(mf.headers['content-type'] || '').includes('application/manifest+json'),
      mf.headers['content-type']);
    let parsed = null;
    try { parsed = JSON.parse(mf.body); } catch {}
    check('manifest 可解析为 JSON', Boolean(parsed));
    const icons = (parsed && parsed.icons) || [];
    check('manifest 图标全部带 ?v= 版本号（换键破缓存）',
      icons.length > 0 && icons.every((i) => /[?&]v=/.test(String(i.src))),
      JSON.stringify(icons.map((i) => i.src)));
    check('manifest 含 PNG 192/512 与 maskable',
      icons.some((i) => i.sizes === '192x192') &&
        icons.some((i) => i.sizes === '512x512' && i.purpose === 'any') &&
        icons.some((i) => i.purpose === 'maskable'),
      JSON.stringify(icons.map((i) => `${i.sizes}:${i.purpose || 'any'}`)));

    // 图标带版本号请求可取，且长缓存
    const v = (String(icons[0] && icons[0].src).match(/v=([0-9a-f]+)/) || [])[1];
    check('manifest 图标版本号非空', Boolean(v), String(v));
    if (v) {
      const png = await viaGateway(gwPort, { path: `/icon-192.png?v=${v}`, headers: H() });
      check('带版本号的 PNG 图标可取', png.status === 200, `status=${png.status}`);
      check('图标可长缓存（immutable）',
        String(png.headers['cache-control'] || '').includes('immutable'),
        png.headers['cache-control']);
    }
  }

  // ── 10c. HTML head 注入 PNG/ICO 图标链接 ───────────────
  {
    const token = store.createSession('mobile');
    const res = await viaGateway(gwPort, {
      path: '/',
      headers: H({ accept: 'text/html', cookie: `${SESSION_COOKIE}=${token}`, 'user-agent': 'Mozilla/5.0 (Linux; Android 14) Mobile' }),
    });
    check('HTML 注入 PNG 图标链接（192x192）', /rel="icon"[^>]*sizes="192x192"/.test(res.body));
    check('HTML 注入 favicon.ico 链接', /rel="icon"[^>]*image\/x-icon/.test(res.body));
    check('HTML 注入 apple-touch-icon 链接', /rel="apple-touch-icon"[^>]*180x180/.test(res.body));
    check('注入的图标 URL 带版本号', /rel="icon"[^>]*icon-192\.png\?v=[0-9a-f]+/.test(res.body));
  }

  // ── 10d. 远程会话「重新连接中」韧性加固（CDN 慢链路 / 会话 / 冻结）────
  // 背景：x-forwarded-* 剥离修复上线后，https 域名与 http 局域网在干净浏览器里
  // 完全一致；真机偶发卡「重新连接中」的剩余可复现差异是 Cloudflare 给 WS 握手
  // 额外 ~7s 延迟 vs 客户端默认 15s generationReadyTimeoutMs。此测试锁定三类兜底。
  {
    const cfg = '<script>globalThis["__DSH_CONNECTION_RECOVERY__"] = {"backoffBaseMs":500,"backoffFactor":2,"backoffMaxMs":10000,"generationReadyWarnMs":3000,"generationReadyTimeoutMs":15000}</script>';
    const html = '<!DOCTYPE html><html data-remote="mobile"><head>' + cfg + '</head><body>hi</body></html>';
    const out = injectRemoteResilience(html);
    check('连接恢复：generationReadyTimeoutMs 被放宽（CDN 慢链路）',
      /"generationReadyTimeoutMs":60000/.test(out), (out.match(/"generationReadyTimeoutMs":\d+/) || [])[0]);
    check('连接恢复：generationReadyWarnMs 同步放宽',
      /"generationReadyWarnMs":20000/.test(out), (out.match(/"generationReadyWarnMs":\d+/) || [])[0]);
    check('连接恢复：backoff 等其余字段原样保留',
      /"backoffBaseMs":500/.test(out) && /"backoffFactor":2/.test(out) && /"backoffMaxMs":10000/.test(out));
    check('连接恢复：只放宽不收窄（宿主更高设定被尊重）',
      /"generationReadyTimeoutMs":90000/.test(injectRemoteResilience(html.replace('15000', '90000'))));
    check('连接恢复：注入看门狗脚本且带幂等标记',
      out.includes('data-dshweb-conn-heal="1"') && out.includes('</script>'));
    check('连接恢复：探活走只读 /api/dshweb/session',
      out.includes("/api/dshweb/session") && !out.includes("/api/dshweb/config"));
    check('连接恢复：401 回登录页 / 卡死文案才刷新',
      out.includes("location.replace('/api/dshweb/login')") &&
      /重新连接中/.test(out) && out.includes('location.reload()'));
    check('连接恢复：仅在 data-remote 页面生效（桌面直连零命中）',
      out.includes("hasAttribute('data-remote')"));
    check('连接恢复：无配置时补前置设定（不回落 15s 默认）',
      /generationReadyTimeoutMs["']?\s*:\s*60000/.test(injectRemoteResilience('<html><head></head><body>x</body></html>')));
    check('连接恢复：幂等（重复注入不叠加）',
      injectRemoteResilience(out) === out);
  }

  // ── 10e. 会话探活端点（公开、只读、无敏感信息）────────────
  {
    const anon = await viaGateway(gwPort, { path: '/api/dshweb/session', headers: H() });
    check('会话探活：无会话 401（不泄露信息）', anon.status === 401, `status=${anon.status}`);
    const token = store.createSession('mobile');
    const good = await viaGateway(gwPort, { path: '/api/dshweb/session', headers: H({ cookie: `${SESSION_COOKIE}=${token}` }) });
    check('会话探活：有效会话 200', good.status === 200, `status=${good.status}`);
    check('会话探活：响应仅含布尔 ok（无 port/口令/设备）',
      /^\{"ok":true\}$/.test(good.body) && !/port|password|device|corePort|token/i.test(good.body), good.body);
    check('会话探活：no-store 不被 CDN 缓存',
      /no-store/.test(String(good.headers['cache-control'] || '')), good.headers['cache-control']);
  }

  // ── 11. HTTPS 与 HTTP 双监听共存 ─────────────────────────
  // 目的：m01467 要求「开启 https，默认端口 3181，端口可设置，和 http 共存」。
  // 单独起一个双监听网关（不动上面已跑通的 gw），验证两个端口同时可服务、
  // status 同时回显 HTTP/HTTPS 信息、close 同时关掉两个监听。
  {
    const tls = loadOrCreateTlsCredentials({ dir: dshwebDir(HOME) });
    check('纯 Node 自签证书可用（无 openssl 依赖）',
      tls.source === 'generated' && /BEGIN CERTIFICATE/.test(tls.cert), tls.source);
    const dgw = new GatewayServer(
      {
        port: 0,
        httpsPort: 0,
        httpsEnabled: true,
        tls: { cert: tls.cert, key: tls.key },
        host: '127.0.0.1',
        corePort,
        coreHost: '127.0.0.1',
      },
      store,
      null,
    );
    const started = await dgw.start();
    const dHttp = started.port;
    const dHttps = dgw.getHttpsBoundPort();
    check('双监听：HTTP 与 HTTPS 端口均已分配且不同',
      dHttp > 0 && dHttps > 0 && dHttp !== dHttps, `http=${dHttp} https=${dHttps}`);
    check('双监听：isHttpsRunning 为 true', dgw.isHttpsRunning() === true);
    check('双监听：isHttpsEnabled 为 true', dgw.isHttpsEnabled() === true);
    check('双监听：isTls() 反映 HTTPS 已就绪', dgw.isTls() === true);

    const DH = (extra = {}) => ({ host: `127.0.0.1:${dHttp}`, ...extra });
    const SH = (extra = {}) => ({ host: `127.0.0.1:${dHttps}`, ...extra });
    // 两个监听都能独立返回 status（公开只读端点）
    const stHttp = await viaGateway(dHttp, { path: '/api/dshweb/status', headers: DH() });
    const stHttps = await viaHttpsGateway(dHttps, { path: '/api/dshweb/status', headers: SH() });
    check('双监听：HTTP 端口返回 200 status', stHttp.status === 200, `status=${stHttp.status}`);
    check('双监听：HTTPS 端口返回 200 status', stHttps.status === 200, `status=${stHttps.status}`);
    const jh = JSON.parse(stHttp.body);
    const jhs = JSON.parse(stHttps.body);
    check('双监听：status 标记 httpsEnabled', jh.httpsEnabled === true);
    check('双监听：status 标记 httpsRunning', jh.httpsRunning === true);
    check('双监听：status 回显 HTTPS 端口', jh.httpsPort === dHttps, `${jh.httpsPort} vs ${dHttps}`);
    check('双监听：status 的 lanUrl 始终为 http（HTTP 接入地址不被 HTTPS 污染）',
      /^http:\/\//.test(jh.lanUrl), jh.lanUrl);
    check('双监听：status 提供 httpsLanUrl（https 协议）',
      /^https:\/\//.test(jh.httpsLanUrl), jh.httpsLanUrl);
    check('双监听：HTTPS 端口返回的 status 与 HTTP 一致',
      jhs.httpsEnabled === true && jhs.httpsRunning === true && jhs.httpsPort === dHttps);

    // 已登录会话在两个监听上都能取到 HTML（注入 data-remote）
    const token = store.createSession('mobile');
    const ck = `${SESSION_COOKIE}=${token}`;
    const htmlHttp = await viaGateway(dHttp, { path: '/', headers: DH({ cookie: ck }) });
    const htmlHttps = await viaHttpsGateway(dHttps, { path: '/', headers: SH({ cookie: ck }) });
    check('双监听：HTTP 已登录 HTML 注入 data-remote', /data-remote="mobile"/.test(htmlHttp.body));
    check('双监听：HTTPS 已登录 HTML 注入 data-remote', /data-remote="mobile"/.test(htmlHttps.body));

    // 关闭后两个端口都不可再连
    await dgw.close();
    let closedHttp = false;
    let closedHttps = false;
    try { await viaGateway(dHttp, { path: '/', headers: DH() }); } catch { closedHttp = true; }
    try { await viaHttpsGateway(dHttps, { path: '/', headers: SH() }); } catch { closedHttps = true; }
    check('双监听：close 同时关闭 HTTP 端口', closedHttp === true);
    check('双监听：close 同时关闭 HTTPS 端口', closedHttps === true);
    check('双监听：close 后 isHttpsRunning 为 false', dgw.isHttpsRunning() === false);
  }

  // ── 11b. HTTPS 端口被占用时降级为仅 HTTP（共存可用性） ─────
  // 「与 HTTP 共存」要求 HTTPS 绑定失败不能连累 HTTP 主监听。
  {
    const net = await import('node:net');
    const blocker = net.createServer();
    await new Promise((r) => blocker.listen(0, '127.0.0.1', r));
    const occupied = blocker.address().port;
    const tls = loadOrCreateTlsCredentials({ dir: dshwebDir(HOME) });
    const dgw2 = new GatewayServer(
      {
        port: 0,
        httpsPort: occupied, // 故意占用
        httpsEnabled: true,
        tls: { cert: tls.cert, key: tls.key },
        host: '127.0.0.1',
        corePort,
        coreHost: '127.0.0.1',
      },
      store,
      null,
    );
    let started = null;
    let startErr = null;
    try { started = await dgw2.start(); } catch (err) { startErr = err; }
    check('占用端口：start() 不抛异常（HTTP 仍可用）', startErr === null, startErr && startErr.message);
    check('占用端口：isHttpsEnabled 仍为 true（配置意图保留）', dgw2.isHttpsEnabled() === true);
    check('占用端口：isHttpsRunning 为 false（HTTPS 未就绪）', dgw2.isHttpsRunning() === false);
    check('占用端口：isTls 反映未就绪', dgw2.isTls() === false);
    check('占用端口：getHttpsBoundPort 为 0', dgw2.getHttpsBoundPort() === 0);
    if (started) {
      const st = await viaGateway(started.port, { path: '/api/dshweb/status', headers: { host: `127.0.0.1:${started.port}` } });
      check('占用端口：HTTP status 仍返回 200', st.status === 200, `status=${st.status}`);
      const j = JSON.parse(st.body);
      check('占用端口：status.httpsRunning=false', j.httpsRunning === false);
      check('占用端口：status.httpsLanUrl 为空', j.httpsLanUrl === '', j.httpsLanUrl);
      check('占用端口：status.lanUrl 仍是 http', /^http:\/\//.test(j.lanUrl), j.lanUrl);
    }
    await dgw2.close();
    await new Promise((r) => blocker.close(r));
  }

  // ── 12. 网关关闭 ───────────────────────────────────────
  {
    await gw.close();
    check('close 后状态为 stopped', gw.getStatus() === 'stopped', gw.getStatus());
    let failed = false;
    try {
      await viaGateway(gwPort, { path: '/', headers: H() });
    } catch {
      failed = true;
    }
    check('close 后端口不再接受请求', failed === true);
  }

  await stopCore();
});

// 若断言失败（process.exit(1)），也要收尾释放端口
process.on('exit', () => {
  try {
    core && core.close();
  } catch {}
});
