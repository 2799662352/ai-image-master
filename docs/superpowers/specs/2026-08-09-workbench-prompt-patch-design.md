# 工作台提示词局部编辑设计

## 背景

用户观察:Cursor / Codex / Claude Code 这些编码 agent 写代码时都不是一次吐一大段,
而是小规模读、定点改。我们的工作台 `apply` / `export` 违背了这一点。

这个观察在**延迟机制**上是成立的,但过程中推翻了两个流行说法,结论也因此和最初的
直觉不完全一样。下面先把证据摆清楚,再落到我们要做什么。

## 证据

### 成立的部分:输出 token 几乎线性决定延迟

LLM 推理分两段。prefill 把输入 token **并行**处理,decode **一次只生成一个 token**。
NVIDIA 推理优化指南([来源](https://developer.nvidia.com/blog/mastering-llm-techniques-inference-optimization/)):

> the prefill phase, which processes input tokens in a highly parallelized manner, and
> the decode phase, which generates output tokens autoregressively one at a time,
> underutilizing GPU compute ability… **the speed at which the data is transferred to
> the GPU from memory dominates the latency**

DistServe(OSDI '24, arXiv:2401.09670)把这条形式化成 TTFT / TPOT 两个独立指标。

**推论**:让模型重吐 17 段提示词,代价是实打实的几十秒纯解码;而读进同样多的内容
几乎不花时间。**读贵不了,写才贵。**

### 被推翻之一:Cursor 并不是"只发改动区域"

[Editing Files at 1000 Tokens per Second](https://cursor.com/blog/instant-apply)(2024-05-14):

> **By default, we have language models generate the fully rewritten file** … We show
> why we rewrite the file instead of using diffs

他们给的三条反对 diff 的理由与"少吐 token 更好"直接冲突:

- **Thinking in Fewer Tokens** — "With more output tokens, the model has more forward
  passes to determine the correct solution. Diffs force the model to think in fewer tokens."
- **Diffs are Out of Distribution** — 预训练里整文件远多于 diff。
- **Outputting Line Numbers** — 模型数不准行号。

他们攻的是常数因子:speculative edits 把整文件重写做到 ~1000 tok/s,相对原生 70B
**快 13 倍**。

### 被推翻之二:业界故意不并行"写"

Claude Code Agent SDK(`code.claude.com/docs/en/agent-sdk/agent-loop`):

> Read-only tools like `Read`, `Glob`, and `Grep` **can run concurrently**, while
> state-modifying tools like `Edit`, `Write`, and `Bash` **run sequentially**. Custom
> tools default to sequential execution but can be enabled for parallel execution by
> setting `readOnlyHint` in their annotations.

所以"并发多个小写入"不是最佳实践,是被刻意避开的做法。**本设计不追求并行写。**

### 决定性证据:Aider 的受控对比

Aider 是唯一做过"同模型、只换编辑格式"对比的:

- 准确率上整文件重写**没输**:"GPT-4 gets comparable results with the `whole` and
  `diff` edit formats"。对 GPT-3.5 反而更准(46% vs 30%)。
- 换格式的**唯一理由是代价**:"using `whole` significantly increases costs and latency
  compared to `diff`",以及 "waiting for even small files to be completely 'retyped'
  on each request is probably unacceptable"。
- **文件越大越容易偷懒**:专门造的大文件基准上,GPT-4 Turbo 用 search/replace 只得
  20%,换 unified diff 后 **61%,偷懒减少 3 倍**。小练习题上几乎不偷懒,"only lazy on
  2-3 of these exercises: the ones with the most code"。

最后一条正对应我们的现象:17 张卡整板 apply、中途 JSON 崩掉。

### 参考实现的形状

Claude Code Edit 工具(`code.claude.com/docs/en/tools-reference`):

> performs **exact string replacement**… It **does not support regex or fuzzy matching**.
> Edits are subject to three checks: **Read-before-edit, Match, and Uniqueness.**
> For an edit to apply, the `old_string` must exist **exactly once** in the file. If
> `old_string` appears multiple times, Claude will either request more context to
> identify a single occurrence or use `replace_all: true`.

Codex apply_patch 的 V4A 语法里**没有行号**,hunk 用 `@@ class BaseClass` 这类语义
锚点定位 —— 和 Aider "禁用行号"独立收敛。

OpenAI apply_patch 最佳实践第一条:"**Encourage small, focused diffs** — nudge the
model toward minimal, targeted edits rather than huge rewrites."(未给理由)

## 现状:缺口只剩一个

前几轮已经修掉的:`set_spec` 一次扫全板改规格、IR 支持只占位条目、`apply` 硬闸 5 张
内容卡、`export` 支持 `skeleton` / `cardIds`。**改 480p / 联网 / 智能时长现在不需要
携带任何提示词。**

注解也已经是对的:`status` / `export` 标 `READ_ONLY`(`readOnlyHint: true`),读侧本来
就有资格并发;写侧标 `WRITE_IDEMPOTENT` / `DESTRUCTIVE`,合规客户端会串行。

剩下的真缺口只有一个:**改提示词本身的一部分**。`prompt` 目前是 `z.string()`,把一段
两百字提示词里的 `dolly in` 改成 `rack focus`,模型必须一字不差地重吐两百字 —— 标准的
whole-file rewrite 问题,而且落在最容易触发偷懒的那一档。

## 目标

新增 `video_workbench_patch_prompt`:对单张卡的提示词做精确字符串替换。

## 非目标

- **不并行化写操作。** 与参考实现一致,保持串行。
- **不强制最小化编辑。** Aider 四原则里的 **HIGH LEVEL** 明确反对逐行手术式修改:
  "High level hunks often contain more lines than a surgical hunk, so they are **less
  likely to accidentally match unrelated parts**"。整段重写保留给真正的重写,由模型
  自己选。
- **不动 `apply` / `export` / `set_spec`。** 它们已经收窄过了。
- **不做模糊匹配。**(理由见下)

## 我们比代码编辑器简单在哪(据此裁掉三样)

调用方是 Codex 指挥 MCP,不是 agent 直接编辑文件。差别决定了裁剪:

| 代码编辑器 | 我们 |
|---|---|
| 文件路径 + 行号寻址 | `cardId` 寻址,没有行号问题 |
| 文件几千行,重读很贵 | 提示词百字级,**重读几乎免费** |
| 外部进程会改文件 | 只有 agent 和 UI 两个写者 |

因此**裁掉**:

- **Read-before-edit 检查。** 没有文件系统,而且下面每次调用都回全文,模型天然同步。
- **每处命中返回前后 40 字上下文。** 提示词本身就那么长 —— 直接回整段,更简单也更
  完整。
- **`replaceAll` 参数。** YAGNI。歧义时让模型把 `oldText` 写长一点即可;真要整段换,
  `update_task` 本来就在。

## 接口

```ts
{
  cardId: string,
  oldText: string,   // 必须在该卡提示词中精确出现且唯一
  newText: string,   // 可为空字符串 = 删除该片段
}
```

返回:改动后的提示词**全文**。这是刻意的 —— 让模型看到落地结果,避免它对当前状态
产生错误假设而连环改错。百字级不构成上下文压力。

## 两道校验

照 Claude Code 的 Match / Uniqueness(Read-before-edit 已按上表裁掉):

1. **Match** — `oldText` 必须精确出现。不做正则、不做模糊。
2. **Uniqueness** — 出现多于一次 → 拒绝,回**命中次数 + 提示词全文**,让模型把
   `oldText` 写长一点重来。
3. **Card exists / not running** — 生成中的卡拒绝改动,与 `set_spec` 现有行为一致。

失败一律**零写入**,且错误信息里带上提示词全文 —— 模型不需要再发一次 `export`
就能自己纠正,省一个往返。

### 为什么不做模糊匹配(两家权威在这里打架)

Aider 说宽容匹配是关键 —— 关掉灵活匹配让编辑错误**暴涨 9 倍**。Anthropic 反过来选了
严格 + 唯一性。

**选 Anthropic。** 差别在于消歧成本:Claude Code 随时能便宜地重读文件,Aider 的模型
不能。我们更像前者 —— `export` 就在手边,而且提示词只有百字级,重读几乎不花钱。模糊
匹配在提示词上尤其危险:改错一个词不会像代码那样编译失败,会安静地生成一条错的视频,
**而那是要花钱的**。

## 验收

按 Anthropic 工具设计文章的建议("collect… the total runtime of individual tool calls
and tasks, the total number of tool calls, the total token consumption, and tool errors"),
**先埋点量一版基线再改**,不靠理论宣称快了多少倍。

对照场景:一块 17 张卡的板,把其中 3 张的某个镜头术语替换掉。

| 指标 | 现在(整板 export + apply) | 目标(3 次 patch) |
|---|---|---|
| 输出 token | 全部 17 段提示词 | 3 × (oldText + newText) |
| 工具调用数 | 2 | 3 |
| 失败重来的代价 | 整份重来 | 单张重来 |

功能验收:

- 精确命中 → 改动落地,返回全文
- 多处命中 → 拒绝,零写入,回命中次数 + 全文
- 未命中 → 拒绝,零写入,回全文
- 卡不存在 → 拒绝
- 生成中的卡 → 拒绝
- `newText: ''` → 删除该片段
- 反证:去掉唯一性校验后,多处命中的用例必须变红

## 风险

**模型可能滥用它做整段替换**(把整段提示词塞进 `oldText`)。Aider 观察到 GPT-3.5 就
这么干过:"It places the entire original source file in the ORIGINAL block and the entire
updated file in the UPDATED block. **This is strictly worse than just using the `whole`
edit format**"。缓解:工具描述写明"整段重写请直接用 `update_task`",并在
`oldText` 长度接近全文时在回执里提示。不硬拦 —— 硬拦会挡住合法的大段改写。
