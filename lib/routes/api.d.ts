import type { IncomingMessage, ServerResponse } from 'node:http';
import type { WebStore } from '../store.js';
export interface WebRoute {
    kind: 'exact' | 'prefix';
    method?: 'GET' | 'POST';
    path: string;
    handler: (req: IncomingMessage, res: ServerResponse) => unknown;
}
interface RouteDeps {
    softRestart: (reason: string) => Promise<{
        ok: boolean;
        port?: number;
        error?: string;
    }>;
    getGateway: () => {
        getBoundPort(): number;
        getStatus(): string;
        getCorePort(): number;
        isTls(): boolean;
        isHttpsEnabled?(): boolean;
        isHttpsRunning?(): boolean;
        getHttpsBoundPort?(): number;
    } | null;
}
/** 首个私网 IPv4（192.168/10.开头优先，其次 172.16-31），找不到回退 '' */
export declare function lanIpv4(): string;
export declare function createRoutes(store: WebStore, deps: RouteDeps): WebRoute[];
export declare function verifyCredentials(password: string, pairCodeInput: string, store: WebStore): boolean;
export {};
