# 上架插件市场的准备材料（本地草稿，尚未提交）

本目录只是**本地暂存**，不属于插件本体，也**没有推送到 GitHub**。
上架动作 = 向目录仓库 `awesome-dsh-plugin/awesome-dsh-plugin` 提一个 PR，
在 `data/plugins/` 下新增一个 YAML 文件。本目录里的 `zwkit__dshweb.yml` 就是那个文件的定稿内容。

- 官方贡献指南：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md
- 目录仓库（提 PR 的目标）：https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
- 我们的仓库：https://github.com/zwkit/dshweb
- 本机市场 `dshmarket@1.73.17` 与 DSH 0.2.1+ 原生「插件 → 发现」读的是同一份目录，收录后通常一天内可见。

## 待提交的文件

`zwkit__dshweb.yml` → 应放到目录仓库的 `data/plugins/zwkit__dshweb.yml`。

```yaml
url: https://github.com/zwkit/dshweb
name: zwkit/dshweb
category: remote
description:
  en: Opens the DeepSeek Harness desktop UI from a phone or tablet browser over the LAN with password and pairing-code login, an HTTPS listener, and PWA support.
  zh: 通过局域网在手机或平板浏览器中打开 DeepSeek Harness 桌面界面，支持口令与配对码登录、HTTPS 监听与 PWA。
icon: https://raw.githubusercontent.com/zwkit/dshweb/main/assets/pwa-icons/icon-192.png
```

校验记录（已用 `yaml` 解析器实跑，10 项全绿）：`url` 与仓库完全一致、`name=owner/repo`、
`category=remote` 在有效取值内、`description.en` 存在且以句号结尾、不含 `: `（否则 YAML 解析失败）、
不含营销词、`description.zh` 以句号结尾、`icon` 是 GitHub 托管的 https 位图、无多余字段。

图标 URL 已实测 `HTTP/1.1 200 OK`（`image/png`，192×192，24645 B，方形）。
SVG 与第三方图床会被拒；备用图：`assets/branding/dsh-app-icon.png`（1024×1024）、
`assets/pwa-icons/apple-touch-icon.png`（180×180）。

描述里每一项声明都已对本仓库源码核对过（评审会按源码逐条核对，不可夸大）：

| 描述用语 | 源码依据 |
| --- | --- |
| LAN / phone or tablet browser | `src/gateway/server.ts:815-823` 注入 `data-remote="mobile\|desktop"` + 移动端/桌面端 CSS + 连接韧性看门狗；`src/gateway/cert.ts` 自签证书 SAN 含本机 LAN IPv4 |
| password login | `src/auth/credentials.ts:12-26` sha256 盐哈希 + 校验 |
| pairing-code login | `src/auth/pair-code.ts:26-30` 配对码 TTL 5min / 最多 5 次成功 / 5 次错误锁定 |
| HTTPS listener | `src/gateway/server.ts:149-185` HTTP 主监听 + HTTPS 副监听共存，默认端口 3181；`src/store.ts` `isHttpsEnabledByDefault()` |
| PWA support | `assets/pwa-manifest.json` + `assets/pwa-icons/*`，`src/gateway/server.ts:538-561` 网关自持 manifest 并对图标 URL 做内容版本化 |

## 硬性条件（当前状态）

| 条件 | 状态 | 说明 |
| --- | --- | --- |
| `package.json` 声明 `dsh.bundle`（仅 `dsh.client` 会被拒） | 通过 | `dsh.bundle.patch=./cordis.patch.yml`，根目录有 `cordis.patch.yml` |
| 真实可用代码 | 通过 | 437 条断言全绿、`lib/` 已提交编译产物 |
| 官方 `@deepseek-ai/*` 用 `peerDependencies` | 通过 | 无运行时依赖，仅本地构建用的 devDependencies |
| 仓库创建满 1 天 | **未达标** | `created_at=2026-11-13T11:34:45Z`，最早 **2026-11-14 19:34:45（北京时间）** 才过 gate；gate 结论是快照，到期自动重跑，不需推空提交 |
| 仓库加 `dsh-plugin` topic | **未做** | 当前 `topics=[]`，需在 GitHub 仓库页或用 API 加 |
| 描述属实、分类贴切、不与已有条目重复 | 需人工评审 | `remote` 分类合适；描述只陈述真实功能，未写数字/API 名 |
| 一个 PR 最多 3 条、只加 1 个文件、别动别人条目 | 待遵守 | 不要手工编辑 README（CI 从 yml 生成） |

## 到期后的执行步骤（尚未执行，等用户确认）

1. **重新走一次 GitHub 设备流授权**：上次发布的临时 `gho_` 令牌已删除。
   用 Node 内置 TLS + 本地代理 `127.0.0.1:7897` 走 `POST /login/device/code`
   （client_id 用 GitHub CLI 的 `178c6fc778ccc68e1d6a`，scope=`repo`，能拿到带 `repo` scope 的 `gho_` 令牌；
   **不要**用 `Iv1.b507a08c87ecfe98`，那是 GitHub App，会出无 scope 的 `ghu_` 令牌导致 `POST /user/repos` 403）。
   用户只需在浏览器打开 https://github.com/login/device 输入一次 user_code。
2. **给 `zwkit/dshweb` 加 topic**：`PUT /repos/zwkit/dshweb/topics` body `{"names":["dsh-plugin"]}`。
3. **建 fork**：`POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/forks`，在 fork 上建分支（如 `add-dshweb`）。
4. **写文件**：`PUT /repos/zwkit/awesome-dsh-plugin/contents/data/plugins/zwkit__dshweb.yml`
   （base64 内容，取自本目录的 `zwkit__dshweb.yml`）。只加这一个文件。
5. **提 PR**：`POST /repos/awesome-dsh-plugin/awesome-dsh-plugin/pulls`，
   `head=zwkit:add-dshweb`、`base=main`，标题如 `Add zwkit/dshweb (remote)`。
6. **CI**：条目数 ≤3 → `dsh.bundle` → 仓库年龄 → `awesome-lint` + 站点构建。
   失败会明确指出要改什么，推同一分支即可，无需重开 PR。
7. **人工评审**：维护者读源码核对描述、分类、是否重复、有无可疑代码。
   需要改动会打 `held: author`，改完推同一分支并留一条评论即可。
8. **合并后**：网站自动重建，市场通常一天内收录。收录 ≠ 安全审查或背书。
9. **收尾**：删除本次临时令牌/脚本；到 https://github.com/settings/applications 可撤销 GitHub CLI 授权。

## 可选加分项（都不影响收录，暂不做）

- **npm 包**：`registry.npmjs.org/dshweb` 返回 404，名字 `dshweb` **未被占用**。
  发布后用户安装免 `allowBuilds` 构建授权、市场显示下载量；`package.json` 的 `repository` 已指回本仓库，满足关联要求。
  不发也行，市场照样从 GitHub 源码安装（`lib/` 已提交 + `prepare` 有沿用兜底）。
- **预构建 tarball**：发 GitHub Release 附 `.tgz`，yml 里加 `tarball:` 字段；
  资产名要不带版本号（用 `latest/download/`），或钉住 release tag。
- **截图 `screenshots.json`**：放在**自家仓库**根、列 1–8 张相对路径图片，市场详情页会像 App Store 一样展示。
  当前 `assets/` 里全是图标 / 图标预览，**没有真实 UI 截图**，因此暂不创建该文件以免展示内容不实；
  等有真机截图后再补（形如 `["assets/screenshot-1.png","assets/screenshot-2.png"]`），
  推自己仓库即可生效，无需再提 PR。不写则市场从 README 自动抽图。

## 本地重新校验命令

```sh
cd /d/DSH/dshweb
NODE_PATH="C:/Users/zou/.dsh/profiles/desktop/node_modules" node -e '
const fs=require("fs"),YAML=require("yaml");
const d=YAML.parse(fs.readFileSync("market/zwkit__dshweb.yml","utf8"));
console.log(d.url,d.name,d.category,d.description.en.endsWith("."),d.icon);'
```
