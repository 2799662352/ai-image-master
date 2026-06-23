# qwen3.7-max-dashscope 理解能力接入 设计文档

**Date**: 2026-06-23
**Status**: Brainstorming complete, awaiting user sign-off
**配套手册**: `c:\Users\27996\Downloads\25-原生qwen3.7max接入详解-功能与步骤.md`
**关联既有集成**: `docs/superpowers/specs/2026-05-22-apiyi-mcp-integration-design.md`(apiyi/Gemini 理解链路)

## 目的

把原生 `qwen3.7-max-dashscope`(经用户自有 new-api / Miau API 网关)接入 CATIMATION,让它具备两种用法:

1. **作为 MCP 工具**:Codex 在任意线程都能调 `understand_video` / `understand_document` / `web_research` 来理解视频、文档、联网扒资料。
2. **作为 Codex 子代理**:Codex 能 spawn 一个**跑在 qwen3.7-max-dashscope 上的子代理**,专门做视频/文档/联网理解,而不只是被动调工具。

**音频**:qwen3.7-max-dashscope 上游不支持音频输入(手册 §2/§6:`InvalidParameter: incorrect modal 'audio'`),所以**不做独立 audio 工具**;改为在 skill 里明确指导「音频先用 ffmpeg 转成 MP4,再走 `understand_video`」的兜底路径。

## 背景:已有 vs 复用 vs 新增

| 组件 | 已有(可复用) | 本设计新增 |
|---|---|---|
| 模型调用链 | 出图/出视频已走 `ApiService` → new-api 网关 `http://175.178.198.17:3000`,`Authorization: Bearer <Miau 令牌>`(`ApiService.ts` `antigravity`/`wan2.7` 等) | `understand_*` 复用同一条链路 + 同一令牌 |
| catimation 内置 MCP | `src/main/mcp/tools/`(image/video/portrait/history/ui/ask/canvas),`router.call(tool, params, threadId)` → 渲染层 `AgentToolExecutor` 执行(`videoTools.ts` 即此模式) | `understandTools.ts` 三个新工具,同样 `router.call` 到渲染层 |
| qwen 多模态协议 | new-api 网关已做 OpenAI→DashScope 转换(手册 §1.1/§2);客户端只发 OpenAI 兼容 content parts | 渲染层 handler 构造 `qwen3.7-max-dashscope` 多模态请求 |
| Codex model_providers | `codexLaunch.ts` 已能 `-c model_providers.<id>.{name,base_url,env_key,wire_api}`;`codexProviders.ts` 有 preset 体系(apiyi/rightcode) | 在 `model_providers` map **追加** `qwen` 条目(不改当前 active provider) |
| 第一方 skill | `firstPartySkills.ts`(catimation-image/video/...),装到 `~/.agents/skills/` | 新增 `catimation-understand` skill |
| 子代理能力 | `catimation-subagents` skill;Codex 支持每个子代理线程自带 `modelProvider`(已用 context7 `/openai/codex` 核实:`model_providers` 是 map,subagent=带 parentThreadId 的 thread,可独立 `modelProvider`) | skill 指导「理解类任务 spawn 到 qwen provider」 |

## 架构(零新依赖)

```
                         Path A(MCP 工具,所有线程可用)
Codex ──(catimation MCP, stdio)──▶ main: understandTools.ts
   └─ router.call('understand_*', …) ──▶ renderer: AgentToolExecutor
         └─ ApiService(复用 Miau 令牌)──▶ new-api /v1/chat/completions
               model = qwen3.7-max-dashscope(含媒体走 multimodal,联网 enable_search)

                         Path B(Codex 子代理)
Codex(主 brain = apiyi/rightcode, gpt-5.x)
   └─ spawn subagent(modelProvider="qwen", model="qwen3.7-max-dashscope")
         └─ codex → new-api /v1/responses(wire_api="responses")
   skill「catimation-understand」指导何时调工具 / 何时 spawn qwen 子代理 / 音频→MP4
```

不 vendor 任何东西、不加新设置弹窗字段、不引入新令牌。

---

## 设计

### Path A — MCP 理解工具

在 catimation 内置 MCP 注册 3 个工具(`src/main/mcp/tools/understandTools.ts`,薄层:校验入参 → `router.call`),渲染层 `AgentToolExecutor` 新增对应 handler 调 `ApiService`。

| 工具 | 入参 | 行为 | qwen 依据 |
|---|---|---|---|
| `understand_video` | `video_url` 或 `video_path`(二选一)、`question`、`fps?` | 构造 `[{text:question},{video_url:{url}}]`(或帧列表 `{video:[...],fps}`),POST `/v1/chat/completions` model=`qwen3.7-max-dashscope` | 手册 §2 视频理解 ✅ |
| `understand_document` | `file_url` 或 `file_path`、`question` | 文档走 `fileid://` 退化文本路径(手册 §2 ⚠️部分);本机文件先按现有附件管线拿到可达 URL | 手册 §2 文档理解 ⚠️ |
| `web_research` | `query` | 纯文本请求 + 顶层 `enable_search:true`,返回联网检索后的回答 | 手册 §2 联网搜索 ✅ |

**本机路径(`*_path`)→ 可达 URL**:qwen 上游只认公网 URL。本机文件复用现有附件/COS 上传管线(`cosImageUpload.ts` / 渲染层既有逻辑)拿到可达 URL 后再发;拿不到则返回结构化错误提示用户改传 URL。

**qwen 请求形态**(渲染层 handler):
- 含媒体:`messages:[{role:'user', content:[{type:'text',...},{type:'video_url',video_url:{url}}]}]`,**不**带 `result_format`(多模态端点不接受,手册 §2 注)。
- 联网:顶层 `enable_search:true`(手册 §3.4)。
- 鉴权:`Authorization: Bearer <Miau 令牌>`(复用 `ApiService` 现有 key 解析,与出图同一令牌)。

**错误处理(健壮解析)**:qwen 调用同样可能 502/返回 HTML。handler 先 `response.text()` → `try JSON.parse`;解析失败或 `!response.ok` → 返回**结构化错误**给 MCP 工具(`{ success:false, error }`),让 Codex 看到干净中文提示(如「服务器繁忙/上游无响应,请重试」)而不是抛异常。这与近期 `parseResponse` 的"先 json 后判 ok"坑同源,新代码直接避开。

**音频(按用户决定)**:不做独立 audio 工具。`catimation-understand` skill 写明:音频文件先用 `ffmpeg-win` skill 转 MP4(音轨 + 占位画面/波形),再 `understand_video` 试。

### Path B — Codex 子代理(qwen 作为可 spawn 的子代理模型)

**B1 — 注册 qwen model_provider(追加,不改 active)**
在 `codexLaunch.ts` 的 `-c` 注入里**追加** map 条目(不动 `-c model_provider="<active>"`):
```
-c model_providers.qwen.name="Qwen3.7-Max (Miau)"
-c model_providers.qwen.base_url="http://175.178.198.17:3000/v1"
-c model_providers.qwen.env_key="MIAU_API_KEY"
-c model_providers.qwen.wire_api="responses"
```
- `wire_api="responses"`:手册 §3.6 确认 qwen3.7-max-dashscope 支持 `/v1/responses`;与现有自定义网关一致。
- `env_key="MIAU_API_KEY"`:codex 子进程从该环境变量读令牌。**主进程需在 codex spawn 时把 Miau 令牌注入该 env**。

**B2 — Miau 令牌桥接到主进程(关键 seam)**
现状 Miau 令牌在渲染层 localStorage(出图 key)。Path A 不需要主进程令牌(走 `router.call` 到渲染层);但 Path B 的 `env_key` 需要主进程在 spawn codex 时能拿到令牌。
- 方案:用户保存出图/Miau key 时,同步持久化一份到主进程可读存储(复用 `CodexProviderStore` 同款明文 JSON 模式),codex spawn 时读出注入 `MIAU_API_KEY`。
- 若令牌缺失:不注入 `model_providers.qwen`(或注入但 enabled 语义置空),避免 codex 报鉴权错;skill 里提示「未配置 Miau 令牌时 qwen 子代理不可用,改用 Path A 工具」。

**B3 — 新增第一方 skill `catimation-understand`**(仿 `catimation-video`,装到 `~/.agents/skills/`):
- 何时用:用户要"理解/分析这个视频"、"读这份文档"、"上网查/扒资料"。
- 怎么用:优先调 Path A 三工具;重活或需要独立推理预算时,spawn 一个 `modelProvider="qwen"` + `model="qwen3.7-max-dashscope"` 的子代理。
- 音频→MP4 兜底写法(ffmpeg)。
- 边界:音频不原生支持;文档仅部分支持(`fileid://` 退化);联网用 `web_research`/`enable_search`。
- 与 `catimation-subagents` 的关系:理解类委派属于"显式 spawn"场景,遵循其"仅在用户明确要求并行/委派时 spawn"的纪律。

## 决策快照(brainstorm 冻结)

| 决策点 | 选择 |
|---|---|
| 调用链 | 复用 catimation 内置 MCP + `router.call` → 渲染层 `ApiService` → new-api,**不 vendor** |
| 令牌 | 复用已存 **Miau API(new-api)令牌**,与出图同一个;不加新设置字段 |
| 工具集 | `understand_video` / `understand_document` / `web_research` 三个 |
| 音频 | 不做独立 audio 工具;skill 文档化 **音频→MP4→understand_video** 兜底 |
| 子代理 | A+B 都做:Path A 工具 + Path B(qwen model_provider + `catimation-understand` skill) |
| qwen provider | 追加进 `model_providers` map,**不改 active provider**(主 brain 仍 apiyi/rightcode);子代理按线程选 `modelProvider="qwen"` |
| wire_api | `responses`(手册 §3.6 + 现有自定义网关惯例) |
| 错误处理 | 先 text 后 try-parse;502/非 JSON → 结构化中文错误,不抛异常 |
| 本机文件 | `*_path` 经现有上传管线转可达 URL;失败回提示改传 URL |

## Out of scope(明确推迟)

- qwen 原生音频理解(上游能力所限)。
- 新设置弹窗"qwen 令牌"字段(复用 Miau 令牌)。
- 把 qwen 设为**主 brain** active provider(只作为子代理/工具,主 brain 不动)。
- 视频/文档结果在 chat message 的结构化预解析(Codex 自行处理 tool response)。
- 多账号 / 多令牌切换。
- 帧抽取本地预处理(直接交 qwen URL/帧列表;复杂抽帧后续再说)。

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| qwen 上游 502 / 返回 HTML | handler 先 text 后 try-parse;结构化错误 + 可重试提示 |
| 裸别名 `qwen3.7-max-dashscope` 喂媒体被升级映射影响 | 升级映射在 new-api 网关服务端(手册 §1.2),客户端只发标准 content;无需 app 侧处理 |
| 本机文件 qwen 不可达 | `*_path` 走上传管线转公网 URL;失败回提示 |
| Path B 令牌不在主进程 | B2 桥接;缺令牌则不注入 qwen provider + skill 提示降级到 Path A |
| 子代理跨 provider 不被支持 | 已用 context7 `/openai/codex` 核实:`model_providers` 为 map + subagent thread 自带 `modelProvider`,支持 |
| 文档理解仅部分 | skill 明确边界,必要时建议转文本/截图走 image/video 路径 |
| 与 apiyi/Gemini 理解链路职责重叠 | skill 注明:音频/PDF 强需求走 apiyi(Gemini);视频/联网/本网关额度走 qwen |

## 测试

**Path A**
- `understandTools.test.ts`:三工具注册成功(对照 `canvasTools.test.ts` 的注册断言);入参 schema 校验(缺 `video_url`/`video_path` 报错)。
- 渲染层 handler 单测:含媒体构造 multimodal content 形状正确、`enable_search` 仅 `web_research` 置位、`result_format` 不出现在多模态请求。
- 健壮解析单测:502+空 body / HTML body → 返回 `{success:false}` 而非抛异常。

**Path B**
- `codexLaunch` 单测扩展:追加 `model_providers.qwen.*` 的 `-c` 参数(name/base_url/env_key/wire_api),且不覆盖 active `model_provider`。
- 令牌桥接单测:有 Miau 令牌 → `MIAU_API_KEY` 注入 codex env;无令牌 → 不注入 qwen provider。
- `firstPartySkills.test.ts` 扩展:`catimation-understand` skill 存在、含音频→MP4 段、含三工具用法。

## PR 拆分(每个独立可 deploy)

1. **PR-1(Path A 后端,~150 行)**:`understandTools.ts` + `index.ts` 注册 + 渲染层 `AgentToolExecutor` handler + `ApiService` qwen 调用 + 健壮解析。无 UI 影响。
2. **PR-2(skill,~80 行)**:`catimation-understand` 第一方 skill(三工具用法 + 音频→MP4 + 联网边界)。
3. **PR-3(Path B 子代理,~120 行)**:`model_providers.qwen` 追加 + Miau 令牌主进程桥接 + skill 补 spawn-qwen 指导。

## 用户验收点(热更新发布后)

1. Codex 聊天里发"理解这个视频 https://….mp4 在干什么" → 调 `understand_video` → 返回中文画面/动作/字幕描述。
2. "上网查一下今天的 AI 新闻" → `web_research`(enable_search)→ 返回联网结果。
3. 给一个音频 → agent 按 skill 用 ffmpeg 转 MP4 → `understand_video` 试。
4. "开个子代理分头读这三份文档并汇总" → Codex spawn qwen 子代理(modelProvider=qwen)分头理解后汇总。
5. qwen 上游 502 → agent 收到"服务器繁忙,请重试"而非 "not valid JSON"。
