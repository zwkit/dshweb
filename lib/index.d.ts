/** Cordis 插件名称标识 */
export declare const name = "dshweb";
/** DSH 设置命名空间 */
export declare const WEB_SETTINGS_NAMESPACE = "dshweb";
/**
 * Cordis 依赖注入声明
 * webServer：用于探测底座 Web GUI 实测绑定端口（桌面客户端为动态端口）
 * 注意：connection 不放静态 inject（cordis 静态注入要求服务必须已存在，存在加载失败风险），
 * 接管鉴权走下方 ctx.inject(['connection'], ...) 动态注入 + apply 立即尝试 + 定时兜底三点冗余。
 */
export declare const inject: string[];
/**
 * 插件生命周期挂载入口
 */
export declare function apply(ctx: any, config?: Record<string, any>): void;
export * from './store.js';
export * from './gateway/server.js';
export * from './routes/api.js';
