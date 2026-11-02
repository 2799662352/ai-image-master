# 类型债务基线 · 2026-10-31 到期复审(续期)

日期：2026-11-02
上一次复审：`docs/superpowers/specs/2026-08-28-typecheck-baseline-review.md`(选项 C,续到 2026-10-31)
实现：`scripts/ci/typecheck-baseline.mjs`，基线数据 `tests/ci-cd/typecheck-baseline.json`

---

## 0. 为什么现在要动

`expiresAt` 在 2026-10-31 过了。到点之后 `validateBaselineExpiry` 直接抛错，`typecheck:ci`
对**所有** PR 都变红（与改动内容无关），聚合门拦住全部合并。这是闸自己设计好的行为：
到期日硬编码在 `typecheck-baseline.mjs` 的 `--write` 分支里，重新生成基线不会续期，
必须有人显式改那一行并留一份复审记录——就是本文。

## 1. 复审结果：还是 7 条，零新增

在「`origin/main`（`809b54ea`,4.9.24）合并了素材预传地址持久化(#394)」的分支上跑
`tsc --noEmit --pretty false`，共 7 条诊断，与基线逐条对得上（该分支比 main 多出的代码没有引入新诊断；
本 PR 自己的 `typecheck:ci` 会在纯 main 基础上再验一次）：

| 文件 | 条数 | 码 |
|---|---|---|
| `src/main/services/smartErase/index.ts` | 4 | TS2339（`stack` 不在 `onFailed` 契约里） |
| `src/renderer/src/services/storage/StorageBridge.ts` | 2 | TS2345 / TS2322（两份 `HistoryItem` 打架） |
| `src/renderer/src/shims/deepagents-bridge.ts` | 1 | TS2307（`deepagents` 包未声明未安装） |

两个月内没有新增、也没有清掉。**上次写下的三个「不属于类型系统的决定」仍然没有人拍板**
（改不改运行时日志 / `HistoryItem` 住哪 / 两条 storyboard 流水线还用不用 `deepagents`），
所以这次没有可以诚实清掉的条目——强行用 `any` / `@ts-expect-error` 压掉只会让闸失效。

## 2. 决定

沿用上次的选项 **C（就地续期）**：`expiresAt` 推到 **2026-12-31**，基线内容不动
（诊断列表本来就是 7 条，没有已修未清的额度）。棘轮仍在：新增任何一条诊断照常红。

**这次不是对 A/B/C 的重新表态。** 上次文档的推荐（A：清零后删闸）至今成立，而且更成立了——
只剩 7 条、根因和修法都已写清。续期只是为了让闸继续只拦「新增」而不是拦所有人，
不代表这 7 条可以一直放着。

## 3. 下次到期（2026-12-31）前该有答案的三件事

1. `smartErase` × 4：在 `jobQueue.ts` 的 `errorPayload` 上保留 `stack` / `cause`（或把原始 error 作为第三个参数传给 `onFailed`），
   一次改动修好 `smartErase` 与 `storyboardSplit` 两个消费方，同时把一条本该存在的排障日志通道接回来。
2. `StorageBridge` × 2：把权威 `HistoryItem` 收敛到一处。注意磁盘上很可能两种时间戳形态（string / number）并存。
3. `deepagents` × 1：先回答「`StoryboardV4Pipeline` / `StoryboardDeepAgentV3Pipeline` 现在还用吗」——
   按现状 `getCreateDeepAgent()` 运行时会抛，这两条流水线当前是坏的。

三件事清完即可按选项 A 删闸，不再需要复审。
