/**
 * HTTPS 共存默认策略（m01467 用户确认「默认开启」）：
 *   settings.json 缺省（无 httpsEnabled 字段） → 开启；
 *   显式 httpsEnabled:false → 关闭；显式 true → 开启。
 * 该 helper 是 index.ts startGateway() 与 routes/api.ts status 共用的唯一事实来源，
 * 单测锁住它，避免两处默认口径漂移。
 */
import { isolateHome, createRunner } from './_home.mjs';

isolateHome('dshweb-store-defaults');
const { isHttpsEnabledByDefault, DEFAULT_HTTPS_PORT } = await import('../lib/store.js');

const r = createRunner('HTTPS 默认开启策略（store）');

await r.run(async (check) => {
  check('DEFAULT_HTTPS_PORT 为 3181', DEFAULT_HTTPS_PORT === 3181, String(DEFAULT_HTTPS_PORT));
  check('缺省配置（{}）默认开启 HTTPS', isHttpsEnabledByDefault({}) === true);
  check('带其它字段但不带 httpsEnabled 仍默认开启',
    isHttpsEnabledByDefault({ port: 3180, trustedHosts: ['a.com'] }) === true);
  check('显式 httpsEnabled:false 关闭', isHttpsEnabledByDefault({ httpsEnabled: false }) === false);
  check('显式 httpsEnabled:true 开启', isHttpsEnabledByDefault({ httpsEnabled: true }) === true);
  check('httpsEnabled:undefined 视为缺省开启', isHttpsEnabledByDefault({ httpsEnabled: undefined }) === true);
});
