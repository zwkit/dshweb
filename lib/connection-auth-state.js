/**
 * connection 鉴权接管状态（ESM 模块单例，供 index.ts / routes/api.ts /
 * gateway/server.ts 三处共享同一对象）。
 *
 * 用途：DSH 桌面客户端重启后，运维可直接 `curl /api/dshweb/status` 看
 * `connectionAuth.attached` 是否为 true，确认官方 launch-token 401 是否已被
 * 短路，不必翻日志或进进程内存。
 */
export const connectionAuthState = {
    attached: false,
    /** 成功包装的方法数（isAuthenticated / requestRejection / authorizeIndex） */
    wrapped: 0,
    /** 接管途径：immediate（apply 直接 get） / inject（动态注入） / service-event / retry */
    via: '',
    /** 最后一次尝试时间（epoch ms），便于判断时序 */
    at: 0,
};
