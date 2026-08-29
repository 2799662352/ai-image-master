# 类型债务基线 · 2026-08-31 到期复审

日期：2026-08-28
状态：**待你决策**（§5）
闸的出处：`docs/superpowers/specs/2026-07-13-cicd-hardening-design.md:188-192`
实现：`scripts/ci/typecheck-baseline.mjs`，基线数据 `tests/ci-cd/typecheck-baseline.json`
CI 接线：`.github/workflows/_quality-gates.yml:50-69`（`typecheck:ci`），是聚合门的必需项（`:189,200`）

---

## 0. 这次复审是闸自己要求的

设计文档原文：

> 实际基线复核得到 828 条 TypeScript 诊断，无法在 CI/CD 改造中一次性消除。为避免继续使用 `continue-on-error`，required gate 改用有到期日的诊断债务基线……**基线于 2026-08-31 到期并强制复审**。原始 `pnpm run typecheck` 仍保持严格 `tsc --noEmit`，不得用基线宣称项目已零类型错误。

关键词是「**强制复审**」，不是「到点必须归零」。`expiresAt` 硬编码在 `typecheck-baseline.mjs:148` 的 `--write` 分支里，所以重新生成基线**不会**续期——这是刻意设计，为的就是逼出这次决策而不是让人绕过去。

## 1. 结果：828 → 7

| 时点 | 诊断数 |
|---|---|
| 闸建立时（2026-07-13） | 828 |
| 基线快照（2026-07-25） | 51 |
| 本次复审开始（2026-08-28） | 43 |
| **本次复审结束** | **7** |

本轮清掉 36 条，`typecheck-baseline.mjs` 报 `7 existing, 44 fixed since baseline, 0 new`。

四批并行清理，各自的提交：

| 提交 | 范围 | 清掉 |
|---|---|---|
| `5689445f` | 测试夹具 + 厂商前缀属性 | 9 |
| `309bdecf` | smartErase 进度补丁 + marketplace Dirent | 4 |
| `11e3d441` | 渲染层 vanilla 遗留 | 11 |
| `f158f9e8` | JSZip 互操作 / Input 收窄 / COS 通道声明 / 参考图源类型 | 12 |

**全程禁止 `any` / `@ts-ignore` / `@ts-expect-error` / `as unknown as` 糊错误**，也禁止在「代码读的字段运行时压根不存在」时把字段补进类型（那只是把编译错误换成静默 undefined）。已扫描四个提交的新增行，零违规。

### 验收

- `node scripts/ci/typecheck-baseline.mjs` → `7 existing, 44 fixed, 0 new`
- 全量单测 `npx vitest run` → **6040 passed / 2 failed**，两条失败均为 15s 超时（`buildContent.order`、`director-cancel`），单独重跑 8/8 全绿，属满载争用 flake，不在本轮改动区域内

## 2. 顺带修掉的真 bug

清债过程中挖出的、不属于「类型写窄」的真问题：

**`marketplaceService` 的下游污染。** 基线里这个文件原有 6 条，其中 5 条是 `NonSharedBuffer` 顺着 `entry.name` 传染出去的症状，当初用 `String(entry.name)` 压掉了下游、没治源头。根因是 `ReturnType<typeof fs.readdir>` 对**重载函数只取最后一个重载**（`encoding:'buffer'` 那个变体）。改成直接写 `Dirent[]` 之后，那个 `String()` 变成恒等包装，连同它上面那条已经变成事实错误的注释一起清掉。

**`ApiService.generateImageWithReference` 的参考图类型是假的。** 旧签名声明 `{ data: string }`，而 `normalizeImageSource` **根本不认 `data` 这个键**——真按这个签名传图会被静默丢掉。已改为与归一化实际认得的分支一一对应的 `ReferenceImageSource`。顺带发现 `ApiService.ts:1328` 的 `const source = imageBase64 || referenceImages?.[0] || ''` 在旧代码下会把**对象**当 source 传进图层拆分预处理（因为上游传的确实是 `ReferenceImage[]` 对象），入口压平之后这条路径也顺带修好了。

**两处 `success` 死代码。** `{ index, prompt, success: result.success, ...result }` —— 展开在后，必然覆盖同值的显式字段。可证等价，删除无行为变化。

## 3. 剩下的 7 条：为什么还在

三组，每组都是「诚实的修法跨出了当时的范围」，不是没人想修。

### 3.1 `smartErase/index.ts` × 4 —— `stack` 恒为 undefined（真 bug）

`index.ts:128`/`:217` 读 `err?.stack`，但 `onFailed` 的契约是 `{ code, message, stage }`，而唯一调用点在调它之前就把 Error 拍平了：

```75:86:src/main/services/tencent/jobQueue.ts
    } catch (err: any) {
      const errorPayload = {
        code: err.code || 'UNKNOWN_ERROR',
        message: err.message || String(err),
        stage: err.stage || 'unknown',
      }
      try {
        this.opts.events.onFailed?.(entry.job, errorPayload)
```

`stack` / `cause` 在这里就丢了。所以 `index.ts:118-120` 那段注释写明「为了让 TLS / DNS / 代理 / 凭证故障出现在开发终端」的诊断日志，**从写下那天起就是死的**。同一处被 `as any` 掩住的另外 4 个字段（`?.error?.code`、`?.cause?.code` 等）同样恒为 undefined——真实坏面积比基线上这 4 条更大。

**为什么没修**：把 `stack?: string` 加进类型只会把编译错误换成静默 undefined，更糟；诚实的修法要同时改 `tencent/types.ts` 和 `jobQueue.ts`，且是**运行时改动**（日志会多出内容）。

**建议**：在 `errorPayload` 上保留 `stack` 与 `cause`，或把原始 error 作为第三个参数传给 `onFailed`。一次改动同时修好 `smartErase` 和 `storyboardSplit` 两个 JobQueue 消费方。风险低（「日志多打点东西」不会弄坏生成），收益是把一条本该存在的排障通道接回来。

### 3.2 `StorageBridge.ts` × 2 —— 两份 `HistoryItem` 打架

根因在 `src/types/index.ts:18-31`：那份 `HistoryItem` 声明 `timestamp: number`、`ratio`/`type` 必填，而**真源是 StorageBridge 那份**（`HistoryManager.HistoryItem` 直接 extends 它），真正的写入方按 string 写时间戳（`HistoryDataService.ts:145` 的 `new Date().toISOString()`）。

preload 实现侧早就放弃了这个类型（`preload/index.ts:811-812` 是 `any[]`），只有 `src/types/index.ts:191-192` 的 `ElectronAPI` 声明还挂着陈旧那份，于是它经 `window.electronAPI` 泄漏进渲染层、撞上真源。这正是 `src/types/index.ts:218-225` 那段注释自己承认过的病：「两份长期不同步」。

**为什么没修**：三种「就地解决」的写法都不对——强转违反禁令且把真分歧焊死；改必填会连锁产生新错误；放宽成 `string | number` 只能修一条、还把债摊到整个历史子系统。

**建议**：把权威 `HistoryItem` 收敛到一处。最小改法是让 `src/types/index.ts:191-192` 指向真源，但那会让共享类型文件反向依赖渲染层（`import type` 无运行时耦合，概念上仍不干净）。更彻底的是把真源搬进 `src/types` 再让 StorageBridge 引用它——那是历史子系统的一次小重构，**需要你拍**。

顺带一提，`ComparePage.ts:1086-1090` 造历史行时写的是 `timestamp: Date.now()`（number），所以磁盘上很可能真有两种形态并存，收敛时要正视这个并集。

### 3.3 `deepagents-bridge.ts` × 1 —— 包没装

`src/renderer/src/shims/deepagents-bridge.ts:31` 的返回标注是 `typeof import('deepagents').createDeepAgent`，而 **`deepagents` 不在 `package.json` 的任何依赖段**，也没安装。

但它**不是死代码**：`StoryboardV4Pipeline.ts:163` 和 `StoryboardDeepAgentV3Pipeline.ts:175` 都在调 `getCreateDeepAgent()`。这个 shim 走的是原生 `require('deepagents')`（动态、不经打包器），属于「可选运行时依赖」。

**为什么没修**：任何修法都要么装一个未声明的依赖、要么凭空编造类型。

**建议**：先回答一个业务问题——**这两条 storyboard 流水线现在还用吗？** 因为按现状，`getCreateDeepAgent()` 在运行时会直接抛 `_loadError`（包不存在），也就是说这两条流水线**当前是坏的**。
- 还要用 → 把 `deepagents` 正式加进 `package.json`，类型自然就有了
- 不用了 → 删掉 shim 与那两条流水线的相关分支

这是本次复审里唯一一条「类型错误其实在提示一个运行时功能已失效」的。

## 4. 三条剩余项的共同特征

它们都不是「懒得修」，而是**修法本身需要一个不属于类型系统的决定**：改不改运行时日志、`HistoryItem` 该住在哪、那个可选依赖到底还要不要。这恰恰是「强制复审」想逼出来的东西——闸的价值在此。

## 5. 待决策：闸怎么办

`--write` 重新生成会把 `expiresAt` 又写成 `2026-08-31`（硬编码在 `typecheck-baseline.mjs:148`），所以无论选哪条都要动那一行或那个文件。

| 选项 | 做法 | 代价 | 得到什么 |
|---|---|---|---|
| **A. 清零后删闸** | 先修完 §3 三组，再删 `typecheck-baseline.mjs` 与基线 JSON，`typecheck:ci` 直接跑 `tsc --noEmit` | 要做三个决定（运行时日志 / 类型归属 / 依赖去留） | **永久解决**，之后任何新错误都直接红，不需要再复审 |
| **B. 修两组，留 1 条续期** | 修 §3.1 与 §3.2，`deepagents` 那条留基线，新 `expiresAt` 定在解决依赖问题之后 | 中等 | 828 → 1，闸继续起作用但几乎不挡路 |
| **C. 就地续期** | 基线降到 7 条，`expiresAt` 往后推（如 2026-10-31），三组各留追踪凭据 | 最小 | 保住 0-new 的棘轮，把三个决定推到下次 |

**推荐 A**，退而求其次 B。理由：现在只剩 7 条、且每条的根因和修法都已经写在上面，是历史上最容易归零的时刻；而 §3.3 那条还牵着一个「功能可能已经坏了」的线索，值得顺着查下去。选 C 也合理，但要意识到那是把三个已经查清楚的决定再推迟两个月。

**无论选哪条，都必须先把基线 JSON 从 51 条降到 7 条**（`npm run typecheck:baseline:refresh`），否则那 44 条已修诊断会一直留在基线里当「允许额度」，将来同样的错误重新出现时闸不会报警。
