# 命令行改动也能看见:回合快照式文件变更

> 状态:设计已确认,待写实施计划
> 日期:2026-08-15

## 要解决什么

聊天里的「agent 编辑了 N 个文件」汇总条(`FileChangeSummary`)只统计 Codex 的
`fileChange` item,也就是 agent 通过 `apply_patch` / 文件编辑工具做的改动。
**agent 用 shell 命令改的文件完全不出现。**

这不是 bug,是当初写死的口径,模块注释里写明了。但它在真实使用中会漏掉整类场景。
触发本次设计的实例:agent 要把一个 markdown 回写成 UTF-8 无 BOM,于是走
`pwsh -c "...WriteAllText(..., UTF8Encoding($false))"`,聊天里只留下两个 CMD 块,
用户看不到改了什么。

## 上游怎么做的(以及为什么不能照抄)

调研了 openai/codex 的实现与 issue,结论是**它有三套机制,且每一套都不能直接用**。

### 一、`TurnDiffTracker`(codex-rs/core)

文档注释原话:

> Tracks the net text diff for the current turn from committed apply_patch
> mutations, **without rereading the workspace filesystem**.

只认 apply_patch,明确不读磁盘。它能不读盘还给出 diff,是因为 `apply_patch` 回包里
同时带 `old_content` 和 `new_content`——把首次见到的 old 存成 `baseline_by_path`、
末次的 new 存成 `current_by_path`,再渲染 unified diff。

**和我们现在的口径完全一致,盲区也一样。** 所以上游核心层给不出答案。

两个值得抄的纪律,**两条都已落地**:
- `track_delta` 里 `delta.is_exact()` 为假时直接 `invalidate()` 作废整轮,而不是
  展示一份可能不准的。→ 对应我们「基线不可信就整轮作废」。
- diff 渲染有 100ms 超时,病态输入宁可降级也不卡住工具返回。→ 对应
  `snapshotDiff.DIFF_TIMEOUT_MS`;区别是我们超时后仍保留这条改动记录、只把正文
  换成说明,因为漏报「这文件被改过」比不展示内容更坏。

### 二、`/diff` 命令

跑真的 `git diff`(含未跟踪文件)。不在 git 仓库里就显示「not inside a git
repository」。对非 git 目录无效——而内容创作类工作区(剧本、素材)通常不是仓库。

### 三、Codex Desktop 的 git checkpoint

Desktop 会往用户仓库写 `refs/codex/turn-diffs/checkpoints/`,把整棵工作区树写成
git 对象。**这正是「回合快照」思路的持久化版本,而它的代价在 issue 里摆着:**

> 口径说明:这部分代码**不在开源仓库里**(repo 内搜 `turn-diffs` / `update-ref` /
> `enable_git_checkpoints` 零命中),下面全部是从 issue 里的可观测症状反推的,
> 不是读源码得到的结论。原帖把根因指向 `git-utils/src/baseline.rs`,那个指认是
> **错的** —— 该模块只服务 `~/.codex/memories`。所以别把「它调了什么函数」当事实
> 引用;能站住的只有症状本身,而症状已经足够支撑我们的取舍。

| Issue | 后果 |
|---|---|
| [#29388](https://github.com/openai/codex/issues/29388) | 单项目 `.git/objects` 涨到 **101.86 GiB**(8476 个 loose object,429 个 blob 超 100MB,仓库从 5.7 GB 涨到 140 GB)。不认 `.gitignore`,不做 GC |
| [#30214](https://github.com/openai/codex/issues/30214) | **数据丢失**:连续三次 rollback 写坏内部 git 仓库,`HEAD` 变二进制垃圾,工作区文件永久丢失 |
| [#37559](https://github.com/openai/codex/issues/37559) / [#35910](https://github.com/openai/codex/issues/35910) | checkpoint ref 路径 214 字符,超 Windows MAX_PATH |
| [#31962](https://github.com/openai/codex/issues/31962) | `enable_git_checkpoints = false` 关不掉 |
| [#35422](https://github.com/openai/codex/issues/35422) | 非 git 工作区「完整文件内容加载失败」,Retry 永远失败 |

### 由此得到的三条硬约束

1. **绝不落盘。** 快照只在内存,回合结束即弃。#29388 整类问题因此不存在。
2. **绝不提供回滚/还原。** #30214 的数据丢失来自 rollback 路径。本功能只读。
3. **必须有忽略规则和体量闸。** 即 #29388 自己提的修复建议 1 与 2。

## 方案选择

量测了两种真实工作区的快照成本(PowerShell 串行读,Node 并发会更快):

| 工作区 | 文本文件 | 体积 | 枚举 | 枚举+全读 |
|---|---|---|---|---|
| 本仓库 `src/` | 1263 | 11.7 MB | 118 ms | 317 ms |
| `D:\第28集`(内容目录) | 8 | 0.08 MB | — | 286 ms(几乎全是遍历 99 个文件的开销) |

几百毫秒量级。三个候选:

**A. 回合异步快照(选中)** — 回合开始异步拍,不阻塞;赛跑输了整轮作废;结束时
重扫对比,随后丢弃。纯聊天回合会白读一次盘。

**B. 常驻缓存 + fsWatcher 增量** — 稳态成本近零,天然跨回合。但 Windows 原生递归
监视在高负载下会丢事件(缓冲区溢出),丢了就意味着缓存里躺着过期的「旧内容」,
而我们不知道——**静默给出错误的 diff**。

**C. 只列变动文件名** — 几乎免费,但给不出 diff,价值不足(用户从 CMD 块里也能猜到)。

**选 A,理由是错误模式的性质而非性能。** A 错了只是「这轮没显示」;B 错了是「显示
了一份看起来对、实则拿旧基线算的 diff」,用户会照着它做判断。上游那几个 issue 的
共同教训正是:这类功能出问题时,沉默的错误比缺失贵得多。B 可作为 A 跑稳后的纯优化。

## 架构

### 组件

**`src/main/agent/workspaceSnapshot.ts`**

```ts
takeSnapshot(roots: string[], budget?: SnapshotBudget): Promise<Snapshot>
interface Snapshot { files: Map<string, string>; complete: boolean }
```

只读文本文件。超预算时 `complete: false`——**不返回半份快照**,调用方据此整轮作废。

**`src/main/agent/snapshotDiff.ts`**

```ts
diffSnapshots(before: Snapshot, after: Snapshot): FileChange[]
```

纯函数,产出 unified diff 字符串(`FileDiffBlock` 现有格式)。

**`src/types/agent-timeline.ts`**

`FileChange` 新增可选字段 `source?: 'reported' | 'observed'`。可选是为了已持久化的
历史行仍然合法;缺省视为 `reported`。

### 数据流

```
回合开始 ──► 异步 takeSnapshot()（不 await）
                │
事件流 ──► 首个 shell item_started
                │  快照还没回来？→ 本轮作废
                ▼
turn_completed ──► 重扫 → diff → 减去 apply_patch 已报告的路径
                          │
                          ▼
        合成 item_completed(fileEdit)，其每条 FileChange 带 source='observed'
                          │
              ┌───────────┴───────────┐
       emitEvent → 渲染端        applyAssistantEvent → 落库
```

**复用现成的 `fileEdit` item 类型与 `item_completed` 事件。** 渲染端 reducer
(`store.applyEvent`)和主进程累加器(`applyAssistantEvent`)本来就处理它,直播与
持久化两条路零改动。这是本设计最省的一处。

**减去已报告的路径**是必须的:同一文件若既被 apply_patch 改过又被命令改过,不减会
出现两条。

### 作废条件(任一即整轮不显示)

- **预算超限** —— 起始或结束任一次快照 `complete: false` 即作废。两次扫描用同一份
  预算;只有一次完整则两边不可比,算出来的「新增/删除」全是扫描范围差异造成的假象。
- **赛跑输了** —— 首个 shell `item_started` 早于起始快照完成。
- **快照读盘出错**。
- **本轮没有执行过命令** —— 判据是这一轮的 timeline items 里出现过 `type: 'shell'`
  的项。没有命令就没有盲区,`apply_patch` 那条路已经全覆盖,不该去猜。

### 扫描根目录

取 `AgentManager.allowedRoots`(即会话的 `writableRoots`,与 `setFsAllowedRoots`
推给文件面板的是同一组)。agent 改不到的地方不必扫,也不该扫。

### 预算初值

| 项 | 值 |
|---|---|
| 最大文件数 | 3000 |
| 单文件上限 | 256 KB |
| 总量上限 | 32 MB |
| 跳过目录 | `node_modules` `.git` `dist` `build` `out` `.next` `coverage` `target` `.venv` `__pycache__` |
| 二进制判定 | 前 8 KB 含 NUL 字节即跳过 |

### 新增依赖

`diff`(npm)。仓库里没有任何 unified diff 生成器——`shared/diffUtils.ts` 只会数
增删行数。手写带 hunk 与上下文的 unified diff 易错,上游用的 Rust `similar` 属同一类。

## UI 与文案

汇总条中 `observed` 的行带独立标记(「命令行」)。`SCOPE_NOTE` 改写为:既包含 agent
报告的编辑,也包含**本轮在磁盘上观察到的变化**;后者**不保证都是 agent 改的**——
用户在其它编辑器里的改动、后台进程写出的产物,都可能落入。

这句话必须出现在 UI 上,不能只写在代码注释里:归因不确定性是本方案的固有代价,
用户有权在看到数字时就知道它的口径。

## 测试

**快照层** — 跳过表生效;单文件超限被跳过;总量超限置 `complete:false`;二进制跳过;
根目录不存在时不抛错。

**对比层** — 新建/修改/删除三态;unified diff 内容正确;增删行数正确;无变化返回空;
任一侧 `complete:false` 时返回空(而不是把扫描范围差异当成改动)。

**接线层** — 赛跑输了不显示;本轮无命令不显示;已报告路径被减掉;合成事件的形状能被
`applyAssistantEvent` 正确消费。

**渲染层** — `observed` 标记渲染;口径说明文案存在。

## 已知限制

- **不解析 `.gitignore`。** 固定跳过表 + 体量闸对不落盘的方案已足够;#29388 的
  gitignore 建议是给持久化方案的刚需。若日后发现漏网的产物目录,优先扩跳过表。
- **归因不确定。** 见上文 UI 段。这是读磁盘方案的固有代价,只能靠文案诚实交代。
- **只覆盖文本文件。** 二进制改动不显示,也不计数。
- **纯聊天回合白读一次盘。** 异步进行,用户不可见;若日后成为问题,方案 B 是升级路径。
