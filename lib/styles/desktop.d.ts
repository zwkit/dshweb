/**
 * dshweb 桌面远程端样式 —— 唯一实现已内联到 src/gateway/server.ts（buildDesktopCss）。
 *
 * 与移动端同理：/api/dshweb/reload 只击穿 server.js 的 ESM 缓存，本模块
 * import 进去的仍是旧实例，改样式必须重启 DSH 才生效。内联进 server.ts
 * 才能热更新。本文件保留为稳定的对外出口（测试/外部工具可继续从这里取），
 * 确保 CSS 只有一个来源，避免两处定义漂移。
 */
export { buildDesktopCss, injectDesktopHead, DSHWEB_DESKTOP_STYLE_ID } from '../gateway/server.js';
