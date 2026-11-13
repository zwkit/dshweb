/**
 * dshweb 配对码状态机（6 位短期码）
 *
 * 为什么要独立成模块、并把状态放进 WebStore：
 *
 * 1. **一个存储，两个视图**。桌面设置页走宿主路由（routes/api.ts 直连核心），
 *    手机/平板走网关（gateway/server.ts 监听 3180）。两份代码是独立加载的 ESM
 *    模块：以前状态是 credentials.ts 里的模块级全局变量，只在「同一个模块实例」
 *    内一致；一旦有一侧走了热重载或加载顺序不同，桌面上显示的码和网关校验的码
 *    就可能不是同一个。落进 settings.json（store.getOptions()）后两边天然同源。
 * 2. **热重载不丢码**。POST /api/dshweb/reload 只击穿 gateway/server.js 的 ESM
 *    缓存；模块级全局会被重置成「没有码」，而桌面 UI 还在显示旧的 6 位数字，
 *    用户一登就 401。落 store 后热重载不影响已生成的码。
 * 3. **删除设备必须保证手上有活码**。旧语义「配对成功一次即永久作废」配合
 *    「设置页从不刷新」正是用户报的 bug：删掉远程客户端后，界面还显示那串死码，
 *    重登只能看到含糊的「凭据无效或配对码已过期」。现在 5 分钟内可多次配对
 *    （默认 5 次），删除设备时若当前码已失效还会主动换发新码。
 *
 * 只用 WebStore 既有方法 getOptions / updateOptions：store.js 在运行期不会被
 * 重新加载，不能依赖新增方法。
 */
import { randomInt, timingSafeEqual } from 'node:crypto';
/** 配对码有效期：5 分钟 */
export const PAIR_CODE_TTL_MS = 5 * 60_000;
/** 单个配对码最多可成功配对次数（删设备后重登、多设备共用同一码） */
export const PAIR_CODE_MAX_USES = 5;
/** 单个配对码最多输错次数，达到即作废 */
export const PAIR_CODE_MAX_FAILS = 5;
function readState(host) {
    const raw = host.getOptions().pairCode;
    if (!raw || typeof raw !== 'object' || typeof raw.code !== 'string' || !raw.code)
        return null;
    return {
        code: raw.code,
        expiresAt: Number(raw.expiresAt) || 0,
        uses: Number(raw.uses) || 0,
        fails: Number(raw.fails) || 0,
        createdAt: Number(raw.createdAt) || 0,
    };
}
function writeState(host, state) {
    host.updateOptions({ pairCode: state });
}
/** 生成并落盘一个新配对码。ttlMs 为负值可造一个「已过期」的码（测试用）。 */
export function setPairCode(host, ttlMs = PAIR_CODE_TTL_MS) {
    const now = Date.now();
    const state = {
        code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
        expiresAt: now + ttlMs,
        uses: 0,
        fails: 0,
        createdAt: now,
    };
    writeState(host, state);
    return state;
}
export function getPairCode(host) {
    return readState(host);
}
/**
 * 把「旧版存放在模块全局里的配对码」接管进 store。
 *
 * 只用于热重载过渡：POST /api/dshweb/reload 只重新加载 gateway/server.js，
 * 宿主路由（routes/api.js）仍是启动时那份旧代码，仍在写旧 credentials.ts 的
 * 模块级全局。若不接管，用户刚在桌面上生成的码在网关侧会变成「没有可用配对码」。
 * 只在旧码当前确实可用时接管，避免把已失效的码搬进 store 掩盖真实状态。
 */
export function adoptPairCode(host, legacy) {
    if (!legacy || typeof legacy.code !== 'string' || !legacy.code)
        return null;
    const state = {
        code: legacy.code,
        expiresAt: Number(legacy.expiresAt) || 0,
        uses: Number(legacy.uses) || 0,
        fails: Number(legacy.fails) || 0,
        createdAt: 0,
    };
    if (Date.now() > state.expiresAt)
        return null;
    if (state.fails >= PAIR_CODE_MAX_FAILS || state.uses >= PAIR_CODE_MAX_USES)
        return null;
    writeState(host, state);
    return state;
}
/** 当前配对码状态（供桌面设置页 / 登录页展示，不含任何口令信息） */
export function pairCodeStatus(host) {
    const state = readState(host);
    if (!state) {
        return {
            valid: false,
            code: '',
            expiresAt: 0,
            remainingMs: 0,
            uses: 0,
            maxUses: PAIR_CODE_MAX_USES,
            reason: 'none',
        };
    }
    const remainingMs = Math.max(0, state.expiresAt - Date.now());
    let reason = 'ok';
    if (state.fails >= PAIR_CODE_MAX_FAILS)
        reason = 'locked';
    else if (remainingMs <= 0)
        reason = 'expired';
    else if (state.uses >= PAIR_CODE_MAX_USES)
        reason = 'used';
    return {
        valid: reason === 'ok',
        code: state.code,
        expiresAt: state.expiresAt,
        remainingMs,
        uses: state.uses,
        maxUses: PAIR_CODE_MAX_USES,
        reason,
    };
}
/**
 * 校验配对码并返回具体原因。
 * 成功累加 uses（到期 / 次数用尽前可继续配对）；失败累加 fails，满 5 次作废。
 * 失败时**保留**状态而不是清空，这样登录页能说清「因输错过多作废」而不是
 * 含糊的「无有效配对码」。
 */
export function verifyPairCodeDetailed(input, host) {
    const state = readState(host);
    if (!state)
        return 'none';
    if (state.fails >= PAIR_CODE_MAX_FAILS)
        return 'locked';
    if (Date.now() > state.expiresAt)
        return 'expired';
    if (state.uses >= PAIR_CODE_MAX_USES)
        return 'used';
    const ok = input.length === state.code.length && safeEqual(input, state.code);
    if (!ok) {
        state.fails += 1;
        writeState(host, state);
        return state.fails >= PAIR_CODE_MAX_FAILS ? 'locked' : 'invalid';
    }
    state.uses += 1;
    writeState(host, state);
    return 'ok';
}
/** 兼容旧签名（只关心通过/不通过） */
export function verifyPairCode(input, host) {
    return verifyPairCodeDetailed(input, host) === 'ok';
}
function safeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
