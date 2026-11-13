import type { WebRoute } from './api.js';
/**
 * 将 dshweb 路由注册到 DSH WebServer（遵循 DSH 底座 WebRoute 契约）
 */
export declare function registerWebRoutes(ctx: any, routes: WebRoute[]): void;
