/**
 * dshweb — DSH 远程网页端接入插件
 *
 * 职责：
 * 1. 在 0.0.0.0:3180 启动 HTTPS 安全接入网关
 * 2. 反代回环 DSH Web GUI（WS/SSE 透传、Host/Origin 成对改写、大响应流式直通）
 * 3. 会话标记：登录后注入 <html data-remote="mobile|desktop">，移动样式仅挂标记
 * 4. 内置热重载：/api/dshweb/reload 重 require 核心 + CSS 每请求读盘，免重启 DSH
 *
 * 配置持久化：~/.dsh/dshweb/settings.json
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { WebStore, isHttpsEnabledByDefault, DEFAULT_HTTPS_PORT } from './store.js';
import { GatewayServer } from './gateway/server.js';
import { createRoutes } from './routes/api.js';
import { registerWebRoutes } from './routes/register.js';
import { loadOrCreateTlsCredentials } from './gateway/cert.js';
import { connectionAuthState } from './connection-auth-state.js';
/**
 * 热重载用的可替换构造器。
 * ESM 模块一旦被 import 就常驻缓存，单纯重建 GatewayServer 实例不会读到改盘后的
 * lib/gateway/server.js。/api/dshweb/reload 会用带 query 的动态 import() 击穿缓存，
 * 把这里指向最新的类，从而「改 lib → 复制安装 → reload」即可生效、无需重启 DSH。
 */
let GatewayCtor = GatewayServer;
/** Cordis 插件名称标识 */
export const name = 'dshweb';
/** DSH 设置命名空间 */
export const WEB_SETTINGS_NAMESPACE = 'dshweb';
let pluginVersion = '';
try {
    const require = createRequire(import.meta.url);
    pluginVersion = String(require('../package.json').version || '');
}
catch { }
/**
 * Cordis 依赖注入声明
 * webServer：用于探测底座 Web GUI 实测绑定端口（桌面客户端为动态端口）
 * 注意：connection 不放静态 inject（cordis 静态注入要求服务必须已存在，存在加载失败风险），
 * 接管鉴权走下方 ctx.inject(['connection'], ...) 动态注入 + apply 立即尝试 + 定时兜底三点冗余。
 */
export const inject = ['webServer'];
/**
 * dshweb 版 gate 判定：只认「有效 dshweb_session 会话」这一个凭据。
 *
 * 设计要点（桌面零影响硬约束）：
 * - 手机经 3180 网关登录成功后，浏览器所有后续请求（HTML / REST / WS upgrade）
 *   都会携带 HttpOnly 的 dshweb_session Cookie；网关 buildProxyHeaders 复制全部
 *   req.headers 仅改 host/origin，Cookie 原样透传到核心。
 * - 桌面浏览器直连核心不带此 Cookie → 判定 false → 回落官方 launch-token
 *   鉴权（含官方 ?token= 换 Cookie 流程），行为零改动。
 * - 刻意不按「回环 socket」放行：桌面直连同样是回环，无法区分；重复/扩大放行
 *   只会削弱官方 401 拦截、破坏桌面隔离。
 * - 会话有效性由 WebStore.getSession() 校验（token 必须存在于 sessions.json）。
 */
/**
 * 读取请求头，兼容两种形态：
 * - node IncomingMessage：req.headers 是普通对象（旧版核心 / WS upgrade / REST 路径）
 * - WHATWG Request：req.headers 是 Headers 实例，只有 .get()（新版 DSH 的
 *   frontend-static 走 Fetch 管线，authorizeIndex 拿到的是这种 Request）
 * 旧实现直接读 req.headers?.cookie，在 Headers 实例上恒为 undefined，
 * 于是 DSH 升级到带 browser-token 鉴权后，首页 index 请求一律回落官方 401。
 */
function requestHeaderValue(req, name) {
    const headers = req?.headers;
    if (!headers)
        return '';
    if (typeof headers.get === 'function') {
        const value = headers.get(name);
        return typeof value === 'string' ? value : '';
    }
    const value = headers[name];
    return typeof value === 'string' ? value : '';
}
function isRequestAuthorizedByDshweb(req, store) {
    if (!req)
        return false;
    const cookie = requestHeaderValue(req, 'cookie');
    const m = cookie.match(/(?:^|;\s*)dshweb_session=([^;]+)/);
    if (!m)
        return false;
    try {
        return Boolean(store.getSession(decodeURIComponent(m[1])));
    }
    catch {
        return false;
    }
}
/**
 * 透明接管 DSH 底座 connection 鉴权（独立幂等标记 __dshweb_auth_takeover__）：
 * - connection.browserAuth.isAuthenticated：dshweb 会话通过 → true
 * - connection.requestRejection：dshweb 会话通过 → undefined（放行）
 * - connection.authorizeIndex：dshweb 会话通过 → true（根路径下发 index.html）
 * 未通过时一律回落原实现，官方 token/cookie 流程与桌面直连零改动。
 * 与任何其它接管该 connection 的插件并存：独立标记 + 链式包裹同一对象互不冲突；
 * 未接管成功时网关侧仍会铸造官方 Cookie 兜底，手机登录不受影响。
 */
function takeOverConnectionAuthForDshweb(connection, store, info) {
    if (!connection)
        return false;
    if (connection.__dshweb_auth_takeover__)
        return true;
    try {
        let wrapped = 0;
        if (connection.browserAuth && typeof connection.browserAuth.isAuthenticated === 'function') {
            const orig = connection.browserAuth.isAuthenticated.bind(connection.browserAuth);
            connection.browserAuth.isAuthenticated = (request, ...rest) => {
                if (isRequestAuthorizedByDshweb(request, store))
                    return true;
                return orig(request, ...rest);
            };
            wrapped += 1;
        }
        if (typeof connection.requestRejection === 'function') {
            const origRejection = connection.requestRejection.bind(connection);
            connection.requestRejection = (request) => {
                if (isRequestAuthorizedByDshweb(request, store))
                    return undefined;
                return origRejection(request);
            };
            wrapped += 1;
        }
        if (typeof connection.authorizeIndex === 'function') {
            const origIndex = connection.authorizeIndex.bind(connection);
            connection.authorizeIndex = (req, res) => {
                if (isRequestAuthorizedByDshweb(req, store))
                    return true;
                return origIndex(req, res);
            };
            wrapped += 1;
        }
        if (wrapped === 0)
            return false;
        connection.__dshweb_auth_takeover__ = true;
        connectionAuthState.attached = true;
        connectionAuthState.wrapped = wrapped;
        connectionAuthState.via = connectionAuthState.via || 'connection';
        connectionAuthState.at = Date.now();
        info(`已透明接管底座 connection 鉴权（${wrapped} 个方法；launch-token 401 对已登录 dshweb 会话短路）`);
        return true;
    }
    catch (err) {
        info('接管 connection 鉴权失败（不影响其它功能）：', err);
        return false;
    }
}
/**
 * 插件生命周期挂载入口
 */
export function apply(ctx, config = {}) {
    const log = (level, ...args) => {
        try {
            ctx.logger?.[level]?.(`[dshweb]`, ...args);
        }
        catch { }
    };
    const warn = (...args) => log('warn', ...args);
    const error = (...args) => log('error', ...args);
    const info = (...args) => log('info', ...args);
    // 1. 配置持久化（自有 settings.json，DSH 0.1.7+ 官方已弃用 settings.yaml）
    let bootConfig = {};
    try {
        const cfgPath = join(homedir(), '.dsh', 'dshweb', 'settings.json');
        bootConfig = JSON.parse(readFileSync(cfgPath, 'utf8'));
    }
    catch { }
    const store = new WebStore({ ...bootConfig, ...config });
    // 2. 探测上游 DSH Web GUI 实测端口（实测 > 配置 > 3080）
    const coreHint = Number(ctx.webServer?.port ?? 3080);
    const corePort = store.getOptions().corePort || (Number.isFinite(coreHint) && coreHint > 0 ? coreHint : 3080);
    let gateway = null;
    /**
     * 击穿 ESM 模块缓存：带 query 的动态 import() 会让 Node 把 lib/gateway/server.js
     * 当作全新 URL 重新求值，从而读到刚复制安装到 C 盘的最新代码。
     * 仅重导网关核心；store / credentials 等未改动的依赖会命中原有缓存、复用同一实例。
     */
    const reloadModules = async () => {
        const bust = `?dshweb_reload=${Date.now()}_${Math.random().toString(36).slice(2)}`;
        try {
            const mod = await import(`./gateway/server.js${bust}`);
            if (mod?.GatewayServer) {
                GatewayCtor = mod.GatewayServer;
                info('网关核心模块已热重载（ESM 缓存击穿）');
            }
        }
        catch (err) {
            warn('网关核心模块热重载失败，沿用已加载版本：', err);
        }
    };
    // soft-restart：重导最新代码 → 关停旧网关 → 用新类重建 → 重听 3180
    const softRestartGateway = async (reason) => {
        if (reason !== 'initial')
            await reloadModules();
        try {
            if (gateway) {
                await gateway.close().catch(() => { });
            }
        }
        catch { }
        try {
            gateway = startGateway(store, corePort ?? undefined, ctx);
            await gateway.start();
            info(`网关 soft-restart 完成 (${reason})，已重新监听 :${gateway.getBoundPort()}`);
            return { ok: true, port: gateway.getBoundPort() };
        }
        catch (err) {
            error('网关 soft-restart 失败：', err);
            return { ok: false, error: err?.message || String(err) };
        }
    };
    const startGateway = (storeRef, corePortArg, ctxRef) => new GatewayCtor({
        port: storeRef.getOptions().port ?? 3180,
        host: '0.0.0.0',
        corePort: corePortArg ?? 3080,
        coreHost: '127.0.0.1',
        // HTTPS 与 HTTP 共存：始终监听 HTTP port，默认（或显式开启）额外监听 httpsPort。
        // 证书仅在开启 HTTPS 时才需要生成/加载（纯 Node 自签，无 openssl 依赖）。
        // 缺省视为开启（用户要求接入即启用 HTTPS），仅显式 false 时关闭。
        tls: isHttpsEnabledByDefault(storeRef.getOptions()) ? buildTls(storeRef) : undefined,
        httpsEnabled: isHttpsEnabledByDefault(storeRef.getOptions()),
        httpsPort: storeRef.getOptions().httpsPort ?? DEFAULT_HTTPS_PORT,
    }, storeRef, ctxRef?.logger);
    const buildTls = (storeRef) => {
        try {
            const tlsDir = join(homedir(), '.dsh', 'dshweb');
            const credentials = loadOrCreateTlsCredentials({
                dir: tlsDir,
                certPath: storeRef.getOptions().tlsCertPath || undefined,
                keyPath: storeRef.getOptions().tlsKeyPath || undefined,
                logger: ctx.logger,
            });
            return { cert: credentials.cert, key: credentials.key };
        }
        catch (err) {
            error('初始化 TLS 证书失败，回退 HTTP 模式：', err);
            return undefined;
        }
    };
    // 3. 注册插件专属路由到宿主 WebServer（桌面 GUI 用：配置 / 配对码 / reload）
    try {
        const routes = createRoutes(store, {
            softRestart: softRestartGateway,
            getGateway: () => gateway,
        });
        if (typeof ctx.webServer?.register === 'function') {
            registerWebRoutes(ctx, routes);
        }
    }
    catch (err) {
        warn('注册 dshweb 路由失败：', err);
    }
    // 4. 启动网关 + 就绪横幅（不返回值，避免 cordis apply 签名不兼容）
    // 4a. 透明接管底座 connection 鉴权（三点冗余：apply 立即 / ctx.inject 动态 / 兜底定时）
    const attachConnectionAuth = (conn) => {
        try {
            return takeOverConnectionAuthForDshweb(conn, store, info);
        }
        catch (err) {
            warn('接管 connection 鉴权异常：', err);
            return false;
        }
    };
    let connectionAuthAttached = false;
    try {
        const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
        if (conn)
            connectionAuthAttached = attachConnectionAuth(conn);
    }
    catch { }
    if (!connectionAuthAttached && typeof ctx.inject === 'function') {
        try {
            ctx.inject(['connection'], (connCtx) => {
                try {
                    const conn = typeof connCtx?.get === 'function' ? connCtx.get('connection') : connCtx?.connection;
                    if (conn)
                        connectionAuthAttached = attachConnectionAuth(conn);
                }
                catch (err) {
                    warn('connection 注入接管失败：', err);
                }
            });
        }
        catch (err) {
            warn('注册 connection 动态注入失败：', err);
        }
    }
    // 兜底：若 10s 后仍未挂接，每 5s 重试一次（最多 12 次 / 1 分钟），杜绝时序竞争导致的 401
    if (!connectionAuthAttached) {
        let retries = 0;
        const timer = setInterval(() => {
            retries += 1;
            try {
                const conn = typeof ctx.get === 'function' ? ctx.get('connection') : undefined;
                if (conn && attachConnectionAuth(conn)) {
                    connectionAuthAttached = true;
                    clearInterval(timer);
                }
            }
            catch { }
            if (retries >= 12 && !connectionAuthAttached) {
                clearInterval(timer);
                warn('connection 鉴权接管未能在 1 分钟内挂接（手机可能遇到官方 401）');
            }
        }, 5000);
        if (typeof ctx.effect === 'function') {
            ctx.effect(() => clearInterval(timer), 'dshweb:connection-auth-retry');
        }
    }
    const ready = (async () => {
        try {
            gateway = startGateway(store, corePort, ctx);
            const { port } = await gateway.start();
            const httpHint = `http://<本机局域网IP>:${port}`;
            const httpsHint = gateway.isHttpsRunning()
                ? `https://<本机局域网IP>:${gateway.getHttpsBoundPort()}`
                : 'HTTPS 未开启（可在「接入」页开启）';
            const divider = '─'.repeat(72);
            console.log(`\n┌${divider}`);
            console.log(`│ [dshweb] v${pluginVersion || '0.1.0'} 远程网页端网关已激活`);
            console.log(`│ 上游 DSH Web GUI: 127.0.0.1:${corePort} (回环，零改动)`);
            console.log(`│ HTTP  接入: ${httpHint} (局域网/虚拟私网 IP)`);
            console.log(`│ HTTPS 接入: ${httpsHint}`);
            console.log(`│ 会话标记: 登录后注入 data-remote，移动样式与桌面隔离`);
            console.log(`│ 热重载: 改动后 POST /api/dshweb/reload 即生效，无需重启 DSH`);
            console.log(`│ 设置入口: Web「设置」->「远程网页端」（接入 / 远程设备）`);
            console.log(`└${divider}\n`);
            return port;
        }
        catch (err) {
            error('网关启动失败:', err);
            console.log(`│ ⚠️ [dshweb] 网关启动失败: ${err?.message || String(err)}`);
            console.log(`│   请检查 ${store.getOptions().port ?? 3180} 端口占用，桌面端不受影响`);
            throw err;
        }
    })();
    // 宿主关停时优雅回收（保证插件重载不残留 3180 监听）
    const cleanupGateway = () => {
        if (gateway) {
            try {
                // eslint-disable-next-line no-void
                gateway.close().catch(() => { });
            }
            catch { }
        }
    };
    if (typeof ctx.effect === 'function') {
        ctx.effect(() => cleanupGateway, 'dshweb:gateway-lifecycle');
    }
    try {
        ctx.on?.('dispose', cleanupGateway);
    }
    catch { }
    ready.catch(() => { });
    return undefined;
}
export * from './store.js';
export * from './gateway/server.js';
export * from './routes/api.js';
