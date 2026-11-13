import type { WebOptions } from '../store.js';
/** 配对码有效期：5 分钟 */
export declare const PAIR_CODE_TTL_MS: number;
/** 单个配对码最多可成功配对次数（删设备后重登、多设备共用同一码） */
export declare const PAIR_CODE_MAX_USES = 5;
/** 单个配对码最多输错次数，达到即作废 */
export declare const PAIR_CODE_MAX_FAILS = 5;
export interface PairCodeState {
    code: string;
    expiresAt: number;
    /** 本码已成功配对的次数 */
    uses: number;
    /** 本码累计输错次数 */
    fails: number;
    /** 生成时间（仅用于排查/展示） */
    createdAt: number;
}
/** 失效原因：ok=可用；none=从未生成；expired=过期；used=次数用尽；locked=输错过多；invalid=本次输入不对 */
export type PairCodeReason = 'ok' | 'none' | 'expired' | 'used' | 'locked' | 'invalid';
export interface PairCodeStatus {
    valid: boolean;
    code: string;
    expiresAt: number;
    /** 剩余有效毫秒数（0 表示已过期） */
    remainingMs: number;
    uses: number;
    maxUses: number;
    reason: PairCodeReason;
}
/** 只需 store 的这两个方法（便于测试注入） */
export interface PairCodeHost {
    getOptions(): Readonly<WebOptions>;
    updateOptions(patch: Partial<WebOptions>): void;
}
/** 生成并落盘一个新配对码。ttlMs 为负值可造一个「已过期」的码（测试用）。 */
export declare function setPairCode(host: PairCodeHost, ttlMs?: number): PairCodeState;
export declare function getPairCode(host: PairCodeHost): PairCodeState | null;
/**
 * 把「旧版存放在模块全局里的配对码」接管进 store。
 *
 * 只用于热重载过渡：POST /api/dshweb/reload 只重新加载 gateway/server.js，
 * 宿主路由（routes/api.js）仍是启动时那份旧代码，仍在写旧 credentials.ts 的
 * 模块级全局。若不接管，用户刚在桌面上生成的码在网关侧会变成「没有可用配对码」。
 * 只在旧码当前确实可用时接管，避免把已失效的码搬进 store 掩盖真实状态。
 */
export declare function adoptPairCode(host: PairCodeHost, legacy: {
    code?: unknown;
    expiresAt?: unknown;
    uses?: unknown;
    fails?: unknown;
} | null | undefined): PairCodeState | null;
/** 当前配对码状态（供桌面设置页 / 登录页展示，不含任何口令信息） */
export declare function pairCodeStatus(host: PairCodeHost): PairCodeStatus;
/**
 * 校验配对码并返回具体原因。
 * 成功累加 uses（到期 / 次数用尽前可继续配对）；失败累加 fails，满 5 次作废。
 * 失败时**保留**状态而不是清空，这样登录页能说清「因输错过多作废」而不是
 * 含糊的「无有效配对码」。
 */
export declare function verifyPairCodeDetailed(input: string, host: PairCodeHost): PairCodeReason;
/** 兼容旧签名（只关心通过/不通过） */
export declare function verifyPairCode(input: string, host: PairCodeHost): boolean;
