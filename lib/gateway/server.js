/**
 * dshweb GatewayServer — HTTPS 回环反代
 *
 * dshweb 独立接入网关，聚焦本插件诉求：
 * 1. Host 白名单宽松策略（局域网 IP 全放行，域名仅 Reject DNS-Rebinding）
 * 2. 会话标记 cookie 校验 + 注入 <html data-remote>（HTML 响应拦截）
 * 3. WS/SSE 全双工透传、30x Location 改写
 */
import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { createHash, createHmac } from "node:crypto";
import { promises as fsp } from "node:fs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import path from "node:path";
import os, { homedir } from "node:os";
import { fileURLToPath } from "node:url";
// 命名空间导入而非具名导入：/api/dshweb/reload 只击穿本模块的 ESM 缓存，
// 被依赖的模块仍是已加载的旧实例。命名空间导入不会因「缺少导出」在链接期抛错，
// 运行期再按导出是否存在做回退，热重载因此永远不会把网关打成不可用。
import * as credentials from "../auth/credentials.js";
import * as pairCode from "../auth/pair-code.js";
/** 工作区根目录推导缓存（60s TTL，避免每次 list 都读 workspace.json） */
const workspaceRootCache = { value: "", at: 0 };
/**
 * 官方 BrowserAuth 签名 Cookie 铸造（内联本模块，随 /api/dshweb/reload 热生效）。
 *
 * 背景：DSH 桌面客户端自带「进程 launch-token + 签名 Cookie」鉴权，浏览器直连
 * 核心时会因没有官方 Cookie 拿到 401「dsh web authentication required」。dshweb
 * 作为独立插件必须自己解决，不能依赖任何第三方插件的接管。
 *
 * 解法：签名密钥持久化在 ~/.dsh/.credentials.yaml 的
 * `client-connection/browser-session` grant 记录中，核心与网关同进程、可读取。
 * 网关在「已登录 dshweb 会话」的请求转发给核心时，用它铸造一个合法官方 Cookie
 * 注入到这一跳（不下发到浏览器，浏览器永远只持有 dshweb_session）。核心的
 * isAuthenticated() 验签通过 → HTML / REST / WS 全链路放行。
 *
 * 与 connection 接管方案的关系：二者并存、互不冲突；本方案只在网关侧生效，
 * 不改动底座任何服务实例，也不需要重启 DSH 来加载新 index.js。
 * 若未来官方改动密钥格式/文件位置，本函数读取失败即返回 null，回退到
 * index.ts 的 connection 接管（需一次重启）。
 */
const OFFICIAL_COOKIE_PREFIX = "dsh-auth-";
const OFFICIAL_COOKIE_PAYLOAD_VERSION = 1;
/** 与官方 cookieName(authority) 一致：sha256(authority) 的 base64url 无 padding */
function officialCookieName(authority) {
    return OFFICIAL_COOKIE_PREFIX + base64urlNoPad(createHash("sha256").update(authority).digest());
}
function base64urlNoPad(buf) {
    return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/u, "");
}
/** 读取官方 persistent signing secret；格式非法返回 null */
function readOfficialSigningSecret() {
    try {
        const home = homedir();
        const file = join(home, ".dsh", ".credentials.yaml");
        const yaml = readFileSync(file, "utf8");
        const m = yaml.match(/client-connection\/browser-session:[\s\S]*?secret:\s*([A-Za-z0-9_-]+)/);
        if (!m)
            return null;
        const secret = Buffer.from(m[1], "base64url");
        return secret.length === 32 ? secret : null;
    }
    catch {
        return null;
    }
}
/** 铸造结果缓存（60s TTL）：密钥与 authority 在进程生命周期内稳定，避免每个静态资源都同步读盘 */
const officialCookieCache = {
    authority: "",
    value: null,
    at: 0,
};
/** 为「核心侧权威源」铸造官方 v1 签名 Cookie 值（30 天有效，对齐官方默认值） */
function mintOfficialCookie(authority) {
    const now = Date.now();
    if (officialCookieCache.authority === authority &&
        officialCookieCache.value !== null &&
        now - officialCookieCache.at < 60_000) {
        return officialCookieCache.value;
    }
    const secret = readOfficialSigningSecret();
    if (!secret)
        return null;
    try {
        const payload = {
            version: OFFICIAL_COOKIE_PAYLOAD_VERSION,
            authority,
            issuedAt: now,
            expiresAt: now + 30 * 86400 * 1000,
        };
        const body = base64urlNoPad(Buffer.from(JSON.stringify(payload), "utf8"));
        const sig = base64urlNoPad(createHmac("sha256", secret).update(body).digest());
        const value = `v${OFFICIAL_COOKIE_PAYLOAD_VERSION}.${body}.${sig}`;
        officialCookieCache.authority = authority;
        officialCookieCache.value = value;
        officialCookieCache.at = now;
        return value;
    }
    catch {
        return null;
    }
}
/**
 * 从 User-Agent 生成可读设备名（轻量内联版，UA 语义取自常见平台标识）。
 * 内联在此模块而非 store.ts：/api/dshweb/reload 只击穿 server.js 的 ESM 缓存，
 * store.js 仍是旧实例，新增方法拿不到；内联函数随 server.js 热重载即时生效。
 */
function describeDevice(ua) {
    const s = String(ua || "");
    let os = "";
    if (/iPhone/i.test(s))
        os = "iPhone";
    else if (/iPad/i.test(s))
        os = "iPad";
    else if (/Android/i.test(s))
        os = "Android";
    else if (/Windows/i.test(s))
        os = "Windows";
    else if (/Mac OS X|Macintosh/i.test(s))
        os = "Mac";
    else if (/Linux/i.test(s))
        os = "Linux";
    let browser = "";
    if (/MicroMessenger/i.test(s))
        browser = "WeChat";
    else if (/Edg\//i.test(s))
        browser = "Edge";
    else if (/Chrome\/|CriOS/i.test(s))
        browser = "Chrome";
    else if (/Firefox\/|FxiOS/i.test(s))
        browser = "Firefox";
    else if (/Safari\/|Version\//i.test(s))
        browser = "Safari";
    const parts = [os, browser].filter(Boolean);
    return parts.length ? parts.join(" · ") : s.slice(0, 40) || "未知设备";
}
export const SESSION_COOKIE = "dshweb_session";
/** 首个私网 IPv4（与宿主路由 api.ts 的 lanIpv4 同逻辑，内联保证 reload 即生效） */
function firstLanIpv4() {
    try {
        const list = [];
        for (const nics of Object.values(os.networkInterfaces())) {
            for (const nic of nics || []) {
                if (nic.family !== "IPv4" || nic.internal)
                    continue;
                list.push(nic.address);
            }
        }
        return (list.find((a) => a.startsWith("192.168.")) ||
            list.find((a) => a.startsWith("10.")) ||
            list.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
            list[0] ||
            "");
    }
    catch {
        return "";
    }
}
export class GatewayServer {
    /** HTTP 主监听（始终存在）与 HTTPS 副监听（httpsEnabled 时存在） */
    server = null;
    httpsServer = null;
    activeSockets = new Set();
    store;
    configuredPort;
    boundPort;
    host;
    corePort;
    coreHost;
    coreTargetAuthority;
    /** TLS 证书材料（{cert,key}）；仅在开启 HTTPS 时需要 */
    tls;
    /** 是否同时监听 HTTPS 端口（与 HTTP 共存） */
    httpsEnabled;
    /** HTTPS 监听端口，默认 3181 */
    configuredHttpsPort;
    httpsBoundPort = 0;
    status = "stopped";
    lastError = null;
    logger;
    /** 已完成设备注册的会话，避免每个请求都写 settings.json（历史会话补注册用） */
    registeredSessions = new Set();
    constructor(options, store, logger) {
        this.configuredPort = options.port ?? 3180;
        this.boundPort = this.configuredPort;
        this.host = options.host ?? "0.0.0.0";
        this.corePort = options.corePort ?? 3080;
        this.coreHost = options.coreHost ?? "127.0.0.1";
        this.coreTargetAuthority =
            this.coreHost.includes(":") && !this.coreHost.startsWith("[")
                ? `[${this.coreHost}]:${this.corePort}`
                : `${this.coreHost}:${this.corePort}`;
        this.tls = options.tls;
        // 兼容历史调用：若传了 tls 但未显式声明 httpsEnabled，仍视为开启（单 HTTPS 模式）。
        this.httpsEnabled = options.httpsEnabled ?? Boolean(options.tls);
        this.configuredHttpsPort = options.httpsPort ?? 3181;
        this.store = store;
        this.logger = logger;
    }
    getStatus() {
        return this.status;
    }
    getLastError() {
        return this.lastError;
    }
    getBoundPort() {
        return this.boundPort;
    }
    getHost() {
        return this.host;
    }
    getCorePort() {
        return this.corePort;
    }
    getServer() {
        return this.server;
    }
    /**
     * 状态字段 `tls` 的历史语义：网关是否提供可用的 HTTPS。
     * 双监听（HTTP 主 + HTTPS 副）下以「HTTPS 监听已就绪」为准。
     */
    isTls() {
        return this.isHttpsRunning();
    }
    /** 是否开启了 HTTPS 共存监听 */
    isHttpsEnabled() {
        return Boolean(this.httpsEnabled);
    }
    /** HTTPS 监听是否实际就绪 */
    isHttpsRunning() {
        return Boolean(this.httpsServer && this.status === "running");
    }
    /** HTTPS 实际监听端口（未开启/未就绪时为 0） */
    getHttpsBoundPort() {
        return this.httpsBoundPort;
    }
    /** 判断某次请求是否来自 HTTPS 监听（用于 30x Location / 登录页协议显示） */
    requestIsTls(req) {
        try {
            return Boolean(req?.socket?.encrypted);
        }
        catch {
            return false;
        }
    }
    /**
     * 构造转发给内部核心的请求头：Host / Origin / Referer 必须「成对虚拟化」。
     *
     * DSH 核心对 WebSocket 升级做 CSWSH 校验（Origin 的 host 必须等于 Host），
     * 对写请求做 CSRF 校验（跨站写直接 403 "已拦截来自其他网站的跨站写请求"）。
     * 网关把 Host 改写成回环核心权威源（127.0.0.1:<corePort>）后，必须同步把
     * Origin / Referer 也改成同源，否则浏览器经网关访问时：
     *   - WS /api/remote.mux 升级返回 403 → 前端永远「重新连接中」
     *   - POST 写请求返回 403 → 设置项/插件/会话数据刷不出
     * 决策矩阵：核心围栏要求 Origin host == Host，故 host 与 origin/referer/
     * sec-fetch-site 必须成对虚拟化，第三方跨站 Origin 原样保留让核心继续拦截。
     */
    buildProxyHeaders(req, originalHost) {
        const headers = { ...req.headers };
        // ── 剥掉反向代理链路的「来源」头（域名/CDN 场景必踩）──────────────
        // DSH 核心的 BrowserAuth 一旦看到 x-forwarded-for / x-forwarded-host /
        // x-forwarded-proto / x-real-ip 等代理头，就认为请求不是本机直连，转而要求
        // 设备级授权并回 401「设备未授权或会话已注销，请前往 /auth 重新配对」。
        // 实测：仅加任一此类头 → /api/dshweb/config 立刻 401；去掉即 200。
        // 经 Cloudflare / nginx 等反代访问域名时这些头是自动加的，于是「能登录、
        // 但登录后跳不回主页面」——登录 POST 是公开路由，故不受影响。
        // 网关已在自身这一跳完成鉴权（dshweb_session），核心侧只需回环直连语义，
        // 因此这里一律删除，避免核心把网关误判成不可信代理。
        for (const h of [
            "x-forwarded-for",
            "x-forwarded-host",
            "x-forwarded-proto",
            "x-forwarded-port",
            "x-real-ip",
            "forwarded",
        ]) {
            delete headers[h];
        }
        // 核心侧看到的 Host 一律为回环权威源（核心按 loopback 处理）
        headers["host"] = this.coreTargetAuthority;
        // 保留外部真实 Host 供溯源（核心不会据此做围栏判定）
        headers["x-ddsh-original-host"] = originalHost;
        // Origin 虚拟化：与改写后的 Host 同源、协议与核心（http 反代）一致
        const origin = req.headers.origin;
        if (typeof origin === "string" && origin && origin !== "null") {
            try {
                const originUrl = new URL(origin);
                // 仅当 Origin 与网关 Host 同源（浏览器正常发起的请求）才洗白；
                // 真正的跨站第三方 Origin 原样保留，让核心继续拦截。
                const originHost = originUrl.host;
                const sameHost = originHost === originalHost ||
                    originHost.replace(/:\d+$/, "") === originalHost.replace(/:\d+$/, "") ||
                    // CDN / 隧道把 Host 改写成回环时，白名单域名仍是同源：照样虚拟化，
                    // 否则核心 isTrustedApiRequest 的 Origin/Host 围栏会 403 掉答案提交。
                    this.originHostIsTrusted(originHost);
                if (sameHost) {
                    headers["origin"] = `http://${this.coreTargetAuthority}`;
                    // Referer 同步改写，避免部分生态插件按 Referer 做二次校验
                    const referer = req.headers.referer;
                    if (typeof referer === "string" && referer) {
                        try {
                            const refUrl = new URL(referer);
                            if (refUrl.host === originalHost ||
                                refUrl.host.replace(/:\d+$/, "") === originalHost.replace(/:\d+$/, "") ||
                                this.originHostIsTrusted(refUrl.host)) {
                                refUrl.protocol = "http:";
                                refUrl.host = this.coreTargetAuthority;
                                headers["referer"] = refUrl.toString();
                            }
                        }
                        catch { }
                    }
                    // 明确同源语义，防止核心按 cross-site 拒绝
                    headers["sec-fetch-site"] = "same-origin";
                }
            }
            catch { }
        }
        // 官方 launch-token 鉴权短路：核心只对「持有官方签名 Cookie」的请求放行。
        // 网关已确认本请求 dshweb_session 有效（调用方均在会话校验之后），在此为
        // 网关→核心这一跳注入铸造的官方 Cookie；浏览器侧完全看不到它，仍只持有
        // dshweb_session。仅在核心侧权威源与官方密钥均可读时生效。
        if (this.getSession(req)) {
            const official = mintOfficialCookie(this.coreTargetAuthority);
            if (official) {
                const name = officialCookieName(this.coreTargetAuthority);
                const existing = typeof headers["cookie"] === "string" ? headers["cookie"] : "";
                // 浏览器不会带官方 Cookie；即便带了也去重覆盖，避免同名冲突
                const kept = existing
                    .split(";")
                    .map((p) => p.trim())
                    .filter((p) => p && !p.startsWith(name + "="));
                kept.push(`${name}=${official}`);
                headers["cookie"] = kept.join("; ");
            }
        }
        return headers;
    }
    /**
     * Host 校验决策：
     * - 本机访问（loopback 变体）：放行
     * - 局域网/虚拟私网/公网 IP 直连：放行（isIP 校验即可）
     * - 域名：仅接受 settings.json trustedHosts 白名单里的（默认全拒绝，防 DNS-Rebinding）。
     *   白名单只比裸主机名（不带端口、忽略大小写），因为反代/TLS
     *   终结/端口转发下外部端口 ≠ boundPort，端口不作为信任边界。
     */
    isHostAllowed(hostHeader) {
        if (!hostHeader)
            return false;
        const hostname = hostHeader.split(":")[0]?.replace(/^\[|\]$/g, "") || "";
        if (!hostname)
            return false;
        if (hostname === "localhost" || hostname.endsWith(".localhost"))
            return true;
        if (isIP(hostname))
            return true;
        // 受信任域名白名单（settings.json 的 trustedHosts）：裸主机名、忽略大小写比对；
        // 通配地址（0.0.0.0 / ::）即使被误配进白名单也绝不放行。
        try {
            const trusted = this.store.getOptions().trustedHosts;
            if (Array.isArray(trusted)) {
                for (const raw of trusted) {
                    if (typeof raw !== "string")
                        continue;
                    // 允许用户填带协议/端口/路径的完整来源，统一剥出裸主机名再比对
                    let bare = raw.trim().toLowerCase();
                    if (!bare)
                        continue;
                    if (bare.includes("://")) {
                        try {
                            bare = new URL(bare).hostname.toLowerCase();
                        }
                        catch {
                            continue;
                        }
                    }
                    else {
                        bare = bare
                            .split("/")[0]
                            .split(":")[0]
                            .replace(/^\[|\]$/g, "");
                    }
                    if (!bare || bare === "0.0.0.0" || bare === "::")
                        continue;
                    if (bare === hostname.toLowerCase())
                        return true;
                }
            }
        }
        catch { }
        // 其余域名一律拒绝（防 DNS-Rebinding）
        return false;
    }
    /**
     * 判断写请求 Origin 的主机名是否在用户「接入 → 域名白名单」里显式配置。
     * CDN / 隧道把 Host 改写成回环绑定地址时，浏览器 Origin 仍是公网域名：字符串
     * 与 Host 不相等，但本质是同一已登录页面的同源写。统一写校验与
     * buildProxyHeaders 据此按同源处理，避免误 403 掉会话内选择弹窗的答案提交
     * （POST /api/$events/result），也就不会「提交无效、几秒后弹窗重现」。
     * Origin 由浏览器设置、脚本不可伪造；这里只比裸主机名，第三方来源不命中。
     */
    originHostIsTrusted(originHost) {
        if (typeof originHost !== "string" || !originHost)
            return false;
        let bare = "";
        try {
            bare = new URL("http://" + originHost).hostname.toLowerCase();
        }
        catch {
            return false;
        }
        if (!bare || bare === "0.0.0.0" || bare === "::")
            return false;
        try {
            const trusted = this.store.getOptions().trustedHosts;
            if (!Array.isArray(trusted))
                return false;
            for (const raw of trusted) {
                if (typeof raw !== "string" || !raw.trim())
                    continue;
                let t = "";
                try {
                    const s = raw.trim();
                    t = new URL(s.includes("://") ? s : "http://" + s).hostname.toLowerCase();
                }
                catch {
                    continue;
                }
                if (t && t !== "0.0.0.0" && t !== "::" && t === bare)
                    return true;
            }
        }
        catch { }
        return false;
    }
    /** 启动网关 */
    async start() {
        if (this.server && this.status === "running") {
            return { port: this.boundPort, host: this.host };
        }
        this.status = "starting";
        this.lastError = null;
        const handler = (req, res) => this.handleHttpRequest(req, res);
        const upgradeHandler = (req, socket, head) => this.handleUpgrade(req, socket, head);
        const trackConnection = (socket) => {
            this.activeSockets.add(socket);
            socket.on("close", () => this.activeSockets.delete(socket));
        };
        // HTTP 主监听：始终存在，端口 = configuredPort（默认 3180）。
        const httpServer = http.createServer(handler);
        httpServer.on("upgrade", upgradeHandler);
        httpServer.on("connection", trackConnection);
        // HTTPS 副监听：httpsEnabled 且有证书材料时额外监听 configuredHttpsPort
        // （默认 3181）。两者共用同一套 handleHttpRequest / handleUpgrade，
        // 因此会话、注入、反代行为完全一致，仅传输层不同。
        let httpsServer = null;
        if (this.httpsEnabled && this.tls) {
            httpsServer = https.createServer({ cert: this.tls.cert, key: this.tls.key }, handler);
            httpsServer.on("upgrade", upgradeHandler);
            httpsServer.on("connection", trackConnection);
        }
        else if (this.httpsEnabled && !this.tls) {
            this.logger?.warn?.("[dshweb] HTTPS 已开启但证书不可用，仅启动 HTTP 监听（请检查证书路径 / 自签权限）");
        }
        this.server = httpServer;
        this.httpsServer = httpsServer;
        try {
            // 先监听 HTTP（主），再监听 HTTPS（副）。任一失败都要清理已监听的 socket。
            await new Promise((resolve, reject) => {
                httpServer.once("error", (err) => reject(err));
                httpServer.listen(this.configuredPort, this.host, () => resolve());
            });
            const addr = httpServer.address();
            this.boundPort = addr && typeof addr === "object" ? addr.port : this.configuredPort;
            if (httpsServer) {
                // HTTPS 端口绑定失败（例如端口被占用）不能连累 HTTP 主监听：
                // 「与 HTTP 共存」的可用性优先，降级为仅 HTTP + 日志告警，status 仍为 running，
                // 由 status.httpsRunning=false / 空 httpsLanUrl 把失败反馈到设置页。
                try {
                    await new Promise((resolve, reject) => {
                        httpsServer.once("error", (err) => reject(err));
                        httpsServer.listen(this.configuredHttpsPort, this.host, () => resolve());
                    });
                    const hAddr = httpsServer.address();
                    this.httpsBoundPort =
                        hAddr && typeof hAddr === "object" ? hAddr.port : this.configuredHttpsPort;
                }
                catch (err) {
                    this.logger?.warn?.(`[dshweb] HTTPS 监听 :${this.configuredHttpsPort} 失败，仅保留 HTTP 接入：${err?.message || String(err)}`);
                    try {
                        httpsServer.close();
                    }
                    catch { }
                    this.httpsServer = null;
                    httpsServer = null;
                    this.httpsBoundPort = 0;
                }
            }
            else {
                this.httpsBoundPort = 0;
            }
            this.status = "running";
            this.logger?.info?.(`[dshweb] 网关已就绪 http://${this.host}:${this.boundPort}` +
                (httpsServer ? ` + https://${this.host}:${this.httpsBoundPort}` : "") +
                ` -> ${this.coreTargetAuthority}`);
            return { port: this.boundPort, host: this.host };
        }
        catch (err) {
            this.status = "error";
            this.lastError = err?.message || String(err);
            // 清理：关掉可能已监听的两个 server，避免端口泄漏。
            for (const s of [httpServer, httpsServer]) {
                if (!s)
                    continue;
                try {
                    s.close();
                }
                catch { }
            }
            this.server = null;
            this.httpsServer = null;
            this.httpsBoundPort = 0;
            throw err;
        }
    }
    /** 优雅关闭（同时关闭 HTTP / HTTPS 两个监听） */
    async close() {
        const servers = [this.server, this.httpsServer].filter(Boolean);
        this.server = null;
        this.httpsServer = null;
        this.httpsBoundPort = 0;
        this.status = "stopped";
        if (servers.length === 0)
            return;
        for (const socket of this.activeSockets) {
            try {
                socket.destroy();
            }
            catch { }
        }
        this.activeSockets.clear();
        await Promise.all(servers.map((s) => new Promise((resolve) => {
            let done = false;
            const finish = () => {
                if (!done) {
                    done = true;
                    resolve();
                }
            };
            const timer = setTimeout(finish, 2000);
            try {
                s.closeIdleConnections?.();
                s.closeAllConnections?.();
            }
            catch { }
            try {
                s.close(() => {
                    clearTimeout(timer);
                    finish();
                });
            }
            catch {
                clearTimeout(timer);
                finish();
            }
        })));
    }
    /**
     * HTTP 请求主处理：
     * 1. Host 白名单
     * 2. 会话标记校验（HTML 路径要求已登录）
     * 3. HTML 响应注入 <html data-remote>
     * 4. 反代
     */
    handleHttpRequest(req, res) {
        const originalHost = req.headers.host || "";
        if (!this.isHostAllowed(originalHost)) {
            res.writeHead(400, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({
                error: "Bad Request",
                message: `不受信任的 Host: "${originalHost}"。若通过反向代理 / 自定义域名远程接入，请先在 dshweb 设置「接入 → 域名白名单」中添加该域名。`,
            }));
            return;
        }
        const url = req.url || "/";
        const isInternalApi = url.startsWith("/api/dshweb/");
        const isHtmlRequest = !isInternalApi && this.looksLikeHtmlRequest(req);
        // 网关自持的公开路由：status（探活，无敏感信息）/ login（登录页与提交）
        // 命中即 return；其余所有请求（含宿主路由）都必须经过下方会话校验。
        if (isInternalApi) {
            if (this.serveInternalApi(url, req, res))
                return;
            // 未命中的是宿主注册的配置类路由（config / pair-code / devices /
            // display / reload），它们本身信任本机、不带认证，绝不能匿名透传。
        }
        // PWA 静态资源（manifest / 图标 / favicon）免登录直通。
        // 浏览器「安装此站点为应用」和 iOS「添加到主屏幕」会在未登录态去拉这些
        // 文件；被 302 到登录页时安装器拿不到 manifest 与图标，只能退化成通用
        // 地球/字母图标。放行这几个只读静态路径不会泄露任何会话数据。
        if (!isInternalApi && isPwaAsset(url)) {
            const lowerPath = (url.split("?")[0] || "").toLowerCase();
            // manifest 也由网关自持：改写图标 URL 为带内容版本号的形式，强制已装过
            // 旧「地球」图标的主屏/桌面快捷方式在重装时取到当前鲸鱼图标。
            if (lowerPath === "/manifest.webmanifest" || lowerPath === "/manifest.json") {
                const manifest = readPwaManifest();
                if (manifest) {
                    const body = versionManifestIcons(manifest);
                    res.writeHead(200, {
                        "Content-Type": "application/manifest+json; charset=utf-8",
                        "Content-Length": String(Buffer.byteLength(body, "utf8")),
                        // manifest 本身允许缓存，但图标 URL 已带版本号，改图标即换键
                        "Cache-Control": "public, max-age=300",
                    });
                    res.end(body);
                    return;
                }
            }
            // 图标优先用本插件自带的（DSH 官方鲸鱼本体，无边框、无底瓦片），
            // 核心自带的方形图会让 PWA 桌面图标看起来和应用图标不是一套。
            const icon = readPwaIcon(lowerPath);
            if (icon) {
                const iconType = lowerPath.endsWith(".svg")
                    ? "image/svg+xml"
                    : lowerPath.endsWith(".ico")
                        ? "image/x-icon"
                        : "image/png";
                res.writeHead(200, {
                    "Content-Type": iconType,
                    "Content-Length": String(icon.length),
                    // 图标 URL 带 ?v=<内容hash>，内容变了 URL 就变，可长缓存
                    "Cache-Control": "public, max-age=31536000, immutable",
                });
                res.end(icon);
                return;
            }
            this.proxyPassThrough(req, res, this.buildProxyHeaders(req, originalHost));
            return;
        }
        // 所有非公开路径要求会话 cookie 已存在。
        // 注意：不能因为 isInternalApi 就跳过 —— 否则匿名用户可绕过登录直接
        // 经 3180 改端口/改口令/生成配对码/读设备列表，认证形同虚设。
        if (!this.getSession(req)) {
            if (isInternalApi) {
                // fetch/XHR 不跟随 302 到登录页 HTML，直接给 401 JSON 便于前端处理
                res.writeHead(401, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "Unauthorized", message: "请先登录" }));
            }
            else {
                res.writeHead(302, { Location: "/api/dshweb/login" });
                res.end();
            }
            return;
        }
        // 历史会话幂等补注册：本修复前已登录但 devices 为空的手机，下一次请求
        // 把当前设备补进「远程设备」列表（每个会话仅一次，不写重复）。
        this.ensureDeviceRegistered(req);
        // 统一写请求同源校验（安全）：网关为已登录会话在「网关→核心」这一跳注入
        // 官方签名 Cookie 后，核心对插件宿主路由（config / pair-code / display /
        // reload，它们信任本机、自身不校验 Origin）不再是可靠的 CSRF 防线。
        // 因此网关自己对一切已登录写请求做同源判定，杜绝第三方站点借已登录会话
        // 跨站写敏感路由。桌面 GUI 设置页走核心直连、不经网关，完全不受影响；
        // 手机/桌面经网关的正常写请求 Origin 恒等于网关 Host，正常放行。
        // 域名 / CDN 场景下隧道可能把 Host 改写成回环地址，而浏览器 Origin 仍是
        // 用户白名单里的公网域名：按「受信任同源」放行（见 originHostIsTrusted），
        // 否则会话内选择弹窗的答案提交写请求会被误判跨站 403。
        // login POST 是公开路由（上方已 return）不受影响；GET/HEAD/OPTIONS 不校验。
        if (req.method && !/^(GET|HEAD|OPTIONS)$/i.test(req.method)) {
            const origin = req.headers.origin;
            const secSite = String(req.headers["sec-fetch-site"] || "").toLowerCase();
            const hostHeader = req.headers.host || "";
            let crossSite = secSite === "cross-site";
            if (typeof origin === "string" && origin && origin !== "null") {
                try {
                    const oHost = new URL(origin).host;
                    if (this.originHostIsTrusted(oHost)) {
                        // 浏览器不可伪造的受信任来源：即便被 CDN 注入了 cross-site 标记或
                        // Host 被改写成回环，本质仍是同一已登录页面的同源写，按同源放行。
                        crossSite = false;
                    }
                    else if (oHost !== hostHeader &&
                        oHost.replace(/:\d+$/, "") !== hostHeader.replace(/:\d+$/, "")) {
                        crossSite = true;
                    }
                }
                catch {
                    crossSite = true;
                }
            }
            if (crossSite) {
                res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
                res.end(JSON.stringify({ error: "Forbidden", message: "跨站写请求被拒绝" }));
                return;
            }
        }
        // 一次性真机诊断：移动端 PWA 顶部「毛玻璃遮盖」probe 上报。
        // 刻意放在会话校验与统一写请求同源校验之后（与 directory API 同理）：
        // 端点只接受已登录、同源的 POST，不暴露任何敏感数据，只追加本地 JSONL。
        // 拿到日志定位真凶后即可整体移除（probe 脚本 + 本分支 + 端点）。
        if (url === "/api/dshweb/top-probe" && req.method === "POST") {
            let body = "";
            req.on("data", (c) => {
                body += c;
                if (body.length > 256000)
                    req.destroy();
            });
            req.on("end", () => {
                try {
                    const parsed = JSON.parse(body);
                    if (!parsed || typeof parsed !== "object")
                        throw new Error("bad payload");
                    const line = JSON.stringify({
                        at: new Date().toISOString(),
                        ua: String(req.headers["user-agent"] || ""),
                        remote: this.store.getSession(this.getSession(req) || "")?.remote || "",
                        ...parsed,
                    });
                    const probeFile = join(homedir(), ".dsh", "dshweb-top-probe.jsonl");
                    void fsp
                        .mkdir(path.dirname(probeFile), { recursive: true })
                        .then(() => fsp.appendFile(probeFile, line + "\n", "utf8"))
                        .catch(() => { });
                }
                catch {
                    // 探针是诊断工具，任何解析/写盘失败都静默，不影响页面
                }
                if (!res.headersSent) {
                    res.writeHead(204);
                    res.end();
                }
            });
            return;
        }
        // Bug1 / 需求④：远程端网页目录选择器（网关自持端点，不透传 DSH 核心；
        // 手机 + 非移动设备浏览器经网关接入时共用，桌面直连零影响）。
        // 位置刻意放在会话校验之后 —— 目录 API 需要登录会话，但 serveInternalApi
        // 命中即 return 会绕过下方统一校验；放在这里可继承 :264-277 的会话校验
        // （未登录 isInternalApi 已被回 401 JSON），命中后直接 return 不反代。
        // 目录 fs 逻辑内联本模块，随 /api/dshweb/reload 击穿 server.js 缓存热生效。
        if (url.startsWith("/api/dshweb/directory/")) {
            void this.handleDirectoryApi(url, req, res).catch((err) => {
                if (!res.headersSent) {
                    res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
                    res.end(JSON.stringify({ error: "Internal", message: String((err && err.message) || err) }));
                }
            });
            return;
        }
        // m05019：删除权限收口 —— 网关层即时生效（随 /api/dshweb/reload 热重载），
        // 宿主路由 api.ts 里的同名收口在 DSH 重启后与之互为纵深防御。
        // 凡到达网关的请求都来自经 3180 接入的远程浏览器（桌面 GUI 设置页直连核心、
        // 不经网关）；此前远程桌面浏览器（remote:'desktop' 会话）也能删设备是 bug，
        // 这里直接挡住两个删除端点，仅桌面 GUI 直连核心可删。位置在会话校验 +
        // 统一写请求同源校验之后、反代之前，DELETE 语义不依赖反代即可生效。
        const apiPath = url.split("?")[0];
        if (apiPath === "/api/dshweb/delete-device" ||
            apiPath === "/api/dshweb/delete-remote-devices") {
            res.writeHead(403, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify({ ok: false, message: "仅桌面客户端可删除设备" }));
            return;
        }
        // m05019：设备列表附「在线」标记 —— 网关自持，随 reload 热生效，远程浏览器
        // 无需等 DSH 重启即可看到所有已连接设备及在线状态。在线集合 = sessions.json
        // 里所有会话绑定的 deviceId（persistSessions 全量原子写盘即权威，store.sessions
        // 私有且 store.js 不参与 reload，故直接读盘）；桌面 GUI 直连核心走宿主路由
        // api.ts（重启后同样附 online），两者数据源一致、互不冲突。
        if (apiPath === "/api/dshweb/devices" && (!req.method || req.method === "GET")) {
            const online = new Set();
            try {
                const raw = readFileSync(join(homedir(), ".dsh", "dshweb", "sessions.json"), "utf8");
                const obj = JSON.parse(raw) || {};
                for (const s of Object.values(obj)) {
                    if (s && typeof s === "object" && typeof s.deviceId === "string") {
                        const id = s.deviceId;
                        if (id)
                            online.add(id);
                    }
                }
            }
            catch {
                // 会话文件不存在 / 损坏时按「全部离线」处理，不影响设备列表展示
            }
            const devices = (this.store.getOptions().devices || []).map((d) => ({
                ...d,
                online: online.has(d.id),
            }));
            res.writeHead(200, {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store",
            });
            res.end(JSON.stringify(devices));
            return;
        }
        // 成对虚拟化 Host/Origin/Referer（解除核心 CSWSH / CSRF 跨站围栏）
        const proxyHeaders = this.buildProxyHeaders(req, originalHost);
        if (isHtmlRequest) {
            // 走响应拦截注入 data-remote
            this.proxyHtmlRequest(req, res, proxyHeaders, originalHost);
            return;
        }
        // 会话内选择弹窗的答案回传（POST /api/$events/result）：这是少数走普通
        // fetch 而非 WS mux 的宿主 RPC。域名/CDN 链路在连接代际切换时可能让浏览器
        // 主动 abort 这次 fetch；普通直通会在客户端断开时 req.pipe 把「网关→核心」
        // 请求一并销毁，答案永远到不了核心 → pending waterfall 在新代际被重新下发
        // → 选择窗「提交无效、几秒后重现」。改为缓冲小 JSON、与客户端断开解耦，
        // 核心 $events/result 按 eventId + deliveries 幂等去重，迟到/重复无副作用。
        if (req.method === "POST" &&
            (url.split("?")[0] === "/api/$events/result" ||
                url.split("?")[0] === "/api/%24events/result")) {
            this.proxyAnswerResult(req, res, proxyHeaders);
            return;
        }
        // 普通请求直通 pipe
        this.proxyPassThrough(req, res, proxyHeaders);
    }
    /**
     * 答案回传专用反代：缓冲极小的 JSON body 后独立转发给核心，不把客户端断开
     * 传播到网关→核心这一跳。即使浏览器因代际重置 abort 了 fetch，核心仍能收到
     * 答案并 settle 对应 pending waterfall；等新代际重连时已无待下发事件，弹窗
     * 便不会再次出现。核心对 $events/result 幂等（eventId 去重），clientId 真过期
     * 时只是回 ok:false 被丢弃，不会比现状更差。
     */
    proxyAnswerResult(req, res, proxyHeaders) {
        const chunks = [];
        let size = 0;
        let done = false;
        const headers = { ...proxyHeaders };
        const forward = () => {
            if (done)
                return;
            done = true;
            if (size === 0)
                return; // 客户端在发出任何 body 前就断开，无需转发
            const body = Buffer.concat(chunks);
            delete headers["transfer-encoding"];
            headers["content-length"] = String(body.length);
            const proxyReq = http.request({
                hostname: this.coreHost,
                port: this.corePort,
                path: req.url,
                method: "POST",
                headers,
            }, (proxyRes) => {
                // 客户端可能已 abort：只把上游响应排空，避免占用核心连接资源。
                if (res.destroyed || res.writableEnded) {
                    proxyRes.resume();
                    return;
                }
                try {
                    res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                    proxyRes.pipe(res);
                }
                catch {
                    proxyRes.resume();
                }
            });
            proxyReq.on("error", (err) => {
                if (!res.destroyed && !res.writableEnded && !res.headersSent) {
                    try {
                        res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                        res.end("[dshweb] 502: 答案回传失败: " + err.message);
                    }
                    catch { }
                }
            });
            // 关键：刻意不注册 req.on("aborted", () => proxyReq.destroy())。
            proxyReq.end(body);
        };
        req.on("data", (c) => {
            if (done)
                return;
            const b = Buffer.isBuffer(c) ? c : Buffer.from(c);
            // 答案 body 极小（数百字节）；设上限防止异常请求撑爆内存。
            if (size + b.length > 64 * 1024) {
                done = true;
                chunks.length = 0;
                size = 0;
                return;
            }
            chunks.push(b);
            size += b.length;
        });
        req.on("end", forward);
        // 客户端 abort / 连接断开时也尽力转发已收到的完整 body（幂等，无害）。
        req.on("aborted", forward);
        req.on("close", forward);
        req.on("error", forward);
    }
    /** 纯流式反代（非 HTML 注入路径）：登录头像/静态资源/SSE/WS 之外的普通请求。 */
    proxyPassThrough(req, res, proxyHeaders) {
        const proxyReq = http.request({
            hostname: this.coreHost,
            port: this.corePort,
            path: req.url,
            method: req.method,
            headers: proxyHeaders,
        }, (proxyRes) => {
            const location = proxyRes.headers.location;
            if (location && [301, 302, 303, 307, 308].includes(proxyRes.statusCode || 0)) {
                proxyRes.headers.location = this.rewriteRedirectLocation(location, req.headers.host || "", req);
            }
            const contentType = String(proxyRes.headers["content-type"] || "").toLowerCase();
            if (contentType.includes("text/event-stream")) {
                proxyRes.headers["x-accel-buffering"] = "no";
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
                res.flushHeaders?.();
            }
            else {
                res.writeHead(proxyRes.statusCode || 200, proxyRes.headers);
            }
            proxyRes.pipe(res);
        });
        proxyReq.on("error", (err) => {
            if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`[dshweb] 502: 无法连接 DSH 核心 (${this.coreTargetAuthority}): ${err.message}`);
            }
        });
        req.on("aborted", () => proxyReq.destroy());
        req.pipe(proxyReq);
    }
    /**
     * HTML 请求：反代 + 拦截响应注入 <html data-remote="mobile|desktop">
     * 响应体流量较小（DSH HTML <100KB），用 buffer 而非流式。
     */
    proxyHtmlRequest(req, res, proxyHeaders, originalHost) {
        const chunks = [];
        req.resume(); // 丢弃请求体（HTML GET 请求大多无 body）
        // 关键：HTML 注入路径要读原文拼 tag，明确禁用压缩
        delete proxyHeaders["accept-encoding"];
        proxyHeaders["accept-encoding"] = "identity";
        const proxyReq = http.request({
            hostname: this.coreHost,
            port: this.corePort,
            path: req.url,
            method: req.method,
            headers: proxyHeaders,
        }, (proxyRes) => {
            const status = proxyRes.statusCode || 200;
            const headers = { ...proxyRes.headers };
            const contentType = String(headers["content-type"] || "");
            if (!contentType.includes("text/html")) {
                // 非 HTML 响应直通
                res.writeHead(status, headers);
                proxyRes.pipe(res);
                return;
            }
            delete headers["content-length"];
            delete headers["content-encoding"]; // 明确丢弃 gzip，这里直接读原文
            const location = headers["location"];
            if (location && [301, 302, 303, 307, 308].includes(status)) {
                headers["location"] = this.rewriteRedirectLocation(location, originalHost, req);
            }
            proxyRes.on("data", (c) => chunks.push(c));
            proxyRes.on("end", () => {
                const body = Buffer.concat(chunks).toString("utf8");
                const remote = this.store.getSession(this.getSession(req))?.remote || "desktop";
                const tag = remote === "mobile"
                    ? ' data-remote="mobile" data-dshweb="1"'
                    : ' data-remote="desktop"';
                let injected = injectHtmlTag(body, tag);
                // 补齐带版本号的 PNG/ICO 图标链接（核心 head 只有 SVG favicon；
                // 部分浏览器/启动器只认 PNG/ICO，缺了就退化成默认「地球」图标）。
                injected = injectPwaIconLinks(injected);
                // 远程会话「重新连接中」韧性：放宽 CDN 慢链路下的 generation-ready
                // 超时 + 会话/冻结看门狗。仅经网关 HTML（带 data-remote）命中。
                injected = injectRemoteResilience(injected);
                if (remote === "mobile") {
                    // 移动端：注入 theme-color / viewport-fit=cover / 定制 CSS。
                    // 必须内联在本模块（reload 只击穿 server.js 的 ESM 缓存）。
                    const opts = this.store.getOptions();
                    injected = injectMobileHead(injected, opts?.fontScale);
                }
                else {
                    // 桌面远程端（data-remote="desktop"）：注入顶栏对齐 CSS。
                    // 同样必须内联在本模块，reload 才能热生效；本机桌面 GUI 直连核心
                    // 不经过网关、HTML 不带 data-remote，零命中（PLAN.md 约束）。
                    injected = injectDesktopHead(injected);
                }
                res.writeHead(status, { ...headers, "Cache-Control": "no-cache" });
                res.end(Buffer.from(injected, "utf8"));
            });
        });
        proxyReq.on("error", (err) => {
            if (!res.headersSent) {
                res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
                res.end(`[dshweb] 502: 上游错误: ${err.message}`);
            }
        });
        proxyReq.end();
    }
    /** WebSocket upgrade 转发（双向 pipe + 60s 握手超时 + 对称清理） */
    handleUpgrade(req, clientSocket, head) {
        const originalHost = req.headers.host || "";
        if (!this.isHostAllowed(originalHost)) {
            clientSocket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
            clientSocket.destroy();
            return;
        }
        if (!this.getSession(req)) {
            clientSocket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
            clientSocket.destroy();
            return;
        }
        // 成对虚拟化 Host/Origin/Referer（浏览器 WS 一定带 Origin，未虚拟化会触发核心 403）
        const proxyHeaders = this.buildProxyHeaders(req, originalHost);
        let isUpgraded = false;
        const proxyReq = http.request({
            hostname: this.coreHost,
            port: this.corePort,
            path: req.url,
            method: req.method || "GET",
            headers: proxyHeaders,
        });
        // Cloudflare / 隧道给 WS 握手额外 ~7s（实测 101 @7.6s vs 局域网 1.0s）：
        // 10s 太紧会在握手途中就销毁升级，触发连接代际反复重建；会话里打开的选择
        // 弹窗答案（POST /api/$events/result）会随代际重置丢失并被重新下发，表现为
        // 「提交无效、几秒后弹窗重现」。放宽到 60s，与注入的 generationReady 超时一致。
        proxyReq.setTimeout(60_000, () => {
            if (!isUpgraded) {
                proxyReq.destroy();
                try {
                    clientSocket.write("HTTP/1.1 504 Gateway Timeout\r\nConnection: close\r\n\r\n");
                    clientSocket.destroy();
                }
                catch { }
            }
        });
        clientSocket.once("close", () => {
            if (!isUpgraded)
                proxyReq.destroy();
        });
        proxyReq.on("response", (proxyRes) => {
            proxyReq.setTimeout(0);
            clientSocket.removeListener("close", () => { });
            const statusLine = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage || ""}\r\n`;
            let hdrs = "";
            const raw = proxyRes.rawHeaders;
            for (let i = 0; i < raw.length; i += 2)
                hdrs += `${raw[i]}: ${raw[i + 1]}\r\n`;
            try {
                clientSocket.write(`${statusLine}${hdrs}\r\n`);
                proxyRes.pipe(clientSocket);
            }
            catch {
                clientSocket.destroy();
            }
        });
        proxyReq.on("upgrade", (proxyRes, coreSocket, proxyHead) => {
            isUpgraded = true;
            proxyReq.setTimeout(0);
            const statusLine = `HTTP/${proxyRes.httpVersion} 101 Switching Protocols\r\n`;
            let hdrs = "";
            const raw = proxyRes.rawHeaders;
            for (let i = 0; i < raw.length; i += 2)
                hdrs += `${raw[i]}: ${raw[i + 1]}\r\n`;
            clientSocket.write(`${statusLine}${hdrs}\r\n`);
            if (proxyHead && proxyHead.length)
                clientSocket.unshift(proxyHead);
            if (head && head.length)
                coreSocket.unshift(head);
            clientSocket.setNoDelay(true);
            coreSocket.setNoDelay(true);
            clientSocket.pipe(coreSocket);
            coreSocket.pipe(clientSocket);
            clientSocket.on("error", () => coreSocket.destroy());
            coreSocket.on("error", () => clientSocket.destroy());
            clientSocket.on("close", () => coreSocket.destroy());
            coreSocket.on("close", () => clientSocket.destroy());
        });
        proxyReq.on("error", (err) => {
            if (!isUpgraded) {
                this.logger?.error?.("[dshweb] WebSocket 转发失败:", err);
                try {
                    clientSocket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
                    clientSocket.destroy();
                }
                catch { }
            }
        });
        proxyReq.end();
    }
    getSession(req) {
        const cookieHeader = req.headers.cookie || "";
        const m = cookieHeader.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
        if (!m)
            return undefined;
        const sess = this.store.getSession(m[1]);
        if (!sess)
            return undefined;
        // 热重载过渡：宿主进程可能仍加载旧版 store.js（getSession 不校验 expiresAt）。
        // 网关是 3180 所有访问的统一鉴权入口，在这里对「保持登录」会话做 24h 绝对
        // 过期兜底；新版 store 自身已拒绝过期会话，此处幂等、只读、无副作用。
        // 0 / 缺省表示会话级，不受影响。
        if (sess.expiresAt && Date.now() > sess.expiresAt)
            return undefined;
        return m[1];
    }
    /**
     * 注册 / 幂等更新「已登录设备」到 settings.devices（Bug2）。
     *
     * 只复用 WebStore 既有方法（getOptions / updateOptions / markSeen）——
     * /api/dshweb/reload 仅击穿 server.js 的 ESM 缓存，store.js 是旧实例，
     * 不能依赖在运行期才加到 store 的新方法，故本逻辑内联于本模块。
     *
     * 设备 id = sha1(remote|UA)，同一设备换 IP 仍归一条（仅更新 ip/lastSeenAt）。
     * 全流程 try/catch，任何异常都不阻断登录。
     */
    registerDevice(req, sessionToken, remote) {
        try {
            const opts = this.store.getOptions();
            const ua = String(req.headers["user-agent"] || "");
            const ip = String(req.socket?.remoteAddress || "").replace(/^::ffff:/, "");
            const devId = createHash("sha1").update(`${remote}|${ua}`).digest("hex").slice(0, 16);
            const devices = Array.isArray(opts.devices) ? opts.devices.slice() : [];
            const now = Date.now();
            const name = describeDevice(ua);
            const existing = devices.find((d) => d && d.id === devId);
            if (existing) {
                existing.name = name;
                existing.ua = ua;
                existing.ip = ip;
                existing.remote = remote;
                existing.lastSeenAt = now;
            }
            else {
                devices.push({ id: devId, name, ua, ip, remote, pairedAt: now, lastSeenAt: now });
            }
            this.store.updateOptions({ devices });
            // 绑定会话 → 设备 id，供 /api/dshweb/status 回传 currentDeviceId 高亮「当前设备」
            this.store.markSeen(sessionToken, devId);
            this.registeredSessions.add(sessionToken);
        }
        catch (e) {
            this.logger?.warn?.("[dshweb] 设备注册失败（不影响登录）:", e);
        }
    }
    /**
     * 热重载过渡：桌面上生成的码暂时还写在旧 credentials.ts 的模块全局里
     * （宿主路由 routes/api.js 不参与热重载），此处直接拿旧实现校验一次，
     * 成功后把码接管进 store，后续请求就走新逻辑。
     *
     * 这是单向兼容层：DSH 重启后宿主路由也换成新代码、旧模块里没有码，
     * verifyLegacyPairCode 自然恒返回 false，无需再删改本方法。
     */
    /**
     * 热重载/跨实例兜底：向宿主路由 GET /api/dshweb/pair-code 回源取当前码。
     *
     * 背景：配对码的「写入侧」在宿主进程（桌面设置页 → routes/api.ts setPairCode）。
     * 若宿主进程加载的仍是旧版 routes（写模块全局而非 store.options），或因任何
     * 时序原因 store 里读不到码，网关登录校验会误报「没有可用的配对码」。
     * 宿主路由在本机回环上且 GET 只读（返回当前码与有效期），网关直接回源问它，
     * 用返回的码做本地比对，成功后 adopt 进 store，后续请求走 store 正常逻辑。
     * 只在本机回环上调用，不经过网关自身，无跨机器暴露。
     */
    fetchHostPairCode() {
        return new Promise((resolve) => {
            try {
                const req = http.request({
                    hostname: this.coreHost,
                    port: this.corePort,
                    path: "/api/dshweb/pair-code",
                    method: "GET",
                    headers: { Host: `${this.coreHost}:${this.corePort}` },
                    timeout: 2000,
                }, (res) => {
                    let body = "";
                    res.on("data", (c) => {
                        body += c;
                        if (body.length > 4096)
                            res.destroy();
                    });
                    res.on("end", () => {
                        try {
                            const pj = JSON.parse(body);
                            if (pj?.ok && typeof pj.code === "string" && /^\d{6}$/.test(pj.code)) {
                                resolve({ code: pj.code, expiresAt: Number(pj.expiresAt) || 0 });
                                return;
                            }
                        }
                        catch { }
                        resolve(null);
                    });
                    res.on("error", () => resolve(null));
                });
                req.on("timeout", () => {
                    req.destroy();
                    resolve(null);
                });
                req.on("error", () => resolve(null));
                req.end();
            }
            catch {
                resolve(null);
            }
        });
    }
    verifyLegacyPairCode(credential, opts) {
        try {
            const legacyVerify = credentials.verifyPairCode;
            if (typeof legacyVerify !== "function")
                return false;
            const ok = legacyVerify.call(credentials, credential, opts) === true;
            if (!ok)
                return false;
            this.adoptLegacyPairCode();
            return true;
        }
        catch {
            return false;
        }
    }
    /**
     * 把旧版存在 credentials.ts 模块全局里的配对码搬进 store。
     *
     * 背景：/api/dshweb/reload 只重新加载本模块，宿主路由（routes/api.js）还是启动时
     * 那份旧代码，仍在写 credentials.ts 的模块级全局。不接管的话，用户刚在桌面生成的
     * 码在网关侧读不到 → 提示「当前没有可用的配对码」。这是单向兼容层，
     * 等 DSH 重启、宿主路由也换成新代码后此处自然变成空操作（旧模块里没有码）。
     */
    adoptLegacyPairCode() {
        try {
            const legacy = credentials.getPairCode?.();
            if (!legacy || typeof legacy.code !== "string")
                return;
            // 桌面上显示哪串码以「生成它的那一侧」为准。过渡期内生成动作仍发生在旧模块里，
            // 所以只要旧模块有一串当前可用的码且与 store 不同，就以它为准搬进来。
            const current = pairCode.getPairCode(this.store);
            if (current && current.code === legacy.code)
                return;
            pairCode.adoptPairCode(this.store, legacy);
        }
        catch { }
    }
    /**
     * 历史会话幂等补注册：用户在本修复前已登录、devices 仍为空时，
     * 下一次带会话的 HTTP 请求把当前设备补进列表（每个会话仅一次）。
     */
    ensureDeviceRegistered(req) {
        const token = this.getSession(req);
        if (!token || this.registeredSessions.has(token))
            return;
        const sess = this.store.getSession(token);
        if (!sess)
            return;
        if (sess.deviceId) {
            this.registeredSessions.add(token);
            return;
        }
        this.registerDevice(req, token, sess.remote);
    }
    /**
     * Bug1 / 需求④：远程端网页目录选择器的 host 端 HTTP API（网关自持）。
     *
     * 为什么必须有它：DSH 官方目录选择器 capability 是「全局单例、boot 时只按
     * webServer.host 采样一次」，核心保持 127.0.0.1 回环 ⇒ 判定为 native。
     * native 的「新建工作区」会让 PC 弹系统文件框、远程 web 收不到任何 UI
     * （手机端最先暴露，非移动设备浏览器同样中招，见客户端 installDirectoryFlow）；
     * 且 directoryPicker/list|createDirectory 动词被 requireCapability('browse') 门控，
     * 在 native 能力下抛 directory-picker/unavailable，无法复用官方 HTTP/WS 端点。
     * 故 dshweb 自建等价的目录 list/create（fs 逻辑对齐官方
     * dsh-host-directory-picker-browse），供所有经网关远程接入的浏览器 occupant
     * 调用（手机 + 非移动设备浏览器），让文件夹选项只在远程端弹出；
     * 桌面 GUI 直连核心不经网关、无此端点调用方 → 原生选择器零影响。
     *
     * 认证：调用点位于 handleHttpRequest 的统一会话校验之后（未登录已被回 401），
     * 这里再显式复核一次会话 + 对写请求做同源校验，纵深防御 CSRF。
     *
     * 路径策略：与官方 browse 一致——只接受「完整绝对路径」(Windows 需盘符限定
     * 或完整 UNC，拒 \foo / /foo / 残缺 UNC / 相对路径)，resolve() 规范化。
     * 不设 homedir 根白名单：用户工作区可能在其它盘（如 iSCSI 挂载的 D:\），
     * 限制在 homedir 会导致选不到 D: 工作区，反而退化为不如桌面原生选择器。
     * 本端点已要求登录会话（口令/配对码），信任级别与「改端口/改口令」设置页相同。
     */
    async handleDirectoryApi(url, req, res) {
        const json = (obj, status = 200) => {
            if (res.headersSent)
                return;
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
            res.end(JSON.stringify(obj));
        };
        const fail = (status, code, message) => json({ error: code, message }, status);
        // 会话复核（纵深）：目录端点必须带登录 cookie
        if (!this.getSession(req))
            return fail(401, "Unauthorized", "请先登录");
        // 工作区根目录：从官方 workspace registry（~/.dsh/storages/workspace.json）推导 ——
        // 取 default workspace 的父目录（官方默认约定 Documents/deepseek-harness 下各工作区）。
        // 读取失败/为空时回退 homedir()。缓存 60s，避免每次 list 都读盘。
        const workspaceRoot = (() => {
            const now = Date.now();
            if (!workspaceRootCache.value || now - workspaceRootCache.at > 60_000) {
                let derived = "";
                try {
                    const regPath = join(homedir(), ".dsh", "storages", "workspace.json");
                    const reg = JSON.parse(readFileSync(regPath, "utf8"));
                    const tables = reg?.tables?.workspaces || {};
                    const ids = Array.isArray(reg?.global?.workspaceIds) ? reg.global.workspaceIds : [];
                    const paths = [];
                    const defId = reg?.global?.defaultWorkspaceId;
                    if (defId && tables[defId]?.path)
                        paths.unshift(String(tables[defId].path));
                    for (const id of ids) {
                        const p = tables[id]?.path;
                        if (p && !paths.includes(String(p)))
                            paths.push(String(p));
                    }
                    if (paths.length > 0) {
                        // 语义对齐用户预期：「根目录」= 默认工作区的父目录（官方默认约定
                        // Documents/deepseek-harness 下各工作区）。部分工作区可能散落其它盘，
                        // 全量公共父目录会把根缩到盘符根部，通常不符合直觉，故直接取默认工作区父目录。
                        const p = process.platform === "win32" ? path.win32 : path.posix;
                        const derived0 = p.dirname(paths[0]);
                        if (derived0 && derived0 !== p.parse(derived0).root)
                            derived = derived0;
                    }
                }
                catch { }
                workspaceRootCache.value = derived || homedir();
                workspaceRootCache.at = now;
            }
            return workspaceRootCache.value;
        })();
        // 写请求同源校验：Origin 与网关 Host 不一致即拒（镜像核心 CSRF 围栏）
        if (req.method === "POST") {
            const origin = req.headers.origin;
            if (typeof origin === "string" && origin && origin !== "null") {
                try {
                    const oHost = new URL(origin).host;
                    const gHost = req.headers.host || "";
                    if (oHost !== gHost && oHost.replace(/:\d+$/, "") !== gHost.replace(/:\d+$/, "")) {
                        return fail(403, "Forbidden", "跨站写请求被拒绝");
                    }
                }
                catch {
                    return fail(403, "Forbidden", "非法 Origin");
                }
            }
        }
        const home = os.homedir();
        const parsed = new URL(url, "http://dshweb.local");
        /** 完整绝对路径校验 + resolve 规范化；空路径→home；不合规则 null */
        const fullyQualified = (input) => {
            if (input === undefined || input === null || input === "")
                return home;
            const s = String(input);
            if (s.includes("\0"))
                return null;
            const p = process.platform === "win32" ? path.win32 : path.posix;
            let ok = p.isAbsolute(s);
            if (process.platform === "win32") {
                // drive-qualified (C:\ or C:/) 或完整 UNC (\\server\share\...)
                ok = ok && /^(?:[A-Za-z]:[\\/]|[\\/]{2}[^\\/]+[\\/]+[^\\/]+)/.test(s);
            }
            return ok ? p.resolve(s) : null;
        };
        /** 目录项是否为「目录或指向目录的符号链接」（跳过非目录/断链） */
        const isDirLike = async (full, dirent) => {
            try {
                if (dirent.isDirectory())
                    return true;
                if (dirent.isSymbolicLink()) {
                    const st = await fsp.stat(full); // 跟随符号链接
                    return st.isDirectory();
                }
            }
            catch { }
            return false;
        };
        /** 从根到目标构造面包屑 */
        const buildCrumbs = (target) => {
            const p = process.platform === "win32" ? path.win32 : path.posix;
            const crumbs = [];
            const root = p.parse(target).root;
            let cur = target;
            const guard = new Set();
            while (cur && !guard.has(cur)) {
                guard.add(cur);
                const name = p.basename(cur) || cur;
                crumbs.unshift({ name, path: cur, hidden: name.startsWith(".") });
                if (cur === root)
                    break;
                const parent = p.dirname(cur);
                if (parent === cur)
                    break;
                cur = parent;
            }
            return crumbs;
        };
        // GET /api/dshweb/directory/list?path=<绝对目录>
        if (parsed.pathname === "/api/dshweb/directory/list" && req.method === "GET") {
            const target = fullyQualified(parsed.searchParams.get("path"));
            if (!target)
                return fail(400, "directory-invalid-path", "路径必须是完整绝对路径");
            try {
                const st = await fsp.stat(target);
                if (!st.isDirectory())
                    return fail(400, "directory-unreadable", "不是目录");
            }
            catch {
                return fail(400, "directory-unreadable", "目录不可读");
            }
            let dirents = [];
            try {
                dirents = await fsp.readdir(target, { withFileTypes: true });
            }
            catch {
                return fail(400, "directory-unreadable", "目录不可读");
            }
            const MAX = 1000;
            const rows = [];
            for (const d of dirents) {
                const name = String(d.name);
                const full = path.join(target, name);
                if (await isDirLike(full, d)) {
                    rows.push({ name, path: full, hidden: name.startsWith(".") });
                }
            }
            // 下拉盘符菜单数据：枚举本机真实存在的盘符（Windows only）。
            // 只显示实际 stat 成功的盘（用户的 C:/D:），不存在的盘不会出现。
            let drives = [];
            if (process.platform === "win32") {
                for (let code = 65; code <= 90; code++) {
                    const letter = String.fromCharCode(code);
                    try {
                        await fsp.stat(`${letter}:\\`);
                        drives.push(`${letter}:`);
                    }
                    catch {
                        // 盘符不存在或不可读（空光驱等）→ 不出现在下拉菜单
                    }
                }
            }
            rows.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
            const truncated = rows.length > MAX;
            const entries = rows.slice(0, MAX);
            const p = process.platform === "win32" ? path.win32 : path.posix;
            const root = p.parse(target).root;
            const parent = target === root ? null : p.dirname(target);
            return json({
                path: target,
                home,
                workspaceRoot,
                parent,
                crumbs: buildCrumbs(target),
                drives,
                entries,
                truncated,
            });
        }
        // POST /api/dshweb/directory/create { path, name }
        if (parsed.pathname === "/api/dshweb/directory/create" && req.method === "POST") {
            let body;
            try {
                body = (await this.readJsonBody(req));
            }
            catch (e) {
                return fail(400, "directory-create-failed", "请求体无效: " + String(e?.message || e));
            }
            const parent = fullyQualified(body && body.path);
            if (!parent)
                return fail(400, "directory-invalid-path", "父路径必须是完整绝对路径");
            const name = String((body && body.name) || "").trim();
            if (!name || name === "." || name === ".." || /[/\\]/.test(name) || name.includes("\0")) {
                return fail(400, "directory-create-failed", "文件夹名非法（需为单个名称，不含 / 或 \\）");
            }
            const target = path.join(parent, name);
            try {
                await fsp.mkdir(target);
            }
            catch (e) {
                if (e?.code === "EEXIST")
                    return fail(409, "directory-exists", "同名文件夹已存在");
                return fail(400, "directory-create-failed", "创建失败: " + String(e?.message || e));
            }
            return json({ path: target });
        }
        return fail(404, "not-found", "未知的目录 API");
    }
    /** 读取并解析 JSON 请求体（带 64KB 上限） */
    readJsonBody(req) {
        return new Promise((resolve, reject) => {
            let raw = "";
            let done = false;
            const finish = (fn) => {
                if (!done) {
                    done = true;
                    fn();
                }
            };
            req.on("data", (c) => {
                raw += c;
                if (raw.length > 64 * 1024) {
                    finish(() => reject(new Error("请求体过大")));
                    req.destroy();
                }
            });
            req.on("end", () => finish(() => {
                try {
                    resolve(raw ? JSON.parse(raw) : {});
                }
                catch (e) {
                    reject(e);
                }
            }));
            req.on("error", (e) => finish(() => reject(e)));
        });
    }
    /**
     * 内部 API 路由（网关自持，不依赖宿主注册）：
     * GET  /api/dshweb/status      — 网关状态（无会话要求）
     * GET  /api/dshweb/login       — 登录页（口令 / 配对码表单）
     * POST /api/dshweb/login       — 提交凭据 → Set-Cookie + 302 /
     */
    serveInternalApi(url, req, res) {
        const host = req.headers.host || "";
        if (url === "/api/dshweb/status" && req.method === "GET") {
            const sessTok = this.getSession(req);
            const sess = sessTok ? this.store.getSession(sessTok) : null;
            const ip = firstLanIpv4();
            // 桌面 GUI 走回环（127.0.0.1:50177），拿不到局域网 IP，需要向本网关
            // 取一次 lanUrl 才能显示完整接入地址。仅对回环 Origin 开放只读 CORS，
            // 且响应里只有端口/版本/布尔值，无会话与口令信息。
            const headers = { "Content-Type": "application/json; charset=utf-8" };
            const origin = String(req.headers.origin || "");
            if (origin && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i.test(origin)) {
                headers["Access-Control-Allow-Origin"] = origin;
                headers["Vary"] = "Origin";
            }
            res.writeHead(200, headers);
            res.end(JSON.stringify({
                ok: true,
                port: this.boundPort,
                status: this.status,
                corePort: this.corePort,
                tls: this.isTls(),
                version: "0.1.3",
                lanIpv4: ip,
                // HTTP 接入地址始终用 http；HTTPS 地址单独给 httpsLanUrl（与 HTTP 共存）。
                lanUrl: ip ? `http://${ip}:${this.boundPort}` : "",
                httpsEnabled: this.isHttpsEnabled(),
                httpsPort: this.httpsBoundPort || this.configuredHttpsPort,
                httpsRunning: this.isHttpsRunning(),
                httpsLanUrl: ip && this.isHttpsRunning()
                    ? `https://${ip}:${this.httpsBoundPort || this.configuredHttpsPort}`
                    : "",
                // 与宿主路由 api.ts 对齐：手机/外部设备经 3180 打开设置页时，
                // 口令框的「已配置」徽标与占位符也依赖此字段（仅布尔，不下发明明文）
                hasPassword: Boolean(this.store.getOptions().passwordHash),
                // 「接入 → 域名白名单」回显用（与宿主路由 status 对齐）
                trustedHosts: Array.isArray(this.store.getOptions().trustedHosts)
                    ? this.store.getOptions().trustedHosts
                    : [],
                // 当前登录会话绑定的设备 id：设置页「远程设备」据此高亮「当前设备」。
                // 桌面直连不经网关、无此 cookie 时为 null（桌面不显示高亮）。
                currentDeviceId: sess?.deviceId || null,
                // 官方 launch-token 401 热修是否可用（能否铸造官方签名 Cookie）。
                // forged-cookie = 网关可为已登录会话注入官方 Cookie，手机无需重启 DSH；
                // unavailable = 官方密钥读取失败，需回退到 index.ts 的 connection 接管。
                officialAuth: mintOfficialCookie(this.coreTargetAuthority)
                    ? "forged-cookie"
                    : "unavailable",
            }));
            return true;
        }
        // 连接韧性看门狗的轻量会话探活（见 injectRemoteResilience）：公开路由，
        // 但自身按 getSession 判定——无有效会话 401、有效会话 200。只读、不写盘，
        // 响应仅含一个布尔，不下发任何会话/口令/设备信息，30s 轮询无副作用。
        if (url === "/api/dshweb/session" && req.method === "GET") {
            const ok = Boolean(this.getSession(req));
            res.writeHead(ok ? 200 : 401, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify({ ok }));
            return true;
        }
        if (url === "/api/dshweb/login" && req.method === "GET") {
            // 按本次请求实际协议显示，避免 HTTP 页面误显示 https（双监听共存时两者都可登录）。
            const proto = this.requestIsTls(req) ? "https" : "http";
            const body = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dshweb 登录</title></head>
<body style="font-family:system-ui;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#101317;color:#e6e6e6;margin:0">
<form method="POST" action="/api/dshweb/login" style="background:#1a1f26;padding:32px;border-radius:12px;min-width:280px;max-width:360px;width:90%">
  <h2 style="margin-top:0">dshweb 远程接入</h2>
  <p style="font-size:13px;opacity:.7">${proto}://${host}</p>
  <label style="display:block;margin:12px 0 4px;font-size:13px">口令或配对码</label>
  <div style="display:flex;gap:8px;align-items:stretch">
    <input id="cred" name="credential" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="输入永久口令或 6 位配对码" style="flex:1;min-width:0;box-sizing:border-box;padding:12px;border-radius:8px;border:1px solid #3a414b;background:#0d0f12;color:#e6e6e6;font-size:15px">
    <button type="button" onclick="(function(b){var i=document.getElementById('cred');var p=i.type==='password';i.type=p?'text':'password';b.textContent=p?'隐藏':'显示';})(this)" style="padding:0 12px;border-radius:8px;border:1px solid #3a414b;background:#0d0f12;color:#e6e6e6;font-size:13px;cursor:pointer">显示</button>
  </div>
  <label style="display:flex;align-items:center;gap:8px;margin:14px 0 0;font-size:13px;cursor:pointer;user-select:none"><input type="checkbox" name="keep" value="1" style="width:15px;height:15px;accent-color:#2f6fed;cursor:pointer">保持登录 24 小时（关闭浏览器后 24 小时内免输口令）</label>
  <button style="width:100%;margin-top:16px;padding:12px;border:0;border-radius:8px;background:#2f6fed;color:#fff;font-size:15px">进入</button>
  <p style="font-size:12px;opacity:.55;margin:14px 0 0;line-height:1.5">永久口令为不少于 6 位的自定义口令；配对码为桌面端「接入」页生成的 6 位短期动态码（5 分钟内可多次配对）。不勾选「保持登录」时仅浏览器会话有效，关闭浏览器即需重新登录。</p>
</form></body></html>`;
            res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
            res.end(body);
            return true;
        }
        if (url === "/api/dshweb/login" && req.method === "POST") {
            // 解析表单 body（单输入框：credential）
            let raw = "";
            req.on("data", (c) => {
                raw += c;
                if (raw.length > 1024)
                    req.destroy();
            });
            req.on("end", async () => {
                const params = new URLSearchParams(raw);
                // 兼容旧的双字段表单，同时支持新的单字段
                const credential = params.get("credential") || params.get("password") || params.get("pairCode") || "";
                // 「保持登录 24 小时」：勾选后下发持久 Cookie + 服务端 24h 绝对过期会话。
                // 兼容 checkbox 的 on/1 以及旧客户端可能直接传 true 的情况。
                const keepRaw = params.get("keep") || "";
                const keep = keepRaw === "1" || keepRaw === "on" || keepRaw === "true";
                const ua = String(req.headers["user-agent"] || "");
                const remote = /Android|iPhone|iPad|iPod|Mobile/i.test(ua) ? "mobile" : "desktop";
                const opts = this.store.getOptions();
                // 判定策略：先试永久口令（可为任意长度）；若不匹配且输入是 6 位数字，
                // 再按「短期配对码」校验。这样 6 位数字永久口令与 6 位配对码互不干扰。
                let credOk = credentials.verifyPassword(credential, opts);
                // pairReason: none = 本次不是配对码输入（按口令失败处理）；invalid = 6 位数字但不对
                let pairReason = "none";
                if (!credOk && /^\d{6}$/.test(credential)) {
                    // 配对码状态存在 store 的 options 里（见 auth/pair-code.ts），所以这里校验的码
                    // 与桌面设置页显示的码永远是同一份，热重载也不会把它重置成「没有码」。
                    pairReason = pairCode.verifyPairCodeDetailed(credential, this.store);
                    // 热重载过渡：store 里还没有码时，回落到旧版模块全局里的码（见 adoptLegacyPairCode）。
                    if (pairReason === "none" && this.verifyLegacyPairCode(credential, opts))
                        pairReason = "ok";
                    if (pairReason === "none") {
                        // 仍读不到码（宿主进程跑的旧 routes 把码写在自己的模块全局里）：
                        // 回源向宿主路由 GET /api/dshweb/pair-code 取当前码做本地比对，
                        // 命中则 adopt 进 store，后续请求走 store 正常逻辑。
                        const hostCode = (await this.fetchHostPairCode());
                        if (hostCode) {
                            const now = Date.now();
                            const same = credential === hostCode.code;
                            const live = hostCode.expiresAt > now;
                            if (same && live) {
                                pairCode.adoptPairCode(this.store, {
                                    code: hostCode.code,
                                    expiresAt: hostCode.expiresAt,
                                    uses: 0,
                                    fails: 0,
                                });
                                pairReason = "ok";
                            }
                            else if (live) {
                                pairReason = "invalid";
                            }
                            else {
                                pairReason = "expired";
                            }
                        }
                    }
                    credOk = pairReason === "ok";
                }
                if (!credOk) {
                    // 文案必须说清「为什么」：旧版一律「凭据无效或配对码已过期」，
                    // 用户在「删设备 → 重登」时会误以为码还能用而反复重试。
                    const tip = pairReason === "expired"
                        ? "该配对码已过期（有效期 5 分钟）。请在桌面端「接入」页重新生成，或改用永久口令登录。"
                        : pairReason === "used"
                            ? "该配对码配对次数已用尽。请在桌面端「接入」页重新生成，或改用永久口令登录。"
                            : pairReason === "locked"
                                ? "该配对码因输错次数过多已作废。请在桌面端「接入」页重新生成，或改用永久口令登录。"
                                : pairReason === "invalid"
                                    ? "配对码不正确（同一码输错 5 次作废）。请核对桌面端「接入」页显示的 6 位数字，或改用永久口令登录。"
                                    : pairReason === "none" && /^\d{6}$/.test(credential)
                                        ? "当前没有可用的配对码（可能尚未生成或已被换发）。请在桌面端「接入」页生成新码，或改用永久口令登录。"
                                        : "口令不正确。请核对桌面端「接入」页设置的永久口令。";
                    const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dshweb 登录失败</title></head>
<body style="font-family:system-ui;padding:40px;background:#101317;color:#e6e6e6">
  <h2 style="margin:0 0 10px;font-size:17px">登录失败</h2>
  <p style="font-size:13px;line-height:1.7;max-width:420px;margin:0 0 16px;opacity:.85">${tip}</p>
  <p style="font-size:12px;opacity:.6;margin:0"><a href="/api/dshweb/login" style="color:#6fa8ff">返回登录页</a></p>
</body></html>`;
                    res.writeHead(401, { "Content-Type": "text/html; charset=utf-8" });
                    res.end(html);
                    return;
                }
                const session = this.store.createSession(remote, keep);
                // 热重载过渡：宿主进程若仍加载旧版 store.js，其 createSession 不写 expiresAt。
                // 网关是 3180 统一鉴权入口，这里补齐 24h 绝对过期并落盘（仅当旧 store 没写时），
                // 使「保持登录」的服务端过期校验在当前进程即刻生效；新版 store 自带该字段，
                // 此分支幂等跳过，DSH 重启后由 store.js 原生负责。
                if (keep) {
                    try {
                        const s = this.store.getSession(session);
                        if (s && !s.expiresAt) {
                            s.expiresAt = Date.now() + 24 * 60 * 60 * 1000;
                            this.store.persistSessions?.();
                        }
                    }
                    catch { }
                }
                // 注册 / 更新「已登录设备」（Bug2：手机登录后「远程设备」要能看到当前设备）
                this.registerDevice(req, session, remote);
                // 勾选保持登录：Cookie 与服务端会话同设 24h（Max-Age=86400 + Expires 兜底）。
                // 不勾选：维持无 Max-Age 的会话 Cookie，关浏览器即失效。
                const cookie = keep
                    ? `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`
                    : `${SESSION_COOKIE}=${session}; Path=/; HttpOnly; SameSite=Lax`;
                res.setHeader("Set-Cookie", cookie);
                res.writeHead(302, { Location: "/" });
                res.end();
            });
            return true;
        }
        return false;
    }
    looksLikeHtmlRequest(req) {
        const accept = String(req.headers.accept || "");
        if (accept.includes("text/html"))
            return true;
        const url = req.url || "";
        // DSH 单页应用根路径总是 HTML
        return url === "/" || url.startsWith("/?") || url.startsWith("/index");
    }
    /**
     * 30x Location 回环改写：把核心返回的 http(s)://127.0.0.1:30xx 改成
     * 「本次请求所用协议://<外部 Host><原路径>」。
     * 双监听（HTTP + HTTPS 共存）下必须按实际协议生成，不能写死 https，
     * 否则从 http://my-cloud.cn:3180 访问会被错误跳到 https。
     */
    rewriteRedirectLocation(location, originalHost, req) {
        if (!location || !originalHost)
            return location;
        try {
            const loopback = /^(?:https?):\/\/(?:127\.\d+\.\d+\.\d+|localhost|\[::1\]):30(?:[0-9]{2})(\/.*)?$/i;
            const m = location.match(loopback);
            if (m) {
                const proto = this.requestIsTls(req) ? "https" : "http";
                return `${proto}://${originalHost}${m[1] || ""}`;
            }
            return location;
        }
        catch {
            return location;
        }
    }
}
function injectHtmlTag(html, tag) {
    const m = html.match(/<html([^>]*)>/i);
    if (!m || m.index === undefined)
        return html;
    const before = html.slice(0, m.index);
    const old = m[0];
    const attrs = m[1] || "";
    const merged = attrs.includes("data-remote")
        ? attrs.replace(/data-remote=["'][^"']*["']/i, tag.trim())
        : attrs + tag;
    return `${before}<html${merged}>${html.slice(m.index + old.length)}`;
}
/**
 * PWA 安装所需静态资源（manifest / 各尺寸图标 / favicon）。
 * 未登录时也要能取到，否则「安装为应用」拿不到图标会退化成通用图标。
 */
export function isPwaAsset(url) {
    const pathname = (url.split("?")[0] || "").toLowerCase();
    if (pathname === "/manifest.webmanifest" || pathname === "/manifest.json")
        return true;
    return /^\/(icon-[a-z0-9._-]+\.(png|svg|ico|webp)|favicon[a-z0-9._-]*\.(png|svg|ico)|apple-touch-icon[a-z0-9._-]*\.png)$/.test(pathname);
}
/**
 * 本插件随包携带的 PWA 图标与 favicon。
 *
 * 品牌口径（2026-11-14 用户最终确认）：「PWA 程序图标不要带边框，中间鲸鱼就行」。
 * PWA 桌面图标与浏览器标签页 favicon 一律只保留 **DSH 官方鲸鱼本体**，不要边框、
 * 圆角底瓦片、描边环或阴影；插件列表图标与设置侧栏图标仍用插件自绘的地球线稿
 * （那是「远程连接」的语义符号，不与产品标识混用）。
 *
 * 历史背景：曾一度把 PWA 图标 / favicon 全换成插件自绘的「大地球」品牌图形，
 * 用户明确指出「PWA 桌面的图标还是要用桌面版的 DSH 图标」→ PWA 图标改用 DSH
 * 官方鲸鱼；随后追加「浏览器标签页的小图标也统一成鲸鱼」→ favicon.svg /
 * favicon-dark.svg 换成核心下发的官方鲸鱼 SVG 本体。2026-11-14 再定稿：去掉圆角
 * 瓦片与边框，只留鲸鱼。
 *
 * 当前实现：scripts/gen-pwa-icons.mjs 从 favicon.svg 的官方鲸鱼 path 直接生成
 * 全部位图（纯 Node、零第三方依赖）——透明底鲸鱼 icon-192/512.png 与 favicon.ico，
 * 纯白底鲸鱼 apple-touch-icon.png / icon-maskable-512.png（白底供 iOS / maskable
 * 裁切，不是瓦片边框）。favicon.svg / favicon-dark.svg 仍为官方鲸鱼 SVG 本体，
 * 由宿主 <link rel="icon" media="(prefers-color-scheme: light|dark)"> 自动切换，
 * 深色描边版配浅色标签栏、白色描边版配深色标签栏，两者只差 path 的 fill。
 *
 * 构建时 assets/pwa-icons 复制到 lib/pwa-icons，这里按需读入并缓存。
 */
const LOCAL_PWA_ICONS = {
    "/icon-192.png": "icon-192.png",
    "/icon-512.png": "icon-512.png",
    "/icon-maskable-512.png": "icon-maskable-512.png",
    "/apple-touch-icon.png": "apple-touch-icon.png",
    "/favicon.svg": "favicon.svg",
    "/favicon-dark.svg": "favicon-dark.svg",
    "/favicon.ico": "favicon.ico",
};
const pwaIconCache = new Map();
/**
 * 图标内容版本号（短 hash）。
 *
 * 为什么必须版本化：PWA / 「添加到主屏幕」的图标按 **URL** 缓存，且安装器
 * 会长期复用（Chrome 按 origin 存 manifest 图标、iOS 按 apple-touch-icon URL）。
 * 早期版本的图标是插件自绘「地球」，后来换成 DSH 官方鲸鱼，但 URL 一直是
 * `/icon-192.png` —— 域名端（还叠了 Cloudflare 缓存）沿用旧图，局域网端是新
 * 装的所以是鲸鱼，于是同一插件两种图标。把内容 hash 拼进 URL 即可强制换键。
 */
let pwaVersionCache = "";
export function pwaIconVersion() {
    if (pwaVersionCache)
        return pwaVersionCache;
    try {
        const h = createHash("sha256");
        for (const p of [
            "/icon-192.png",
            "/icon-512.png",
            "/icon-maskable-512.png",
            "/apple-touch-icon.png",
            "/favicon.ico",
        ]) {
            const b = readPwaIcon(p);
            if (b)
                h.update(b);
        }
        pwaVersionCache = h.digest("hex").slice(0, 10);
    }
    catch {
        pwaVersionCache = "1";
    }
    return pwaVersionCache;
}
/**
 * 把核心下发的 manifest 图标 URL 改写为「带内容版本号」的形式。
 *
 * 核心 manifest 里写的是 `"src": "icon-192.png"` 这类相对路径，浏览器会按
 * 页面 URL 解析成 `/icon-192.png` 并**长期按 URL 缓存图标**。旧版图标曾是插件
 * 自绘「地球」，换成鲸鱼后 URL 不变 → 已装过的主屏/桌面快捷方式仍是地球。
 * 追加 `?v=<内容hash>` 换掉缓存键，新安装必取当前鲸鱼图标。
 *
 * 只在网关自持的 manifest 响应里改（核心本身不动），因此桌面直连零影响。
 */
export function versionManifestIcons(manifestText) {
    const v = pwaIconVersion();
    let out = String(manifestText);
    try {
        const parsed = JSON.parse(out);
        if (parsed && Array.isArray(parsed.icons)) {
            for (const icon of parsed.icons) {
                if (!icon || typeof icon.src !== "string" || !icon.src)
                    continue;
                if (/[?&]v=/.test(icon.src))
                    continue;
                const base = icon.src.split("?")[0].split("#")[0];
                icon.src = `${base}?v=${v}`;
            }
            // start_url / scope 保持相对 "./"，与核心一致（反代下自动跟随当前 origin）
            return JSON.stringify(parsed, null, 2);
        }
    }
    catch {
        // 非 JSON（极少见）：退化为正则给 icons 里的 src 补版本号
        out = out.replace(/("src"\s*:\s*")([^"?]+)(")/g, `$1$2?v=${v}$3`);
    }
    return out;
}
/**
 * 往 HTML head 注入带版本号的 PNG 图标链接。
 *
 * 为什么需要：核心 head 只声明了 SVG favicon（`favicon.svg` / `favicon-dark.svg`），
 * 没有任何 PNG 图标链接。部分浏览器（尤其「创建快捷方式」而非完整 PWA 安装时）
 * 与部分启动器只认 PNG/ICO，拿不到就退化成默认「地球」图标。这里补上
 * 192/512 PNG + apple-touch-icon + favicon.ico，全部带内容版本号，且幂等。
 */
export function injectPwaIconLinks(html) {
    const v = pwaIconVersion();
    const marker = 'data-dshweb-pwa-icons="1"';
    if (String(html).includes(marker))
        return html;
    const links = [
        `<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png?v=${v}" ${marker} />`,
        `<link rel="icon" type="image/png" sizes="512x512" href="/icon-512.png?v=${v}" />`,
        `<link rel="icon" type="image/x-icon" href="/favicon.ico?v=${v}" />`,
        `<link rel="apple-touch-icon" sizes="180x180" href="/apple-touch-icon.png?v=${v}" />`,
    ].join("");
    const at = String(html).toLowerCase().indexOf("</head>");
    if (at < 0)
        return html + links;
    return html.slice(0, at) + links + html.slice(at);
}
/**
 * 远程会话「重新连接中」韧性加固（仅注入经网关的 HTML / data-remote 页面）。
 *
 * 实测结论（2026-11-13，真机 Edge CDP + Cloudflare 端到端）：x-forwarded-* 剥离
 * 修复上线后，https 域名与 http 局域网在干净浏览器里完全一致且健康 —— 101 WS
 * 升级、$events ready、100+ RPC、200s 空闲无掉线，101 个 JS bundle 字节级相同。
 * 故真机偶发的「进入主页面后一直重新连接中 / 无法载入对话」不是传输层 https
 * 差异，而是三类「会话 / 设备状态」问题，本函数逐一兜底：
 *
 *   1) Cloudflare 给 WS 握手额外 ~7s（实测 101 @7.6s vs 局域网 1.0s），而客户端
 *      默认 generationReadyTimeoutMs 只有 15s：慢蜂窝链路上 generation 在 ready
 *      前被取消 → 反复重连 → 永远「重新连接中」。此处放宽 ready 超时（Math.max
 *      只放宽不放窄，尊重宿主将来更高的设定）。
 *   2) 会话过期 / 被其它设备撤销：SPA 内 RPC 即便 401 也不会自动跳登录页，界面
 *      一直卡在连接中。定时探活 /api/dshweb/config，401 即回登录页。
 *   3) iOS standalone PWA 从后台恢复时 WebView 常被冻结/丢弃，WS 已死但 JS 没
 *      收到 close → 卡死；或旧 PWA 缓存了过期 immutable bundle。检测「可见的
 *      重连文案」持续 90s 仍不消失时做一次有上限的硬刷新，重建 WS 并吃最新 bundle。
 *
 * 只作用于 proxyHtmlRequest（带 data-remote）；本机桌面 GUI 直连核心不经网关、
 * 无 data-remote，零命中。全部逻辑 try/catch 包裹、幂等、随 server.js 热重载。
 */
export function injectRemoteResilience(html) {
    const marker = 'data-dshweb-conn-heal="1"';
    let src = String(html);
    if (src.includes(marker))
        return html;
    // (1) 直接改写核心下发的连接恢复配置：确定性、先于任何脚本执行，不受
    // classic/module 脚本时序影响。只放宽不收窄（尊重宿主将来更高的设定）。
    src = src.replace(/("generationReady(?:Warn|Timeout)Ms"\s*:\s*)(\d+)/g, (_m, k, v) => k + Math.max(Number(v), /Warn/.test(k) ? 20000 : 60000));
    // 核心未下发该配置时（未来版本 / 精简 HTML）补一段前置设定，避免回落 15s 默认。
    const hasCfg = src.includes("__DSH_CONNECTION_RECOVERY__");
    const fallback = hasCfg
        ? ""
        : "<script>globalThis.__DSH_CONNECTION_RECOVERY__={backoffBaseMs:500," +
            "backoffFactor:2,backoffMaxMs:10000,generationReadyWarnMs:20000," +
            "generationReadyTimeoutMs:60000};</script>";
    // (2) 会话 / 冻结看门狗（仍受 data-remote 运行时门控，桌面直连零命中）。
    // 内层脚本刻意不用反引号 / ${}，避免与外层模板字符串冲突；不出现 </script>。
    const watchdog = "try{if(!document.documentElement.hasAttribute('data-remote'))return;" +
        "var KEY='dshweb_conn_heal',RE=/重新连接中|连接中断|连接异常|正在重试|Reconnecting/i,stuck=0,hiddenAt=0;" +
        "function heal(){try{var s=sessionStorage,n=Number(s.getItem(KEY+'_n')||0),t=Number(s.getItem(KEY+'_ts')||0),now=Date.now();" +
        "if(now-t>120000)n=0;if(n>=1)return;s.setItem(KEY+'_n',String(n+1));s.setItem(KEY+'_ts',String(now));location.reload();}catch(e){}}" +
        "function probe(){try{fetch('/api/dshweb/session',{method:'GET',credentials:'same-origin',cache:'no-store'})" +
        ".then(function(r){if(r&&r.status===401){location.replace('/api/dshweb/login');return;}" +
        "var vis=false;try{var b=document.body;vis=!!b&&RE.test(b.innerText||'');}catch(e){}" +
        "stuck=vis?stuck+1:0;if(stuck>=3){stuck=0;heal();}}).catch(function(){});}catch(e){}}" +
        "probe();setInterval(probe,30000);" +
        "document.addEventListener('visibilitychange',function(){try{" +
        "if(document.hidden){hiddenAt=Date.now();return;}" +
        "var away=hiddenAt?Date.now()-hiddenAt:0;hiddenAt=0;if(away>300000)probe();" +
        "}catch(e){}});}catch(e){}";
    const script = fallback + "<script " + marker + ">(function(){" + watchdog + "})();</script>";
    const at = src.toLowerCase().indexOf("</head>");
    if (at < 0)
        return src + script;
    return src.slice(0, at) + script + src.slice(at);
}
/** 读取本地 PWA manifest；不存在则返回 null（回退到核心反代）。 */
export function readPwaManifest() {
    try {
        const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
        return readFileSync(path.join(dir, "pwa-manifest.json"), "utf8");
    }
    catch {
        return null;
    }
}
/** 读取本地 PWA 图标；不存在则返回 null（回退到核心反代）。 */
export function readPwaIcon(pathname) {
    const file = LOCAL_PWA_ICONS[pathname.toLowerCase()];
    if (!file)
        return null;
    const hit = pwaIconCache.get(file);
    if (hit)
        return hit;
    try {
        const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pwa-icons");
        const buf = readFileSync(path.join(dir, file));
        pwaIconCache.set(file, buf);
        return buf;
    }
    catch {
        return null;
    }
}
/**
 * 移动端定制 CSS。
 *
 * 为什么内联在 server.ts：/api/dshweb/reload 只击穿 server.js 的 ESM 缓存，
 * import 进来的 styles 模块仍是旧实例，改样式不重启不生效。
 *
 * 只覆盖三处真实痛点（对应需求 2/3/4）+ 一处 PWA 顶部/底部 Bug 修复，
 * 不改官方布局骨架：
 * 1. 输入卡圆角 28px → 14px（--dsw-radius-panel 是面板级圆角，手机屏太圆）；
 * 2. 输入区底部留白收紧为 max(8px, env(safe-area-inset-bottom))，
 *    去掉层层叠加的「固定 px + 安全区 × 系数」造成的底部大片空白；
 * 3. 控制行禁止换行 —— 官方 observeControlRow 一旦测到溢出会走 data-model-compact
 *    （隐藏模型名、只留图标）；flex-wrap:wrap 抢先换行反而把左侧按钮顶到上一行，
 *    把输入卡撑高；
 * 4. PWA standalone 顶部：根因是 injectMobileHead 曾注入
 *    apple-mobile-web-app-status-bar-style=black-translucent，iOS 会把状态栏
 *    毛玻璃画在网页内容「之上」，加 padding / 关 Safari 着色都挡不住（结论来自
 *    dsh-mobile-console 项目）。现改为 default，系统自己占住不透明状态栏、
 *    网页从它下方开始；#root 仅保留 env(...) 兜底，兼容旧图标缓存。
 * 5. iOS 26/27 standalone PWA 的「系统级」顶部 progressive blur（第 9 轮真因）：
 *    这条毛玻璃不是网页元素，而是 WebKit 在视口顶部叠加的 top-edge effect。
 *    用一个 background-clip:text 的隐形 position:fixed 哑元素骗过 WebKit 的
 *    「顶部是否有固定头部」判定，见下方 .dshweb-ios-blur-fix 长注释。
 * 6. 顶部净空微调（用户 m02443「将顶部上移 20px」）：--dshweb-top-shift
 *    从 #root 的 padding-top 里减掉，把整个顶栏往上挪。用 max(0px, calc(...))
 *    兜底，净空不足 20px 时最多减到 0，绝不会出现负 padding 把顶栏推进
 *    状态栏区域（那会重新导致「顶栏被盖 / 侧边栏开关不可触控」）。
 * 7. 顶部三个控件高度对齐（用户 m02509）：侧边栏顶部图标 / 侧边栏折叠按钮 /
 *    会话窗折叠按钮，三者中心落到同一水平线。见下方 long comment 的实测几何。
 */
export function buildMobileCss(fontScale) {
    const raw = Number(fontScale);
    const scale = Number.isFinite(raw) && raw > 0 ? Math.min(Math.max(raw / 100, 0.8), 1.6) : 1;
    return `
:root { --dshweb-font-scale: ${scale}; --dshweb-top-shift: 20px; }

/* ── 需求 4：全屏同色，去掉可见接缝 ───────────────────────────── */
/* 回退链必须跟着「首屏主题」走，不能写死白色。
   核心 boot-theme 会先把一条 body{background-color:#151517;--dsh-boot-bg:#151517}
   （深色）或 #fff（浅色）写进 <head>，而 --dsw-alias-bg-base 要等主题 CSS / React
   挂载后才定义。所以「首屏阶段」--dsw-alias-bg-base 是空的：
   这里若把回退写死 #fff（或在 html 上也写 #fff），深色 PWA 冷启动时整页与
   html 画布都会被强行刷白，而 #root 顶部的 padding-top 安全区正好把底色
   透出来 —— 屏幕上就是顶部一条白色「毛玻璃」盖（用户实测截图 IMG_2032.png：
   深色启动页上方白条 + 模糊过渡带，加载完成后自变量就绪才消失）。
   · html 一律透明：画布交给 body 的 background 传播（css 规范：html 无背景时
     body 背景上提为画布），这样「用户手动设了深色 / 系统是深色」两种情形都
     自动跟随，不用去猜 prefers-color-scheme 与 body 内联主题哪一个为准。
   · body 回退链：--dsw-alias-bg-base → --dsh-boot-bg（首屏主题给的底色）→ #fff。 */
html { background-color: transparent !important; }
body { background-color: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important; }
[data-remote="mobile"], [data-remote="mobile"] body { overflow-x: hidden; }
[data-remote="mobile"] body {
  background-color: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important;
  font-size: calc(14px * var(--dshweb-font-scale, 1));
  -webkit-tap-highlight-color: transparent;
}

/* ── 第 9 轮真因：iOS 26/27 standalone PWA 的系统级顶部 progressive blur ────
    前 8 轮全被打回，是因为这条毛玻璃根本不是网页元素：真机探针 14 次上报
    证明页面内 0 backdrop-filter / 0 半透明覆盖 / env(safe-area-inset-top) 恒 0px，
    改 padding、改 theme-color、改 status-bar-style、清滤镜、锁不透明底色全都无效。
    权威来源（用户 m02227 给出的 DeepSeek 分享答案指向）：
      · Qiita「iOS 27 PWAで画面上端に表示されるブラーを消す方法」
        https://qiita.com/na-trium-144/items/0add98a80ca2391e3f17 （2026-09-20）
      · Glide 社区 https://community.glideapps.com/t/ios-27-ipados-27-blur-obscuring-top-navigation-in-glide-classic-apps/87792
    WebKit 会检查「视口顶部是否存在一定高度的 position:fixed 元素」；判定为
    「内容潜入状态栏背后的滚动区域」时就强制叠加 top-edge progressive blur。
    判定基于 CSS 样式声明、不基于实际渲染像素 —— 这正是探针抓不到它、而
    「侧边栏（body 直属 portal，在 #root 之外）干净 / 对话页被盖」的原因。
    解法：放一个 height:11px（WebKit 阈值 >10px）的 position:fixed 哑元素，
    用 background-clip:text 把背景裁到「空文本」上 —— 浏览器 0 像素绘制
    （视觉全透明、pointer-events:none 不挡点击），但 CSS 上仍是「有背景色 +
    有尺寸 + fixed」的合法元素，骗过 WebKit 判定，blur 随之消失。
    · 绝不能用 opacity:0 / visibility:hidden / display:none，会被判定排除、
      blur 复活（Qiita 明确警告）；只有 background-clip:text 有效。
    · background-color 走同一条主题回退链：该色会被 iOS 拿去涂状态栏区域，
      顺带解决 m02223「状态栏灰 vs 页面白不一致」。
    · 不套 @media (display-mode: standalone)：元素本就不可见，恒存在可保证
      「刚进入时」首帧判定一定命中（用户实测点按钮后 blur 才消失），避免
      冷启动时媒体查询尚未匹配的竞态。仅 [data-remote="mobile"] 命中，桌面零影响。
    · 哑元素由 injectMobileHead 直接写进 <body> 开头（HTML 源码级，不是 JS
      后插），保证 WebKit 首次布局/绘制前就存在。 */
[data-remote="mobile"] .dshweb-ios-blur-fix {
  position: fixed !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  width: 100% !important;
  height: 11px !important;
  z-index: 2147483647 !important;
  pointer-events: none !important;
  background-color: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important;
  -webkit-background-clip: text !important;
  background-clip: text !important;
}

/* ── Bug 修复：PWA standalone 顶部不再被系统状态栏毛玻璃遮盖 ──────
   真正的根因不是 padding 不够，而是 injectMobileHead 之前注入的
   apple-mobile-web-app-status-bar-style=black-translucent：iOS 会把状态栏
   的毛玻璃画在网页内容「之上」，加多少 padding、关 Safari「允许延伸网站
   颜色」都挡不住；而且部分外壳把 env(safe-area-inset-top) 报成 0。
   （结论来自 dsh-mobile-console 项目 web/index.html 注释 + README 档 7。）
   现改为 default：系统自己占住那条不透明状态栏，网页从它下方开始，
   inset-top 恒为 0，顶栏 / 侧边栏开关自然完整可见、可触控。
   这里仍给 #root 留 env(safe-area-inset-top) 兜底，兼容「主屏图标还缓存
   旧 black-translucent」与 Android edge-to-edge 外壳：它们 inset-top>0 时
   把整条布局下移，=0 时零影响。
   · box-sizing:border-box 必须同时设置：核心 #root 默认 content-box，
     直接加 padding 会叠加到 height:100% 上把底部输入卡挤出可视区。
   · 仅 [data-remote="mobile"] 命中，桌面直连不经网关永不应用。 */
[data-remote="mobile"] #root {
  /* 顶部上移 20px（用户 m02443）：从顶部安全区净空里减掉 --dshweb-top-shift。
     max(0px, …) 兜底：净空不足 20px 时最多减到 0，绝不出现负 padding 把顶栏
     推进状态栏区域（会重新导致「顶栏被盖 / 侧边栏开关不可触控」）。
     box-sizing:border-box + height:100% 下，padding 减少 20px = 内容盒变高 20px，
     顶栏上移 20px、消息区多 20px，吸底 composer 位置不变。 */
  padding-top: max(0px, calc(env(safe-area-inset-top, 0px) - var(--dshweb-top-shift, 0px))) !important;
  box-sizing: border-box !important;
  /* padding 让出来的那条带子是透明的，会直接透出 html/body 底色。
     首屏阶段若那里是白色，就会出现「顶部一条白色毛玻璃盖」（IMG_2032.png）。
     这里给 #root 自己也上同一条回退链，双保险：即使 body 的规则被别处覆盖，
     这条带子也跟着首屏主题走。 */
  background-color: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important;
}
/* ── 残留遮盖（第三轮修复）：iOS 独立模式下再补一点不依赖精确值的净空 ──
   现象：meta 改成 default 后从「完全被盖」变成「还有一部分被盖」，说明系统
   报的 env(safe-area-inset-top) 比真实玻璃条矮（常见差 8~12px），#root 按它
   下移后顶栏顶部仍有一条压在玻璃下，导致侧边栏开关那一行摸不到。
   做法：只在「iOS 内核 + 独立模式」里，在系统报的值之上再加一点净空。
   · @supports (-webkit-touch-callout: none) 只有 iOS WebKit 为真，Android /
     Windows 全部不命中，不会凭空多出空白；
   · @media (display-mode: standalone/minimal-ui/fullscreen) 保证 Safari 内
     普通浏览（有地址栏，系统已让位）不受影响；
   · --dshweb-ios-top-extra 是唯一可调数字：还露一点就加到 14/16px，出现
     多余空白就减到 0。
   calc 里 env 仍带 0 回退，旧外壳/无安全区时就是这一个值。 */
@media (display-mode: standalone), (display-mode: minimal-ui), (display-mode: fullscreen) {
  @supports (-webkit-touch-callout: none) {
    [data-remote="mobile"] #root {
      /* 与基础规则一致：顶部上移也必须在 iOS 独立模式生效，否则会被这条
         更高优先级的规则覆盖回原值。max(0px, …) 保证净空不会被减成负数。 */
      padding-top: max(0px, calc(env(safe-area-inset-top, 0px) + var(--dshweb-ios-top-extra, 10px) - var(--dshweb-top-shift, 0px))) !important;
    }
  }
}
/* 标题栏下边框 + 标题横向淡出遮罩：在深色背景上会形成一条"渐变遮盖层" */
[data-remote="mobile"] .an3WzG_header {
  border-bottom: none !important;
  /* 参考项目 dsh-mobile-console 的最终定案（web/style.css 档 3/最后一档）：
     顶栏必须「不透明 + 完全无 blur」——"a blur here smears the messages
     scrolling underneath and is exactly what looked covered"。这里显式把
     对话视图与顶栏的底色/滤镜锁死：即便某个皮肤在运行期给 #root / shell
     挂了 backdrop-filter 或 filter（侧边栏 CSS 注释明确警告过这种 glass skin
     会把 backdrop-filter/filter/transform 放到 shell wrapper 或 body 上），
     对话页也不会再被那层玻璃糊住。侧边栏是 body 直属 portal、在 #root 之外，
     本来就不受这些层影响 —— 这正是「侧边栏干净 / 对话被盖」的不对称来源。
     只清 filter/backdrop-filter 与固定不透明底色，不动 transform / 布局 px，
     所以不会引入新的空白或破坏吸底 sticky 不变量（低风险、可随时回退）。 */
  background-color: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  filter: none !important;
}
[data-remote="mobile"] .an3WzG_root {
  background-color: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important;
  backdrop-filter: none !important;
  -webkit-backdrop-filter: none !important;
  filter: none !important;
}
[data-remote="mobile"] .an3WzG_titleCluster {
  mask-image: none !important;
  -webkit-mask-image: none !important;
}
/* 输入区吸底遮罩本身是 36px 渐变，屏幕小时看着像底部压了一层雾。
   回退色同顶部：首屏阶段 --dsw-alias-bg-base 还没定义，回退写死 #fff
   会让深色 PWA 冷启动时底部也闪一条白，故走同一条 --dsh-boot-bg 回退链。 */
[data-remote="mobile"] .an3WzG_composerSeat {
  background: var(--dsw-alias-bg-base, var(--dsh-boot-bg, #fff)) !important;
}

/* ── 需求 2：输入卡圆角改小 ───────────────────────────────────── */
[data-remote="mobile"] .GRgSLq_card {
  border-radius: 14px !important;
}
[data-remote="mobile"] .GRgSLq_card .GRgSLq_input,
[data-remote="mobile"] .GRgSLq_add,
[data-remote="mobile"] .GRgSLq_primary { border-radius: 10px !important; }
[data-remote="mobile"] .GRgSLq_primary { border-radius: 999px !important; }

/* ── 需求 2：输入区与屏幕底边的距离（底部大片空白 Bug 修复）─────
   之前的写法层层叠加：「固定 6px + 全量 inset」（浏览器）与
   standalone 里「固定 4px + inset×0.5」两套互相覆盖，再加上
   viewport-fit=cover 下 black-translucent 把 env(inset-bottom) 撑到
   ≈34px，结果底边堆出一大片空白（用户反馈「底部空白区域还是太大」）。
   照 dsh-mobile-console 档 7 的最终结论收敛成「一条规则」：
   padding-bottom: max(8px, env(safe-area-inset-bottom, 0px))。
   · normal / default 状态栏生效后 inset-bottom≈0 → 8px，输入卡紧贴底边；
   · 旧图标仍缓存 black-translucent 时 inset-bottom≈34px → 34px，
     恰好让出 home indicator，不多不少，不再额外叠加固定像素。
   同时把 dock（Token/上下文信息栏）的额外行高归零，避免再叠一层。 */
[data-remote="mobile"] .GRgSLq_root {
  padding-bottom: max(8px, env(safe-area-inset-bottom, 0px)) !important;
}
/* 用户要求（m03228/m03245）：输入框 + 上方按钮排 + Token 栏三者整体下移。
   官方 sticky 吸底布局的「seat 占位=composer 视觉位置」不变量决定：root 相对平移
   会让贴底时消息流末尾与输入卡错位 10px。正解是给 composerSeat 占位加 margin-top
   —— 占位、composer 视觉、消息流滚动范围三者同步 +10px（CDP 实测 card 699→706），
   贴合语义与官方一致。 */
[data-remote="mobile"] .an3WzG_composerSeat {
  margin-top: 10px !important;
}

/* 用户要求（m03342）：输入卡上方的按钮排（消息操作/工具状态行）距输入卡太远。
   CDP 实测真正带 padding-bottom:16px 的是消息流子元素 .V4vHZW_scroll
   （不是 .V4vHZW_root —— 只写 root 会打空）。归零后消息流末尾按钮到 seat 顶
   只剩 seat margin-top 的 10px，与卡→Token 栏、任务条→卡三段等距。 */
[data-remote="mobile"] .V4vHZW_root,
[data-remote="mobile"] .V4vHZW_scroll {
  padding-bottom: 0px !important;
}
/* 用户要求（m03398）：输入卡到「上方按钮」与到「下方 Token 栏」的间距调成一致。
   CDP 实测（390x844 贴底态）：卡 706–804、Token 栏(dock) 814–836 → 下方 10px
   （dock margin-top:10px）；紧贴卡的上一行是 composer 内任务/状态条按钮
   .DXuOLW_root（660–696），由 .an3WzG_composerStack 的 row-gap:6px 撑开 → 上方 6px。
   6≠10 即「不一致」。把 stack row-gap 统一为 10px，上下都 = 10px；
   seat 占位高度 +4px（180→184）由 ResizeObserver 写回 --dsh-composer-height，
   card/dock 的吸底绝对位置不变（CDP 双会话态验证 10/10）。 */
[data-remote="mobile"] .an3WzG_composerStack {
  row-gap: 10px !important;
}
/* dock = ContextMeter 那一行（Token/上下文信息栏）。margin-top 2px → 7px → 10px：
   用户先要求「下移 5px」「再下移 10px」（m01968/m03137），后明确
   「token 栏与输入卡间距调整为 10px」（m03245）——间距即 card 与 dock
   之间的空隙，定为 10px。margin-top 是它唯一的落点，不挤压输入卡。 */
[data-remote="mobile"] .GRgSLq_dock {
  padding-top: 0 !important;
  padding-bottom: 0 !important;
  min-height: 0 !important;
  margin-top: 10px !important;
}

/* ── 需求 3：控制行不换行，交给官方 compact 逻辑 ───────────────── */
[data-remote="mobile"] .GRgSLq_row {
  flex-wrap: nowrap !important;
  gap: 8px !important;
}
[data-remote="mobile"] .GRgSLq_tools,
[data-remote="mobile"] .GRgSLq_trailing {
  flex: none !important;
  gap: 8px !important;
}
[data-remote="mobile"] .GRgSLq_standardControls {
  min-width: 0 !important;
  overflow: hidden !important;
  gap: 6px !important;
}
/* 模型名过长时只留图标（等价于官方 data-model-compact 的观感） */
@media (max-width: 430px) {
  [data-remote="mobile"] .GRgSLq_row {
    --dsh-composer-model-text-display: none;
    --dsh-composer-model-icon-display: block;
  }
}
[data-remote="mobile"] ._9r0rkG_trigger { max-width: 42vw !important; }

/* ── PWA 桌面图标（standalone）全屏模式 ─────────────────────── */
/* 不再为 standalone 加任何「硬编码状态栏净空」：dsh-mobile-console 的
   README 档 8.0~8.3 反复验证过，写死 44/49/50px 只在一种 iOS 模式下成立
   （主屏图标缓存 black-translucent 时页面从时钟下开始，硬编码不够→被盖；
    default 生效后页面已在时钟下，硬编码又太多→「又太靠下」）。
   真正的解是 meta 改 default（系统保留不透明状态栏），配合上面 #root 的
   env(safe-area-inset-top) 兜底与 .GRgSLq_root 的单条 max(8px, inset-bottom)，
   两种模式下都对，无需媒体查询里再猜数字。 */

/* ── 反馈 #2：侧栏底部账号头像位置微调 ─────────────────────────────
   官方 .wtg9ga_root{padding:6px 8px} 完全没有 safe-area 处理（桌面窗口
   无圆弧无所谓）。用户两轮实测累计微调：先右移5/下移10，再右移5/下移10
   （m02847、m03126）→ 累计右移 10px、下移 20px。
   padding-left 12→22px；底部净空 16px → 6px → 0px：padding-bottom 归 0、
   footArea margin-bottom 改 -4px（合计净空 0，相对上轮再下移 10px，
   头像回到官方默认贴合程度，仅保留安全区叠加）。 */
[data-remote="mobile"] .wtg9ga_root {
  padding-left: 22px !important;
  padding-right: 12px !important;
  padding-bottom: env(safe-area-inset-bottom, 0px) !important;
}
/* 头像行用 -4px 负外边距把净空压到 0（再下移 10px） */
[data-remote="mobile"] .wtg9ga_footArea {
  margin-bottom: -4px !important;
}

/* ── 反馈 #4：顶部三个控件高度对齐（用户 m02509）────────────────────
   真机探针（~/.dsh/dshweb-top-probe.jsonl，iPhone 402/390 宽，
   140 次上报）实测几何，三者原本不在同一水平线：
   · 会话窗折叠按钮 = frame 的 shell.leading 座位里的 [data-sidebar-opener]
     （HeaderLeadingControls → .hc2fJa_iconButton，28×28）。核心规则
     .mP3x-q_frame[data-sidebar-drawer] .mP3x-q_leadingSeat{top:11px;left:12px}
     → 按钮 y=11..39、中心 25px。同行的 .an3WzG_titleRow[20,10,354,31] 与
     .an3WzG_headerUtilities[191,11,151,28] 也以 25px 为中心 —— 25px 是会话窗
     整行控件的基准线，不能动它（动了就和标题错位）。
   · 侧边栏顶部图标（.wtg9ga_brandMark 里的 FishLogo，24px）与侧边栏折叠按钮
     （.wtg9ga_toggle = [data-sidebar-toggle]，28px）同在 .wtg9ga_logoRow：
     官方 .wtg9ga_root{padding-top:6px} + .wtg9ga_logoRow{height:60px}
     → 行 y=6..66、中心 36px（探针实测 .wtg9ga_logoRow[22,6,246,60]、
     .wtg9ga_brandName[59,24,156,24] 亦印证中心 36px）。
   两者相差 11px：抽屉滑入时侧栏这一行比会话窗按钮低一截，看着没对齐。
   做法：用一个变量 --dshweb-top-control-center 把三者钉在同一水平线：
   · 会话窗按钮显式按「中心 - 半高(14px)」定位（当前等价于核心的 11px，
     不改动观感，只是把基准显式化、可调）；
   · 侧栏 logoRow 用负 margin 整体上移 (36px - 中心)，后续 newSession /
     面板列表同步上移，行与行之间不会撕出空隙。
   仅 [data-remote="mobile"] 命中；要整体上下微调只改这一个变量即可。 */
[data-remote="mobile"] {
  --dshweb-top-control-center: 25px;
}
[data-remote="mobile"] .mP3x-q_frame[data-sidebar-drawer] .mP3x-q_leadingSeat {
  top: calc(var(--dshweb-top-control-center, 25px) - 14px) !important;
}
[data-remote="mobile"] .wtg9ga_logoRow {
  margin-top: calc(var(--dshweb-top-control-center, 25px) - 36px) !important;
}

/* ── 反馈 #3：账号弹窗（头像点开的菜单）在手机上太小 ──────────────
   primitives Menu surface = ._surface_1w4el_1（portal 到 body），列表 =
   ._list_1p5el_7{min-width:min(144px,…)}，菜单项 ._item_1p5el_105
   {min-height:34px;font-size:13px} —— 桌面鼠标尺寸，手机触控太小。
   手机端统一放大：宽 ≥250px（仍留 24px 屏幕边距），行高 ≥44px 达到
   iOS 触控目标标准，字号 14px。影响所有 primitives 弹出菜单
   （账号菜单 / 右键菜单），对触屏都是改善。 */
[data-remote="mobile"] ._surface_1w4el_1._list_1p5el_7 {
  min-width: 250px !important;
  max-width: min(360px, calc(100vw - 24px)) !important;
}
[data-remote="mobile"] ._item_1p5el_105 {
  min-height: 44px !important;
  font-size: 14px !important;
  line-height: 20px !important;
  padding-top: 8px !important;
  padding-bottom: 8px !important;
}
[data-remote="mobile"] ._item_1p5el_105 ._itemIcon_1p5el_105,
[data-remote="mobile"] ._item_1p5el_105 [aria-hidden] svg {
  width: 18px !important;
  height: 18px !important;
}
`;
}
/**
 * 读取核心写进 <head> 的「首屏主题」（boot-theme）。
 *
 * 核心在返回 HTML 时已经把一条 <style> 放在 head 最前面，内容形如：
 *   - 用户手动选了深色： `:root{color-scheme:dark}body{background-color:#151517;--dsh-boot-bg:#151517}`
 *   - 用户手动选了浅色： `:root{color-scheme:light}body{background-color:#fff;--dsh-boot-bg:#fff}`
 *   - 跟随系统：        light 段 + `@media(prefers-color-scheme:dark){...}`
 * 这是唯一「页面首屏到底会用哪个底色」的权威来源（主题偏好存在 Host 配置里，
 * 网关侧拿不到，也不能靠 localStorage 猜）。
 */
export function parseBootTheme(html) {
    const style = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
    const css = style ? style[1] : "";
    // 跟随系统：同一份 CSS 里带 prefers-color-scheme 媒体查询 → 保留两条 media meta。
    if (/@media[^{]*prefers-color-scheme/i.test(css)) {
        return { preference: null, background: "#151517" };
    }
    const dark = /color-scheme:\s*dark/i.test(css);
    const bg = css.match(/--dsh-boot-bg:\s*([^;}\s]+)/i);
    const fallback = dark ? "#151517" : "#ffffff";
    return { preference: dark ? "dark" : "light", background: (bg ? bg[1] : fallback).trim() };
}
/**
 * 一次性运行时诊断探针（移动端 PWA 顶部「毛玻璃遮盖」定位用）。
 *
 * 前几轮把页面里所有 CSS Modules、静态 CSS、插件皮肤都扫了一遍，确认
 * 不存在「常驻在对话视图顶部」的 backdrop-filter 层；但真机上仍残留一条
 * 遮盖，且「侧边栏顶部干净 / 对话界面顶部被盖」的不对称无法从静态代码
 * 判定真凶（候选：iOS 系统状态栏玻璃层 / 缓存的 black-translucent 图标 /
 * 抽屉遮罩 / 皮肤把 --dsw-alias-bg-base 改成半透明）。继续盲改 px、颜色
 * 已经被打回五次，这一轮改为拿真机实测数据：
 *
 *   · 沿顶部 y=2..120、x=左/中/右采样 elementFromPoint 元素链，逐层记录
 *     computed backdrop-filter / filter / background / mask / position / z-index；
 *   · 枚举与顶部 150px 相交且带模糊/滤镜/遮罩/半透明底的可疑元素；
 *   · 记录 env(safe-area-inset-*) 的「真值」、display-mode、navigator.standalone、
 *     visualViewport 几何、UA、#root / 顶栏 / 抽屉遮罩的计算样式；
 *   · 在 load / 500ms / 1800ms / 4000ms、首次 pointerdown 后 350ms / 1000ms
 *     （抓侧边栏打开态）、visibilitychange 时上报到 /api/dshweb/top-probe。
 *
 * 网关把上报追加到 ~/.dsh/dshweb-top-probe.jsonl；拿到日志后再做定点修复。
 * 整个脚本 try/catch 包裹、sessionStorage 单次门控、上报上限 9 次，
 * 任何异常都不影响页面渲染与交互。仅移动端 HTML 注入，桌面零影响。
 * 注意：脚本内部刻意不用反引号 / ${} / 正则 / 反斜杠，避免破坏本模板字符串。
 */
export function buildMobileProbe() {
    const js = `(function(){
  try {
    var KEY = 'dshweb-top-probe-v1';
    try { if (sessionStorage.getItem(KEY)) return; } catch (e) {}
    try { sessionStorage.setItem(KEY, '1'); } catch (e) {}
    var sent = 0, MAX = 9, W = window.innerWidth;
    function px(v) { return Math.round(parseFloat(v) || 0); }
    function desc(el) {
      if (!el || !el.getBoundingClientRect) return null;
      var s = getComputedStyle(el), r = el.getBoundingClientRect();
      return {
        tag: el.tagName, id: el.id || '',
        cls: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
        bd: s.backdropFilter || s.webkitBackdropFilter || '',
        fl: s.filter || '', bg: s.backgroundColor || '',
        bgi: (s.backgroundImage === 'none' ? '' : s.backgroundImage).slice(0, 90),
        op: s.opacity, pos: s.position, z: s.zIndex, pe: s.pointerEvents,
        mask: (s.maskImage || s.webkitMaskImage || '').slice(0, 80),
        r: [px(r.x), px(r.y), px(r.width), px(r.height)]
      };
    }
    function chain(el) {
      var out = [], n = el, i = 0;
      while (n && i < 5) { out.push(desc(n)); n = n.parentElement; i++; }
      return out;
    }
    function env() {
      var d = document.createElement('div');
      d.style.cssText = 'position:fixed;top:-9999px;left:0;height:0;width:0;padding-top:env(safe-area-inset-top,0px);padding-bottom:env(safe-area-inset-bottom,0px);padding-left:env(safe-area-inset-left,0px);padding-right:env(safe-area-inset-right,0px)';
      document.body.appendChild(d);
      var s = getComputedStyle(d);
      var o = { top: s.paddingTop, bottom: s.paddingBottom, left: s.paddingLeft, right: s.paddingRight };
      d.remove();
      return o;
    }
    function keyStyles() {
      var sels = ['html', 'body', '#root', '.an3WzG_root', '.an3WzG_header', '.an3WzG_headerLeading', '.mP3x-q_drawerMask', '.an3WzG_composerSeat'];
      var o = {};
      for (var i = 0; i < sels.length; i++) {
        var el = document.querySelector(sels[i]);
        o[sels[i]] = el ? desc(el) : null;
      }
      o['_drawer'] = !!document.querySelector('[data-sidebar-drawer]');
      o['_collapsed'] = !!document.querySelector('[data-sidebar-collapsed]');
      return o;
    }
    function suspects() {
      var out = [], all = document.querySelectorAll('*');
      for (var i = 0; i < all.length && out.length < 40; i++) {
        var el = all[i], r;
        try { r = el.getBoundingClientRect(); } catch (e) { continue; }
        if (r.bottom < 0 || r.top > 150 || r.width <= 0 || r.height <= 0) continue;
        var d = desc(el), glassy = false;
        if (d.bd && d.bd !== 'none') glassy = true;
        if (d.fl && d.fl !== 'none') glassy = true;
        if (d.mask && d.mask !== 'none') glassy = true;
        if (d.bg && d.bg.indexOf('rgba') === 0) glassy = true;
        if (d.bgi) glassy = true;
        if (glassy) out.push(d);
      }
      return out;
    }
    function topSamples() {
      var ys = [2, 8, 16, 24, 32, 44, 56, 72, 96, 120], xs = [8, Math.round(W / 2), W - 8], out = [];
      for (var i = 0; i < ys.length; i++) {
        for (var j = 0; j < xs.length; j++) {
          out.push({ x: xs[j], y: ys[i], chain: chain(document.elementFromPoint(xs[j], ys[i])) });
        }
      }
      return out;
    }
    function meta() {
      var vv = window.visualViewport || {};
      var mm = window.matchMedia || function () { return { matches: false }; };
      return {
        ua: navigator.userAgent, standalone: !!navigator.standalone,
        modeStandalone: !!mm('(display-mode: standalone)').matches,
        modeMinimal: !!mm('(display-mode: minimal-ui)').matches,
        modeBrowser: !!mm('(display-mode: browser)').matches,
        dark: !!mm('(prefers-color-scheme: dark)').matches,
        iw: window.innerWidth, ih: window.innerHeight, dpr: window.devicePixelRatio,
        vv: { w: Math.round(vv.width || 0), h: Math.round(vv.height || 0), ot: Math.round(vv.offsetTop || 0), ol: Math.round(vv.offsetLeft || 0), scale: vv.scale || 0 },
        env: env(), scrollY: window.scrollY
      };
    }
    function report(trigger) {
      if (sent >= MAX) return;
      sent++;
      try {
        var payload = { trigger: trigger, t: Date.now(), meta: meta(), key: keyStyles(), suspects: suspects(), top: topSamples() };
        fetch('/api/dshweb/top-probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), keepalive: true });
      } catch (e) {}
    }
    function schedule() {
      report('load');
      setTimeout(function () { report('t500'); }, 500);
      setTimeout(function () { report('t1800'); }, 1800);
      setTimeout(function () { report('t4000'); }, 4000);
    }
    if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(schedule, 0);
    else document.addEventListener('DOMContentLoaded', schedule);
    var tapped = false;
    document.addEventListener('pointerdown', function () {
      if (tapped) return; tapped = true;
      setTimeout(function () { report('tap350'); }, 350);
      setTimeout(function () { report('tap1000'); }, 1000);
    }, true);
    document.addEventListener('visibilitychange', function () { if (!document.hidden) report('visible'); });
  } catch (e) {}
})()`;
    return `<script id="dshweb-top-probe">${js}</script>`;
}
/**
 * iOS 状态栏同色脚本（真机探针 + IMG_2047/2048 定性后的定点修复）。
 *
 * 真机实证（dshweb-top-probe.jsonl 14 次上报）：页面内 0 blur / 0 backdrop-filter /
 * 0 半透明覆盖层；header 纯白、env(safe-area-inset-top) 全程 0px。用户看到的
 * 「进入时顶部灰带 / 毛玻璃，点按钮后消失，状态栏灰 vs 页面白」不是 DOM 元素，
 * 而是 iOS 在 status-bar-style=default 下用 theme-color 给系统状态栏条上色时，
 * head 里同时存在多条 theme-color（我们注入的 1-2 条 + 核心 ThemePresenter
 * 运行期追加的第三条 getComputedStyle(body).backgroundColor），取值在
 * boot → React 挂载之间来回跳变造成的颜色错配。
 *
 * 修法：任何时刻只保留一条不带 media 的 theme-color，且它的值恒等于
 * 当前 body 的实际底色（rgba→#rrggbb 归一）。
 * - MutationObserver 监听 head 的子节点增删与 meta content 属性变化，
 *   ThemePresenter 一写入第三条就立即归一；
 * - body 挂载前（脚本在 </head> 前、body 还不存在）computed 取不到有效色，
 *   就保留原有 meta 不动，等 load / 轮询窗口再同步；
 * - 全程 try/catch，绝不阻塞首屏。
 */
export function buildStatusBarSync() {
    const js = `(function(){
  try {
    var HEAD = document.head;
    if (!HEAD) return;
    function toHex(c) {
      if (!c) return null;
      var m = c.match(/rgba?\\(([^)]+)\\)/);
      if (m) {
        var p = m[1].split(',').map(function (s) { return parseFloat(s); });
        if (p.length >= 3) {
          if (p.length >= 4 && p[3] === 0) return null;
          function h(n) { n = Math.round(n).toString(16); return n.length < 2 ? '0' + n : n; }
          return '#' + h(p[0]) + h(p[1]) + h(p[2]);
        }
        return null;
      }
      c = c.trim();
      if (c.charAt(0) === '#' && (c.length === 7 || c.length === 4)) return c;
      return null;
    }
    function sync() {
      var el = document.body || document.documentElement;
      if (!el) return;
      var bg = toHex(getComputedStyle(el).backgroundColor);
      if (!bg) return;
      var metas = HEAD.querySelectorAll('meta[name="theme-color"]');
      var keep = null;
      for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        if (m.getAttribute('media')) { if (m.parentNode) m.parentNode.removeChild(m); continue; }
        if (!keep) { keep = m; } else if (m.parentNode) { m.parentNode.removeChild(m); }
      }
      if (!keep) {
        keep = document.createElement('meta');
        keep.setAttribute('name', 'theme-color');
        HEAD.appendChild(keep);
      }
      if (keep.getAttribute('content') !== bg) keep.setAttribute('content', bg);
    }
    sync();
    if (window.MutationObserver) {
      new MutationObserver(function () { sync(); }).observe(HEAD, {
        childList: true, attributes: true, subtree: false, attributeFilter: ['content'],
      });
    }
    var n = 0;
    var t = setInterval(function () { sync(); if (++n > 40) clearInterval(t); }, 250);
    window.addEventListener('load', sync);
  } catch (e) {}
})();`;
    return `<script id="dshweb-status-sync">${js}</script>`;
}
/** 在 </head> 前注入移动端 theme-color / viewport-fit / 定制 style。 */
export function injectMobileHead(html, fontScale) {
    // theme-color 必须跟着「首屏主题」走，不能只按 prefers-color-scheme 猜。
    // 关键 Bug（用户 IMG_2032.png）：手机系统是浅色、而 App 主题是深色时，
    // 原来那条 media="(prefers-color-scheme: light)" content="#ffffff" 会命中，
    // iOS 在 status-bar-style=default 下用 theme-color 涂满它保留的状态栏条，
    // 于是深色启动页顶部被刷出一条白色「毛玻璃」盖 —— 这正是用户看到的残留遮盖。
    // 修法：首屏主题是明确的深/浅色时，只发一条不带 media 的 theme-color
    // （取首屏真实底色），让状态栏条与页面同色；只有「跟随系统」时才发两条 media。
    const boot = parseBootTheme(html);
    // 状态栏同色策略（真机探针定性后收紧）：无论 boot 是否「跟随系统」，
    // 都只发一条不带 media 的 theme-color = 首屏真实底色。
    // 跟随系统的场景由 buildStatusBarSync 脚本接管：boot CSS 的
    // @media(prefers-color-scheme) 会先把 body 底色染对，脚本随后把
    // theme-color 同步为该底色；多条 meta / ThemePresenter 追加的第三条
    // 一律被归一 —— iOS 状态栏条颜色从此恒等于页面底色（消灰带/错配）。
    // （preference===null 时的 fallback 色不影响深色系统：boot style 仍带
    //  media 查询，body 先行染深，脚本 250ms 内把 meta 改成深色。）
    const themeColor = `<meta name="theme-color" content="${boot.background}" />`;
    const head = [
        themeColor,
        // 关键 Bug 修复：必须是 default，不能是 black-translucent。
        // black-translucent 会让 iOS 把系统状态栏的「毛玻璃」画在网页内容「之上」，
        // 无论怎么加 padding、关 Safari「允许延伸网站颜色」都盖不住（参考
        // dsh-mobile-console 项目 web/index.html 注释与 README 档 7 结论）。
        // default 让系统自己占住那条不透明状态栏，网页从它下方开始，
        // env(safe-area-inset-top) 恒为 0，顶栏 / 侧边栏开关自然完整可见、可触控。
        // 注意：主屏图标会缓存旧的 status-bar-style，改完需从主屏删除后
        // 重新「添加到主屏幕」才会生效。
        '<meta name="apple-mobile-web-app-capable" content="yes" />',
        '<meta name="apple-mobile-web-app-status-bar-style" content="default" />',
        `<style id="dshweb-mobile">${buildMobileCss(fontScale)}</style>`,
        // 一次性真机诊断探针：把顶部 elementFromPoint / env() 真值 / 计算样式
        // 上报到 /api/dshweb/top-probe 落盘，供定点定位「对话顶部仍被毛玻璃盖」
        // 的真凶。sessionStorage 单次门控，页面加载/交互才触发，无 CSP 冲突。
        buildMobileProbe(),
        // 状态栏同色脚本：归一 theme-color（恒等于 body 底色），消「灰带/状态栏灰 vs 页白」
        buildStatusBarSync(),
    ].join("");
    // viewport 追加 viewport-fit=cover，让安全区 env() 生效
    let out = html;
    out = out.replace(/<meta([^>]*?)name=["']viewport["']([^>]*?)content=["']([^"']*)["']([^>]*)>/i, (all, pre, mid, content, post) => {
        if (/viewport-fit/i.test(content))
            return all;
        return `<meta${pre}name="viewport"${mid}content="${content}, viewport-fit=cover"${post || ""}>`;
    });
    // 第 9 轮：iOS 26/27 standalone PWA 系统级顶部 progressive blur 的隐形哑元素。
    // 直接写进 <body> 开头（HTML 源码级，非 JS 后插），保证 WebKit 首次布局/绘制
    // 前就存在，从而「刚进入时」首帧判定即命中 —— 用户实测点按钮后 blur 才消失，
    // 若靠脚本后插会错过冷启动那一次判定。样式见 buildMobileCss 的长注释。
    // 只在真正的移动端注入（本函数仅 mobile 调用），桌面零影响。
    if (!/class="dshweb-ios-blur-fix"/.test(out)) {
        out = out.replace(/(<body\b[^>]*>)/i, '$1<div class="dshweb-ios-blur-fix" aria-hidden="true"></div>');
    }
    const at = out.toLowerCase().indexOf("</head>");
    if (at < 0)
        return out + head;
    return out.slice(0, at) + head + out.slice(at);
}
/**
 * 桌面浏览器顶栏对齐 CSS（dshweb 网关桌面远程端，仅 [data-remote="desktop"]）。
 *
 * 需求（用户 m00001）：「桌面浏览器侧边栏顶部图标及收起按钮的高度和会话窗口
 * 最上层文字及按钮高度不一致，按钮大小也要统一，都按侧边栏按钮大小」。
 * 经用户确认（约 m00151）：只作用于「经网关 :3180 打开的远程桌面浏览器」
 * （data-remote="desktop"），不动本机 DSH GUI 直连 :62890；范围是「只统一
 * 高度 + 按钮尺寸」，文字字号随官方不变、不影响标题截断。
 *
 * 之所以内联在 server.ts：/api/dshweb/reload 只击穿 server.js 的 ESM 缓存，
 * 放这里改样式可热生效，无需重启 DSH（与 buildMobileCss 同理）。
 *
 * CDP 实测几何（headless Edge 157，1440×900，经 :3180，会话已激活）：
 *   · 侧栏 .wtg9ga_logoRow 展开 [x8,y6,264×60,cy36] / 折叠 rail [x10,y18,35×36,cy36]；
 *     .wtg9ga_brand [220×24,cy36]（顶部图标/新建会话按钮）、
 *     .wtg9ga_toggle [28×28,cy36]（收起侧边栏按钮）。
 *   · 会话窗 .an3WzG_titleRow [y10,h30,cy25]、.an3WzG_crumbs [h28,cy25]、
 *     .an3WzG_headerActions/Utilities/Corner [h28,cy25]，顶行独立图标按钮均 28×28。
 *   两者相差 11px：侧栏这一行比会话窗顶行低一截，侧栏顶部图标按钮盒高
 *   也不齐（24 vs 28）。25px 是会话窗整行控件的基准线，不能动它（动了和标题错位）。
 *
 * 做法沿用移动端「反馈 #4」已验证方案：logoRow 负 margin 整体上移 11px，
 * 后续 newSession / 会话列表同步上移，行与行之间不撕出空隙；再把侧栏顶部
 * 图标按钮盒高统一到「侧边栏按钮大小」28×28（.wtg9ga_iconButton 官方尺寸）。
 *
 * ⚠ 两处经 CDP 验证会回归、故刻意不写的规则（务必保留这些约束）：
 *   · 不给顶行容器设 min-height:28px —— 会覆盖 .an3WzG_titleRow 官方
 *     min-height:30px，把行压矮 1px、整块 grid 上移 0.5px、tabs 跟着错位。
 *     官方顶行容器本就 28px 且垂直居中，无需重复声明。
 *   · 纯图标按钮归一化必须 :not(.mOxcpG_chevron) —— 那是「更多打开方式」
 *     复合分体按钮（.mOxcpG_split 的一半），官方 18×22；强压 28×28 会撑宽
 *     headerUtilities（151→161）、挤动 .mOxcpG_main，视觉破坏分体胶囊。
 *
 * 验证：CDP 注入本 CSS 后展开态 32 项断言、折叠态控制实验全部通过（几何
 * 见 test 说明）；桌面直连（无 data-remote）零命中；第二行 tabs
 * （.an3WzG_tabs/.an3WzG_tab/.an3WzG_viewsMore 官方 25/35/22 设计）明确排除。
 */
export function buildDesktopCss() {
    return `
/* ── 桌面浏览器顶栏对齐（仅 [data-remote="desktop"]，桌面直连零命中）── */
[data-remote="desktop"] {
  --dshweb-desktop-top-center: 25px;
  --dshweb-desktop-top-size: 28px;
}

/* ① 中心线对齐：侧栏 logoRow 中心 36px → 25px。
   展开态与折叠 rail 实测中心同为 36px，一条规则同时覆盖两种状态；
   折叠 rail 的 36×36 按钮保持官方尺寸，不强行压成 28。 */
[data-remote="desktop"] .wtg9ga_logoRow {
  margin-top: calc(var(--dshweb-desktop-top-center, 25px) - 36px) !important;
}

/* ② 侧栏顶部图标按钮（.wtg9ga_brand 220×24）与收起按钮（28×28）统一到
   28px 盒高。只改盒高，FishLogo 与品牌字字号/尺寸保持官方不变。 */
[data-remote="desktop"] .wtg9ga_logoRow .wtg9ga_brand {
  height: var(--dshweb-desktop-top-size) !important;
  min-height: var(--dshweb-desktop-top-size) !important;
  box-sizing: border-box !important;
  align-items: center !important;
}

/* ③ 会话窗「第一行」里的「纯图标按钮」统一为侧栏按钮大小 28×28。
   :has(> svg:only-child) 只命中无文字的独立图标按钮；
   :not(.mOxcpG_chevron) 排除「更多打开方式」复合分体按钮（见函数头说明）；
   作用域限定在第一行容器，第二行 tabs 的 .an3WzG_viewsMore(22×22) 不会命中；
   文字按钮（.an3WzG_crumb / .Ag-ohG_trigger 等含 span 的）不受影响，字号随官方。
   当前 DOM 下这些独立图标按钮本就 28×28，本规则是防御性归一，显式钉牢口径。 */
[data-remote="desktop"] .an3WzG_titleRow button:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_titleRow [role="button"]:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_headerActions button:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_headerActions [role="button"]:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_headerUtilities button:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_headerUtilities [role="button"]:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_headerCorner button:has(> svg:only-child):not(.mOxcpG_chevron),
[data-remote="desktop"] .an3WzG_headerCorner [role="button"]:has(> svg:only-child):not(.mOxcpG_chevron) {
  width: var(--dshweb-desktop-top-size) !important;
  height: var(--dshweb-desktop-top-size) !important;
  min-width: var(--dshweb-desktop-top-size) !important;
  min-height: var(--dshweb-desktop-top-size) !important;
  padding: 0 !important;
  box-sizing: border-box !important;
  flex: none !important;
  display: inline-flex !important;
  align-items: center !important;
  justify-content: center !important;
}
`;
}
/** 注入到桌面远程端 HTML 里的 <style> 元素 id。 */
export const DSHWEB_DESKTOP_STYLE_ID = "dshweb-desktop";
/**
 * 把 buildDesktopCss() 以 <style id="dshweb-desktop"> 注入到 HTML 的 </head> 前。
 * 只在 proxyHtmlRequest 的 desktop 分支调用；幂等（已有同 id 则不重复插入）。
 * 与 injectMobileHead 一样内联本模块，随 /api/dshweb/reload 热生效。
 */
export function injectDesktopHead(html) {
    if (html.includes(`id="${DSHWEB_DESKTOP_STYLE_ID}"`))
        return html;
    const style = `<style id="${DSHWEB_DESKTOP_STYLE_ID}">${buildDesktopCss()}</style>`;
    const at = html.toLowerCase().indexOf("</head>");
    if (at < 0)
        return html + style;
    return html.slice(0, at) + style + html.slice(at);
}
