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
export declare const SESSION_COOKIE = "dshweb_session";
export declare class GatewayServer {
    /** HTTP 主监听（始终存在）与 HTTPS 副监听（httpsEnabled 时存在） */
    server: http.Server | https.Server | null;
    httpsServer: https.Server | null;
    activeSockets: Set<import("node:net").Socket>;
    store: any;
    configuredPort: any;
    boundPort: any;
    host: any;
    corePort: any;
    coreHost: any;
    coreTargetAuthority: string;
    /** TLS 证书材料（{cert,key}）；仅在开启 HTTPS 时需要 */
    tls: any;
    /** 是否同时监听 HTTPS 端口（与 HTTP 共存） */
    httpsEnabled: any;
    /** HTTPS 监听端口，默认 3181 */
    configuredHttpsPort: any;
    httpsBoundPort: number;
    status: string;
    lastError: null;
    logger: any;
    /** 已完成设备注册的会话，避免每个请求都写 settings.json（历史会话补注册用） */
    registeredSessions: Set<unknown>;
    constructor(options: any, store: any, logger: any);
    getStatus(): string;
    getLastError(): null;
    getBoundPort(): any;
    getHost(): any;
    getCorePort(): any;
    getServer(): http.Server<typeof http.IncomingMessage, typeof http.ServerResponse> | https.Server<typeof http.IncomingMessage, typeof http.ServerResponse> | null;
    /**
     * 状态字段 `tls` 的历史语义：网关是否提供可用的 HTTPS。
     * 双监听（HTTP 主 + HTTPS 副）下以「HTTPS 监听已就绪」为准。
     */
    isTls(): boolean;
    /** 是否开启了 HTTPS 共存监听 */
    isHttpsEnabled(): boolean;
    /** HTTPS 监听是否实际就绪 */
    isHttpsRunning(): boolean;
    /** HTTPS 实际监听端口（未开启/未就绪时为 0） */
    getHttpsBoundPort(): number;
    /** 判断某次请求是否来自 HTTPS 监听（用于 30x Location / 登录页协议显示） */
    requestIsTls(req: any): boolean;
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
    buildProxyHeaders(req: any, originalHost: any): any;
    /**
     * Host 校验决策：
     * - 本机访问（loopback 变体）：放行
     * - 局域网/虚拟私网/公网 IP 直连：放行（isIP 校验即可）
     * - 域名：仅接受 settings.json trustedHosts 白名单里的（默认全拒绝，防 DNS-Rebinding）。
     *   白名单只比裸主机名（不带端口、忽略大小写），因为反代/TLS
     *   终结/端口转发下外部端口 ≠ boundPort，端口不作为信任边界。
     */
    isHostAllowed(hostHeader: any): boolean;
    /** 启动网关 */
    start(): Promise<{
        port: number;
        host: string;
    }>;
    /** 优雅关闭（同时关闭 HTTP / HTTPS 两个监听） */
    close(): Promise<void>;
    /**
     * HTTP 请求主处理：
     * 1. Host 白名单
     * 2. 会话标记校验（HTML 路径要求已登录）
     * 3. HTML 响应注入 <html data-remote>
     * 4. 反代
     */
    handleHttpRequest(req: any, res: any): void;
    /** 纯流式反代（非 HTML 注入路径）：登录头像/静态资源/SSE/WS 之外的普通请求。 */
    proxyPassThrough(req: any, res: any, proxyHeaders: any): void;
    /**
     * HTML 请求：反代 + 拦截响应注入 <html data-remote="mobile|desktop">
     * 响应体流量较小（DSH HTML <100KB），用 buffer 而非流式。
     */
    proxyHtmlRequest(req: any, res: any, proxyHeaders: any, originalHost: any): void;
    /** WebSocket upgrade 转发（双向 pipe + 10s 超时 + 对称清理） */
    handleUpgrade(req: any, clientSocket: any, head: any): void;
    getSession(req: any): any;
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
    registerDevice(req: any, sessionToken: any, remote: any): void;
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
    fetchHostPairCode(): Promise<unknown>;
    verifyLegacyPairCode(credential: any, opts: any): boolean;
    /**
     * 把旧版存在 credentials.ts 模块全局里的配对码搬进 store。
     *
     * 背景：/api/dshweb/reload 只重新加载本模块，宿主路由（routes/api.js）还是启动时
     * 那份旧代码，仍在写 credentials.ts 的模块级全局。不接管的话，用户刚在桌面生成的
     * 码在网关侧读不到 → 提示「当前没有可用的配对码」。这是单向兼容层，
     * 等 DSH 重启、宿主路由也换成新代码后此处自然变成空操作（旧模块里没有码）。
     */
    adoptLegacyPairCode(): void;
    /**
     * 历史会话幂等补注册：用户在本修复前已登录、devices 仍为空时，
     * 下一次带会话的 HTTP 请求把当前设备补进列表（每个会话仅一次）。
     */
    ensureDeviceRegistered(req: any): void;
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
    handleDirectoryApi(url: any, req: any, res: any): Promise<void>;
    /** 读取并解析 JSON 请求体（带 64KB 上限） */
    readJsonBody(req: any): Promise<unknown>;
    /**
     * 内部 API 路由（网关自持，不依赖宿主注册）：
     * GET  /api/dshweb/status      — 网关状态（无会话要求）
     * GET  /api/dshweb/login       — 登录页（口令 / 配对码表单）
     * POST /api/dshweb/login       — 提交凭据 → Set-Cookie + 302 /
     */
    serveInternalApi(url: any, req: any, res: any): boolean;
    looksLikeHtmlRequest(req: any): any;
    /**
     * 30x Location 回环改写：把核心返回的 http(s)://127.0.0.1:30xx 改成
     * 「本次请求所用协议://<外部 Host><原路径>」。
     * 双监听（HTTP + HTTPS 共存）下必须按实际协议生成，不能写死 https，
     * 否则从 http://my-cloud.cn:3180 访问会被错误跳到 https。
     */
    rewriteRedirectLocation(location: any, originalHost: any, req?: any): any;
}
/**
 * PWA 安装所需静态资源（manifest / 各尺寸图标 / favicon）。
 * 未登录时也要能取到，否则「安装为应用」拿不到图标会退化成通用图标。
 */
export declare function isPwaAsset(url: any): boolean;
export declare function pwaIconVersion(): string;
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
export declare function versionManifestIcons(manifestText: any): string;
/**
 * 往 HTML head 注入带版本号的 PNG 图标链接。
 *
 * 为什么需要：核心 head 只声明了 SVG favicon（`favicon.svg` / `favicon-dark.svg`），
 * 没有任何 PNG 图标链接。部分浏览器（尤其「创建快捷方式」而非完整 PWA 安装时）
 * 与部分启动器只认 PNG/ICO，拿不到就退化成默认「地球」图标。这里补上
 * 192/512 PNG + apple-touch-icon + favicon.ico，全部带内容版本号，且幂等。
 */
export declare function injectPwaIconLinks(html: any): any;
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
export declare function injectRemoteResilience(html: any): any;
/** 读取本地 PWA manifest；不存在则返回 null（回退到核心反代）。 */
export declare function readPwaManifest(): string | null;
/** 读取本地 PWA 图标；不存在则返回 null（回退到核心反代）。 */
export declare function readPwaIcon(pathname: any): any;
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
export declare function buildMobileCss(fontScale: any): string;
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
export declare function parseBootTheme(html: any): {
    preference: null;
    background: string;
} | {
    preference: string;
    background: any;
};
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
export declare function buildMobileProbe(): string;
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
export declare function buildStatusBarSync(): string;
/** 在 </head> 前注入移动端 theme-color / viewport-fit / 定制 style。 */
export declare function injectMobileHead(html: any, fontScale: any): string;
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
export declare function buildDesktopCss(): string;
/** 注入到桌面远程端 HTML 里的 <style> 元素 id。 */
export declare const DSHWEB_DESKTOP_STYLE_ID = "dshweb-desktop";
/**
 * 把 buildDesktopCss() 以 <style id="dshweb-desktop"> 注入到 HTML 的 </head> 前。
 * 只在 proxyHtmlRequest 的 desktop 分支调用；幂等（已有同 id 则不重复插入）。
 * 与 injectMobileHead 一样内联本模块，随 /api/dshweb/reload 热生效。
 */
export declare function injectDesktopHead(html: any): any;
