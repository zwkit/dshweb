/**
 * 宿主路由测试（src/routes/api.ts → lib/routes/api.js）
 *
 * 重点覆盖设备删除两条路由的准入矩阵：
 *   - 带 dshweb_session cookie（= 经网关接入的远程浏览器）→ 403，先于方法检查
 *   - 无 cookie 但非 POST → 405
 *   - 缺 id / 当前设备 → 400
 *   - 正常 → 200 且真正删掉
 * 另外覆盖 display（保留兼容，UI 页签已删但接口不破）、devices 的 online 标记、
 * config 的 trustedHosts 校验。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, dshwebDir, createRunner, fakeResponse, fakeRequest } from './_home.mjs';

const HOME = isolateHome('dshweb-routes');
const TMP = dshwebDir(HOME);
const { WebStore } = await import('../lib/store.js');
const { createRoutes } = await import('../lib/routes/api.js');

const r = createRunner('宿主路由');

const softRestarts = [];
const deps = {
  softRestart: async (reason) => {
    softRestarts.push(reason);
    return { ok: true, port: 3180 };
  },
  getGateway: () => ({
    getBoundPort: () => 3180,
    getStatus: () => 'running',
    getCorePort: () => 3080,
    isTls: () => false,
    isHttpsEnabled: () => false,
    isHttpsRunning: () => false,
    getHttpsBoundPort: () => 3181,
  }),
};

function freshStore(devices) {
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const store = new WebStore({});
  if (devices) store.updateOptions({ devices });
  return store;
}

function dev(id, extra = {}) {
  return { id, name: `设备${id}`, ua: `ua-${id}`, pairedAt: 1700000000000, remote: 'mobile', ...extra };
}

/** 按 path + method 找到对应路由并执行，返回 {status, body} */
async function call(store, pathname, { method = 'GET', headers = {}, body = null } = {}) {
  const routes = createRoutes(store, deps);
  const route = routes.find((rt) => rt.path === pathname);
  if (!route) throw new Error(`路由不存在: ${pathname}`);
  const req = await fakeRequest({ method, url: pathname, headers, body });
  const res = fakeResponse();
  await route.handler(req, res);
  return { status: res.statusCode, body: res.json(), headers: res.headers };
}

/** 造一个「远程浏览器」cookie（会话绑定到 deviceId） */
function sessionCookie(store, deviceId, remote = 'desktop') {
  const token = store.createSession(remote);
  if (deviceId) store.markSeen(token, deviceId);
  return { cookie: `dshweb_session=${token}`, token };
}

await r.run(async (check) => {
  // ── 路由清单 ────────────────────────────────────────────────
  {
    const store = freshStore();
    const routes = createRoutes(store, deps);
    const paths = routes.map((x) => x.path);
    const expected = [
      '/api/dshweb/status',
      '/api/dshweb/config',
      '/api/dshweb/pair-code',
      '/api/dshweb/devices',
      '/api/dshweb/display',
      '/api/dshweb/reload',
      '/api/dshweb/delete-device',
      '/api/dshweb/delete-remote-devices',
    ];
    check('注册了 8 条宿主路由', routes.length === 8, `实际 ${routes.length}`);
    for (const p of expected) check(`包含路由 ${p}`, paths.includes(p));
    check('所有路由 kind 都是 exact', routes.every((x) => x.kind === 'exact'));
  }

  // ── delete-device：远程浏览器 403 ──────────────────────────
  {
    const store = freshStore([dev('d1'), dev('d2')]);
    const { cookie } = sessionCookie(store, 'd1');
    const res = await call(store, '/api/dshweb/delete-device', {
      method: 'POST',
      headers: { cookie },
      body: { id: 'd2' },
    });
    check('带会话 cookie 的删除请求返回 403', res.status === 403, `status=${res.status}`);
    check('403 文案为「仅桌面客户端可删除设备」', res.body && res.body.message === '仅桌面客户端可删除设备', JSON.stringify(res.body));
    check('403 时设备未被删除', store.getOptions().devices.length === 2);
  }

  // ── delete-device：cookie 优先于方法检查 ──────────────────
  {
    const store = freshStore([dev('d1')]);
    const { cookie } = sessionCookie(store, 'd1');
    const res = await call(store, '/api/dshweb/delete-device', { method: 'GET', headers: { cookie } });
    check('带 cookie 的非 POST 也先 403（准入先于方法）', res.status === 403, `status=${res.status}`);
  }

  // ── delete-device：无 cookie 非 POST → 405 ────────────────
  {
    const store = freshStore([dev('d1')]);
    const res = await call(store, '/api/dshweb/delete-device', { method: 'GET' });
    check('无 cookie 的 GET 返回 405', res.status === 405, `status=${res.status}`);
    check('405 文案 Method Not Allowed', res.body && res.body.message === 'Method Not Allowed');
  }

  // ── delete-device：缺 id → 400 ────────────────────────────
  {
    const store = freshStore([dev('d1')]);
    const res = await call(store, '/api/dshweb/delete-device', { method: 'POST', body: {} });
    check('缺 id 返回 400', res.status === 400, `status=${res.status}`);
    check('400 文案「缺少设备 id」', res.body && res.body.message === '缺少设备 id');
  }
  {
    const store = freshStore([dev('d1')]);
    const res = await call(store, '/api/dshweb/delete-device', { method: 'POST', body: { id: 123 } });
    check('id 非字符串返回 400', res.status === 400);
  }
  {
    const store = freshStore([dev('d1')]);
    const res = await call(store, '/api/dshweb/delete-device', { method: 'POST', body: { id: '' } });
    check('id 为空串返回 400', res.status === 400);
  }

  // ── delete-device：非当前设备 → 200 ───────────────────────
  {
    const store = freshStore([dev('d1'), dev('d2')]);
    const res = await call(store, '/api/dshweb/delete-device', {
      method: 'POST',
      body: { id: 'd2' },
    });
    check('桌面直连删除设备返回 200', res.status === 200, `status=${res.status}`);
    check('响应 {ok:true, deleted:true}', res.body && res.body.ok === true && res.body.deleted === true, JSON.stringify(res.body));
    const ids = store.getOptions().devices.map((d) => d.id);
    check('设备确实被删掉', !ids.includes('d2'), ids.join(','));
  }

  // ── delete-device：删除不存在的设备 → 200 但 deleted:false ─
  {
    const store = freshStore([dev('d1')]);
    const res = await call(store, '/api/dshweb/delete-device', { method: 'POST', body: { id: 'ghost' } });
    check('删除不存在的设备返回 200', res.status === 200);
    check('deleted 为 false', res.body && res.body.deleted === false, JSON.stringify(res.body));
  }

  // ── delete-device：不能删当前设备（会话 cookie 场景被 403 挡住，
  //    这里验证「桌面直连但 body 指定了 currentDeviceId」的分支不可达即安全）
  //    —— 桌面直连没有 cookie，故 currentId 恒为 null，永远不会误判。
  {
    const store = freshStore([dev('cur')]);
    const res = await call(store, '/api/dshweb/delete-device', { method: 'POST', body: { id: 'cur' } });
    check('桌面直连可删除任意设备（无 cookie 时 currentId 为 null）', res.status === 200);
  }

  // ── delete-remote-devices ──────────────────────────────────
  {
    const store = freshStore([dev('a'), dev('b'), dev('c')]);
    const res = await call(store, '/api/dshweb/delete-remote-devices', { method: 'POST', body: {} });
    check('一键删除返回 200', res.status === 200, `status=${res.status}`);
    check('removed 为 3', res.body && res.body.removed === 3, JSON.stringify(res.body));
    check('设备清空', store.getOptions().devices.length === 0);
  }
  {
    const store = freshStore([dev('a')]);
    const { cookie } = sessionCookie(store, 'a');
    const res = await call(store, '/api/dshweb/delete-remote-devices', {
      method: 'POST',
      headers: { cookie },
      body: {},
    });
    check('远程浏览器一键删除返回 403', res.status === 403, `status=${res.status}`);
    check('403 时设备仍在', store.getOptions().devices.length === 1);
  }
  {
    const store = freshStore([dev('a')]);
    const res = await call(store, '/api/dshweb/delete-remote-devices', { method: 'GET' });
    check('一键删除非 POST 返回 405', res.status === 405, `status=${res.status}`);
  }
  {
    // 带会话 cookie 时 keepId 应保留自己：但该分支被 403 挡住，
    // 因此用 store 层直接验证（见 store-devices.mjs）。这里只测无 cookie 全删。
    const store = freshStore([]);
    const res = await call(store, '/api/dshweb/delete-remote-devices', { method: 'POST', body: {} });
    check('空列表一键删除返回 removed:0', res.status === 200 && res.body.removed === 0, JSON.stringify(res.body));
  }

  // ── devices 路由：online 标记来自 sessions.json ────────────
  {
    const store = freshStore([dev('on1'), dev('off1')]);
    const token = store.createSession('mobile');
    store.markSeen(token, 'on1');
    const res = await call(store, '/api/dshweb/devices', { method: 'GET' });
    check('devices 返回数组', Array.isArray(res.body), JSON.stringify(res.body));
    const byId = Object.fromEntries((res.body || []).map((d) => [d.id, d]));
    check('绑定会话的设备 online=true', byId.on1 && byId.on1.online === true, JSON.stringify(byId.on1));
    check('无会话的设备 online=false', byId.off1 && byId.off1.online === false, JSON.stringify(byId.off1));
  }
  {
    // 删除设备后其 online 标记必须消失（会话被撤销 → sessions.json 无该 deviceId）
    const store = freshStore([dev('x1'), dev('x2')]);
    const token = store.createSession('mobile');
    store.markSeen(token, 'x1');
    let res = await call(store, '/api/dshweb/devices', { method: 'GET' });
    let byId = Object.fromEntries((res.body || []).map((d) => [d.id, d]));
    check('删除前 x1 在线', byId.x1.online === true);

    await call(store, '/api/dshweb/delete-device', { method: 'POST', body: { id: 'x1' } });
    res = await call(store, '/api/dshweb/devices', { method: 'GET' });
    byId = Object.fromEntries((res.body || []).map((d) => [d.id, d]));
    check('删除后设备不在列表里', !byId.x1);
    check('另一台设备仍在', Boolean(byId.x2));
  }

  // ── display 路由（UI 页签已删，但接口保留以防既有移动端样式失效）──
  {
    const store = freshStore();
    let res = await call(store, '/api/dshweb/display', { method: 'GET' });
    check('display GET 返回默认值', res.body && res.body.fontScale === 100 && res.body.fontFamily === '', JSON.stringify(res.body));

    res = await call(store, '/api/dshweb/display', {
      method: 'POST',
      body: { fontFamily: 'Consolas', fontScale: 120 },
    });
    check('display POST 返回 ok', res.body && res.body.ok === true);
    res = await call(store, '/api/dshweb/display', { method: 'GET' });
    check('display GET 读到新值', res.body.fontScale === 120 && res.body.fontFamily === 'Consolas', JSON.stringify(res.body));
  }

  // ── config：trustedHosts 校验 ──────────────────────────────
  {
    const store = freshStore();
    let res = await call(store, '/api/dshweb/config', { method: 'POST', body: { trustedHosts: 'x.com' } });
    check('trustedHosts 非数组返回 400', res.status === 400, `status=${res.status}`);
    check('400 文案提到数组', /数组/.test(res.body.error || ''), res.body.error);

    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { trustedHosts: ['a.com', 'bad host'] } });
    check('含空白项的 trustedHosts 返回 400', res.status === 400);
    check('400 文案提到无效项', /无效项/.test(res.body.error || ''), res.body.error);

    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { trustedHosts: ['0.0.0.0'] } });
    check('通配地址 0.0.0.0 被拒', res.status === 400);

    softRestarts.length = 0;
    res = await call(store, '/api/dshweb/config', {
      method: 'POST',
      body: { trustedHosts: ['Example.COM', 'example.com', 'https://foo.bar:8443'] },
    });
    check('合法 trustedHosts 返回 200', res.status === 200, `status=${res.status}`);
    const saved = store.getOptions().trustedHosts || [];
    check('trustedHosts 已小写化', saved.includes('example.com'), saved.join(','));
    check('trustedHosts 已去重', saved.filter((x) => x === 'example.com').length === 1, saved.join(','));
    check('URL 形式被剥成裸主机名', saved.includes('foo.bar'), saved.join(','));
    check('保存白名单会触发网关软重载', softRestarts.some((x) => x.includes('trustedHosts')), softRestarts.join('|'));
  }

  // ── config：端口 / 口令校验（非法值被静默忽略，不写盘、不重启）────
  {
    const store = freshStore();
    store.updateOptions({ port: 3180 });
    softRestarts.length = 0;
    let res = await call(store, '/api/dshweb/config', { method: 'POST', body: { port: 0 } });
    check('端口 0 不会写盘', store.getOptions().port === 3180, String(store.getOptions().port));
    check('端口 0 不触发重载', softRestarts.length === 0, softRestarts.join('|'));
    check('端口 0 仍返回 ok（非法值忽略）', res.body && res.body.ok === true, JSON.stringify(res.body));

    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { port: 70000 } });
    check('端口越界不会写盘', store.getOptions().port === 3180, String(store.getOptions().port));
    check('端口越界不触发重载', softRestarts.length === 0, softRestarts.join('|'));

    softRestarts.length = 0;
    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { port: 3210 } });
    check('合法端口返回 200', res.status === 200, `status=${res.status}`);
    check('端口已落盘', store.getOptions().port === 3210);
    check('改端口会触发软重载', softRestarts.length === 1, softRestarts.join('|'));

    const hashBefore = store.getOptions().passwordHash;
    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { password: '123' } });
    check('短口令被忽略（不写哈希）', store.getOptions().passwordHash === hashBefore, String(store.getOptions().passwordHash));
    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { password: 'longenough' } });
    check('合法口令返回 200', res.status === 200, `status=${res.status}`);
    check('口令以哈希形式落盘（不存明文）', Boolean(store.getOptions().passwordHash) && !JSON.stringify(store.getOptions()).includes('longenough'));
    check('口令带盐', Boolean(store.getOptions().passwordSalt));
  }

  // ── config：HTTPS 共存开关 / 独立端口（m01467）─────────────
  {
    const store = freshStore();
    softRestarts.length = 0;
    // 非法值不写盘、不重载
    let res = await call(store, '/api/dshweb/config', { method: 'POST', body: { httpsPort: 0 } });
    check('HTTPS 端口 0 不写盘', store.getOptions().httpsPort === undefined, String(store.getOptions().httpsPort));
    check('HTTPS 端口 0 不触发重载', softRestarts.length === 0, softRestarts.join('|'));
    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { httpsPort: 70000 } });
    check('HTTPS 端口越界不写盘', store.getOptions().httpsPort === undefined, String(store.getOptions().httpsPort));
    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { httpsEnabled: 'yes' } });
    check('非布尔 httpsEnabled 被忽略', store.getOptions().httpsEnabled === undefined, String(store.getOptions().httpsEnabled));
    check('非法 HTTPS 配置不触发重载', softRestarts.length === 0, softRestarts.join('|'));

    // 开启 + 自定义端口：写盘并软重载一次
    softRestarts.length = 0;
    res = await call(store, '/api/dshweb/config', {
      method: 'POST',
      body: { httpsEnabled: true, httpsPort: 3443 },
    });
    check('合法 HTTPS 配置返回 200', res.status === 200, `status=${res.status}`);
    check('httpsEnabled 已落盘', store.getOptions().httpsEnabled === true, String(store.getOptions().httpsEnabled));
    check('httpsPort 已落盘', store.getOptions().httpsPort === 3443, String(store.getOptions().httpsPort));
    check('改 HTTPS 配置触发软重载', softRestarts.length === 1, softRestarts.join('|'));

    // 仅改开关（不带端口）也要重载
    softRestarts.length = 0;
    res = await call(store, '/api/dshweb/config', { method: 'POST', body: { httpsEnabled: false } });
    check('关闭 HTTPS 触发软重载', softRestarts.length === 1, softRestarts.join('|'));
    check('httpsEnabled=false 已落盘', store.getOptions().httpsEnabled === false, String(store.getOptions().httpsEnabled));
  }

  // ── status 路由字段 ───────────────────────────────────────
  {
    const store = freshStore([dev('d1')]);
    store.updateOptions({ port: 3180, trustedHosts: ['ex.com'] });
    const res = await call(store, '/api/dshweb/status', { method: 'GET' });
    const b = res.body || {};
    check('status 返回 ok', b.ok === true);
    check('status 带 port', b.port === 3180, String(b.port));
    check('status 带 corePort', b.corePort === 3080, String(b.corePort));
    check('status 带 hasPassword 布尔', typeof b.hasPassword === 'boolean');
    check('status 回显 trustedHosts', Array.isArray(b.trustedHosts) && b.trustedHosts.includes('ex.com'), JSON.stringify(b.trustedHosts));
    check('status 带 lanUrl', typeof b.lanUrl === 'string');
    check('status 的 lanUrl 始终为 http（HTTP 接入地址）', /^http:\/\//.test(b.lanUrl || ''), b.lanUrl);
    check('status 带 httpsEnabled 布尔', typeof b.httpsEnabled === 'boolean');
    check('status 带 httpsPort（默认 3181）', b.httpsPort === 3181, String(b.httpsPort));
    check('status 带 httpsRunning 布尔', typeof b.httpsRunning === 'boolean');
    check('status 带 httpsLanUrl 字符串', typeof b.httpsLanUrl === 'string');
  }

  // ── reload 路由 ───────────────────────────────────────────
  {
    const store = freshStore();
    softRestarts.length = 0;
    const res = await call(store, '/api/dshweb/reload', { method: 'POST' });
    check('reload 返回 200', res.status === 200);
    check('reload 触发 softRestart', softRestarts.length === 1, softRestarts.join('|'));
  }
});
