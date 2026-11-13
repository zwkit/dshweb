/**
 * dshweb 永久口令校验（sha256 盐哈希）
 *
 * 配对码不在这里：它需要跨「桌面宿主路由」与「外部网关」共享状态、并且要能被
 * 删除设备流程主动换发，因此单独放在 auth/pair-code.ts 并落进 WebStore。
 * 历史上两者混在本文件里、用模块级全局变量保存配对码，导致了
 * 「删除远程客户端后重新登录提示凭据无效或配对码已过期」。
 */
import { createHash, timingSafeEqual } from 'node:crypto';
export function hashPassword(password, salt) {
    return createHash('sha256').update(`${salt}:${password}`).digest('hex');
}
export function setHashedPassword(options, password) {
    const salt = createHash('sha256')
        .update(String(Date.now()) + Math.random())
        .digest('hex')
        .slice(0, 16);
    options.passwordSalt = salt;
    options.passwordHash = hashPassword(password, salt);
}
export function verifyPassword(password, options) {
    if (!options.passwordHash || !options.passwordSalt)
        return false;
    const candidate = hashPassword(password, options.passwordSalt);
    return safeEqual(candidate, options.passwordHash);
}
function safeEqual(a, b) {
    if (a.length !== b.length)
        return false;
    return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}
