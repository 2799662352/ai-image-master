# file-change 的四条通道:谁在发、我们接哪条、以及为什么实时化的优先级变了

> 状态:前两节是已验证的事实,第三节是待确认的设计
> 日期:2026-08-17
> 前置:[2026-08-15 命令行改动也能看见](./2026-08-15-observed-file-changes-design.md)

## 缘起

用户报「agent 聊天栏的 diff 卡片不会在修改过程中实时展示,要等整块一次性弹出」。
按字面看是接线问题,于是去接 codex 的流式通知。**接完发现方向错了** —— 那条链路
在当前配置下根本不产生任何通知。中间绕的弯留在 [#255](https://github.com/2799662352/ai-image-master/pull/255)
的 commit 里,这份文档只记结论。

## 一、codex 的 file-change 通知有四条,语义各不相同

对着 app-server README、codex-rs 源码和打包进来的 0.147.0 二进制核过。

| 通道 | 内容 | 何时发 | 前提 |
|---|---|---|---|
| `item/started` | 完整 `changes[]`(含 diff) | 编辑开始时 | 无条件 |
| `item/fileChange/patchUpdated` | 累积 `changes[]` 快照 | 模型正在写 patch,500ms 缓冲 | `ApplyPatchStreamingEvents` flag |
| `item/fileChange/outputDelta` | **apply_patch 的工具回执**,不是 diff | 工具执行完 | 无条件 |
| `turn/diff/updated` | turn 级聚合 unified diff | 每个 FileChange item 完成后 | 无条件 |

两条容易踩的坑:

**`outputDelta` 不是 diff。** README 的 fileChange 小节原文是「contains the tool call
response of the underlying `apply_patch` tool call」,而 commandExecution 那条写的是
「streams stdout/stderr … render live output」—— 措辞是有意区分的。合规 codex 在
这里发的是 `Success. Updated the following files: M src/a.ts` 之类。当 diff 渲染
就是往卡片里灌工具日志。

**流式 diff 的 hunk 头不是标准格式。** `format_update_chunks_for_progress` 拼的是
`@@ <context>` 而非 `@@ -a,b +c,d @@`,末尾还有 `*** End of File` 标记。按标准正则
解析行号会匹配不上。

### 官方客户端只用两条

`codex-rs/tui/src/chatwidget.rs` 的事件分发表里跟 patch 有关的只有:

```rust
EventMsg::PatchApplyBegin(ev) => self.on_patch_apply_begin(ev),  // 当场用完整 changes 渲染
EventMsg::PatchApplyEnd(ev)   => self.on_patch_apply_end(ev),    // 成功什么都不做,只在失败时加错误块
```

**没有 `PatchApplyUpdated` 分支,也不消费任何 patch output delta。** 映射到
app-server v2 就是 `item/started` → `item/completed`。想做对,照这个抄就够了。

### 一个上游已知缺陷

[openai/codex#18289](https://github.com/openai/codex/pull/18289) 的 P2 评审:
`PatchApplyUpdated` 的 changes 用的是**未经 cwd 解析的原始 hunk 路径**,而
`item/completed` 用的是解析后的路径 —— 同一个文件在生命周期中途会从 `src/a.ts`
变成 `D:/repo/src/a.ts`。**任何按路径做 key 的渲染都会把它当成另一个文件。**
我们的卡片行因此改成按下标做 key;官方 TUI 用 `HashMap<PathBuf, FileChange>`,
同一个根因在那边表现为多出一个重复条目。

## 二、当前配置下,这四条一条都不发

2026-08-17 实机验证(Qwen 3.8 Max + 自建网关,codex-cli 0.147.0):

- 日志里 `apply_patch` 出现 **0 次**
- `[codex trace]` 79 条,item 类型只有 agentMessage / commandExecution / mcpToolCall /
  reasoning / userMessage,**一条 fileChange 都没有**
- 模型全程用 PowerShell 改文件

也就是说 codex 只在模型调用 `apply_patch` 时才产生 fileChange item,而这个模型
不用它。上面那四条通道于是全部沉默。

> **验证方法已固化。** `CodexProtocolClient` 在每个改过文件的 turn 结束时打一行
> `[codex diag] file-change channels this turn: patchUpdated=N outputDelta=N turnDiff=N`。
> 关键在于「零」被**显式打印** —— 三条都没发和压根没打日志,在日志文件里长得
> 一模一样,而这两种情况的处置完全相反。下次换模型/网关先看这行。

### 由此得到的真正结论

`observedChanges`(回合前后工作区快照对比)**不是 apply_patch 链路的补充,在这类
配置下它是唯一链路**。前置文档把它定位成「补盲区」,这个定位需要上调。

而它按构造只能在 `turn_completed` 时出结果:

```4839:4848:src/main/agent/AgentManager.ts
          if (event.type === 'turn_completed') {
            // 落库之前把观察到的改动补进去,这样直播和历史看到的是同一份。
            const reportedPaths = new Set(...)
            const observedChanges: FileChange[] = observer
              ? await observer.finish(reportedPaths).catch(() => [])
              : []
```

**用户报的「不实时」就是这个,不是接线漏了。** 前置文档「已知限制」里没有这一条,
因为当时它只是补充手段,晚一点出无所谓;现在它是主路径,这就成了主要缺陷。

## 三、待确认:实时化怎么做

### 与被否掉的方案 B 的区别

前置文档评估过 watcher 并否掉:

> **B. 常驻缓存 + fsWatcher 增量** …… Windows 原生递归监视在高负载下会丢事件
> (缓冲区溢出),丢了就意味着缓存里躺着过期的「旧内容」,而我们不知道 ——
> **静默给出错误的 diff**。

**这个理由成立,而且不该被推翻。** 但它针对的是「watcher 提供**真相**」的形态:
基线常驻在缓存里,丢一个事件 = 基线永久失真。

提议的形态不同 —— **watcher 只提供提示,快照仍是唯一真相**:

- 回合开始的全量基线快照:**保留不动**
- 回合期间订阅 `fsWatcher`,只用它回答「**可能**哪几个文件动了」
- 对这几个文件读当前内容、与基线内容对比,提前发出增量 observed 改动
- `turn_completed` 时**仍跑现有的全量重扫对比**,以它为准

丢事件的后果因此从「diff 是错的」降级为「这个文件的 diff 晚到回合结束才出现」
—— 也就是**退回今天的行为**,而不是给错的。这符合前置文档「宁可不给也不给错」
的纪律。

成本上,把「每条命令扫全树」换成「只读实际动过的那几个文件」,而基线快照的次数
不变(仍是每回合两次)。

### 现成的基础设施

`src/main/file-explorer/fsWatcher.ts` 已经在用 `@parcel/watcher` 对工作区根做原生
递归监视(Windows 走 ReadDirectoryChangesW),FILES 面板正在消费。选它的理由正是
agent 批量改文件这种 burst 场景。

### 开工前必须先验的前提

**监视器只在用户把文件夹加进 FILES 面板后才启动**(`watchStart(folder)` 在文件
浏览器 store 里调)。如果 `allowedRoots` 里存在没被加进 FILES 的目录,那部分改动
watcher 看不见 —— 那些 root 只能退回回合末快照。这个覆盖差有多大,决定了这套东西
值不值得做。

### 不变的两条纪律

1. **归因不确定性必须继续如实交代。** observed 行带「命令行」标记、表头是「本轮
   改动了 N 个文件」而非「agent 编辑了 N 个文件」。实时化之后这一点**更重要**:
   改动一边发生一边冒出来,看到的人会更倾向于认为「这是 agent 刚干的」,而同一
   时间窗里用户在别的编辑器里的改动同样会落进来。
2. **宁可不给也不给错。** 基线不可信仍然整轮作废。

## 附:本轮顺带修掉的既有缺陷

都在 [#255](https://github.com/2799662352/ai-image-master/pull/255),与上面的结论
无关但值得记一笔:

- `item/started` 一直带着完整 `changes[]`,而我们只取了 `path` 把它扔了
- 两处 O(n²):按增量重数拼接全文的行数、以及对累积全文做 `split('\n')` 只为看第一行
- `DiffBody` 在流式期间每帧重新解析全文并为每行分配对象(`useMemo` 命不中,因为
  diff 每帧都变)
- 快照通道给过 changes 之后没有抑制裸文本追加,同一份 diff 会被拼两遍、计数翻倍
