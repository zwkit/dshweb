/** HTTPS 共存监听默认端口（与 HTTP 端口相互独立） */
export declare const DEFAULT_HTTPS_PORT = 3181;
/**
 * HTTPS 监听是否开启：缺省（未配置）视为「开启」——用户要求接入即启用 HTTPS 协议，
 * 与 HTTP 共存；仅当 settings.json 里显式写入 httpsEnabled:false 时才关闭。
 * 这样全新安装 / 旧配置里没有该字段时都默认启用，又保留显式关闭的能力。
 */
export declare function isHttpsEnabledByDefault(opts: Readonly<WebOptions>): boolean;
export interface WebOptions {
    /** 网关监听端口，默认 3180（HTTP，与 HTTPS 共存） */
    port?: number;
    /** 是否开启 HTTPS 监听（与 HTTP 同时监听）；缺省 = 开启，显式 false = 关闭 */
    httpsEnabled?: boolean;
    /** HTTPS 监听端口，默认 3181；端口可设置且独立于 HTTP 端口 */
    httpsPort?: number;
    /** 上游 DSH Web GUI 端口（留空则自动探测） */
    corePort?: number;
    /** 自有证书路径（可选） */
    tlsCertPath?: string;
    tlsKeyPath?: string;
    /** 永久登录口令盐哈希（忽略时仅配对码可用） */
    passwordHash?: string;
    passwordSalt?: string;
    /**
     * 6 位短期配对码状态（见 auth/pair-code.ts）。
     * 落在这里而不是模块级全局：桌面宿主路由与网关是两份独立加载的模块，
     * 只有共用 store 才能保证「桌面显示的码」= 「网关校验的码」，
     * 且 POST /api/dshweb/reload 不会把它重置掉。
     */
    pairCode?: {
        code: string;
        expiresAt: number;
        uses: number;
        fails: number;
        createdAt: number;
    } | null;
    /** 设备记录（配对后绑定） */
    devices?: DeviceRecord[];
    /** 显示：字体 */
    fontFamily?: string;
    /** 显示：文字大小（百分比 100 = 默认） */
    fontScale?: number;
    /**
     * 受信任域名白名单：
     * 允许这些域名通过反向代理 / 端口转发远程接入网关。只比裸主机名
     * （不含端口、忽略大小写）；localhost / IP 直连不受此列表影响。
     */
    trustedHosts?: string[];
}
export interface DeviceRecord {
    id: string;
    name: string;
    ua: string;
    /** 登录来源 IP（网关直接对外，remoteAddress 即真实局域网 IP） */
    ip?: string;
    /** 会话标记：mobile 经网关的手机/平板，desktop 为桌面/其它 */
    remote?: 'mobile' | 'desktop';
    pairedAt: number;
    lastSeenAt?: number;
}
export declare class WebStore {
    private options;
    /**
     * 会话标记映射。
     * expiresAt 为绝对过期时间（ms）；0 / 缺省表示「浏览器会话级」，
     * 仅内存保留、浏览器关闭即丢，且服务重启后不作为持久会话复活。
     * 勾选「保持登录」时才写入 24h 后的绝对时间。
     */
    private sessions;
    constructor(initial?: Partial<WebOptions>);
    getOptions(): Readonly<WebOptions>;
    updateOptions(patch: Partial<WebOptions>): void;
    private saveOptions;
    /**
     * 创建会话。
     * @param persistent 是否「保持登录」：true 时给会话设置 24h 绝对过期时间
     *   （配合下发的 Max-Age=86400 Cookie，浏览器关闭后 24h 内仍可直入界面）。
     *   默认 false，保持旧的「会话级 Cookie」语义，向下兼容所有现有调用方。
     */
    createSession(remote: 'mobile' | 'desktop', persistent?: boolean): string;
    getSession(token?: string): {
        deviceId?: string;
        remote: 'mobile' | 'desktop';
        createdAt: number;
        expiresAt?: number;
    } | null;
    markSeen(token: string, deviceId: string): void;
    revokeSession(token: string): boolean;
    /**
     * 删除单个设备：从 options.devices 移除，并撤销所有绑定该 deviceId 的会话。
     * 必须连会话一起撤销 —— 否则被删设备仍持有有效会话可继续访问，且网关的
     * ensureDeviceRegistered 因 sess.deviceId 已存在不会重新登记，表现为「删不掉」。
     */
    deleteDevice(id: string): boolean;
    /**
     * 一键删除所有远程设备：可保留 keepId（当前会话绑定设备，避免把操作者自己踢下线）。
     * 返回被删除的设备数量。
     */
    deleteRemoteDevices(keepId?: string | null): number;
    /** 撤销 deviceId 命中给定集合的所有会话，并持久化 sessions.json。 */
    private revokeSessionsForDevices;
    private loadSessions;
    private persistSessions;
}
