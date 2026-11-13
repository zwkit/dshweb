/**
 * 配对码 / 口令 / 设备名解析测试
 *
 * 覆盖 auth/pair-code.ts 的状态机（有效期、使用次数、输错锁定、换发）
 * 以及 auth/credentials.ts 的哈希校验，和网关的设备名归一化逻辑。
 */
import { isolateHome, createRunner } from './_home.mjs';

isolateHome('dshweb-auth');
const { WebStore } = await import('../lib/store.js');
const {
  setPairCode,
  getPairCode,
  pairCodeStatus,
  verifyPairCode,
  verifyPairCodeDetailed,
  PAIR_CODE_MAX_USES,
  PAIR_CODE_MAX_FAILS,
  PAIR_CODE_TTL_MS,
} = await import('../lib/auth/pair-code.js');
const { hashPassword, verifyPassword, setHashedPassword } = await import('../lib/auth/credentials.js');
const { createHash } = await import('node:crypto');

/** 与网关 registerDevice 相同的设备 id 算法：sha1(remote|ua) 前 16 位十六进制。 */
function sha1(s) {
  return createHash('sha1').update(s).digest('hex');
}

const r = createRunner('配对码与口令');

// 每个用例一个干净的 store（走隔离 HOME，不会污染真实配置）
function newStore() {
  return new WebStore({});
}

await r.run(async (check) => {
  // ── 口令哈希 ────────────────────────────────────────────
  {
    const salt = 'a1b2c3d4e5f60718';
    const hash = hashPassword('secret123', salt);
    check('同一口令+盐得到同一哈希', hashPassword('secret123', salt) === hash);
    check('不同盐得到不同哈希', hashPassword('secret123', 'ffffffffffffffff') !== hash);
    check('哈希不等于明文', hash !== 'secret123');
    check('verifyPassword 正确口令通过', verifyPassword('secret123', { passwordHash: hash, passwordSalt: salt }) === true);
    check('verifyPassword 错误口令失败', verifyPassword('wrong', { passwordHash: hash, passwordSalt: salt }) === false);
    check('未设置口令时任何口令都失败', verifyPassword('', {}) === false && verifyPassword('x', {}) === false);
  }
  {
    const store = newStore();
    setHashedPassword(store.getOptions(), 'longpassword');
    const opts = store.getOptions();
    check('setHashedPassword 生成 salt', Boolean(opts.passwordSalt));
    check('setHashedPassword 生成 hash', Boolean(opts.passwordHash));
    check('生成的口令可校验', verifyPassword('longpassword', opts) === true);
    check('生成的口令错误值失败', verifyPassword('longpasswor', opts) === false);
  }

  // ── 配对码生成 ──────────────────────────────────────────
  {
    const store = newStore();
    const st = setPairCode(store);
    check('配对码为 6 位数字', /^\d{6}$/.test(st.code), st.code);
    check('过期时间约 5 分钟后', Math.abs(st.expiresAt - Date.now() - PAIR_CODE_TTL_MS) < 2000);
    check('初始 uses/fails 为 0', st.uses === 0 && st.fails === 0);
    check('配对码写入 store', getPairCode(store) && getPairCode(store).code === st.code);
    const status = pairCodeStatus(store);
    check('status.valid 为 true', status.valid === true, JSON.stringify(status));
    check('status 回显剩余毫秒', status.remainingMs > 0 && status.remainingMs <= PAIR_CODE_TTL_MS, String(status.remainingMs));
  }

  // ── 配对码校验：正确 / 错误 ─────────────────────────────
  {
    const store = newStore();
    const st = setPairCode(store);
    check('正确配对码校验通过', verifyPairCode(st.code, store) === true);
    check('正确配对码不计入 fails', getPairCode(store).fails === 0, String(getPairCode(store).fails));
    check('正确配对码计入 uses', getPairCode(store).uses === 1, String(getPairCode(store).uses));

    check('错误配对码校验失败', verifyPairCode('000000', store) === false);
    check('错误配对码计入 fails', getPairCode(store).fails === 1, String(getPairCode(store).fails));
    check('空配对码失败', verifyPairCode('', store) === false);
    check('非 6 位失败', verifyPairCode('12345', store) === false);
  }

  // ── 配对码：超过最大使用次数 ────────────────────────────
  {
    const store = newStore();
    const st = setPairCode(store);
    let okCount = 0;
    for (let i = 0; i < PAIR_CODE_MAX_USES; i++) {
      if (verifyPairCode(st.code, store)) okCount++;
    }
    check(`可成功配对 ${PAIR_CODE_MAX_USES} 次`, okCount === PAIR_CODE_MAX_USES, String(okCount));
    check('超过使用次数后校验失败', verifyPairCode(st.code, store) === false);
    const status = pairCodeStatus(store);
    check('status.valid 变为 false', status.valid === false, JSON.stringify(status));
    check('失效原因为 used', status.reason === 'used', String(status.reason));
  }

  // ── 配对码：输错次数达上限即作废 ────────────────────────
  {
    const store = newStore();
    const st = setPairCode(store);
    for (let i = 0; i < PAIR_CODE_MAX_FAILS; i++) verifyPairCode('999999', store);
    const status = pairCodeStatus(store);
    check('输错达上限后状态为 locked', status.reason === 'locked', String(status.reason));
    check('锁定后正确码也失效', verifyPairCode(st.code, store) === false);
  }

  // ── 配对码：过期 ────────────────────────────────────────
  {
    const store = newStore();
    const st = setPairCode(store, -1000); // 造一个已过期的码
    const status = pairCodeStatus(store);
    check('过期码状态 reason=expired', status.reason === 'expired', String(status.reason));
    check('过期码校验失败', verifyPairCode(st.code, store) === false);
    check('过期码 remainingMs 为 0', status.remainingMs === 0, String(status.remainingMs));
  }

  // ── 配对码：没有码 ──────────────────────────────────────
  {
    const store = newStore();
    const status = pairCodeStatus(store);
    check('无码时 valid=false', status.valid === false);
    check('无码时 reason=none', status.reason === 'none', String(status.reason));
    check('无码时任何输入都失败', verifyPairCode('123456', store) === false);
  }

  // ── verifyPairCodeDetailed 返回原因 ─────────────────────
  {
    const store = newStore();
    const st = setPairCode(store);
    let d = verifyPairCodeDetailed(st.code, store);
    check('detailed 正确码返回 ok', d === 'ok', JSON.stringify(d));
    d = verifyPairCodeDetailed('111111', store);
    check('detailed 错误码返回 invalid', d === 'invalid', JSON.stringify(d));
    check('detailed 失败累加 fails', getPairCode(store).fails === 1, String(getPairCode(store).fails));

    const store2 = newStore();
    const d2 = verifyPairCodeDetailed('123456', store2);
    check('无码时 detailed 返回 none', d2 === 'none', JSON.stringify(d2));

    // 连错到上限时最后一次返回 locked
    const store3 = newStore();
    const st3 = setPairCode(store3);
    let last = '';
    for (let i = 0; i < PAIR_CODE_MAX_FAILS; i++) last = verifyPairCodeDetailed('000000', store3);
    check('连错到上限最后一次返回 locked', last === 'locked', last);
    check('锁定后正确码 detailed 也返回 locked', verifyPairCodeDetailed(st3.code, store3) === 'locked');
  }

  // ── 换发新码后旧码失效 ──────────────────────────────────
  {
    const store = newStore();
    const first = setPairCode(store);
    const second = setPairCode(store);
    check('换发后 store 里是新码', getPairCode(store).code === second.code);
    check('换发后旧码校验失败', verifyPairCode(first.code, store) === false || first.code === second.code);
    check('换发后新码校验通过', verifyPairCode(second.code, store) === true);
  }

  // ── 配对码落盘后重建 store 仍可用（热重载不丢码）────────
  {
    const store = newStore();
    const st = setPairCode(store);
    const disk = store.getOptions();
    // 模拟网关热重载：用磁盘配置重建 store
    const reopened = new WebStore({ pairCode: disk.pairCode });
    check('重建 store 后配对码仍存在', getPairCode(reopened) && getPairCode(reopened).code === st.code);
    check('重建 store 后配对码仍可校验', verifyPairCode(st.code, reopened) === true);
  }
});

/* ── 设备名归一化（网关 describeDevice）─────────────────── */
const r2 = createRunner('设备登记与命名');
await r2.run(async (check) => {
  // describeDevice 是网关内部函数，通过 registerDevice 间接覆盖成本高，
  // 这里直接测 UA → 设备名的映射行为：用一个最小 store + 网关实例。
  const { GatewayServer } = await import('../lib/gateway/server.js');
  const store = new WebStore({ devices: [] });
  const gw = new GatewayServer({ port: 0, host: '127.0.0.1', corePort: 1, coreHost: '127.0.0.1' }, store, null);

  function register(ua, remote) {
    const token = store.createSession(remote);
    const req = { headers: { 'user-agent': ua }, socket: { remoteAddress: '192.168.0.9' } };
    gw.registerDevice(req, token, remote);
    const devs = store.getOptions().devices;
    // 注意：registerDevice 对已存在的设备是原地更新（不追加），
    // 所以不能取「最后一个」，要按 id 定位本次登记的那台。
    const devId = sha1(`${remote}|${ua}`).slice(0, 16);
    return devs.find((d) => d && d.id === devId);
  }

  const android = register('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Mobile Safari/537.36', 'mobile');
  check('Android UA 解析出 Android', /Android/.test(android.name), android.name);
  check('Android UA 解析出 Safari', /Safari/.test(android.name), android.name);
  check('设备名含分隔符', android.name.includes('·'), android.name);
  check('记录 remote=mobile', android.remote === 'mobile', android.remote);
  check('记录 IP', android.ip === '192.168.0.9', android.ip);
  check('设备 id 为 16 位十六进制', /^[0-9a-f]{16}$/.test(android.id), android.id);

  const iphone = register('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1', 'mobile');
  check('iPhone UA 解析出 iOS', /iOS|iPhone/.test(iphone.name), iphone.name);

  const win = register('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120', 'desktop');
  check('Windows UA 解析出 Windows', /Windows/.test(win.name), win.name);
  check('Edge UA 解析出 Edge', /Edge/.test(win.name), win.name);

  const empty = register('', 'desktop');
  check('空 UA 有兜底名', empty.name.length > 0, empty.name);

  const same = register('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120', 'desktop');
  check('同 UA + 同 remote 复用同一设备 id', same.id === win.id, `${same.id} vs ${win.id}`);
  check('重复登记不会新增设备', (store.getOptions().devices || []).length === 4, String((store.getOptions().devices || []).length));

  const mobileSameUa = register('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120 Safari/537.36 Edg/120', 'mobile');
  check('同 UA 但 remote 不同 → 不同 device id', mobileSameUa.id !== win.id, `${mobileSameUa.id} vs ${win.id}`);
});
