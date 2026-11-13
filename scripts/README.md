# 构建与部署脚本

本目录包含 dshweb 的构建 / 部署脚本。

| 脚本 | 作用 |
| --- | --- |
| `build.cjs` | 主构建脚本（本文件说明的重点） |
| `gen-pwa-icons.mjs` | 可选：重新生成 `assets/pwa-icons/` 下的 PWA 图标 |

> `assets/pwa-icons/` 已随仓库提交，日常构建与发布**不需要** `gen-pwa-icons.mjs`，也不需要 `jimp`。只有当你想换一套图标时才用它。

---

## `build.cjs`

把 `src/` 编译成可发布的 `lib/`，并可选地部署到本机 DSH profile。

### 设计原则：默认可移植

**默认构建（`node scripts/build.cjs`）只做编译，不碰任何本机 / 个人路径**：

1. `tsc`：`src/**/*.ts` → `lib/**/*.js` + `.d.ts`（用项目内 vendored 的 TypeScript）
2. `esbuild`：`src/client/index.jsx` → `lib/client.raw.js`（bundle、cjs、react external）
3. 把 `lib/client.raw.js` 包装进 `window.__ModuleLoader__.load({ id: "dshweb", factory })` → `lib/client.js`
4. 复制 `assets/pwa-icons/` + `assets/pwa-manifest.json` → `lib/`

这样构建结果可以直接提交进仓库，也能作为 npm 的 `prepare` 钩子在 GitHub / git 依赖安装、CI 等任意平台上安全运行。

### 命令

| 命令 | 等价 | 行为 |
| --- | --- | --- |
| `npm run build` | `node scripts/build.cjs` | 仅编译 → `lib/`（不写本机路径） |
| `npm run deploy` | `node scripts/build.cjs --deploy` | 编译 + 物理复制到本机 DSH profile |
| `npm run prepare` | `node scripts/build.cjs --prepare` | npm 安装钩子（见下） |
| `npm run typecheck` | `tsc --noEmit` | 仅类型检查 |
| `npm test` | `node test/run-all.mjs` | 跑 `test/` 下全部测试 |

环境变量与参数：

| 变量 / 参数 | 作用 |
| --- | --- |
| `--deploy` 或 `DSHWEB_DEPLOY=1` | 启用第 5 步「复制安装」。默认关闭。 |
| `DSHWEB_DEPLOY_DIRS` | 覆盖部署目标，用分号 `;` 或逗号 `,` 分隔多个绝对路径。 |
| `--prepare` | npm git-install 钩子模式：缺工具链但 `lib/` 已提交时，跳过编译沿用产物。 |

### `--prepare` 兜底

`package.json` 里配了 `"prepare": "node scripts/build.cjs --prepare"`。当本插件被当作 `github:` / git 依赖安装时：

- 若本机有 `typescript` / `esbuild`（`npm install` 装好了 devDependencies）→ 正常编译；
- 若工具链缺失但仓库里已提交 `lib/index.js` → 打印 `⏭ prepare: 构建工具不可用，沿用仓库内已提交的 lib/ 产物`，沿用产物，**不让安装失败**；
- 若两者都缺 → 报错退出。

这就是为什么仓库要提交 `lib/`：让 git 依赖安装不依赖目标机器上有构建工具。

### 第 5 步：本机部署（仅 `--deploy`）

默认部署目标（用 `os.homedir()` 拼，**不含任何硬编码用户名 / 盘符**）：

- `~/.dsh/dshweb-plugin`（canonical）
- `~/.dsh/profiles/desktop/node_modules/dshweb`（profile 的 `node_modules` 下，加载器按包名解析）

复制的是 `COPY_FILES` / `COPY_DIRS` 列出的**逐文件物理副本，不是软链接 / junction**：

- 若目标已是链接（`isLink()` 用 `lstatSync` + `nlink` 判断），先删链接再建真实目录；
- 运行态必须完全落在系统盘、不依赖任何链接（开发盘为 iSCSI 挂载时尤其重要）；
- 两处是同一次构建的镜像副本。

> `deploy` 只负责复制文件，**不会修改 profile 的 `package.json`**（`file:` 依赖声明与 `dsh.profile.bundles` 注册需自行在 profile 里配置）。
>
> 自定义目标示例（PowerShell）：
> ```powershell
> $env:DSHWEB_DEPLOY_DIRS = "D:\my\dshweb-plugin;D:\my\profile\node_modules\dshweb"
> npm run deploy
> ```

### 工具链

`build.cjs` 内的 `localTool()` 逻辑只查本项目 `node_modules`：

- `node_modules/typescript/bin/tsc`
- `node_modules/esbuild`（含平台二进制，如 `@esbuild/win32-x64`）
- `tsconfig.json` 的 `typeRoots` 只指向本项目路径

**不会**去 `../dsh-remote` 或任何外部路径找工具。`devDependencies`：

```
@types/node ^26.6.6
esbuild    ^0.28.2
prettier   ^3.10.1
typescript ^7.0.2
```

重装：`npm install` 即可。`typescript@7` 发布的是原生 `tsc` 二进制（不再暴露 `createProgram` / `emit` 的 JS API），因此脚本直接调用 CLI（通过 `spawnSync(process.execPath, [tscBin, ...])`）；`esbuild` 用其 Node API `buildSync`。

> 若你在一个**禁止嵌套进程 spawn** 的受限沙箱里跑 `npm run build`，`spawnSync` 会以 `EPERM` 失败——这是执行环境的限制，不是脚本 bug。可在顶层直接执行：
> ```bash
> node node_modules/typescript/bin/tsc -p tsconfig.json
> ```
> 再单独处理客户端 bundle 的包装。普通机器 / CI / `npm install` 不受影响。

### `gen-pwa-icons.mjs`（可选）

用 `jimp` 从 `icon.svg` 生成各尺寸 PWA 图标到 `assets/pwa-icons/`。

- 优先从本项目 `node_modules/jimp`、其次全局安装查找 `jimp`；找不到时提示 `npm i -D jimp`。
- 产出的图标已随仓库提交，**构建 / 发布不需要它**。

```bash
npm i -D jimp
node scripts/gen-pwa-icons.mjs
```

---

## 发布清单核对

发布 / 打 tag 前建议确认：

1. `lib/` 是最新的（改过 `src/` 后跑过 `npm run build` 或顶层 `tsc`）。
2. `src/` 与 `lib/` 里没有个人绝对路径、没有对 `dsh-remote` 的引用。
3. `package.json` 的 `files` 含 `lib`、`cordis.patch.yml`、`icon.svg`、`README.md`、`LICENSE`。
4. `README.md` / `LICENSE` 存在，`repository.url` 指向正确仓库。
5. `.gitignore` 忽略 `node_modules/`、`*.log`、`.restore/` 等本机产物。
