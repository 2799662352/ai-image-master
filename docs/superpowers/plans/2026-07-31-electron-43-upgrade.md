# Electron 43 升级 Implementation Plan（Phase 0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Electron 从 41.2.1 升到 43.2.0，脱离 2026-08-25 的 EOL 窗口，且不改动任何业务代码。

**Architecture:** 这是一次纯配置升级。改动只落在四个面：CI 的 Node 版本、`package.json` 的依赖与 postinstall、`electron.vite.config.ts` 的构建 target、以及一次真实打包加启动冒烟。之所以能这么小，是因为 41→43 全程在 `net` / `session` / `DownloadItem` / `protocol` / `webContents` / `utilityProcess` / `contextBridge` 上**零破坏性变更**（已逐条核对 42.0 与 43.0 两节 breaking-changes，并逐行比对 41-x-y 与 43-x-y 的 API 文档）。真正的风险集中在构建链和原生模块 ABI。

**Tech Stack:** Electron 43.2.0（Chromium 150.0.7871.129 / Node v24.18.0 / V8 15.0 / ABI 148）、electron-vite 5.0.0、electron-builder 26.4.0、pnpm 10.12.4、Vitest、GitHub Actions。

设计依据：`docs/superpowers/specs/2026-07-31-electron-43-upgrade-and-streaming-downloads-design.md`

## Global Constraints

- 目标 Electron 版本：`^43.2.0`。不升到 42——42 的 EOL 是 2026-10-20，升过去两个半月后要再升一次。
- CI Node 版本必须 ≥ `22.12.0`（`electron@43.2.0` 的 `engines.node` 声明）。本计划统一用 `'22'`。
- **不改任何业务代码。** 本阶段只动配置。任何"顺手改一下"都属于越界，会污染升级的归因。
- `typecheck:ci` 债务门禁必须 0 新增。
- 不动 `clearStorageData` 的三处调用（已核实均未使用被移除的 `quotas`）。
- 不动 `net.fetch` 的绕行实现（electron/electron#42244 至今 open）。
- 每个 Task 结束即提交，提交信息用中文，遵循仓库现有的 `type(scope): 描述` 风格。

---

## File Structure

本阶段不新建任何文件。修改清单：

| 文件 | 责任 | 改什么 |
| --- | --- | --- |
| `.github/workflows/_quality-gates.yml` | PR 质量门禁（6 个 job） | `node-version` ×6 |
| `.github/workflows/_windows-release-build.yml` | Windows 打包 | `node-version` ×1 |
| `.github/workflows/release.yml` | 发版流水线 | `node-version` ×5 |
| `.github/workflows/nonblocking-quality.yml` | 非阻塞检查 | `node-version` ×4 |
| `.github/workflows/rollback-hot-update.yml` | 热更新回滚 | `node-version` ×1 |
| `.github/workflows/migrate-release-baseline.yml` | 发版基线迁移 | `node-version` ×1 |
| `.github/workflows/pages.yml` | 文档站 | `node-version` ×1 |
| `.github/workflows/codex-auto-update.yml` | codex 二进制自动更新 | `node-version` ×1（值是 `'20.x'`） |
| `package.json` | 依赖与安装钩子 | `electron` 版本、`postinstall` |
| `electron.vite.config.ts` | 构建产物 target | `node18`×2、`chrome120`×1 |

合计 8 个 workflow 文件、20 处 `node-version`。

---

## Task 1: CI Node 20 → 22（仍在 Electron 41 上）

先单独把 Node 抬上去，**这一步不碰 Electron**。这样如果 Node 22 本身破坏了什么（原生模块、pnpm 行为、某个脚本），能在没有 Electron 换代干扰的情况下暴露出来。

**Files:**
- Modify: `.github/workflows/_quality-gates.yml:39,64,85,116,141,162`
- Modify: `.github/workflows/_windows-release-build.yml:62`
- Modify: `.github/workflows/release.yml:72,131,184,347,463`
- Modify: `.github/workflows/nonblocking-quality.yml:29,63,97,131`
- Modify: `.github/workflows/rollback-hot-update.yml:45`
- Modify: `.github/workflows/migrate-release-baseline.yml:47`
- Modify: `.github/workflows/pages.yml:41`
- Modify: `.github/workflows/codex-auto-update.yml:38`

**Interfaces:**
- Consumes: 无
- Produces: CI runner 的 Node 版本为 22.x，Task 2 的 `electron@43.2.0` 安装依赖此前提。

- [ ] **Step 1: 确认当前状态**

```powershell
rg -n "node-version" .github/workflows
```

Expected: 20 处匹配，19 处是 `node-version: '20'`，`codex-auto-update.yml:38` 是 `node-version: '20.x'`。

- [ ] **Step 2: 全量替换**

把所有 `node-version: '20'` 改为 `node-version: '22'`，把 `codex-auto-update.yml:38` 的 `node-version: '20.x'` 改为 `node-version: '22.x'`（保留该文件原有的 `.x` 写法，不要统一——它是独立的自动更新流水线，改写法等于顺手动了无关的东西）。

- [ ] **Step 3: 验证没有遗漏**

```powershell
rg -n "node-version: '20" .github/workflows
```

Expected: 无输出（退出码 1）。

```powershell
rg -n "node-version" .github/workflows
```

Expected: 仍是 20 处，全部为 `'22'` 或 `'22.x'`。

- [ ] **Step 4: 本地验证 Node 22 下依赖能装、测试能跑**

```powershell
node --version
pnpm install
pnpm run test:run
```

Expected: `node --version` 输出 `v22.*`（若不是，用 nvm-windows 切过去：`nvm install 22.12.0 && nvm use 22.12.0`）；install 成功；测试全绿。

已知 flaky：`src/renderer/src/services/pipeline/__tests__/` 下的 DirectorPipeline 用例在机器负载高时会超时，单独重跑通过即可视为通过。这是既有问题，不是本次改动引入的。

- [ ] **Step 5: 提交**

```powershell
git add .github/workflows
git commit -m "ci: Node 20 升到 22,为 Electron 43 让路"
```

- [ ] **Step 6: 开草稿 PR 让 CI 实跑一轮**

`ci.yml` 只在 `pull_request` 指向 `main`（或 push 到 main/develop）时触发——**只推分支不会跑任何 CI**，必须开 PR。用草稿 PR，后续 Task 2–4 的提交继续推到同一个分支上，最后再转正式。

```powershell
git push -u origin HEAD
gh pr create --draft --base main --title "chore(deps): Electron 41 升到 43" --body "Phase 0 执行中,按 docs/superpowers/plans/2026-07-31-electron-43-upgrade.md 推进。Task 1(CI Node 20→22)已提交,先让 CI 单独验证这一步。"
gh pr checks <PR 号>
```

Expected: Quality Gate 全绿。**这一轮必须绿了再进 Task 2**——它证明 Node 22 本身没问题，后面出的任何问题都能明确归因到 Electron 换代。

---

## Task 2: Electron 41.2.1 → 43.2.0 与 postinstall 兜底

**Files:**
- Modify: `package.json:46`（`postinstall`）、`package.json:184`（`electron` 依赖）

**Interfaces:**
- Consumes: Task 1 产出的 Node 22 环境
- Produces: `node_modules/electron` 为 43.2.0，且 `node_modules/electron/path.txt` 在 `pnpm install` 之后存在（Task 3 的 electron-vite 构建依赖它）

### 背景：为什么必须加 postinstall

Electron 42 起，npm 包不再通过 `postinstall` 下载二进制（供应链安全，RFC #22），改为首次运行 `bin` 脚本时按需下载。而 `electron-vite@5.0.0` 的 `getElectronPath()` 读 `node_modules/electron/path.txt`，读不到就直接 `throw new Error('Electron uninstall')`——`dev`、`build`、`preview` 三条命令**全部会挂**。官方修复 PR（alex8088/electron-vite#905）至今未合并，官方文档也没有任何 Electron 42+ 的适配说明。

Electron 42+ 的 npm 包提供了 `install-electron` 这个 bin（内容与原 postinstall 脚本完全相同），我们自己调它来补上 `path.txt`。

**注意官方示例里的 `--no`：** 文档写的是 `npx install-electron --no`，那个 `--no` 是 **npx 的参数**（等价 `--no-install`，让 npx 不去远程拉包）。在 `package.json` 的 `scripts` 里调用时是直接走 `node_modules/.bin`，不经过 npx，**不要带这个 flag**，否则会被当成传给脚本本身的参数。

- [ ] **Step 1: 确认当前状态**

```powershell
node -p "require('./package.json').devDependencies.electron"
node -p "require('./package.json').scripts.postinstall"
```

Expected:
```
^41.2.1
prisma generate && electron-builder install-app-deps
```

- [ ] **Step 2: 改 `package.json`**

把 `devDependencies.electron` 从 `"^41.2.1"` 改为 `"^43.2.0"`。

把 `scripts.postinstall` 改为：

```json
"postinstall": "install-electron && prisma generate && electron-builder install-app-deps"
```

`install-electron` 放最前面：后面两步（prisma generate 与 install-app-deps）都可能需要 Electron 二进制已就位，`install-app-deps` 尤其如此——它要按 Electron 的 ABI 去重建原生模块。

- [ ] **Step 3: 重装依赖**

```powershell
pnpm install
```

Expected: 安装成功，输出里能看到 Electron 二进制的下载进度。**如果这里报 `install-electron: command not found`**，说明 electron 包没装上或版本没到 42+，先 `node -p "require('electron/package.json').version"` 确认。

- [ ] **Step 4: 验证二进制与 `path.txt` 都到位**

```powershell
node -p "require('electron/package.json').version"
Test-Path node_modules/electron/path.txt
npx electron --version
```

Expected:
```
43.2.0
True
v43.2.0
```

`path.txt` 那条是**这个 Task 的核心断言**——它在就说明 electron-vite 不会挂。

- [ ] **Step 5: 验证 electron-vite 三条命令都不再抛 `Electron uninstall`**

```powershell
pnpm run build:vite
```

Expected: 构建成功。若抛 `Error: Electron uninstall`，说明 `path.txt` 没生成，回到 Step 3 排查。

- [ ] **Step 6: 跑全量测试与类型检查**

```powershell
pnpm run test:run
pnpm run typecheck:ci
```

Expected: 测试全绿（DirectorPipeline 的 flaky 同 Task 1 处理）；typecheck 输出 `Typecheck debt gate passed: ... 0 new`。

- [ ] **Step 7: 提交**

```powershell
git add package.json pnpm-lock.yaml
git commit -m "chore(deps): Electron 41.2.1 升到 43.2.0,并自行触发二进制下载"
```

---

## Task 3: 构建 target 对齐 Electron 43 的运行时

**Files:**
- Modify: `electron.vite.config.ts:16`（main，`target: 'node18'`）
- Modify: `electron.vite.config.ts:89`（preload，`target: 'node18'`）
- Modify: `electron.vite.config.ts:113`（renderer，`target: 'chrome120'`）

**Interfaces:**
- Consumes: Task 2 产出的 Electron 43.2.0
- Produces: 构建产物按 Node 24 / Chrome 150 生成，Task 4 的打包基于此

### 背景

显式写死 target 这件事本身是对的——它让我们躲过了 electron-vite 版本表只更新到 Electron 39、查不到就兜底取**最老项**（`node16.17` / `chrome108`）的坑。但 `node18` / `chrome120` 对 Electron 43 的 Node 24.18 / Chrome 150 来说过旧，会白白降级转译、产物变大。

- [ ] **Step 1: 确认当前状态**

```powershell
rg -n "target: 'node18'|target: 'chrome120'" electron.vite.config.ts
```

Expected: 三处匹配，行号分别是 16、89、113。

- [ ] **Step 2: 改 target**

`electron.vite.config.ts:16` 与 `:89`：

```ts
      target: 'node24',
```

`electron.vite.config.ts:113`：

```ts
      target: 'chrome150',
```

- [ ] **Step 3: 验证改动生效且构建通过**

```powershell
rg -n "target: 'node24'|target: 'chrome150'" electron.vite.config.ts
pnpm run build:vite
```

Expected: 三处匹配（16、89、113）；构建成功无报错。

- [ ] **Step 4: 跑全量测试**

```powershell
pnpm run test:run
```

Expected: 全绿。target 变化不应影响任何测试；若有用例失败，说明产物行为变了，**停下来查清楚再继续**，不要直接改测试。

- [ ] **Step 5: 提交**

```powershell
git add electron.vite.config.ts
git commit -m "build: 构建 target 对齐 Electron 43 的 Node 24 / Chrome 150"
```

---

## Task 4: 真实打包与启动冒烟

这是本阶段唯一无法由 CI 覆盖的验证，必须本地做，并把结果写进 PR。

**Files:**
- 无代码改动。产出物是 PR 描述里的一段冒烟记录。

**Interfaces:**
- Consumes: Task 1–3 的全部改动
- Produces: 「Electron 43 下原生模块与子进程集成正常」这一结论

### 为什么必须有这一步

Electron ABI 从 145 跳到 148。仓库有两个原生依赖：`sharp`（`@img/sharp-<platform>-<arch>` 提供 `.node`，走 `mediaThumbIpc.ts` 的 `media:thumb` 热路径）和 `@parcel/watcher`。两者都走 N-API，**理论上** ABI 稳定、不受此次跳变影响，且 `electron-builder install-app-deps` 会兜底重建。但"理论上"不等于"实际上"——这类问题的典型表现是打包后启动瞬间崩溃，开发模式下完全看不出来。

- [ ] **Step 1: 打一个真实的 Windows 包**

```powershell
pnpm run build:win
```

Expected: 打包成功，`dist/` 下产出安装包。**过程中留意 `install-app-deps` 有没有报原生模块重建失败。**

- [ ] **Step 2: 装上并启动**

安装 `dist/` 下的产物并启动应用。

Expected: 主窗口正常出现，不闪退。

- [ ] **Step 3: 验证 PGlite worker（utilityProcess）**

在应用里发一条 agent 消息（内容任意，如"你好"）。

Expected: 消息正常发出并收到回复，且不出现 `PrismaClientKnownRequestError` / `P1017`。这条验证的是 `utilityProcess` 起的 PGlite 数据库 worker——41→43 文档比对显示 `utilityProcess` 零破坏性变更，这一步是把"文档说没变"落到"实际没变"。

- [ ] **Step 4: 验证 sharp（原生模块，ABI 敏感）**

打开文件浏览器面板，浏览到一个包含图片的目录，确认缩略图能正常渲染。

Expected: 缩略图出图。**这是整个升级里最可能被 ABI 跳变咬到的地方**——如果这里出图失败或应用崩溃，说明 `@img/sharp-*` 的预编译产物与 ABI 148 不兼容，需要在 `electron-builder.yml` 或 `install-app-deps` 层面处理。

- [ ] **Step 5: 验证 codex 子进程**

启动一次 agent 会话，确认 codex 二进制能被拉起。

Expected: 会话正常建立。

- [ ] **Step 6: 写 PR 正文到临时文件**

新建 `_pr_body.md`（用完即删，不进版本库），内容必须包含四块：

1. 改了哪四个面（CI Node、Electron 依赖与 postinstall、构建 target、冒烟验证）
2. 为什么跳过 42 直接到 43（42 的 EOL 是 2026-10-20，升过去两个半月后要再升一次）
3. 明确**不需要改**的项及其依据：`clearStorageData` 三处均未使用被移除的 `quotas`、代码库无 `toBitmap`/`getBitmap` 调用、未配置 `electronDist`、不发 32 位包、未开启 bytecode、`utilityProcess` 在 41→43 零破坏性变更
4. Step 2–5 的冒烟记录，**逐条写明实际结果**（通过/失败）与打包产物版本号。不要只写"冒烟通过"——下一个升级的人需要知道具体验了哪几个点。

- [ ] **Step 7: 开 PR**

```powershell
gh pr create --base main --title "chore(deps): Electron 41 升到 43" --body-file _pr_body.md
Remove-Item _pr_body.md
```

- [ ] **Step 8: 等 CI 全绿，重点确认 Electron E2E**

```powershell
gh pr checks <PR 号>
```

Expected: 七项全过。其中 **`Quality Gate / Electron Stable E2E` 是本次升级最关键的一道门禁**——它是唯一在真实 Electron 运行时里跑起来的自动化检查，Chromium 从 M146 跨到 M150 带来的渲染层行为差异只有它能挡。

如果 E2E 失败，**不要重跑碰运气**。先看失败用例是不是稳定复现：稳定失败说明 Chromium 换代确实改了行为，需要定位到具体是哪条变更；偶发失败再考虑 flaky。

---

## 回滚

四个 Task 的改动全部集中在配置文件，不涉及业务代码，也没有数据迁移。回滚即 revert 整个 PR，然后 `pnpm install` 回到 41.2.1。

唯一需要留意的是：revert 后 `package.json` 的 `postinstall` 会恢复成不带 `install-electron` 的版本，此时 `node_modules` 里可能仍残留 43 的二进制，需要手动 `rm -r node_modules/electron` 后重装。

## 遗留事项（不在本阶段）

- **43 是最后一个提供 `win32-ia32` 预编译产物的系列**（EOL 2027-01-05）。我们当前不发 32 位包，不受影响，但如果未来要发，需要在 43 EOL 前排期。
- **44 会从渲染进程移除 `clipboard` 模块**。本次不受影响，但下次升级（43→44）要先排查渲染层有没有直接 `require('electron').clipboard`。
- Phase 1（视频下载流式化）与 Phase 2（DownloadItem 迁移）各自单独出计划。
