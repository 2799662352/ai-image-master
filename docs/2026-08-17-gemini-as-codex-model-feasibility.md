# 能不能让 Gemini 当 Codex 的驱动模型（2026-08-17 调研）

结论先写：**不能直接接，任何路线都必须在本地多跑一个常驻代理进程。** 权衡完之后这一轮决定不做，Gemini 保持现状——只作为被 agent 调用的理解工具。

这份文档记录的是为什么，以及如果将来条件变了要从哪里重新开始，免得下次再从零查一遍。

## 硬约束：Codex 只认 Responses 协议

上游 `codex-rs/model-provider-info/src/lib.rs` 里 `WireApi` 枚举现在只剩一个值：

```rust
pub enum WireApi {
    #[default]
    Responses,
}
// "chat" => Err("`wire_api = \"chat\"` is no longer supported.")
```

`chat` 不是"不推荐"，是反序列化直接报错、`codex app-server` 退出码 1。我们自己踩过这个坑，见 `src/main/agent/codexLaunch.ts` 里 `CodexProviderConfig.wireApi` 上方的注释。上游公告是 openai/codex discussion #7782，2026 年 2 月完成移除。

所以任何 provider 想被 Codex 使用，必须真的提供 `POST /v1/responses`。这一条是整个问题的根。

## 三家网关都不提供 Gemini 的 Responses 端点

### Right Code `/gemini`

模型列表页标注"Gemini cli 逆向，不太稳定"，计费倍率 0.6x。官方配置文档
（`docs.right.codes/docs/rc_cli_config/gemini.html`）给的接法是往 `~/.gemini/.env` 写
`GOOGLE_GEMINI_BASE_URL=https://rightapi.ai/gemini` —— 这是 Gemini 原生协议
（`generateContent`），给 gemini-cli 用的。

对照同一页的 DeepSeek 分了「OpenAI格式」`/deepseek` 和「Anthropic格式」
`/deepseek/anthropic` 两个端点，Gemini 只有一个且不带格式标注，说明只有原生一种。

在售模型（截至查询日）：`gemini-3-flash-preview` / `gemini-3.1-pro` /
`gemini-3.1-pro-preview` / `gemini-3.5-flash` / `gemini-3.6-flash`。他们文档示例里写的
`gemini-3-pro-preview` 在列表里不存在，文档和实际售卖已经不同步。

### API易 `/v1/responses`

只支持 gpt-5 系列。他们的 FAQ 明写「`model_not_supported` 报错 → 该模型不支持
responses 端点，换 gpt-5 系列」，文档开头也说要调 Claude / Gemini 得走兼容模式
（chat/completions）。所以在现有 apiyi provider 里填个 gemini 模型名是不行的。

### Google 官方 OpenAI 兼容层

`https://generativelanguage.googleapis.com/v1beta/openai/` 支持的端点只有
`chat/completions`、`embeddings`、`images/generations`、`videos`、`models`。整页示例里
`responses` 一次都没出现，文档结尾自己写着仍在 beta。

方向上也不乐观：该页顶部横幅推的是 Google 自家新的 Interactions API（已 GA），说"推荐用
这个 API 获取所有最新特性和模型"。Google 在投自己的新协议，没有要兼容 OpenAI Responses
的意思。指望他们哪天补上 `/v1/responses` 不现实。

## 唯一可行路线：本地 Responses 桥

架构是 Codex → `http://127.0.0.1:PORT/v1`（`wire_api="responses"`）→ 桥 → Gemini。
候选：

| 方案 | 形态 | 适配 Gemini | 打包可行性 |
|---|---|---|---|
| LiteLLM | Python 服务 | 原生支持 `gemini/` provider，最完整 | 差：要塞 Python 运行时进 Electron 安装包 |
| talkcozy/api2codex | 轻量 Responses↔Chat 翻译 | 不懂 Gemini，需要 OpenAI 格式上游 | 中 |
| yatesdr/go-llm-proxy | Go 单文件，能探测后端是否原生支持 responses | 同上，需要 OpenAI 格式上游 | 好 |

反方向的项目别选错：`icebear0828/codex-proxy` 是把 Codex 模型伪装成 Gemini/Anthropic
端点给别的客户端用，不是把 Gemini 喂给 Codex。

### 这条路上已知会咬人的 bug

LiteLLM 仓库里针对 Codex→Gemini 这个具体组合的 issue：

- **#29854** —— Codex 发的 `type=namespace` 工具（MCP 命名空间）转 Gemini 时只保留
  `name`，`description` 和 `parameters` 被静默丢掉，模型拿到空壳工具，所有调用返回
  unsupported call。**我们恰好免疫**：为了 openai/codex#26234，`codexLaunch.ts` 已经给
  每个 provider 打了 `namespace_tools=false`，MCP 工具被摊平成普通 `function`，走不到
  那个坏分支。
- **#22578** —— Gemini 3 并行工具调用报 "Missing corresponding tool call for tool
  response message"，1.82 之后修了。
- **#32545** —— `__thought__` 后缀导致 call_id 匹配失败，在修。

要走这条路 LiteLLM 至少 1.86.3。

## 价格：Right Code 就是官方的 0.6 倍

| 模型 | Google 官方（输入/输出 per 1M USD） | Right Code |
|---|---|---|
| gemini-3-flash-preview | 0.50 / 3.00 | 0.30 / 1.80 |
| gemini-3.5-flash | 1.50 / 9.00 | 0.90 / 5.40 |
| gemini-3.1-pro-preview | 2.00 / 12.00 | 1.20 / 7.20 |

三条全是精确的 0.6 倍，和他们页面标的"计费倍率 0.6x"一致。**直连 Google 比走 Right Code
贵 67%。**

未核实的一点：官方 pro 分段计价，prompt > 200k tokens 时输入涨到 4.00、输出 18.00，直接
翻倍。Right Code 页面只有单一价格、没标分段。agent 编码很容易冲过 200k 上下文，这里怎么
算是个未知，要问客服或实测。

## 直连 Google 的取舍

好处不在价格：

1. Flash 系有免费额度（3-flash-preview / 3.5-flash / 3.6-flash / 3.7-flash 的 Free Tier
   都是 Free of charge）。Pro 系全部 Not available，免费档拿不到 pro。
2. 付费档官方承诺不拿数据训练（免费档会用于改进产品，条款里写明）。Right Code 是逆向渠道，
   代码流经他们服务器，去向不透明。
3. 不是逆向，不会因上游封堵突然断服。

坑里有一条要命的：**Tier 1 有基于消费额的限流，每 10 分钟 $10**，滚动窗口，超了返回
`429 RESOURCE_EXHAUSTED`。agent 跑长任务烧 token 很快，一次大重构就可能触发。要摆脱得升
Tier 2（每 10 分钟 $200），门槛是累计付款 $100 + 首次成功付款后满 3 天。Tier 1 账单上限
$250。

另外各档具体的 RPM/TPM，Google 已经把表格从文档撤了，改成"去 AI Studio 看你项目自己的
限额"，所以没法预先规划容量。

## 现状：Gemini 已经在应用里，只是角色不同

`src/main/agent/apiyiMcpLauncher.ts` 的 `APIYI_MCP_ENV_SCAFFOLD` 里
`GEMINI_MODEL = 'gemini-3.5-flash'`。apiyi-mcp 这个 MCP server 就是拿 Gemini 做视频 /
文档 / 音频理解，走 apiyi 的 chat/completions，跟 Codex 的 wire protocol 无关所以不受
上面那条硬约束限制。

也就是说 Gemini 现在是**被 agent 调用的工具**，不是**驱动 agent 的模型**。要变成后者，
成本是给安装包加一个常驻代理进程，外加一整套生命周期管理：启动、端口冲突处理、崩溃重启、
退出清理、健康检查。

## 什么条件下值得重新评估

- Google 的 OpenAI 兼容层补上 `/v1/responses`（届时直连不再需要桥，只需加一个 provider
  预设，成本从"新增常驻进程"降到"改一个常量文件"）。
- 出现一个 Node 实现的、专门做 Responses↔Gemini 的桥（我们已经在 bundle Node 生态，
  apiyi-mcp / cinematography-kb-mcp 都是 Node，边际成本会低很多）。
- 有明确的业务理由必须让 Gemini 当主模型（比如某类任务上 gemini-3.1-pro 明显强过
  gpt-5.x，且差距大到值得付这个工程成本）。

相关文档：`docs/keys-and-endpoints.md`（各网关 key 与端点现状）。
