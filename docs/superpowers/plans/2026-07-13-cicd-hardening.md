# Windows CI/CD 稳定化与自动发布实施计划

> **执行要求：** 按任务顺序执行；每个任务坚持 RED → GREEN → 回归。禁止在同一步同时
> 改测试和实现来“配绿”。未得到用户明确要求时，不 commit、不 push、不创建 PR。

**目标：** 将当前重叠的 Windows 构建、弱门禁和本地 COS 上传收敛为可信 CI、单次
Windows x64 构建、同一制品晋级 GitHub Release/COS、可续跑且可回退的发布链。

**架构：** `ci.yml` 与 `release.yml` 复用同一质量门禁；正式发布只接受手动
`workflow_dispatch`。Windows 安装包构建后形成 canonical artifact，GitHub 与 COS
只消费它。GitHub Release 公开、COS 不可变对象验证完成后，最后移动频道 manifest。

**技术栈：** GitHub Actions、Node.js 20、pnpm 10、Electron Builder 26、
Playwright 1.58、Vitest 4、Node `node:test`、Tencent COS Node SDK v5。

**设计文档：**
`docs/superpowers/specs/2026-07-13-cicd-hardening-design.md`

---

## 文件地图

### 新增

- `.github/workflows/_quality-gates.yml`
- `.github/workflows/_windows-release-build.yml`
- `.github/workflows/nonblocking-quality.yml`
- `.github/workflows/migrate-release-baseline.yml`
- `.github/workflows/rollback-hot-update.yml`
- `.github/dependabot.yml`
- `tests/ci-cd/workflow-contracts.test.mjs`
- `scripts/release/release-contract.mjs`
- `scripts/release/release-contract.test.mjs`
- `scripts/release/artifact-contract.mjs`
- `scripts/release/artifact-contract.test.mjs`
- `scripts/release/cos-release-core.mjs`
- `scripts/release/cos-release-core.test.mjs`
- `scripts/release/cos-client.mjs`
- `scripts/release/cos-release.mjs`
- `scripts/release/validate-e2e-quarantine.mjs`
- `scripts/release/validate-e2e-quarantine.test.mjs`
- `e2e/quarantine.json`

### 重写或修改

- `.github/workflows/ci.yml`
- `.github/workflows/release.yml`
- `.github/workflows/codex-auto-update.yml`
- `tests/windows-only-workflows.test.mjs`
- `playwright.config.ts`
- `vitest.config.ts`
- `src/main/updater.ts`
- `tests/main/updater.test.ts`
- `src/main/index.ts`
- `electron-builder.yml`
- `package.json`
- `pnpm-lock.yaml`
- `.env.signing.example`
- `docs/code-signing.md`
- `docs/hot-update.md`
- `docs/BUILDING.md`

### 删除

- `.github/workflows/build.yml`
- `package-lock.json`
- `scripts/upload-cos.js`（其能力迁入 `scripts/release/` 后删除）

---

## Task 1：建立真实基线并统一测试/包管理契约

**Files**
- Create: `tests/ci-cd/workflow-contracts.test.mjs`
- Modify: `tests/windows-only-workflows.test.mjs`
- Modify: `package.json`
- Modify: `vitest.config.ts`
- Delete: `package-lock.json`

- [ ] **Step 1：在干净 `main` 记录真实基线**

依次运行，不加 `continue-on-error`：

```powershell
pnpm install --frozen-lockfile
pnpm run test:workflows
pnpm run typecheck
pnpm run test:run
pnpm run test:coverage
pnpm run audit:skill-arch
pnpm run test:skill-arch
pnpm run skills:gen:check
pnpm run build:vite
```

记录每条命令的退出码与失败测试。不能沿用工作流中“847 个错误”等旧注释。

- [ ] **Step 2：写包管理与测试发现的 RED 契约**

`tests/ci-cd/workflow-contracts.test.mjs` 先断言：

```js
test('pnpm is the only lockfile', () => {
  assert.equal(pkg.packageManager, 'pnpm@10.12.4')
  assert.equal(existsSync(path.join(repoRoot, 'package-lock.json')), false)
})

test('the active source suite and legacy updater suite have explicit runners', () => {
  assert.match(vitestConfig, /src\/\*\*/)
  assert.doesNotMatch(vitestConfig, /tests\/\*\*/)
  assert.equal(
    pkg.scripts['test:updater'],
    'vitest run -c vitest.legacy.config.ts tests/main/updater.test.ts',
  )
})
```

运行：

```powershell
node --test "tests/ci-cd/workflow-contracts.test.mjs"
```

Expected: FAIL，因为 `package-lock.json` 存在，且 updater 尚无独立 runner。

- [ ] **Step 3：统一到 pnpm 并修复测试发现**

1. 删除已漂移的 `package-lock.json`。
2. 保持已维护的 `src/**` 为阻塞 Vitest suite；为仍有价值的
   `tests/main/updater.test.ts` 新增显式 `test:updater` runner。实跑整个
   `tests/**` 会重新启用大量陈旧 legacy suite，不把它们悄悄混入 required gate。
3. 将原 workflow contract helpers 迁到新测试目录；旧文件可保留薄入口，避免脚本瞬间
   失效。
4. 把 `test:workflows` 改为运行全部 CI/CD contract tests。

- [ ] **Step 4：修复被重新发现的单测**

先运行：

```powershell
pnpm run test:run
pnpm run test:updater
```

修复已维护 source suite 与显式 updater suite 的真实失败，不建立单测忽略清单。
其余 legacy root suites 需要独立现代化项目后才能加入 required gate。

- [ ] **Step 5：验证 GREEN**

```powershell
node --test "tests/ci-cd/workflow-contracts.test.mjs"
pnpm run test:run
pnpm run test:updater
pnpm install --frozen-lockfile
git diff --exit-code -- pnpm-lock.yaml
```

---

## Task 2：对齐 updater 的 stable/beta/alpha 运行时频道

**Files**
- Modify: `src/main/updater.ts`
- Modify: `tests/main/updater.test.ts`

- [ ] **Step 1：写 RED 测试**

新增覆盖：

1. `1.2.3` 默认映射到 electron-updater `latest`；
2. `1.2.3-beta.1` 默认映射到 `beta`；
3. `1.2.3-alpha.1` 默认映射到 `alpha`；
4. 显式 `stable` 规范化为 `latest`；
5. `autoUpdater.channel` 设置完成后，`allowDowngrade` 最终仍为 `false`；
6. beta/alpha 自动启用 `allowPrerelease`，但不启用降级。

运行：

```powershell
pnpm exec vitest run "tests/main/updater.test.ts"
```

Expected: FAIL，当前默认恒为 `latest`，且在设置 channel 前写
`allowDowngrade`。

- [ ] **Step 2：实现纯频道函数**

在 `src/main/updater.ts` 提取并导出：

```ts
export function releaseChannelForVersion(version: string): 'latest' | 'beta' | 'alpha'
export function normalizeReleaseChannel(
  channel: ReleaseChannel,
): 'latest' | 'beta' | 'alpha'
```

未显式提供 channel 时使用 `app.getVersion()` 推导。顺序固定为：

1. 设置规范 channel；
2. 设置 `allowPrerelease`；
3. 最后强制 `allowDowngrade = false`。

- [ ] **Step 3：验证 GREEN 与回归**

```powershell
pnpm exec vitest run "tests/main/updater.test.ts"
pnpm run typecheck:ci
```

---

## Task 3：实现发布版本、签名与 provenance 纯契约

**Files**
- Create: `scripts/release/release-contract.mjs`
- Create: `scripts/release/release-contract.test.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1：添加直接依赖**

使用包管理器添加当前稳定版 SemVer 解析库：

```powershell
pnpm add -D semver
```

不得依赖未声明的传递依赖。

- [ ] **Step 2：写 RED 纯单测**

覆盖：

- 仅接受 `x.y.z`、`x.y.z-beta.n`、`x.y.z-alpha.n`；
- 拒绝前导 `v`、未知后缀、命令注入字符；
- 推导 `latest.yml` / `beta.yml` / `alpha.yml`；
- 普通 Release 版本必须高于当前频道与历史最高版本；
- rollback 目标必须严格低于当前频道且同频道；
- `WIN_CERTIFICATE`/密码全有、全无、部分配置三态；
- 发行说明拒绝 `TODO/TBD/FIXME/<version>/[待补充]`；
- `actions-build` 与 `legacy-import` provenance schema；
- `release-ready.json` 的 `github-release` 与 `legacy-import` eligibility；
- canonical candidates 同 digest 自动选择，不同 digest 要求
  `canonical_run_id`；
- 历史 artifact 只接受本仓库 `release.yml`、`workflow_dispatch`、目标 SHA、
  非 dry-run。

运行：

```powershell
node --test "scripts/release/release-contract.test.mjs"
```

Expected: FAIL，因为模块不存在。

- [ ] **Step 3：实现最小纯逻辑**

模块不读环境、不访问 Git/GitHub/COS，只接收数据并返回验证结果。核心导出：

```js
parseReleaseVersion
deriveReleaseChannel
channelManifestName
validateReleaseNotes
resolveSigningMode
validateReleaseManifest
selectCanonicalArtifact
assertForwardRelease
assertRollbackTarget
```

所有 switch/variant 处理必须有不可达兜底；错误消息包含字段名与安全恢复动作。

- [ ] **Step 4：验证 GREEN**

```powershell
node --test "scripts/release/release-contract.test.mjs"
```

---

## Task 4：实现 Windows 制品校验与无自引用清单

**Files**
- Create: `scripts/release/artifact-contract.mjs`
- Create: `scripts/release/artifact-contract.test.mjs`

- [ ] **Step 1：写 RED fixture 测试**

使用临时目录生成小文件，覆盖：

- 缺 `.exe`、`.blockmap`、channel YAML 任一项硬失败；
- 多个同版本安装包或 `.dmg/.AppImage/.deb` 硬失败；
- YAML version/path/size/sha512 与文件不符硬失败；
- stable/beta/alpha 选择正确 YAML；
- `release-manifest.json` 只散列三个 payload；
- `SHA256SUMS.txt` 散列 payload + manifest，但不散列自身；
- `actions-build` 字段完整；
- `legacy-import` 允许未知原构建字段为 `null`，禁止伪造默认值；
- staging 目录忽略 `release/win-unpacked`，但拒绝 staging 内意外文件。

运行：

```powershell
node --test "scripts/release/artifact-contract.test.mjs"
```

Expected: FAIL。

- [ ] **Step 2：实现校验与清单生成**

导出：

```js
discoverWindowsArtifacts
verifyUpdaterManifest
createReleaseManifest
createSha256Sums
verifyReleaseBundle
```

使用仓库现有 `yaml` 包解析 updater YAML；使用 `node:crypto` 计算 SHA-256/SHA-512。

- [ ] **Step 3：验证 GREEN**

```powershell
node --test "scripts/release/artifact-contract.test.mjs"
```

---

## Task 5：实现可注入、fail-closed 的 COS 状态机

**Files**
- Create: `scripts/release/cos-release-core.mjs`
- Create: `scripts/release/cos-release-core.test.mjs`
- Create: `scripts/release/cos-client.mjs`
- Create: `scripts/release/cos-release.mjs`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

- [ ] **Step 1：固定 CRC64 实现**

不要使用 `crc64-ecma182.js` 2.x：它的 postinstall 需要 `make`/Emscripten，无法在
干净 Windows runner 上可靠安装。实现可流式更新的纯 JavaScript CRC64-ECMA182，
并用腾讯 COS 文档参数（`rev=true`、`initCrc=0`、`xorOut=0xffffffffffffffff`）
及 `123456789 → 11051210869376104954` 标准向量固定行为。

- [ ] **Step 2：为假客户端写 RED 测试**

Fake adapter 只在内存保存对象。覆盖：

- bucket versioning 非空/Enabled/Suspended 时 fail closed；
- 缺 `GetObject`/multipart/PutObject 权限在任何写入前失败；
- 新不可变对象携带 `x-cos-forbid-overwrite: true`；
- 已存在且 hash/size 相同为幂等成功；
- 已存在但内容不同拒绝覆盖；
- 大文件比较本地/服务端 CRC64；
- 历史对象无 CRC64 时流式 SHA-256；
- `release-ready.json` 之前不能 promote；
- `eligibility.kind=github-release` 要求公开 Release 校验；
- `legacy-import` 只允许登记的基线；
- 频道复制使用 `MetadataDirective: Replaced`；
- 频道 manifest 使用 no-cache，版本资产使用 immutable；
- promote 回读失败时恢复旧内容；
- 原频道不存在时失败恢复为不存在，Delete 仅能作用三个频道 key；
- rollback 必须同频道且严格向后；
- `--dry-run` 无 COS 写调用。

运行：

```powershell
node --test "scripts/release/cos-release-core.test.mjs"
```

Expected: FAIL。

- [ ] **Step 3：实现纯状态机**

`cos-release-core.mjs` 只依赖 adapter，导出：

```js
preflightCos
planImmutableUploads
uploadImmutableAssets
markReleaseReady
promoteChannel
rollbackChannel
importLegacyBaseline
```

- [ ] **Step 4：实现 COS SDK adapter**

`cos-client.mjs` 封装：

- `getBucketVersioning`
- `headObject`
- `getObject`
- `putObject`
- `sliceUploadFile`
- `putObjectCopy`
- `deleteObject`

不得记录 SecretId/SecretKey 或完整认证错误对象。版本对象上传使用防覆盖头；频道对象
允许受控覆盖，但写前备份、写后回读。

- [ ] **Step 5：实现 CLI**

`cos-release.mjs` 支持：

```text
preflight
upload-assets
mark-ready
promote
rollback
import-legacy
verify
--dry-run
```

CI 写模式要求 `GITHUB_ACTIONS=true`，本地只允许 verify/dry-run。

- [ ] **Step 6：验证 GREEN**

```powershell
node --test "scripts/release/cos-release-core.test.mjs"
```

---

## Task 6：建立可审计的 E2E 隔离

**Files**
- Create: `e2e/quarantine.json`
- Create: `scripts/release/validate-e2e-quarantine.mjs`
- Create: `scripts/release/validate-e2e-quarantine.test.mjs`
- Modify: `playwright.config.ts`
- Modify: 仅实际复现失败的 `e2e/*.e2e.ts`
- Modify: `package.json`

- [ ] **Step 1：写 quarantine schema RED 测试**

固定 schema：

```json
[
  {
    "testId": "relative/file.e2e.ts :: exact title",
    "reason": "可复现症状",
    "issue": "https://github.com/.../issues/...",
    "addedAt": "2026-07-13",
    "expiresAt": "2026-07-27"
  }
]
```

测试拒绝：缺字段、过期、重复 testId、找不到对应 `@quarantine` tag、tag 未登记。

- [ ] **Step 2：实现 validator**

运行：

```powershell
node --test "scripts/release/validate-e2e-quarantine.test.mjs"
```

- [ ] **Step 3：拆分 Playwright projects**

在 `playwright.config.ts` 新增：

- `electron-stable`：明确维护的启动/主界面 smoke 文件，`grepInvert: /@quarantine/`；
- `electron-extended`：其余 legacy POM 场景，nightly/manual 观测；
- `electron-quarantine`：`grep: /@quarantine/`；
- `visual`：保持独立。

空 quarantine 时 runner 应明确成功退出，不让“无测试”误报失败。

- [ ] **Step 4：复现后才隔离**

在 Windows 上运行：

```powershell
pnpm run build:vite
pnpm exec playwright test --project=electron-stable
```

只有可连续复现且与本轮无关的环境波动测试才加 `@quarantine` 和 manifest 条目。稳定
失败必须直接修复。

- [ ] **Step 5：验证**

```powershell
pnpm run test:e2e:stable
pnpm run test:e2e:quarantine
```

---

## Task 7：收敛可信 CI 与非阻塞观测工作流

**Files**
- Modify: `tests/ci-cd/workflow-contracts.test.mjs`
- Create: `.github/workflows/_quality-gates.yml`
- Rewrite: `.github/workflows/ci.yml`
- Create: `.github/workflows/nonblocking-quality.yml`
- Modify: `vitest.config.ts`
- Modify: `package.json`

- [ ] **Step 1：添加 workflow RED 契约**

断言：

- `ci.yml` 只调用共享质量工作流，不访问生产 secrets；
- required jobs 无 `continue-on-error`；
- 只有证据上传 step 可 `continue-on-error: true`；
- `quality-gate` 使用 `if: always()` 并检查每个 `needs.*.result === success`；
- PR concurrency 可取消旧 run；
- stable E2E 只在 Windows；
- quarantine/visual/benchmark 只在 schedule/manual 非阻塞工作流；
- Skill 守护三条命令存在；
- action 引用固定完整 commit SHA。

运行：

```powershell
pnpm run test:workflows
```

Expected: FAIL。

- [ ] **Step 2：创建 `_quality-gates.yml`**

使用 `workflow_call`，不接收 `skip_tests`，不接收 secrets。包含：

1. contracts + typecheck + Skill 守护；
2. source unit + coverage threshold，并单独运行 updater suite；
3. Windows `build:vite` + `electron-stable` E2E；
4. `quality-gate` 汇总。

把覆盖率阈值放进 Vitest 配置，避免在 YAML 内嵌长 Node 脚本。报告上传用
`if: always()`，上传失败不能覆盖原测试结论。

- [ ] **Step 3：重写 `ci.yml`**

保留 `push`/`pull_request`，调用共享工作流；设置按 ref 的 concurrency。

- [ ] **Step 4：创建 nonblocking workflow**

`schedule` + `workflow_dispatch` 运行：

- quarantine E2E；
- extended E2E；
- visual；
- benchmark。

总是上传报告并写 summary，但不成为 PR required check。

- [ ] **Step 5：解析并 pin Actions SHA**

对 `actions/checkout`、`actions/setup-node`、`pnpm/action-setup`、
`actions/upload-artifact` 等，从官方 tag 解析当前 commit SHA 后写入 workflow；
不得凭记忆填写 SHA。

- [ ] **Step 6：验证 GREEN**

```powershell
pnpm run test:workflows
pnpm run typecheck:ci
pnpm run test:coverage
pnpm run audit:skill-arch
pnpm run test:skill-arch
pnpm run skills:gen:check
```

---

## Task 8：实现单次 Windows 发布构建工作流

**Files**
- Modify: `tests/ci-cd/workflow-contracts.test.mjs`
- Create: `.github/workflows/_windows-release-build.yml`
- Modify: `.env.signing.example`
- Modify: `docs/code-signing.md`

- [ ] **Step 1：写构建 workflow RED 契约**

断言：

- 只允许 `windows-latest`、x64；
- checkout 精确 release SHA；
- frozen pnpm install；
- 只下载 win32-x64 runtime；
- 先 `build:vite`，再
  `electron-builder --win --x64 --publish never`；
- signed/unsigned/partial 三态；
- signed 必须用 PowerShell 验证 Authenticode `Valid`；
- 正式文件先复制到 staging，再执行 artifact validator；
- artifact 名包含 version + SHA，dry-run 使用不同前缀；
- retention 90 天、无 macOS/Linux 文件；
- workflow 输出 artifact id/digest/name。

- [ ] **Step 2：实现 workflow_call 输入/输出**

输入：

```text
version
release_sha
dry_run
```

build job 在被调用工作流内部声明所需 Environment，显式引用签名 secrets，不用
`secrets: inherit`。

- [ ] **Step 3：实现可选签名**

将 GitHub secrets 映射为：

```text
WIN_CERTIFICATE          -> WIN_CSC_LINK
WIN_CERTIFICATE_PASSWORD -> WIN_CSC_KEY_PASSWORD
```

subject 只用于校验。临时证书文件在 `if: always()` cleanup step 删除。

- [ ] **Step 4：验证契约**

```powershell
pnpm run test:workflows
```

---

## Task 9：重写唯一 Release 编排状态机

**Files**
- Modify: `tests/ci-cd/workflow-contracts.test.mjs`
- Rewrite: `.github/workflows/release.yml`

- [ ] **Step 1：写 Release RED 契约**

断言：

- 只允许 `workflow_dispatch`；
- 输入为 `version`、`dry_run`、可选 `canonical_run_id`；
- 无 `skip_tests`、push/tag trigger；
- concurrency 为 `production-release` 且不取消；
- 先本地/远端只读校验，再共享质量门禁；
- COS versioning/权限预检早于 tag/draft；
- canonical discovery job 同时声明 `contents: read`、`actions: read`；
- 历史 artifact 下载传入 token + verified run-id；
- 没有 canonical 才调用 Windows build；
- tag → draft → assets → COS immutable → GitHub publish →
  release-ready → channel manifest；
- GitHub beta/alpha 为 prerelease 且非 latest；
- channel promote 后仅只读验证/summary；
- dry-run 不写生产状态。

- [ ] **Step 2：实现 validate/discover jobs**

1. 安全解析 inputs；
2. tag 不存在时绑定当前 `main`；
3. tag 存在时 checkout tag SHA 续跑；
4. 校验源码版本、发行说明、频道单调性与更新 URL；
5. 搜索可信 canonical candidates，冲突时要求 `canonical_run_id`。

- [ ] **Step 3：接入共享 gates 与条件构建**

Release 必须调用 `_quality-gates.yml`。只有 discover 输出 `needs_build=true` 时调用
`_windows-release-build.yml`。

- [ ] **Step 4：实现 GitHub draft/Release 幂等**

优先使用仓库自带 `gh` CLI：

- tag 同 SHA复用，不同 SHA失败；
- draft/public assets 逐一按 SHA-256 校验；
- 已公开 Release 不替换资产；
- stable 设置 latest，beta/alpha 设置 prerelease；
- Release body 使用 `docs/releases/v<version>.md`，追加签名状态、SHA 和 run。

- [ ] **Step 5：接入 COS 阶段**

严格调用：

```text
preflight
upload-assets
publish GitHub Release
mark-ready
promote
verify anonymous URL
```

任何失败都在 summary 输出当前阶段与安全续跑方式。

- [ ] **Step 6：验证 workflow contract**

```powershell
pnpm run test:workflows
```

---

## Task 10：实现 4.3.95 基线迁移与热更新回退

**Files**
- Modify: `tests/ci-cd/workflow-contracts.test.mjs`
- Create: `.github/workflows/migrate-release-baseline.yml`
- Create: `.github/workflows/rollback-hot-update.yml`

- [ ] **Step 1：写迁移/回退 RED 契约**

断言：

- 两者只允许手动触发并绑定 `production`；
- 与 Release 共用 `production-release` concurrency；
- confirm 必须准确等于目标版本；
- migration 只创建 `legacy-import` provenance/eligibility，不伪造 GitHub/run 信息；
- rollback 不构建、不改 tag/Release；
- rollback channel 由版本推导，无 channel 输入；
- rollback 要求 target < current、同频道、release-ready、payload 完整；
- `github-release` eligibility 要实时验证公开 Release；
- promote 使用 `MetadataDirective: Replaced`；
- 首次空频道恢复允许删除的 key 仅三个频道 manifest。

- [ ] **Step 2：实现 baseline migration**

默认目标 4.3.95，但仍要求显式输入与 confirm。流程：

1. 读取线上 `latest.yml`；
2. 验证 exe/blockmap；
3. 生成 `legacy-import` manifest/SHA；
4. 写版本化 manifest 与 `release-ready.json`；
5. 回读证明。

若基线已存在且内容一致，幂等成功；不同则停止。

- [ ] **Step 3：实现 rollback**

只调用 `cos-release.mjs rollback`。成功 summary 明确：

- 从哪个版本回到哪个版本；
- 只停止后续扩散；
- 已安装高版本客户端不会自动降级。

- [ ] **Step 4：验证契约与纯单测**

```powershell
pnpm run test:workflows
node --test "scripts/release/cos-release-core.test.mjs"
```

---

## Task 11：删除旧发布旁路并补齐供应链/文档

**Files**
- Modify: `tests/ci-cd/workflow-contracts.test.mjs`
- Delete: `.github/workflows/build.yml`
- Modify: `.github/workflows/codex-auto-update.yml`
- Delete: `scripts/upload-cos.js`
- Modify: `package.json`
- Create: `.github/dependabot.yml`
- Modify: `electron-builder.yml`
- Modify: `src/main/index.ts`
- Modify: `.env.signing.example`
- Modify: `docs/code-signing.md`
- Modify: `docs/hot-update.md`
- Modify: `docs/BUILDING.md`

- [ ] **Step 1：写旁路与配置漂移 RED 契约**

断言：

- `build.yml` 不存在；
- 只有 `release.yml` 能创建正式 Release；
- `upload:cos` / `release:cn` 不再直接写生产；
- `codex-auto-update.yml` 只验证 `win32-x64`；
- `electron-builder.yml` 与 `src/main/index.ts` 的 COS URL 等于 Environment variables
  推导结果；
- Electron Builder 仍只用 generic COS updater provider；
- `electron-builder.yml` 不再固定 `publish.channel: latest`，由 package SemVer 后缀
  生成对应频道 YAML；
- GitHub Release 只作维护者审计/备用下载；
- action pin 由 Dependabot 维护。

- [ ] **Step 2：删除旧路径并调整 package scripts**

保留：

```text
release:verify
release:cos:dry
test:release
test:workflows
```

删除或封闭可绕过 Actions 门禁的本地生产写命令。

- [ ] **Step 3：更新签名与热更新文档**

文档必须准确反映：

- COS 是客户端唯一 updater；
- GitHub Release 不作客户端 fallback；
- stable/beta/alpha 文件映射；
- 本地只做 verify/dry-run；
- 可选签名三态；
- baseline migration、正式发布、续跑、rollback 操作；
- rollback 不等于客户端降级。

- [ ] **Step 4：配置 Dependabot**

新增 `github-actions` 与 `npm` 更新项。工作流中的 Action 仍锁完整 SHA，Dependabot
负责提出升级 PR。

- [ ] **Step 5：验证 GREEN**

```powershell
pnpm run test:workflows
pnpm run test:release
pnpm run typecheck:ci
```

---

## Task 12：全量验证、GitHub 配置与发布演练

**Files**
- Modify: 仅测试发现的相关文件
- Modify: 设计文档状态与实施证据（全部通过后）

- [ ] **Step 1：本地全量验证**

```powershell
pnpm install --frozen-lockfile
pnpm run test:workflows
pnpm run test:release
pnpm run typecheck:ci
pnpm run test:coverage
pnpm run audit:skill-arch
pnpm run test:skill-arch
pnpm run skills:gen:check
pnpm run build:vite
```

Windows：

```powershell
pnpm run test:e2e:stable
```

禁止用全套 `continue-on-error` 将失败伪装为通过。

- [ ] **Step 2：检查 lints 与差异**

检查所有新增/修改的 TS/TSX 文件 lints；审阅：

```powershell
git status --short
git diff --check
```

确认未包含 `.env`、证书、COS 凭据、构建产物。

- [ ] **Step 3：配置 GitHub 仓库外状态**

在 `production` Environment 配置：

```text
Secrets:
  COS_SECRET_ID
  COS_SECRET_KEY
  WIN_CERTIFICATE                  # 可选
  WIN_CERTIFICATE_PASSWORD         # 可选
  WIN_CERTIFICATE_SUBJECT_NAME     # 可选

Variables:
  COS_BUCKET
  COS_REGION
  COS_PREFIX
```

确认：

- bucket versioning 未启用；
- CI 子账号 CAM 权限符合设计；
- Actions artifact retention 至少 90 天，或记录实际上限；
- 首次 CI 通过后，把实际 `quality-gate` check context 设为 main required check。

- [ ] **Step 4：运行安全演练**

顺序不可交换：

1. 手动运行 Release `dry_run=true`；
2. 运行 4.3.95 baseline migration；
3. 再次 dry-run，确认 canonical/legacy 状态可读；
4. 用 beta 版本执行完整发布，验证 GitHub prerelease、COS `beta.yml`、匿名 URL；
5. 用 beta 历史版本演练 rollback；
6. 最后才启用下一次 stable 发布。

- [ ] **Step 5：最终验收**

必须证明：

- 同一安装包在 Actions/GitHub/COS 的 SHA-256 一致；
- 缺文件、部分签名、不同 hash、错误 tag/SHA 均 fail closed；
- 发布中途失败不会移动频道；
- 同版本续跑不重新签名构建；
- rollback 与 Release 不并发；
- 4.3.95 可作为 legacy 基线恢复；
- stable/beta/alpha 不串频道。

- [ ] **Step 6：更新设计状态**

只有全部本地测试、GitHub dry-run、baseline migration 和 beta 演练有证据后，才将设计
文档状态改为“已实现并验证”，并附 workflow run URL。未得到用户明确要求时不要
commit、push 或创建 PR。
