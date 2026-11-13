/**
 * 设备删除语义测试（store 层）
 *
 * 核心不变量：
 * 1. deleteDevice 必须同时撤销绑定该 deviceId 的会话 —— 否则被删设备仍持
 *    有效会话可继续访问，且网关 ensureDeviceRegistered 因 sess.deviceId 已存在
 *    不会重新登记，表现成「删了还在」。
 * 2. deleteRemoteDevices(keepId) 保留 keepId（当前操作者），返回被删数量。
 * 3. 未命中时返回 false / 0，且不写盘。
 */
import fs from 'node:fs';
import path from 'node:path';
import { isolateHome, dshwebDir, createRunner } from './_home.mjs';

const HOME = isolateHome('dshweb-store');
const TMP = dshwebDir(HOME);
const { WebStore } = await import('../lib/store.js');

const r = createRunner('设备删除语义（store）');

function seedStore(devices) {
  // 先清空磁盘，保证每个用例从零开始
  fs.rmSync(TMP, { recursive: true, force: true });
  fs.mkdirSync(TMP, { recursive: true });
  const store = new WebStore({});
  store.updateOptions({ devices });
  return store;
}

function readSessions() {
  try {
    return JSON.parse(fs.readFileSync(path.join(TMP, 'sessions.json'), 'utf8'));
  } catch {
    return {};
  }
}

function dev(id, extra = {}) {
  return { id, name: id, ua: `ua-${id}`, pairedAt: 1700000000000 + Number(id.slice(-2) || 0), ...extra };
}

await r.run(async (check) => {
  // ── 1. deleteDevice 命中：设备消失 + 会话连带撤销 ────────────────
  {
    const store = seedStore([dev('d1'), dev('d2'), dev('d3')]);
    const t2a = store.createSession('mobile');
    const t2b = store.createSession('desktop');
    store.markSeen(t2a, 'd2');
    store.markSeen(t2b, 'd2');
    const t1 = store.createSession('mobile');
    store.markSeen(t1, 'd1');

    check('删除前 devices 有 3 台', store.getOptions().devices.length === 3);
    check('删除前 sessions.json 有 3 条', Object.keys(readSessions()).length === 3);

    const ok = store.deleteDevice('d2');
    check('deleteDevice 命中返回 true', ok === true);

    const ids = store.getOptions().devices.map((d) => d.id);
    check('d2 已从 devices 移除', !ids.includes('d2'), ids.join(','));
    check('d1/d3 仍在', ids.includes('d1') && ids.includes('d3'), ids.join(','));

    const sessions = readSessions();
    check('d2 的两条会话已被撤销并落盘', !(t2a in sessions) && !(t2b in sessions));
    check('d1 的会话保留', t1 in sessions);
    check('getSession(已撤销 token) 返回 null', store.getSession(t2a) === null);
    check('getSession(d1 token) 仍有效', store.getSession(t1) !== null);
  }

  // ── 2. deleteDevice 未命中：返回 false，不删数据 ────────────────
  {
    const store = seedStore([dev('d1')]);
    const t = store.createSession('mobile');
    store.markSeen(t, 'd1');
    const before = fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8');

    check('删除不存在的设备返回 false', store.deleteDevice('nope') === false);
    check('未命中时 devices 不变', store.getOptions().devices.length === 1);
    check('未命中时会话不被撤销', store.getSession(t) !== null);
    check('未命中时不改写 settings.json', fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8') === before);
  }

  // ── 3. 删除设备持久化：磁盘上是删除后的状态，能被新 store 读回 ──
  {
    const store = seedStore([dev('d1'), dev('d2')]);
    store.deleteDevice('d1');
    const disk = JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'));
    const diskIds = (disk.devices || []).map((d) => d.id);
    check('settings.json 里 d1 已移除', !diskIds.includes('d1'), diskIds.join(','));
    check('settings.json 里 d2 仍在', diskIds.includes('d2'));

    // 与 index.ts 的启动路径一致：构造时把磁盘配置传进去
    const reopened = new WebStore({ devices: disk.devices });
    const ids = reopened.getOptions().devices.map((d) => d.id);
    check('按磁盘配置新建 store 后 d1 不存在', !ids.includes('d1'), ids.join(','));
  }

  // ── 4. deleteRemoteDevices(keepId)：保留当前设备 ────────────────
  {
    const store = seedStore([dev('cur'), dev('r1'), dev('r2'), dev('r3')]);
    const tc = store.createSession('desktop');
    store.markSeen(tc, 'cur');
    const r1 = store.createSession('mobile');
    store.markSeen(r1, 'r1');
    const r2 = store.createSession('mobile');
    store.markSeen(r2, 'r2');
    const r3 = store.createSession('mobile');
    store.markSeen(r3, 'r3');

    const removed = store.deleteRemoteDevices('cur');
    check('返回被删数量 3', removed === 3, `removed=${removed}`);

    const ids = store.getOptions().devices.map((d) => d.id);
    check('只剩当前设备 cur', ids.length === 1 && ids[0] === 'cur', ids.join(','));

    const sessions = readSessions();
    check('r1/r2/r3 会话全部撤销', !(r1 in sessions) && !(r2 in sessions) && !(r3 in sessions));
    check('当前设备会话保留（不会把自己踢下线）', tc in sessions);
  }

  // ── 5. deleteRemoteDevices(null)：全部删除 ──────────────────────
  {
    const store = seedStore([dev('a'), dev('b')]);
    const ta = store.createSession('desktop');
    store.markSeen(ta, 'a');

    check('keepId=null 时返回 2', store.deleteRemoteDevices(null) === 2);
    check('devices 清空', store.getOptions().devices.length === 0);
    check('所有会话撤销', Object.keys(readSessions()).length === 0);
    check('getSession 返回 null', store.getSession(ta) === null);
  }

  // ── 6. deleteRemoteDevices 空列表：返回 0 ──────────────────────
  {
    const store = seedStore([]);
    check('空设备列表返回 0', store.deleteRemoteDevices(null) === 0);
    check('空列表后再删仍返回 0', store.deleteRemoteDevices('whatever') === 0);
  }

  // ── 7. 设备列表里的脏数据（null 元素）不应让删除抛异常 ──────────
  {
    const store = seedStore([dev('ok'), null, dev('x')]);
    let threw = null;
    let ok;
    try {
      ok = store.deleteDevice('x');
    } catch (e) {
      threw = e.message;
    }
    check('脏数据下 deleteDevice 不抛异常', threw === null, threw);
    check('脏数据下仍能删掉目标设备', ok === true);
    const ids = store.getOptions().devices.filter(Boolean).map((d) => d.id);
    check('脏数据下保留其余设备', ids.includes('ok'));
  }

  // ── 8. saveOptions 不会清空磁盘上的其它字段 ────────────────────
  {
    const store = seedStore([dev('d1'), dev('d2')]);
    store.updateOptions({ passwordHash: 'HASH', passwordSalt: 'SALT' });
    store.deleteDevice('d1');
    const disk = JSON.parse(fs.readFileSync(path.join(TMP, 'settings.json'), 'utf8'));
    check('删除设备后 passwordHash 未被清空', disk.passwordHash === 'HASH');
    check('删除设备后 passwordSalt 未被清空', disk.passwordSalt === 'SALT');
  }
});
