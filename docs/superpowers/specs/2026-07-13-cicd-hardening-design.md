# Windows CI/CD 稳定化与自动发布设计

日期：2026-07-13
状态：设计已确认，待实施
基线：`main`，应用版本 4.3.95，仅发布 Windows x64

## 背景

当前仓库已经具备 CI、Windows 打包、GitHub Release 和本地 COS 上传能力，
但这些能力尚未形成一条可证明、可续跑、可回退的发布链：

- `ci.yml`、`build.yml`、`release.yml` 都承担部分 Windows 构建职责；
- `build.yml` 与 `release.yml` 都响应 `v*` tag，存在重复构建和重复发布风险；
- `release.yml` 的手动 `version` 输入不驱动版本校验、tag 或 GitHub Release；
- typecheck、单测和覆盖率使用整套 `continue-on-error`，不能阻止新回归；
- E2E 存在已知不稳定项，但稳定项和不稳定项没有明确边界；
- COS 仍依赖本地执行，上传脚本遇到缺失文件时只警告并继续；
- Windows 证书未配置时可以生成安装包，但发布结果没有明确标注未签名；
- COS 只有可变的 `releases/latest.yml`，缺少版本化 manifest 和自动回退路径；
- `codex-auto-update.yml` 仍验证四个平台，与当前仅发布 Windows 的策略不一致。

本设计把这些分散能力收敛为“质量门禁 → 单次 Windows 构建 → 同一制品晋级
GitHub/COS → 可验证频道指针”的流水线。

## 已确认决策

1. 分两阶段实施：先稳定 CI，再自动化 GitHub Release 与 COS CD。
2. 正式发布由 `workflow_dispatch` 手动发起并输入版本号。
3. Windows 签名为可选能力：
   - 证书完整配置时自动签名并验证；
   - 完全未配置时允许发布，但必须明确告警；
   - 只配置部分证书 secrets 时视为错误并阻止发布。
4. 稳定测试必须阻塞；只有显式列入隔离清单的 E2E 可以暂时告警。
5. Windows 安装包只构建一次，GitHub Release 与 COS 使用同一份 canonical artifact。
6. GitHub Release 正式发布后，才更新 COS 对应频道 manifest。
7. COS 保存每个版本的不可变 manifest，并提供只移动频道指针的手动回退入口。
8. stable、beta、alpha 从 SemVer 后缀自动识别，不单独维护第二套发布流程。

## 目标

完成后应满足：

1. PR 上的必需检查能真实阻止类型、单测、构建和稳定 E2E 回归。
2. 同一提交和版本只产生一组 Windows 制品。
3. 手动输入版本后，流水线可自动创建 tag、GitHub Release 和 COS 热更新。
4. 任一步失败都不会提前推动 COS 热更新频道。
5. 同版本失败任务可以安全续跑，不会覆盖内容不同的远端对象。
6. 可以在不重建安装包、不删除 Release 的前提下，把热更新指针回退到历史版本。
7. 发布摘要能回答：发布了哪个 SHA、制品是否签名、散列值是什么、GitHub/COS
   分别处于什么状态。

## 非目标

- 本期不恢复 macOS 或 Linux 构建。
- 本期不购买或签发 Windows 代码签名证书。
- 本期不把视觉回归和 benchmark 设为 PR 强制门禁。
- 本期不自动修改 GitHub 仓库的 Environment 审批人或分支保护；工作流会定义所需
  status 名称，仓库设置单独启用。
- 本期不删除历史 GitHub Release，也不通过覆盖旧版本安装包实现回退。
- 本期不允许通过 `skip_tests` 绕过正式发布门禁。

## 发布渠道角色

GitHub 与 COS 承担不同职责：

- GitHub Release 是维护者侧的版本审计、制品留档和备用下载面。仓库为私有时，
  它不作为面向终端用户的自动更新源。
- COS 是 Electron 客户端唯一的热更新源；`electron-builder.yml` 继续只配置
  generic COS provider，不新增 GitHub updater provider。
- 两端必须消费同一个 Actions artifact，并通过 SHA-256 证明内容一致。

当前 `electron-builder.yml` 中“GitHub never for binaries”的注释与新决策不完全一致。
实施时应改为“GitHub Release 不作为客户端更新源，但保留维护者制品”，避免维护者误读；
generic COS 更新 URL 本身不变。

## 目标架构

### 工作流边界

#### `.github/workflows/ci.yml`

只处理 `push` 和 `pull_request` 质量检查：

- 调用可复用质量门禁；
- 上传失败证据；
- 不创建安装包，不访问 COS 或签名 secrets，不创建 Release。

为每个 ref 设置 concurrency，并允许新提交取消同一 PR 的旧 CI。

#### `.github/workflows/_quality-gates.yml`

通过 `workflow_call` 被 CI 和 Release 共用，提供稳定且名称固定的检查：

1. workflow contract tests；
2. TypeScript typecheck；
3. 稳定单测与覆盖率；
4. Skill 架构审计、守护测试与生成物 drift 检查；
5. `build:vite`；
6. Windows Electron 稳定 E2E；
7. 一个仅在上述任务全部成功后通过的 `quality-gate` 汇总 job。

任何 required job 都不得使用整套 `continue-on-error`。失败报告通过
`if: always()` 上传；仅证据上传 step 可使用 `continue-on-error: true`，防止报告服务
故障覆盖原始测试结论，测试/构建/门禁 step 不得使用。

`quality-gate` 本身也使用 `if: always()`，逐项检查所有 blocking job 的
`needs.<job>.result` 必须为 `success`；上游失败或取消时它必须显式失败，不能因依赖
被跳过而缺失。分支保护在首个新工作流运行后绑定 GitHub 实际显示的完整 check
context，不假定可见名称一定只有 `quality-gate`。

#### `.github/workflows/_windows-release-build.yml`

通过 `workflow_call` 只做 Windows x64 发布构建：

1. checkout 已通过门禁的精确 SHA；
2. 安装锁定依赖；
3. 获取 Windows Codex、FFmpeg、Docker MCP runtime；
4. 判断签名配置；
5. 在这个干净 job 内执行 `pnpm run build:vite`；
6. 执行一次 `electron-builder --win --x64 --publish never`，从机制上禁止构建 job
   产生发布副作用；
7. 把正式文件复制到独立 staging 目录，再验证版本、签名状态和散列；
8. 上传一个带版本与 commit SHA 的固定 Actions artifact，并保留 90 天。

质量门禁中的 `build:vite` 只证明源码能构建，不向发布 job 传递 `dist/`。发布构建
必须在自己的干净 Windows job 重新生成 `dist/`，但 `electron-builder` 安装包在整条
发布链中仍只执行一次。`release/win-unpacked` 等正常临时目录不属于正式 staging
制品，既不上传，也不作为“意外平台文件”误判。

#### `.github/workflows/release.yml`

只保留 `workflow_dispatch`，输入：

- `version`：不含 `v` 的 SemVer；
- `dry_run`：默认 `false`。为 `true` 时完成校验、门禁、构建和制品验证，但不创建
  tag、不写 GitHub Release、不写 COS。
- `canonical_run_id`：默认空，仅在自动发现多个不同 canonical artifact 时由维护者
  指定受信任的历史 release run。

正式发布使用全局 concurrency `production-release`，且
`cancel-in-progress: false`。该名称同时用于回退工作流；发布和回退不能并发修改
频道 manifest。

#### `.github/workflows/rollback-hot-update.yml`

手动输入：

- `version`：目标历史版本；
- `confirm`：必须准确输入目标版本，防止误操作。

channel 完全由版本后缀推导，不提供第二个可矛盾的输入；`workflow_dispatch` 也不承担
“动态显示推导值”的职责。该流程与 Release 共用 `production-release` concurrency，
只验证历史 manifest、发布资格标记和引用制品，然后更新同频道指针。它不构建、不创建
tag、不修改 GitHub Release。

#### `.github/workflows/build.yml`

删除。PR 构建验证归 `_quality-gates.yml`，正式安装包构建归
`_windows-release-build.yml`，避免第三条重复路径。

#### `.github/workflows/codex-auto-update.yml`

保留自动 bump PR，但把资产验证范围收窄为 `win32-x64`，并同步修正文案。Codex
版本升级仍必须通过 PR 和同一套质量门禁。

#### 工作流复用与 secrets

质量工作流不接收任何 secret。Windows 构建工作流若使用 GitHub Environment 中的
签名 secret，必须在被调用工作流的实际 build job 上声明 environment；不能假设
`workflow_call` 会从调用方传递 environment secret。调用方也不得使用
`secrets: inherit` 把无关凭证交给构建工作流。

## CI 门禁

### 真实基线优先

实施第一步是在干净 `main` 上分别运行 typecheck、单测、覆盖率、构建和 Electron
E2E，记录实际结果。当前工作流中的“847 个 TypeScript 错误”等注释已可能过期，
不得作为继续放宽门禁的依据。

处理规则：

- 当前已通过的检查立即设为 blocking；
- typecheck 或单测若仍有失败，优先修复，不建立无限期的全套豁免；
- 只有可复现且与当前改造无关的 E2E 不稳定项可以进入隔离清单；
- 新失败不得借用旧隔离项名义放行。

实际基线复核得到 828 条 TypeScript 诊断，无法在 CI/CD 改造中一次性消除。为避免继续
使用 `continue-on-error`，required gate 改用有到期日的诊断债务基线：忽略行列号变化，
按文件、TS code、消息和出现次数阻止任何新增诊断；已修复诊断允许减少；基线于
2026-08-31 到期并强制复审。原始 `pnpm run typecheck` 仍保持严格 `tsc --noEmit`，
不得用基线宣称项目已零类型错误。

Skill 门禁至少执行：

- `pnpm run audit:skill-arch`；
- `pnpm run test:skill-arch`；
- `pnpm run skills:gen:check`。

### E2E 隔离

隔离必须是显式且可审计的。每个条目至少记录：

- 测试文件或稳定测试标识；
- 失败症状；
- 对应 issue；
- 加入日期；
- 到期复查日期。

PR 和 Release 运行明确维护的启动/主界面 smoke 稳定集并阻塞。现有大量 legacy POM
场景进入 `electron-extended`，由 nightly 和手动任务持续观测；只有实际复现的不稳定
测试才能加 `@quarantine` 并登记到隔离清单。extended 与隔离集都始终上传 trace、
截图和 Playwright report；被隔离测试修复后必须移除登记并重新进入对应稳定/extended
集合。

不得通过为整个 `e2e-tests` job 设置 `continue-on-error` 实现隔离。

### 非阻塞检查

视觉回归和 benchmark 在第一阶段改为 schedule/手动运行：

- 失败会在摘要中告警并保留产物；
- 不占用每个 PR 的发布关键路径；
- 建立稳定基线后再单独决定是否升级为 required checks。

## 发布前版本契约

`release.yml` 先做不产生外部写入的本地校验和远端只读校验。

### 发布 SHA

- tag 不存在时属于首次发布：workflow 必须从 `main` 发起，dispatch SHA 必须等于远端
  `main` 当前头部，该 SHA 成为 release SHA。
- tag 已存在时属于续跑：release SHA 取 tag 的既有目标，不要求它仍是当前 `main`
  头部；工作流 checkout 该精确 SHA 并重新验证源码版本。不得移动既有 tag。
- tag 与输入版本对应的 GitHub/COS 状态冲突时停止，不能把“重新发一个同名版本”当续跑。

### 本地契约

1. 输入版本必须为合法 SemVer，不带 `v`；
2. release SHA 上的 `package.json.version` 必须等于输入；
3. pnpm 是唯一包管理器，`pnpm-lock.yaml` 是唯一依赖锁；实施时删除已经漂移的
   `package-lock.json`；
4. `pnpm install --frozen-lockfile` 后 `pnpm-lock.yaml` 必须无漂移；
5. `docs/releases/v<version>.md` 必须存在且非空，并拒绝
   `TODO`、`TBD`、`FIXME`、`<version>`、`[待补充]` 等占位标记；
6. 预发布只接受 `-beta.<n>` 或 `-alpha.<n>`，无后缀版本归 stable；
7. 工作流与 staging 制品不得包含非 Windows 发布目标。

### 远端只读契约

1. tag 不存在，或已指向解析出的 release SHA；
2. 新发布版本必须高于 COS 对应频道当前版本和该频道历史最高已发布版本；
3. 向后移动频道只能使用 rollback 工作流，普通 Release 不允许降级；
4. GitHub Release 若存在，必须属于同一 tag/SHA；
5. `COS_BUCKET`、`COS_REGION`、`COS_PREFIX` 生成的更新 URL，必须与
   `electron-builder.yml` 及 `src/main/index.ts` 的运行时 URL 完全一致；
6. COS 凭证具备所需读权限，bucket versioning 未启用，现有频道对象可返回 CRC64
   或可被流式回读；这些检查必须早于 tag、draft 和 assets 写入。

所有 workflow input 先通过 `env` 传给校验脚本，再由脚本解析；不得把未经验证的输入
直接拼进 PowerShell/Bash。以上任一校验失败时不安装依赖、不运行构建、不创建外部资源。

## Windows 构建与签名

### 签名状态判定

必需签名 secret 是证书与密码这一对：

- `WIN_CERTIFICATE` → `WIN_CSC_LINK`；
- `WIN_CERTIFICATE_PASSWORD` → `WIN_CSC_KEY_PASSWORD`。

两者都存在时进入 signed 模式；两者都不存在且 subject 也不存在时进入 unsigned
模式并写入显著 warning。只存在其中一个，或只有
`WIN_CERTIFICATE_SUBJECT_NAME` 而没有证书对，均属于部分配置并停止发布。subject
是 signed 模式下的可选验证约束，不单独启用签名。

signed 模式在构建后使用 Windows Authenticode 工具验证：

- 签名存在且状态有效；
- 证书主题符合配置；
- 时间戳存在；
- 最终被上传的 `.exe` 正是被验证的文件。

unsigned 模式在 Actions summary、制品清单和 GitHub Release 正文中写明
“未配置 Windows 代码签名证书”。不得用成功构建暗示已签名。

### 制品契约

构建输出只允许：

- `catimation-cyberpunk-master-<version>-setup.exe`；
- 对应 `.exe.blockmap`；
- 当前 channel 的 updater YAML；
- `SHA256SUMS.txt`；
- `release-manifest.json`。

`release-manifest.json` 至少记录：

- `schemaVersion`；
- 版本、channel、commit SHA；
- provenance；
- `.exe`、`.blockmap`、updater YAML 的大小和 SHA-256；
- `signed: true | false`；
- 新构建的 Actions run ID。

provenance 是显式联合类型：

- `kind: "actions-build"`：要求构建时间、Node/pnpm/Electron Builder 版本和 run ID；
- `kind: "legacy-import"`：用于 4.3.95 基线迁移，记录导入时间、操作者、来源 COS key
  和导入 workflow run；无法证明的原构建时间、工具版本、commit 必须为 `null`，
  不得伪造。

散列集合必须无自引用：

1. `release-manifest.json` 只记录三个 payload 文件，不记录自身；
2. `SHA256SUMS.txt` 记录三个 payload 文件和 `release-manifest.json`；
3. `SHA256SUMS.txt` 不记录自身；
4. Actions artifact 的 digest 由 GitHub 单独记录，不写回 artifact 内部。

验证器必须：

- 对缺失文件、重复文件、版本不一致或意外平台文件直接失败；
- 解析 updater YAML 并确认 version、文件名、size、sha512 与实际文件一致；
- 在 artifact 上传前重新计算 SHA-256；
- 不依赖文件 glob “碰巧匹配”来证明制品完整。

## 发布状态机

### 阶段 1：校验与门禁

版本契约通过后运行共享质量门禁。任一稳定检查失败，流程终止，外部状态保持不变。

### 阶段 2：确定 canonical artifact

带时间戳的 Windows 签名和 `release-manifest.json` 中的构建信息不是可复现构建；
同一 SHA 重新打包也可能产生不同哈希。因此续跑不能无条件重新构建。

按以下优先级确定唯一 canonical artifact：

1. 已存在且文件完整、散列一致的 GitHub draft/public Release assets；
2. 仓库内此前同版本、同 SHA workflow run 保留的
   `release-win-<version>-<sha>` Actions artifact；
3. 只有在 tag、GitHub assets、COS 版本对象均不存在时，才调用 Windows 构建工作流。

历史 Actions artifact 只接受本仓库 `release.yml`、`workflow_dispatch`、目标 release
SHA 产生的非 dry-run 构建；dry-run 使用不同 artifact 前缀，不参与候选。若自动发现
多个候选：

- digest 完全相同：选择最早成功的 run，并记录 run ID；
- digest 不同：停止，要求维护者用 `canonical_run_id` 明确选择；
- 指定 run 不满足 workflow/event/SHA 约束：拒绝。

如果远端已有任何不可变版本资产，但找不到完整 canonical artifact，任务必须停止并输出
人工恢复说明；不得重新签名后覆盖。Actions artifact 保留 90 天，正常续跑应优先重跑
原 workflow 的失败 job，或由新 run 下载此前 artifact。发布编排下载后再次验证
`release-manifest.json` 的版本、commit SHA、签名状态和所有 payload 散列。

### 阶段 3：创建 tag 与 GitHub draft

门禁和制品验证成功后：

1. 创建 `v<version>` tag，目标为已验证 SHA；
2. 创建 draft GitHub Release；
3. 使用 `docs/releases/v<version>.md` 作为主体，并追加签名状态与散列说明；
4. 上传 canonical artifact 中的发布文件。

无后缀 stable Release 设置 `prerelease: false` 并在公开时成为 GitHub latest；
beta/alpha 设置 `prerelease: true` 且不得成为 GitHub latest。续跑必须核对既有 Release
的 prerelease/latest 状态与版本后缀一致。

如果 tag 已存在：

- 指向同一 SHA：允许续跑；
- 指向其他 SHA：立即失败，不移动 tag。

如果 draft 已存在，远端同名资产只有在 SHA-256 相同时才视为已完成；内容不同则失败。
如果 Release 已公开，则只校验现有 assets 并继续协调 COS 状态，不再次发布或替换资产。
draft 只有部分资产且无法找到原 canonical artifact 时停止，禁止通过删除后重建掩盖来源。

### 阶段 4：上传 COS 不可变制品

上传安装包、blockmap、散列清单、发布清单和版本化 updater manifest。固定键空间：

```text
releases/
  catimation-cyberpunk-master-<version>-setup.exe
  catimation-cyberpunk-master-<version>-setup.exe.blockmap
  versions/<version>/<channel-file>.yml
  versions/<version>/SHA256SUMS.txt
  versions/<version>/release-manifest.json
  versions/<version>/release-ready.json
```

上传规则：

- 本地缺失任一预期文件立即失败；
- 远端对象不存在时使用 `x-cos-forbid-overwrite: true` 上传；
- 远端对象存在且 hash/size 相同则跳过，支持续跑；
- 远端对象存在但内容不同则失败，禁止静默覆盖；
- 上传后通过 COS API 回读并再次校验。

发布前查询 bucket versioning。`x-cos-forbid-overwrite` 仅在未启用版本控制时有效；
若目标 bucket 已启用版本控制，本期流程 fail closed，先完成单独的版本化对象策略，
不能假装“禁止覆盖”仍生效。

大文件继续使用 SDK 的分片上传能力。自定义 SHA-256 metadata 只用于快速预检，不能
单独证明远端字节正确；上传后比较 COS 返回的 `x-cos-hash-crc64ecma` 与本地 CRC64。
历史对象没有 CRC64 时，通过 COS API 流式读取并计算 SHA-256。小型 manifest 使用
`putObject` 上传并通过 `getObject` 回读原文。频道晋级与恢复可以使用对象复制，但复制
后仍必须回读，不能把 API 返回成功等同于内容已正确生效。

此时不修改任何频道 manifest。失败只会留下未被频道引用的版本化对象和 GitHub draft，
不会影响现有用户。

### 阶段 5：正式发布 GitHub Release

只有 COS 不可变制品验证完成后才将 GitHub draft 发布。若该步失败，频道指针仍保持
旧版本；修复权限或 GitHub 状态后可对同版本续跑。

Release 公开且 assets 再次核对成功后，写入不可变
`versions/<version>/release-ready.json`，记录 GitHub Release URL、tag/SHA、
channel、payload 散列和 `eligibility.kind: "github-release"`。该标记是 rollback
可以晋级该版本的发布资格门；仅完成阶段 4、尚未公开的版本不能被 rollback 绕过。

`release-ready.json` 内容由上述稳定字段确定，不包含当前 run ID 或写入时间，确保同一
Release 续跑时内容完全一致。

### 阶段 6：晋级 COS 频道

GitHub Release 已公开后：

1. 读取并保存当前频道 manifest；
2. 将版本化 manifest 内容写入对应频道指针；
3. 使用 COS API 直接回读并确认 version 与 hash；
4. 通过客户端实际使用的匿名 URL 加 `?ci=<run-id>` cache-busting 参数，验证可读性、
   版本和缓存头；
5. 验证失败时恢复先前 manifest，并让任务失败。

频道 manifest 使用 `Cache-Control: no-cache, max-age=0, must-revalidate` 和 YAML
content type；按版本命名的 `.exe`、`.blockmap`、历史 manifest 使用
`Cache-Control: public, max-age=31536000, immutable`。匿名验收必须检查频道响应未被
配置成长缓存，并确认安装包/blockmap URL 至少可匿名 HEAD/Range 读取。

从历史 manifest 复制到频道指针时使用 `MetadataDirective: Replaced`，显式重设频道
content type 与 no-cache metadata，不能继承历史对象的 `immutable` 缓存头。

逻辑 channel 与物理文件名固定映射：

- stable（无预发布后缀）→ updater channel `latest` → `releases/latest.yml`；
- `-beta.<n>` → updater channel `beta` → `releases/beta.yml`；
- `-alpha.<n>` → updater channel `alpha` → `releases/alpha.yml`。

`electron-builder.yml` 移除 generic provider 上固定的 `channel: latest`，保留
`generateUpdatesFilesForAllChannels: true`，让 Electron Builder 按 package SemVer
后缀生成对应 channel 文件；artifact contract 必须证明实际输出与上述映射一致。

版本化 manifest 保留同一个物理文件名，例如
`releases/versions/4.3.96/latest.yml`。`src/main/updater.ts` 中现有 `stable` 别名必须
在传给 electron-updater 前规范化为 `latest`。调用方没有显式 channel 时，根据
`app.getVersion()` 推导默认值：stable → `latest`、beta → `beta`、alpha → `alpha`，
确保预发布安装包不会错误读取 stable 指针。

设置 `autoUpdater.channel` 后再次显式设置 `allowDowngrade = false`，避免 channel
setter 改写该值。beta/alpha 不共享 stable 指针，本轮不自动跨频道，也不默认开启
降级；用户主动切换频道属于独立产品行为，必须经过现有设置 UI 与测试。

频道更新之后只允许执行只读验证和 Actions summary，不再执行其他外部写操作。

## COS 上传脚本

现有 `scripts/upload-cos.js` 需要拆分为可测试的纯逻辑和 COS 适配器，至少支持：

- `verify`：检查本地文件契约；
- `upload-assets`：上传并验证不可变对象；
- `promote`：更新并验证频道 manifest；
- `rollback`：从历史版本 manifest 恢复频道；
- `--dry-run`：打印计划，不写 COS。

CI 中必须显式提供 `COS_SECRET_ID`、`COS_SECRET_KEY`、`COS_BUCKET`、`COS_REGION`
和 `COS_PREFIX`。
生产路径不使用脚本内硬编码 bucket/region 作为兜底。日志不得输出 secret、签名证书
内容或完整认证错误对象。

COS 凭证应限制到目标 bucket 和 `releases/` 前缀所需的最小读写权限。

CAM 最小 action 集：

- bucket 只读：`name/cos:GetBucketVersioning`、`name/cos:GetBucket`（分页列出
  `releases/versions/`，用于版本推进校验）；
- 对象读取/校验：`name/cos:GetObject`；
- 小文件与复制目标写入：`name/cos:PutObject`；
- 分片上传：
  `name/cos:InitiateMultipartUpload`、`name/cos:ListMultipartUploads`、
  `name/cos:ListParts`、`name/cos:UploadPart`、
  `name/cos:CompleteMultipartUpload`、`name/cos:AbortMultipartUpload`；
- 恢复“原先不存在”的首次频道指针：`name/cos:DeleteObject`，resource 只允许
  `releases/latest.yml`、`releases/beta.yml`、`releases/alpha.yml`，不得覆盖整个
  `releases/` 前缀。

`COS_BUCKET`、`COS_REGION`、`COS_PREFIX` 是 GitHub Environment variables，不是
secrets。校验器据此生成更新 URL，并与 `electron-builder.yml` 和
`src/main/index.ts` 中的 URL 做契约比较；三者不一致时在构建前失败，防止制品上传到
客户端永远不会读取的 bucket。该重复配置由 contract test 约束，不能静默漂移。

## 幂等、失败与回退

### 允许自动续跑

以下状态可由相同版本、相同 SHA 的新 run 接续：

- tag 已创建；
- GitHub draft 已创建；
- GitHub asset 已存在且 hash 相同；
- COS 版本对象已存在且 hash 相同；
- GitHub Release 已公开但 COS 频道尚未晋级；
- COS 频道已经指向目标版本。

续跑必须复用阶段 2 选出的 canonical artifact。只有尚未产生任何外部版本状态的失败
才允许重新构建。若频道已经正确指向目标版本且两端散列一致，任务以幂等 no-op 成功
结束。

### 必须停止并人工处理

以下情况不得自动覆盖：

- tag 指向不同 SHA；
- 同版本 GitHub/COS 资产内容不同；
- 已有远端版本状态但 canonical artifact 已丢失；
- 部分签名 secrets 存在；
- updater YAML 与实际安装包不一致；
- 目标 channel 与版本后缀不一致；
- rollback 目标 manifest 或其引用制品缺失；
- rollback 目标缺少 `release-ready.json`；
- COS 回读验证失败且旧 manifest 无法恢复。

### 热更新回退

回退流程与 Release 共用同一个 concurrency group。它从版本后缀推导 channel，验证
目标版本的 `release-ready.json`、版本化 manifest、安装包和 blockmap。发布资格还必须
满足：

- `eligibility.kind: "github-release"` 还要通过 GitHub API 确认 Release 仍为公开、
  非 draft，且 assets 散列一致；
- `eligibility.kind: "legacy-import"` 只允许迁移流程建立的基线版本。

满足后才把同频道 manifest 内容改为目标版本。目标版本必须严格低于当前频道版本；把
尚未晋级的更高版本推上频道只能继续原 Release，不能借 rollback 绕过发布状态机。
回退完成后：

- GitHub Release 保持原样，保留审计历史；
- 新版本制品保持不可变，便于问题修复后重新晋级；
- Actions summary 记录从哪个版本回退到哪个版本、操作者、run ID 和 SHA-256。

这类回退只会阻止坏版本继续扩散，并让仍在旧版本的客户端看见目标版本。已经安装更高
版本的客户端不会因此自动降级；真实客户端降级涉及 `allowDowngrade`、数据兼容和用户
确认，不属于本期。

## 首次启用与旧链冻结

新 CD 首次写频道前，先把当前线上 stable（基线为 4.3.95）纳入历史：

1. 从 COS 读取当前 `latest.yml`；
2. 验证其引用的安装包和 blockmap；
3. 生成 `provenance.kind: "legacy-import"` 的历史 manifest，不伪造原 Actions run、
   工具版本或 commit；
4. 计算并保存散列和 `eligibility.kind: "legacy-import"` 的
   `release-ready.json`；若现有 GitHub Release/资产存在则一并核对，但不把缺失的
   GitHub 历史当作迁移失败；
5. 再启用新 Release/rollback 工作流。

若 beta/alpha 指针尚不存在，首次发布前记录“先前状态为空”；首次晋级验证失败时恢复为
不存在，而不是伪造一个 stable manifest。

两个阶段是实现顺序，不是允许长期并存的两套生产发布链。最终改造合并前：

- 删除 `build.yml` 的重复路径；
- 移除旧 `release.yml` 的 tag trigger 与 `skip_tests`；
- 移除或封闭 `package.json` 中可绕过门禁直接写 COS 的 `upload:cos` /
  `release:cn`，保留本地 `verify` / `--dry-run`；
- 更新 `docs/hot-update.md`，废弃“本地构建后直接上传”的正式流程。

在新 CD 尚未完成 dry-run 与基线迁移前不推送新版本 tag。若实现必须跨多个 PR，相关 PR
只在功能分支依次落地，最终以一个完整可用状态合入 `main`。

## 权限与供应链安全

- 工作流顶层默认 `permissions: contents: read`；
- 创建 tag/Release 的 job 单独获得 `contents: write`；
- canonical artifact 发现/下载 job 单独且完整声明 `contents: read` 与
  `actions: read`（job 级权限会覆盖顶层权限），跨 run 下载同时显式传入
  `github-token` 与已验证的 `run-id`；
- PR job 不声明 environment，也不接收 COS 或签名 secrets；
- COS 发布 job 使用 GitHub `production` environment；签名 job 使用同一 environment
  或单独的 `release-signing` environment，但只显式引用签名 secrets；
- 发布关键路径上的第三方 Actions 必须锁定完整 commit SHA，并由 Dependabot 更新；
- `pnpm install --frozen-lockfile` 是所有生产构建的唯一依赖安装方式；
- runtime 下载使用锁定的 `package.json` 版本，并按
  `scripts/runtime-assets.lock.json` 的 SHA-256 校验 Codex、FFmpeg、Docker MCP
  Windows 资产；自动 bump 必须同步更新版本与 digest，不在发版时解析“latest”；
- 发布清单记录 Actions run 与 commit，确保二进制可追溯。

## 可观测性

每次正式发布生成单一 Actions summary，至少包含：

- version、channel、commit、tag；
- quality gate 结果；
- Windows 签名状态；
- 文件名、大小和 SHA-256；
- GitHub Release URL 与状态；
- COS 版本对象验证结果；
- COS 频道当前版本；
- 若失败，失败阶段和安全续跑条件；
- 对应的回退工作流入口。

失败时上传相关报告：

- typecheck/单测/覆盖率输出；
- Playwright trace、截图和 report；
- `release-manifest.json` 与 `SHA256SUMS.txt`；
- 脱敏后的 COS 校验结果。

## 预计文件变更

工作流：

- 重写 `.github/workflows/ci.yml`；
- 新增 `.github/workflows/_quality-gates.yml`；
- 新增 `.github/workflows/_windows-release-build.yml`；
- 新增 `.github/workflows/nonblocking-quality.yml`，承载 nightly/manual 的
  extended/隔离 E2E、visual 和 benchmark；
- 重写 `.github/workflows/release.yml`；
- 新增 `.github/workflows/migrate-release-baseline.yml`，一次性把当前 4.3.95 COS
  制品登记为 `legacy-import` 基线；
- 新增 `.github/workflows/rollback-hot-update.yml`；
- 删除 `.github/workflows/build.yml`；
- 收窄 `.github/workflows/codex-auto-update.yml`。

脚本与测试：

- 把 `tests/windows-only-workflows.test.mjs` 扩展/拆分为 CI/CD contract tests；
- 新增 `scripts/release/validate-release.mjs`；
- 新增 `scripts/release/verify-artifacts.mjs`；
- 把 `scripts/upload-cos.js` 替换为可测试的 `scripts/release/cos-release.mjs` 和纯逻辑
  模块；
- 新增对应的 Node 单元测试和 package scripts；
- 新增 `e2e/quarantine.json`，schema 固定为
  `{ testId, reason, issue, addedAt, expiresAt }[]`；
- 在 `playwright.config.ts` 中提供 `electron-stable`、`electron-extended` 与
  `electron-quarantine` projects；被隔离测试使用 `@quarantine` tag，contract test
  保证 tag 与 manifest 一一对应且未过期。

应用与文档：

- 更新 `src/main/updater.ts` 及其测试，规范化 stable/latest 并关闭隐式跨频道降级；
- 为 `src/main/index.ts`、`electron-builder.yml` 和 COS variables 增加更新 URL
  一致性契约；
- 更新 `package.json`，删除非权威且已漂移的 `package-lock.json`，移除直接生产上传
  入口并增加 verify/dry-run 命令；
- 更新 `.env.signing.example` 与 `docs/code-signing.md`，明确本地
  `WIN_CSC_LINK/WIN_CSC_KEY_PASSWORD` 和 GitHub
  `WIN_CERTIFICATE/WIN_CERTIFICATE_PASSWORD` 的映射；
- 更新 `docs/hot-update.md`、`docs/BUILDING.md` 和发行说明模板。

## 实施阶段

### 第一阶段：稳定 CI

1. 在干净 `main` 上建立真实基线。
2. 扩展 workflow contract tests，先写失败用例约束目标结构。
3. 提取 `_quality-gates.yml`。
4. 显式隔离已确认的不稳定 E2E，稳定集改为强制门禁。
5. 删除 typecheck、单测和覆盖率的整套 `continue-on-error`。
6. 将视觉回归、benchmark 移到 schedule/手动任务。
7. 让 `quality-gate` 在上游失败/取消时显式失败。
8. 验证 PR、push 和手动质量门禁都使用固定 status 名称。

### 第二阶段：自动 CD

1. 为版本校验、制品校验、COS 规划和幂等判断编写单元测试。
2. 重构 COS 上传脚本，默认 fail closed。
3. 实现 Windows 单次构建工作流和签名状态验证。
4. 实现 canonical artifact 发现、跨 run 复用和手动 Release 状态机。
5. 实现 COS 防覆盖、版本化 manifest、发布资格、频道晋级和回读验证。
6. 实现手动热更新回退工作流。
7. 迁移当前 4.3.95 stable 为首个可回退历史版本。
8. 删除重复 `build.yml` 和旧生产上传入口，收窄 Codex 自动更新目标为 Windows。
9. 配置 GitHub `production` environment、COS secrets/variables 和可选签名 secrets。
10. 先运行 `dry_run`，再用预发布版本验证完整链，最后启用 stable。

## 测试策略

所有改造采用 TDD，优先扩展仓库已有的 Node workflow contract tests。

必须覆盖：

- 仅有一个正式 Windows 构建路径；
- Release 不响应 tag push 或 main push；
- Release 只能手动触发且不能跳过测试；
- PR 工作流不引用生产 secrets；
- 任一频道 manifest 晋级严格晚于 GitHub Release 发布和 COS 版本对象校验；
- 缺失任一制品时上传计划失败；
- 同 hash 允许续跑，不同 hash 拒绝覆盖；
- tag 同 SHA 允许续跑，不同 SHA 失败；
- 已有远端状态时复用 canonical artifact，不重新签名构建；
- 跨 run artifact 下载只接受可信 workflow/event/SHA，并具备 `actions: read`；
- signed、unsigned、部分配置三种签名状态；
- stable、beta、alpha channel 推导与隔离；
- rollback 与 Release 串行，并拒绝未正式发布、缺失或跨频道目标；
- rollback 目标必须低于当前频道，不能作为向前 promotion；
- `release-manifest.json` / `SHA256SUMS.txt` 不自引用；
- `actions-build` 与 `legacy-import` 两种 provenance 均可验证且不伪造字段；
- COS 更新 URL 与打包/运行时配置一致；
- COS bucket/versioning/权限预检发生在任何外部写入之前；
- 构建命令固定带 `--publish never`；
- GitHub prerelease/latest 状态与 SemVer 后缀一致；
- 频道与不可变资产使用各自的 Cache-Control；
- 工作流只生成 Windows 文件；
- `dry_run` 不写 tag、GitHub Release、COS 等生产状态；允许上传隔离命名的 Actions
  artifact 和 job summary。

COS 单元测试使用注入的假客户端，不访问真实云服务。真实 COS 只在受保护的生产 job
中做最小上传、回读和 manifest 晋级验证。

## 验收标准

1. PR required checks 中不存在笼统的“成功但实际失败”任务。
2. 已隔离 E2E 有明确清单、证据、issue 和到期时间。
3. 手动 dry run 能从干净 checkout 产出并验证完整 Windows artifact。
4. 正式 run 自动创建正确 tag、GitHub Release 和 COS 热更新。
5. GitHub 与 COS 文件 SHA-256 和本地 artifact 完全一致。
6. 无证书时发布成功但明确标为 unsigned；部分签名配置会失败。
7. 任意阶段故障都不会让任何频道 manifest 指向未验证制品。
8. 相同 SHA 的同版本重跑复用 canonical artifact，不重新签名产生第二套二进制。
9. stable/beta/alpha 使用互不混用的 `latest.yml`/`beta.yml`/`alpha.yml`。
10. 4.3.95 已成为新流程启用前的首个可验证回退基线。
11. 热更新回退不需要重建，只允许具备有效发布资格的同频道版本，并能通过 COS API
    证明频道已指向目标版本。
12. 回退文档明确说明它不会让已安装高版本的客户端自动降级。
13. Windows-only workflow contract tests、typecheck、稳定单测、Skill 门禁、构建和
    稳定 E2E 全部通过。

## 仓库外配置清单

实施完成后需要在 GitHub 配置：

- Environment：`production`；
- Secrets：`COS_SECRET_ID`、`COS_SECRET_KEY`；
- Environment variables：`COS_BUCKET`、`COS_REGION`、`COS_PREFIX`；
- COS bucket：确认 versioning 未启用，并为 CI 子账号配置文档列出的前缀级 CAM
  权限；
- Actions retention：确认仓库/组织允许至少 90 天；若上限更低，在发布摘要记录实际
  有效天数，并相应缩短“可跨 run 自动续跑”的承诺；
- 可选签名 secrets：`WIN_CERTIFICATE`、`WIN_CERTIFICATE_PASSWORD`，
  以及需要时的 `WIN_CERTIFICATE_SUBJECT_NAME`；
- Branch protection：首次运行后，把 GitHub 实际显示的 `quality-gate` 完整 check
  context 设为 `main` required check；
- 可选 Environment reviewer：若将来希望在手动发版后再增加一次发布审批。

证书未就绪不阻塞本轮上线；COS 凭证和 bucket/region 配置是启用自动 CD 的必要条件。

## 参考资料

- GitHub Actions 手动触发：
  https://docs.github.com/en/actions/using-workflows/triggering-a-workflow
- GitHub Actions 可复用工作流：
  https://docs.github.com/en/actions/how-tos/reuse-automations/reuse-workflows
- GitHub Actions 部署与 concurrency：
  https://docs.github.com/en/actions/concepts/use-cases/deploying-with-github-actions
- 腾讯云 COS Node.js SDK：
  https://github.com/tencentyun/cos-nodejs-sdk-v5
- 腾讯云 COS `x-cos-forbid-overwrite`：
  https://cloud.tencent.com/document/product/436/7749
- 腾讯云 COS CRC64 校验：
  https://intl.cloud.tencent.com/document/product/436/45260
- 腾讯云 COS API 授权策略：
  https://cloud.tencent.com/document/product/436/31923
