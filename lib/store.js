/**
 * dshweb 配置/会话持久化
 * 存放 ~/.dsh/dshweb/settings.json；会话标记映射存 ~/.dsh/dshweb/sessions.json
 */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
const SETTINGS_DIR = join(homedir(), '.dsh', 'dshweb');
const SETTINGS_PATH = join(SETTINGS_DIR, 'settings.json');
const SESSIONS_PATH = join(SETTINGS_DIR, 'sessions.json');
/** HTTPS 共存监听默认端口（与 HTTP 端口相互独立） */
export const DEFAULT_HTTPS_PORT = 3181;
/**
 * HTTPS 监听是否开启：缺省（未配置）视为「开启」——用户要求接入即启用 HTTPS 协议，
 * 与 HTTP 共存；仅当 settings.json 里显式写入 httpsEnabled:false 时才关闭。
 * 这样全新安装 / 旧配置里没有该字段时都默认启用，又保留显式关闭的能力。
 */
export function isHttpsEnabledByDefault(opts) {
    return opts.httpsEnabled !== false;
}
export class WebStore {
    options;
    /**
     * 会话标记映射。
     * expiresAt 为绝对过期时间（ms）；0 / 缺省表示「浏览器会话级」，
     * 仅内存保留、浏览器关闭即丢，且服务重启后不作为持久会话复活。
     * 勾选「保持登录」时才写入 24h 后的绝对时间。
     */
    sessions = new Map();
    constructor(initial = {}) {
        this.options = { ...initial };
        this.loadSessions();
    }
    getOptions() {
        return this.options;
    }
    updateOptions(patch) {
        this.options = { ...this.options, ...patch };
        this.saveOptions();
    }
    saveOptions() {
        try {
            mkdirSync(SETTINGS_DIR, { recursive: true });
            // 防御：把磁盘上已有的配置并入本次写入，避免用「部分 options」整份覆盖
            // settings.json 而意外清空 passwordHash / passwordSalt / pairCode 等字段。
            // 曾因测试脚本 new WebStore({}) 后写盘，把真实口令哈希冲成测试口令。
            // 内存中的值优先，因此正常改口令 / 换发配对码 / 删设备仍然生效。
            let onDisk = {};
            try {
                onDisk = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
            }
            catch { }
            writeFileSync(SETTINGS_PATH, JSON.stringify({ ...onDisk, ...this.options }, null, 2), 'utf8');
        }
        catch { }
    }
    /* ── 会话与标记 ───────────────────────── */
    /**
     * 创建会话。
     * @param persistent 是否「保持登录」：true 时给会话设置 24h 绝对过期时间
     *   （配合下发的 Max-Age=86400 Cookie，浏览器关闭后 24h 内仍可直入界面）。
     *   默认 false，保持旧的「会话级 Cookie」语义，向下兼容所有现有调用方。
     */
    createSession(remote, persistent = false) {
        const token = randomUUID().replace(/-/g, '');
        const now = Date.now();
        const expiresAt = persistent ? now + 24 * 60 * 60 * 1000 : 0;
        this.sessions.set(token, { remote, createdAt: now, expiresAt });
        this.persistSessions();
        return token;
    }
    getSession(token) {
        if (!token)
            return null;
        const sess = this.sessions.get(token);
        if (!sess)
            return null;
        // 绝对过期：即使 Cookie 被人为留存 / 时钟回拨，服务端也不认过期会话。
        if (sess.expiresAt && Date.now() > sess.expiresAt) {
            this.sessions.delete(token);
            this.persistSessions();
            return null;
        }
        return sess;
    }
    markSeen(token, deviceId) {
        const s = this.sessions.get(token);
        if (!s)
            return;
        s.deviceId = deviceId;
        this.sessions.set(token, s);
        this.persistSessions();
    }
    revokeSession(token) {
        const ok = this.sessions.delete(token);
        if (ok)
            this.persistSessions();
        return ok;
    }
    /**
     * 删除单个设备：从 options.devices 移除，并撤销所有绑定该 deviceId 的会话。
     * 必须连会话一起撤销 —— 否则被删设备仍持有有效会话可继续访问，且网关的
     * ensureDeviceRegistered 因 sess.deviceId 已存在不会重新登记，表现为「删不掉」。
     */
    deleteDevice(id) {
        const devices = Array.isArray(this.options.devices) ? this.options.devices : [];
        const next = devices.filter((d) => !d || d.id !== id);
        if (next.length === devices.length)
            return false;
        this.updateOptions({ devices: next });
        this.revokeSessionsForDevices(new Set([id]));
        return true;
    }
    /**
     * 一键删除所有远程设备：可保留 keepId（当前会话绑定设备，避免把操作者自己踢下线）。
     * 返回被删除的设备数量。
     */
    deleteRemoteDevices(keepId) {
        const devices = Array.isArray(this.options.devices) ? this.options.devices : [];
        const removed = new Set();
        const kept = devices.filter((d) => {
            if (keepId && d && d.id === keepId)
                return true;
            if (d)
                removed.add(d.id);
            return false;
        });
        if (removed.size === 0)
            return 0;
        this.updateOptions({ devices: kept });
        this.revokeSessionsForDevices(removed);
        return removed.size;
    }
    /** 撤销 deviceId 命中给定集合的所有会话，并持久化 sessions.json。 */
    revokeSessionsForDevices(ids) {
        let changed = false;
        for (const [token, sess] of this.sessions) {
            if (sess.deviceId && ids.has(sess.deviceId)) {
                this.sessions.delete(token);
                changed = true;
            }
        }
        if (changed)
            this.persistSessions();
    }
    loadSessions() {
        try {
            const raw = readFileSync(SESSIONS_PATH, 'utf8');
            const parsed = JSON.parse(raw);
            const now = Date.now();
            for (const [k, v] of Object.entries(parsed || {})) {
                const sess = v;
                // 服务重启后不复活已过期的「保持登录」会话，否则关掉浏览器再开仍能直入。
                if (sess && sess.expiresAt && now > sess.expiresAt)
                    continue;
                this.sessions.set(k, sess);
            }
        }
        catch { }
    }
    persistSessions() {
        try {
            mkdirSync(SETTINGS_DIR, { recursive: true });
            const obj = {};
            this.sessions.forEach((v, k) => {
                obj[k] = v;
            });
            const tmp = SESSIONS_PATH + '.tmp';
            writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
            renameSync(tmp, SESSIONS_PATH);
        }
        catch { }
    }
}
