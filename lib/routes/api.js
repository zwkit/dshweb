/**
 * dshweb 宿主路由（注册到 DSH WebServer，桌面 GUI 本机访问）
 * 与网关自持路由（外部设备经 3180 访问）是同一套处理逻辑的两面：
 * 复用 credentials.ts 的校验与 store 的会话管理。
 */
import os from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { isHttpsEnabledByDefault, DEFAULT_HTTPS_PORT } from '../store.js';
import { verifyPassword, hashPassword } from '../auth/credentials.js';
import { verifyPairCode, setPairCode, pairCodeStatus } from '../auth/pair-code.js';
function jsonResponse(res, status, obj) {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(obj));
}
/** 配对码失效原因 → 设置页可读文案（与网关登录页保持同一套解释） */
const PAIR_CODE_INVALID_MESSAGE = {
    none: '无有效配对码，请生成新码',
    expired: '配对码已过期（有效期 5 分钟），请重新生成',
    used: '配对码配对次数已用尽，请重新生成',
    locked: '配对码因输错次数过多已作废，请重新生成',
};
/** 首个私网 IPv4（192.168/10.开头优先，其次 172.16-31），找不到回退 '' */
export function lanIpv4() {
    const list = [];
    for (const nics of Object.values(os.networkInterfaces())) {
        for (const nic of nics || []) {
            if (nic.family !== 'IPv4' || nic.internal)
                continue;
            list.push(nic.address);
        }
    }
    return (list.find((a) => a.startsWith('192.168.')) ||
        list.find((a) => a.startsWith('10.')) ||
        list.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
        list[0] ||
        '');
}
async function readJsonBody(req) {
    let raw = '';
    for await (const c of req) {
        raw += c;
        if (raw.length > 64 * 1024)
            return {};
    }
    try {
        return JSON.parse(raw);
    }
    catch {
        return {};
    }
}
/** 读取请求 cookie 中 dshweb_session 对应的会话（桌面 GUI 直连核心、无此 cookie → null）。
 *  与网关 server.ts 的 SESSION_COOKIE 常量保持一致；此处不 import 网关模块以免拖入其副作用。
 *  用途：① 推导「当前设备 id」避免把自己踢下线；② 判定请求是否来自经网关接入的
 *        远程浏览器（凡带有效会话即远程浏览器），此类请求不允许删除设备。 */
function reqSession(req, store) {
    try {
        const cookie = req.headers.cookie || '';
        const m = cookie.match(/dshweb_session=([^;]+)/);
        if (!m)
            return null;
        return store.getSession(m[1]) || null;
    }
    catch {
        return null;
    }
}
/** 删除端点准入（m05019）：只有「桌面 GUI 直连核心」——即不带 dshweb_session
 *  会话 cookie 的请求——才有权限删除设备。任何经 dshweb 网关接入的远程浏览器
 *  （手机 mobile / 桌面浏览器 desktop，cookie 由网关 buildProxyHeaders 原样透传）
 *  一律拒绝，修复「远程桌面浏览器也能删设备」的 bug；与客户端
 *  isRemoteBrowser() 隐藏删除控件互为纵深防御。 */
function deletionDeniedForRemoteBrowser(req, store) {
    return reqSession(req, store) !== null;
}
/** 当前在线设备 id 集合：sessions.json 中每条有效会话都绑定一个 deviceId。
 *  persistSessions() 在每次会话变更（登录/markSeen/撤销）时全量原子写盘，故读盘
 *  即权威快照；宿主路由与网关共用同一 WebStore 实例（index.ts 单例），无需给
 *  store.js 加方法（它不参与 reload）。读取失败时返回空集合，不影响设备列表。 */
function onlineDeviceIds() {
    const ids = new Set();
    try {
        const raw = readFileSync(join(os.homedir(), '.dsh', 'dshweb', 'sessions.json'), 'utf8');
        const obj = JSON.parse(raw);
        for (const sess of Object.values(obj || {})) {
            const id = sess?.deviceId;
            if (typeof id === 'string' && id)
                ids.add(id);
        }
    }
    catch {
        // 文件不存在 / 解析失败 → 视为无在线设备
    }
    return ids;
}
export function createRoutes(store, deps) {
    const gateway = () => deps.getGateway();
    return [
        // 0. 网关状态（桌面 GUI 探活）
        {
            kind: 'exact',
            path: '/api/dshweb/status',
            handler: (_req, res) => {
                const g = gateway();
                const opts = store.getOptions();
                const gwPort = g?.getBoundPort?.() ?? opts.port ?? 3180;
                const ip = lanIpv4();
                // 缺省（未配置 / 旧实例）视为开启 HTTPS 共存，与 index.ts startGateway() 一致；
                // 只有 settings.json 显式 httpsEnabled:false 才关闭。
                const httpsEnabled = g?.isHttpsEnabled?.() ?? isHttpsEnabledByDefault(opts);
                const httpsRunning = Boolean(g?.isHttpsRunning?.());
                const httpsPort = g?.getHttpsBoundPort?.() || opts.httpsPort || DEFAULT_HTTPS_PORT;
                // HTTP 与 HTTPS 共存：HTTP 接入地址始终用 http，HTTPS 地址单独给 httpsLanUrl。
                jsonResponse(res, 200, {
                    ok: true,
                    running: Boolean(g && g.getStatus() === 'running'),
                    port: gwPort,
                    corePort: g?.getCorePort?.() ?? null,
                    version: '0.1.2',
                    tls: Boolean(g?.isTls?.()),
                    httpsEnabled,
                    httpsPort,
                    httpsRunning,
                    httpsLanUrl: ip && httpsRunning ? `https://${ip}:${httpsPort}` : '',
                    lanHint: `http://<局域网IP>:${gwPort}`,
                    lanIpv4: ip,
                    lanUrl: ip ? `http://${ip}:${gwPort}` : '',
                    hasPassword: Boolean(opts.passwordHash),
                    // 「接入 → 域名白名单」回显用
                    trustedHosts: Array.isArray(opts.trustedHosts) ? opts.trustedHosts : [],
                });
            },
        },
        // 1. 配置更新（端口 / 口令 / 显示设置）
        {
            kind: 'exact',
            path: '/api/dshweb/config',
            handler: async (req, res) => {
                const body = await readJsonBody(req);
                const patch = {};
                if (Number.isFinite(Number(body.port)) &&
                    Number(body.port) > 0 &&
                    Number(body.port) < 65536) {
                    patch.port = Number(body.port);
                }
                // HTTPS 与 HTTP 共存开关：任何非布尔值都忽略（不写盘、不重启）
                if (typeof body.httpsEnabled === 'boolean') {
                    patch.httpsEnabled = body.httpsEnabled;
                }
                // HTTPS 端口：独立于 HTTP 端口，范围校验同 port；非法值静默忽略
                if (Number.isFinite(Number(body.httpsPort)) &&
                    Number(body.httpsPort) > 0 &&
                    Number(body.httpsPort) < 65536) {
                    patch.httpsPort = Number(body.httpsPort);
                }
                if (typeof body.password === 'string' && body.password.length >= 6) {
                    const salt = hashPassword(String(Date.now()), 'salt-gen'); // 盐复用 hash 生成
                    patch.passwordSalt = salt.slice(0, 16);
                    patch.passwordHash = hashPassword(body.password, patch.passwordSalt);
                }
                if (typeof body.fontFamily === 'string')
                    patch.fontFamily = body.fontFamily;
                if (Number.isFinite(Number(body.fontScale)))
                    patch.fontScale = Number(body.fontScale);
                // 域名白名单：数组 → 每项剥出裸主机名
                // （允许带协议/端口/路径的完整来源）→ trim → 去空 → 去重；拒绝空白字符 /
                // 超长项，防止把垃圾写进 settings.json。0.0.0.0 / :: 等通配地址永不放行
                // （网关 isHostAllowed 侧还会再拦一次）。
                if (body.trustedHosts !== undefined) {
                    if (!Array.isArray(body.trustedHosts)) {
                        jsonResponse(res, 400, { ok: false, error: 'trustedHosts 必须是字符串数组' });
                        return;
                    }
                    const normalize = (raw) => {
                        if (typeof raw !== 'string')
                            return null;
                        let bare = raw.trim().toLowerCase();
                        if (!bare)
                            return null;
                        if (/\s/.test(bare))
                            return null;
                        if (bare.includes('://')) {
                            try {
                                bare = new URL(bare).hostname.toLowerCase();
                            }
                            catch {
                                return null;
                            }
                        }
                        else {
                            bare = bare
                                .split('/')[0]
                                .split(':')[0]
                                .replace(/^\[|\]$/g, '');
                        }
                        if (!bare || bare.length > 255)
                            return null;
                        if (bare === '0.0.0.0' || bare === '::')
                            return null;
                        return bare;
                    };
                    const hosts = body.trustedHosts
                        .map(normalize)
                        .filter((h) => Boolean(h));
                    if (hosts.length !==
                        body.trustedHosts.filter((h) => typeof h === 'string' && h.trim())
                            .length) {
                        jsonResponse(res, 400, {
                            ok: false,
                            error: 'trustedHosts 中包含无效项（含空白字符、无法解析的来源，或 0.0.0.0/:: 等通配地址）',
                        });
                        return;
                    }
                    patch.trustedHosts = Array.from(new Set(hosts));
                }
                const switchingHttps = Object.prototype.hasOwnProperty.call(patch, 'httpsEnabled') ||
                    Object.prototype.hasOwnProperty.call(patch, 'httpsPort');
                store.updateOptions(patch);
                // 端口 / HTTPS 开关 / HTTPS 端口 改动需要 soft-restart 网关以重新监听；
                // 口令/显示/白名单改动即时生效（白名单本身会触发一次 softRestart）。
                const needRestart = Boolean(patch.port) || switchingHttps;
                if (needRestart) {
                    const reason = patch.port
                        ? `port changed to ${patch.port}`
                        : `https ${patch.httpsEnabled === undefined ? '' : patch.httpsEnabled} / httpsPort ${patch.httpsPort ?? ''}`;
                    const r = await deps.softRestart(reason);
                    jsonResponse(res, 200, {
                        ok: r.ok,
                        port: r.port ?? patch.port ?? undefined,
                        restarted: true,
                        error: r.error,
                    });
                }
                else {
                    // 白名单保存后自动 softRestart 网关（同「重载网关」按钮路径），
                    // 让 isHostAllowed 立刻读到新列表（免手动操作）。
                    if (patch.trustedHosts) {
                        try {
                            await deps.softRestart('trustedHosts changed');
                        }
                        catch { }
                    }
                    jsonResponse(res, 200, {
                        ok: true,
                        restarted: Boolean(patch.trustedHosts),
                        trustedHosts: patch.trustedHosts,
                    });
                }
            },
        },
        // 2. 生成 / 查询 6 位配对码（5 分钟有效、期内可多次配对）
        {
            kind: 'exact',
            path: '/api/dshweb/pair-code',
            handler: async (req, res) => {
                if (req.method === 'POST') {
                    const s = setPairCode(store);
                    const st = pairCodeStatus(store);
                    jsonResponse(res, 200, {
                        ok: true,
                        code: s.code,
                        expiresAt: s.expiresAt,
                        valid: st.valid,
                        remainingMs: st.remainingMs,
                        uses: st.uses,
                        maxUses: st.maxUses,
                        reason: st.reason,
                    });
                }
                else {
                    const st = pairCodeStatus(store);
                    if (!st.valid) {
                        jsonResponse(res, 200, {
                            ok: false,
                            valid: false,
                            code: '',
                            expiresAt: st.expiresAt,
                            remainingMs: st.remainingMs,
                            uses: st.uses,
                            maxUses: st.maxUses,
                            reason: st.reason,
                            message: PAIR_CODE_INVALID_MESSAGE[st.reason] || '无有效配对码，请生成新码',
                        });
                    }
                    else {
                        jsonResponse(res, 200, {
                            ok: true,
                            valid: true,
                            code: st.code,
                            expiresAt: st.expiresAt,
                            remainingMs: st.remainingMs,
                            uses: st.uses,
                            maxUses: st.maxUses,
                            reason: st.reason,
                        });
                    }
                }
            },
        },
        // 3. 设备列表（m05019：附带 online 在线标记，供「远程设备」页展示所有已连接设备）
        {
            kind: 'exact',
            path: '/api/dshweb/devices',
            handler: (_req, res) => {
                const online = onlineDeviceIds();
                const devices = (store.getOptions().devices || []).map((d) => ({
                    ...d,
                    online: online.has(d.id),
                }));
                jsonResponse(res, 200, devices);
            },
        },
        // 4. 显示设置读取
        {
            kind: 'exact',
            path: '/api/dshweb/display',
            handler: async (req, res) => {
                if (req.method === 'POST') {
                    const body = await readJsonBody(req);
                    const patch = {};
                    if (typeof body.fontFamily === 'string')
                        patch.fontFamily = body.fontFamily;
                    if (Number.isFinite(Number(body.fontScale)))
                        patch.fontScale = Number(body.fontScale);
                    store.updateOptions(patch);
                    jsonResponse(res, 200, { ok: true });
                }
                else {
                    const opts = store.getOptions();
                    jsonResponse(res, 200, {
                        fontFamily: opts.fontFamily ?? '',
                        fontScale: opts.fontScale ?? 100,
                    });
                }
            },
        },
        // 5. 热重载网关（网关自实现 soft-restart）
        {
            kind: 'exact',
            path: '/api/dshweb/reload',
            handler: async (_req, res) => {
                const r = await deps.softRestart('manual reload from settings');
                jsonResponse(res, 200, r);
            },
        },
        // 6. 删除单个设备（仅桌面 GUI 直连核心可调用；远程浏览器一律 403）
        {
            kind: 'exact',
            path: '/api/dshweb/delete-device',
            handler: async (req, res) => {
                if (deletionDeniedForRemoteBrowser(req, store)) {
                    jsonResponse(res, 403, { ok: false, message: '仅桌面客户端可删除设备' });
                    return;
                }
                if (req.method !== 'POST') {
                    jsonResponse(res, 405, { ok: false, message: 'Method Not Allowed' });
                    return;
                }
                const body = await readJsonBody(req);
                const id = typeof body.id === 'string' ? body.id : '';
                if (!id) {
                    jsonResponse(res, 400, { ok: false, message: '缺少设备 id' });
                    return;
                }
                const sess = reqSession(req, store);
                const currentId = sess?.deviceId || null;
                if (currentId && id === currentId) {
                    jsonResponse(res, 400, { ok: false, message: '不能删除当前正在使用的设备' });
                    return;
                }
                const deleted = store.deleteDevice(id);
                jsonResponse(res, 200, {
                    ok: true,
                    deleted,
                });
            },
        },
        // 7. 一键删除所有远程设备（仅桌面 GUI 直连核心可调用；远程浏览器一律 403）
        {
            kind: 'exact',
            path: '/api/dshweb/delete-remote-devices',
            handler: async (req, res) => {
                if (deletionDeniedForRemoteBrowser(req, store)) {
                    jsonResponse(res, 403, { ok: false, message: '仅桌面客户端可删除设备' });
                    return;
                }
                if (req.method !== 'POST') {
                    jsonResponse(res, 405, { ok: false, message: 'Method Not Allowed' });
                    return;
                }
                const sess = reqSession(req, store);
                const currentId = sess?.deviceId || null;
                const removed = store.deleteRemoteDevices(currentId);
                jsonResponse(res, 200, {
                    ok: true,
                    removed,
                });
            },
        },
    ];
}
export function verifyCredentials(password, pairCodeInput, store) {
    const opts = store.getOptions();
    return password
        ? verifyPassword(password, opts)
        : pairCodeInput
            ? verifyPairCode(pairCodeInput, store)
            : false;
}
