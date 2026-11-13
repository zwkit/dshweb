/**
 * 测试用 HOME 隔离工具。
 *
 * dshweb 的 lib/store.js 在**模块加载时**就用 os.homedir() 算出
 * ~/.dsh/dshweb/settings.json 与 sessions.json 的路径，所以任何会写盘的测试
 * 都必须在 import 之前把 HOME / USERPROFILE 指到临时目录，否则会覆盖用户真实
 * 配置（历史上真的把真实口令哈希和设备列表冲掉过）。
 *
 * 用法：
 *   import { isolateHome } from './_home.mjs';
 *   const HOME = isolateHome();            // 必须在 import lib/*.js 之前调用
 *   const { WebStore } = await import('../lib/store.js');
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function isolateHome(tag = 'dshweb-test') {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `${tag}-`));
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  // Windows 上 os.homedir() 读 USERPROFILE，POSIX 上读 HOME；断言确保隔离真的生效
  const resolved = os.homedir();
  if (resolved !== home) {
    console.error(`[test] HOME 隔离失败：homedir()=${resolved} 期望=${home}`);
    process.exit(1);
  }
  return home;
}

export function dshwebDir(home) {
  return path.join(home, '.dsh', 'dshweb');
}

/** 极简断言收集器：全部跑完后统一汇总，任一失败则 exit(1) */
export function createRunner(title) {
  const results = [];
  function check(name, cond, extra) {
    const ok = Boolean(cond);
    results.push({ name, ok, extra });
    const mark = ok ? 'PASS' : 'FAIL';
    const detail = ok || extra === undefined ? '' : `  <-- ${String(extra)}`;
    console.log(`  ${mark}  ${name}${detail}`);
    return ok;
  }
  function eq(name, actual, expected) {
    return check(name, actual === expected, `actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`);
  }
  async function run(fn) {
    console.log(`\n=== ${title} ===`);
    try {
      await fn(check);
    } catch (err) {
      check('未捕获异常', false, err && err.stack ? err.stack.split('\n').slice(0, 4).join(' | ') : String(err));
    }
    const passed = results.filter((r) => r.ok).length;
    const total = results.length;
    console.log(`\n${passed}/${total} PASS`);
    if (passed !== total) {
      console.log('失败项：');
      for (const r of results.filter((x) => !x.ok)) console.log(`  - ${r.name}${r.extra === undefined ? '' : ` (${r.extra})`}`);
      process.exit(1);
    }
    return { passed, total };
  }
  return { check, eq, run, results };
}

/** 造一个假的 ServerResponse，收集 writeHead(status, headers) 与 end(body) */
export function fakeResponse() {
  const res = {
    statusCode: 0,
    headers: null,
    body: '',
    finished: false,
    writeHead(status, headers) {
      res.statusCode = status;
      res.headers = headers || {};
      return res;
    },
    setHeader(k, v) {
      res.headers = res.headers || {};
      res.headers[k] = v;
    },
    end(chunk) {
      if (chunk && typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) {
        try {
          res.body = JSON.stringify(chunk);
        } catch {
          res.body = String(chunk);
        }
      } else {
        res.body = chunk ? String(chunk) : res.body;
      }
      res.finished = true;
      return res;
    },
    json() {
      try {
        return JSON.parse(res.body || '{}');
      } catch {
        return null;
      }
    },
  };
  return res;
}

/**
 * 造一个假的 IncomingMessage：以 Readable 承载 JSON body，附带 headers/method/url。
 * 路由层的 readJsonBody 用 req.on('data') 读流，所以必须是真流。
 */
export async function fakeRequest({ method = 'GET', url = '/', headers = {}, body = null } = {}) {
  const { Readable } = await import('node:stream');
  const payload = body === null ? '' : typeof body === 'string' ? body : JSON.stringify(body);
  const req = Readable.from(payload ? [Buffer.from(payload, 'utf8')] : []);
  req.method = method;
  req.url = url;
  req.headers = headers;
  req.socket = { remoteAddress: '127.0.0.1' };
  return req;
}
