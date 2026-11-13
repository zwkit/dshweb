# dshweb

[中文](#中文) | [English](#english)

---

## 中文

**dshweb** 是 [DeepSeek Harness (DSH)](https://github.com/DeepSeek-AI) 的一个插件，让你在**同一局域网（或虚拟私网 / 经反向代理）**里，用手机、平板、另一台电脑的浏览器，访问桌面端那套**官方 Web GUI**，并获得移动优先的界面适配。

它不重写、不 fork 官方前端，而是起一个**反向代理网关**，把官方 Web 原样转发出来，再按需注入移动端/桌面端的样式与少量增强脚本。桌面 GUI 本机访问保持原样，不受影响。

> 项目状态：个人自研插件，`0.1.0`。与 `dsh-remote` 无依赖、无耦合。

### 功能

- **远程接入**：网关默认监听 `0.0.0.0:3180`（HTTP），把官方 Web GUI 反代到局域网/虚拟私网 IP，外部设备浏览器直接打开即可。
- **HTTPS 共存**：默认同时监听 `3181`（HTTPS，自签证书，端口可改）；HTTP 与 HTTPS 并存互不干扰。HTTPS 端口被占用时自动降级为仅 HTTP。
  - 缺省（配置里没有 `httpsEnabled` 字段）视为**开启**；仅显式 `httpsEnabled: false` 时关闭。
  - 证书用纯 Node `crypto` 手写 ASN.1 DER 自签 X.509 生成，SAN 包含 `localhost` / `127.0.0.1` / 本机 LAN IPv4，**不依赖 openssl**，缓存于 `~/.dsh/dshweb/tls.cert.pem` 与 `tls.key.pem`。
- **移动优先适配**：`data-remote="mobile"` 下注入移动端 CSS（输入卡、顶部净空、状态栏同色、PWA 图标/manifest 等）；`data-remote="desktop"` 下注入桌面端顶栏对齐 CSS。
- **连接韧性**：HTML 内联增强脚本放宽 generation ready 超时、30s 探活、卡死自动恢复，应对 Cloudflare / 慢链路下 WebSocket 握手慢导致的「重新连接中」。
- **官方鉴权兼容**：网关为已登录会话在「网关 → 核心」这一跳自动铸造并注入 DSH 官方签名 Cookie（`BrowserAuth`），解决外部浏览器直连核心 `401 dsh web authentication required`；客户端永远拿不到该 Cookie。`index.ts` 另有一套独立的 connection 鉴权接管作二次兜底。
- **登录与设备**：
  - 永久登录口令（sha256 加盐哈希）；
  - 6 位短期配对码（5 分钟有效、期内最多成功配对 5 次、连续输错 5 次作废）；
  - 会话 Cookie `dshweb_session`（`HttpOnly` / `SameSite=Lax`，可选「保持登录」24h）；
  - 「远程设备」页：列出已配对设备、在线标记、当前设备高亮、删除设备。
- **设置页**（DSH 设置 →「远程控制 / dshweb」，两个页签「接入」「远程设备」）：
  - HTTP / HTTPS 端口、HTTPS 开关、登录口令、配对码生成与展示；
  - 接入地址（HTTP / HTTPS）一键复制；
  - 域名白名单 `trustedHosts`（防 DNS-Rebinding，仅裸主机名匹配）；
  - 字体与文字缩放；重载网关按钮。
- **PWA**：自带 `pwa-manifest.json` 与图标（内容 hash 版本化的 URL），可「添加到主屏幕」。
- **远程目录选择器**：网关自持 `/api/dshweb/directory/list` 与 `/directory/create`，供远程浏览器选择/新建工作区目录。

### 安装

dshweb 是一个 DSH **bundle 插件**（通过 `cordis.patch.yml` 注入）。需要 Node.js `>=18`。

#### 方式 A：本地 `file:` 依赖（开发期推荐）

```bash
# 1) 取得源码
git clone https://github.com/zwkit/dshweb.git
cd dshweb

# 2) 生成 lib/（首次或改过 src/ 后）
npm install
npm run build

# 3) 把构建产物复制安装到本机 DSH profile（两处物理副本）
npm run deploy
```

`npm run deploy` 默认把产物复制到：

- `~/.dsh/dshweb-plugin`（canonical）
- `~/.dsh/profiles/desktop/node_modules/dshweb`（profile 的 `node_modules` 下，加载器按包名解析）

两者是**同一次构建的逐文件物理副本，不是软链接 / junction**。这是刻意的：运行态必须完全落在 C 盘（开发盘 `D:\` 是 iSCSI 挂载时尤其重要），且不依赖任何链接。

> 本机 profile 的 `package.json` 里需把本插件登记为 `file:` 依赖并列入 `dsh.profile.bundles`（`deploy` 脚本只负责复制文件，不会改 profile 的注册信息）。

#### 方式 B：GitHub / git 依赖（发布后）

把 profile 里的依赖从 `file:...` 改成 git 依赖即可：

```json
{
  "dependencies": {
    "dshweb": "github:zwkit/dshweb"
  }
}
```

```bash
npm update dshweb
```

仓库已随源码提交 `lib/` 编译产物，并配置了 `prepare` 钩子：git 依赖安装时若本机缺少构建工具链，会直接沿用已提交的 `lib/`，不会让安装失败。更新回路：`git push` → `npm update dshweb` → 重启 DSH（或触发插件重载）。

#### 方式 C：npm registry（已发布的作用域包）

本插件已在 npm 上以作用域包 [`@zwkit/dshweb`](https://www.npmjs.com/package/@zwkit/dshweb) 发布（裸名 `dshweb` 被 npm 判定与占位包 `dsh-web` 过近，故采用作用域名）。把 profile 里的依赖改成：

```json
{
  "dependencies": {
    "dshweb": "npm:@zwkit/dshweb@^0.1.0"
  }
}
```

```bash
npm install
```

包名别名 `dshweb` 仅供加载器按包名解析；实际来源是作用域包。注意：本地 `file:` 开发模式（方式 A）与这里的 npm 安装互不冲突，二者择一即可。

### 使用

1. 安装并重启 DSH，让插件加载。
2. 在**桌面端 DSH 设置**里打开「远程控制 / dshweb」：
   - 设置一个登录口令（至少 6 位），或生成一个 6 位配对码；
   - 记下「接入地址」（HTTP 与 HTTPS 两个），按需调整端口 / 域名白名单。
3. 在同一局域网（或虚拟私网、或经你配置好的反向代理）的手机 / 平板 / 另一台电脑浏览器里打开接入地址：
   - `http://<局域网IP>:3180`
   - `https://<局域网IP>:3181`（自签证书，首次需在浏览器里信任）
4. 用口令或配对码登录，即可看到官方 Web GUI 的移动适配版本。
5. 勾选「保持登录」可保留会话 24h；否则为浏览器会话级，关闭即失效。

> **域名接入**：通过域名/反向代理访问时，必须把域名加入设置页的「域名白名单」，否则网关会因 `Host` 不在白名单而拒绝（防 DNS-Rebinding）。`localhost` 与 IP 直连不受此限制。
>
> **浏览器缓存**：客户端 bundle 以 `cache-control: immutable` 提供，改过 UI 后手机/桌面都要**硬刷新**（`Ctrl+Shift+R`）。

### 配置

配置持久化在 `~/.dsh/dshweb/`：

| 文件 | 内容 |
| --- | --- |
| `settings.json` | 端口、HTTPS 开关/端口、口令盐哈希、配对码状态、设备记录、字体、域名白名单等 |
| `sessions.json` | 会话标记映射（用于在线设备列表与当前设备高亮） |
| `tls.cert.pem` / `tls.key.pem` | 自签 HTTPS 证书缓存 |

主要配置项（见 `src/store.ts` 的 `WebOptions`）：

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `port` | `3180` | HTTP 网关监听端口 |
| `httpsEnabled` | 缺省开启 | 显式 `false` 关闭 HTTPS 共存 |
| `httpsPort` | `3181` | HTTPS 监听端口（独立于 HTTP） |
| `corePort` | 自动探测 | 上游 DSH Web GUI 回环端口 |
| `tlsCertPath` / `tlsKeyPath` | — | 可选，使用自有证书替代自签证书 |
| `passwordHash` / `passwordSalt` | — | 永久登录口令的加盐哈希 |
| `pairCode` | — | 当前短期配对码状态 |
| `devices` | `[]` | 已配对设备记录 |
| `fontFamily` / `fontScale` | — | 显示字体与缩放（100 = 默认） |
| `trustedHosts` | `[]` | 允许接入的域名白名单 |

### 开发

```bash
npm install          # 安装 devDependencies（typescript / esbuild / @types/node / prettier）
npm run build        # 可移植构建：tsc + esbuild + 包装 client.js + 拷 PWA 资源 → lib/（不碰任何本机路径）
npm run deploy       # 本地部署：构建 + 把产物物理复制到 ~/.dsh 两处
npm run typecheck    # tsc --noEmit
npm test             # 运行 test/ 下全部测试
```

构建细节见 [scripts/README.md](scripts/README.md)。

#### 热重载边界（重要）

- 改 `src/gateway/server.ts` → 可热生效：`POST /api/dshweb/reload {}` 或设置页「重载网关」按钮，会击穿 `server.js` 的 ESM 缓存（`index.ts` 用 `await import('./gateway/server.js?dshweb_reload=...')`）。
- 改 `src/index.ts` / `src/store.ts` / `src/routes/api.ts` / 客户端 UI → **必须重启 DSH** 才能加载新代码。
- 改客户端 UI 后，浏览器还需硬刷新以越过 immutable 缓存。

#### 目录结构

```
src/
  index.ts                 插件入口：启动网关、注册宿主路由、connection 鉴权接管
  store.ts                 配置/会话持久化（settings.json / sessions.json）
  connection-auth-state.ts 连接鉴权状态
  auth/
    credentials.ts         口令加盐哈希
    pair-code.ts           6 位短期配对码
  gateway/
    server.ts              反向代理网关、HTML 注入、自持 API、CSRF/官方 Cookie 处理
    cert.ts                纯 Node crypto 自签 X.509 证书
  routes/
    api.ts                 宿主路由（桌面 GUI 本机访问）
    register.ts            路由注册
  styles/
    mobile.ts / desktop.ts 移动端 / 桌面端 CSS（由 server.ts 内联注入）
  client/
    index.jsx              设置页 React UI（接入 / 远程设备）
lib/                       已提交的编译产物（含 client.js / client.raw.js / *.d.ts）
assets/                    PWA 图标与 manifest
scripts/                   构建脚本、PWA 图标生成
test/                      测试（口令/配对码、store、路由、网关、客户端 UI、HTTPS 集成）
cordis.patch.yml           bundle 注入声明
```

#### 主要 API

宿主路由（桌面 GUI 本机访问，注册到 DSH WebServer）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dshweb/status` | 网关状态、端口、接入地址、HTTPS 信息、口令/白名单回显 |
| POST | `/api/dshweb/config` | 更新端口 / 口令 / HTTPS / 显示 / 白名单 |
| GET/POST | `/api/dshweb/pair-code` | 生成 / 查询配对码 |
| GET | `/api/dshweb/devices` | 已配对设备列表（含在线标记） |
| POST | `/api/dshweb/display` | 显示设置 |
| POST | `/api/dshweb/reload` | 热重载网关（仅 `server.ts`） |
| POST | `/api/dshweb/delete-device` | 删除设备（仅桌面 GUI 直连） |
| POST | `/api/dshweb/delete-remote-devices` | 批量删除远程设备 |

网关自持（外部设备经 `:3180` 访问）：

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/dshweb/status` | 网关状态（无会话要求，回环 Origin 开放只读 CORS） |
| GET/POST | `/api/dshweb/login` | 登录页 / 提交凭据 |
| GET | `/api/dshweb/session` | 会话探活（只读，401 回登录页） |
| GET | `/api/dshweb/directory/list` | 远程目录列表 |
| POST | `/api/dshweb/directory/create` | 远程新建目录 |
| GET | `/api/dshweb/manifest` / `pwa-icons` | PWA manifest / 图标 |
| POST | `/api/dshweb/top-probe` | 真机布局探针上报 |

### 安全说明

- **网关直接对外**，所有写请求在网关侧做统一同源（CSRF）校验；注入官方 Cookie 后，宿主 `config` / `pair-code` / `display` / `reload` 等写路由不再受核心围栏保护，因此网关必须补这层校验。
- **域名白名单**：默认全拒绝域名接入，只放行 `trustedHosts` 里的裸主机名，防 DNS-Rebinding；`localhost` 与 IP 直连不受影响。
- **删除设备**：仅「桌面 GUI 直连核心、不带 `dshweb_session`」的请求可执行；任何经网关接入的远程浏览器一律 403，与客户端隐藏删除控件互为纵深防御。
- **官方 Cookie 不下发浏览器**：`buildProxyHeaders` 只在「网关 → 核心」这一跳为已登录会话注入铸造的官方签名 Cookie。
- **代理头成对虚拟化**：`host` / `origin` / `referer` / `sec-fetch-site` 一起改写，并剥离 `x-forwarded-*`，以通过核心的 CSWSH / CSRF 围栏（否则 WebSocket 升级 403）。
- **口令**：仅存 sha256 加盐哈希；配对码短期、限次、防暴破。
- **HTTPS**：自签证书，首次访问需手动信任；正式对外建议前置可信反向代理或使用自有证书（`tlsCertPath` / `tlsKeyPath`）。

### 许可证

[MIT](LICENSE)

---

## English

**dshweb** is a [DeepSeek Harness (DSH)](https://github.com/DeepSeek-AI) plugin that lets you open the **desktop's official Web GUI** from a phone, tablet, or another computer's browser over the **same LAN (or VPN / reverse proxy)**, with a mobile-first UI adaptation.

It does not rewrite or fork the official frontend. Instead it runs a **reverse-proxy gateway** that forwards the official Web as-is and injects mobile/desktop styles plus a small enhancement script on demand. The local desktop GUI is untouched.

> Status: personal plugin, `0.1.0`. No dependency on or coupling with `dsh-remote`.

### Features

- **Remote access**: gateway listens on `0.0.0.0:3180` (HTTP) and reverse-proxies the official Web GUI to a LAN/VPN IP.
- **HTTPS coexistence**: also listens on `3181` (HTTPS, self-signed, configurable) by default; HTTP and HTTPS coexist. If the HTTPS port is taken it gracefully falls back to HTTP-only. Certificate is a pure-Node-`crypto` ASN.1 DER self-signed X.509 (SAN: `localhost`, `127.0.0.1`, LAN IPv4), **no openssl needed**, cached under `~/.dsh/dshweb/`.
- **Mobile-first adaptation** plus desktop top-bar alignment CSS.
- **Connection resilience** for slow WebSocket handshakes (Cloudflare / slow links).
- **Official auth compatibility**: the gateway mints and injects the DSH official signed Cookie (`BrowserAuth`) on the gateway→core hop for logged-in sessions, fixing `401 dsh web authentication required` for external browsers. The Cookie is never sent to the browser.
- **Login & devices**: permanent password (salted sha256), 6-digit short-lived pairing code (5 min / 5 uses / 5 fails lockout), `dshweb_session` cookie, device list with online markers.
- **Settings page** (DSH Settings → Remote Control): ports, HTTPS toggle, password, pairing code, copyable access URLs, `trustedHosts` domain allowlist (DNS-Rebinding protection), font settings, reload button.
- **PWA** manifest and icons (content-hash-versioned URLs).

### Install

Requires Node.js `>=18`. It's a DSH **bundle plugin** (`cordis.patch.yml`).

**Local `file:` dependency (development):**

```bash
git clone https://github.com/zwkit/dshweb.git && cd dshweb
npm install && npm run build
npm run deploy          # copy artifacts into ~/.dsh (two physical copies)
```

`npm run deploy` copies to `~/.dsh/dshweb-plugin` and `~/.dsh/profiles/desktop/node_modules/dshweb` — two **physical copies, not symlinks/junctions** (runtime must live entirely on the system drive, no links).

**GitHub/git dependency (after publishing):** set `"dshweb": "github:zwkit/dshweb"` in the profile's `package.json`, then `npm update dshweb`. Committed `lib/` + a `prepare` hook keep git installs working without a local toolchain.

**npm registry (published scoped package):** the plugin is published on npm as the scoped package [`@zwkit/dshweb`](https://www.npmjs.com/package/@zwkit/dshweb) (the bare name `dshweb` is rejected by npm as too similar to the placeholder package `dsh-web`, hence the scoped name). Set the profile dependency to:

```json
{
  "dependencies": {
    "dshweb": "npm:@zwkit/dshweb@^0.1.0"
  }
}
```

```bash
npm install
```

The `dshweb` alias is only for the loader's package-name resolution; the actual source is the scoped package. The local `file:` development setup and this npm install are mutually exclusive — pick one.

### Usage

1. Install and restart DSH.
2. In desktop DSH Settings → Remote Control / dshweb: set a password (min 6 chars) or generate a pairing code; note the HTTP/HTTPS access URLs; adjust ports / allowlist as needed.
3. Open the access URL from a browser on the same LAN/VPN: `http://<LAN-IP>:3180` or `https://<LAN-IP>:3181` (trust the self-signed cert on first visit).
4. Log in with the password or pairing code.

When accessing through a **domain / reverse proxy**, add the domain to the **domain allowlist** in settings or the gateway rejects it (DNS-Rebinding protection). `localhost` and direct IP access are unaffected. Client bundle is served with `cache-control: immutable` — hard-refresh (`Ctrl+Shift+R`) after UI changes.

### Config

Persisted in `~/.dsh/dshweb/settings.json` (ports, HTTPS, password hash, pairing code, devices, font, allowlist) and `sessions.json` (session markers). TLS cert/key cached as `tls.cert.pem` / `tls.key.pem`.

Key options (`src/store.ts` `WebOptions`): `port` (3180), `httpsEnabled` (default on), `httpsPort` (3181), `corePort` (auto), `tlsCertPath` / `tlsKeyPath`, `passwordHash` / `passwordSalt`, `pairCode`, `devices`, `fontFamily` / `fontScale`, `trustedHosts`.

### Development

```bash
npm install
npm run build        # portable: tsc + esbuild + wrap client.js + PWA assets -> lib/ (no machine paths)
npm run deploy       # build + physical copy into ~/.dsh
npm run typecheck
npm test
```

See [scripts/README.md](scripts/README.md) for build details.

**Hot-reload boundary:** changing `src/gateway/server.ts` can be hot-reloaded via `POST /api/dshweb/reload {}` (busts `server.js` ESM cache). Changes to `index.ts` / `store.ts` / `routes/api.ts` / client UI require a **DSH restart**; UI changes also need a browser hard-refresh.

### Security

All write requests get a same-origin (CSRF) check at the gateway (host config/pair-code/display/reload routes lose core fence protection once the official Cookie is injected). Domain allowlist defaults to deny-all. Device deletion is restricted to local desktop GUI requests (no `dshweb_session`). The official Cookie is injected only on the gateway→core hop. Proxy headers (`host`/`origin`/`referer`/`sec-fetch-site`) are virtualized together and `x-forwarded-*` stripped to pass the core CSWSH/CSRF fence. Passwords are stored as salted sha256. HTTPS uses a self-signed cert (trust on first use) — put a trusted reverse proxy in front or supply your own cert for production exposure.

### License

[MIT](LICENSE)
