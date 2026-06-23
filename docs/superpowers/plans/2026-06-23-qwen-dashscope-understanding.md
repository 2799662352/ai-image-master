# qwen3.7-max-dashscope 理解能力接入 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: 用 superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。每个 Task 内步骤用 `- [ ]` 勾选;每个 Task 结束 commit;先写测试(RED)后实现(GREEN)。

**Goal:** 让 Codex 能理解视频/文档/联网扒资料 —— (A) 在 catimation 内置 MCP 加 `understand_video` / `understand_document` / `web_research` 三个工具;(B) 把 `qwen3.7-max-dashscope` 注册成可被 Codex 子代理选用的 model_provider + 新增 `catimation-understand` 第一方 skill。音频不原生支持,skill 文档化「音频→ffmpeg→MP4→understand_video」兜底。

**Architecture:** 复用现有出图链路。Codex →(catimation MCP, stdio)→ main `understandTools.ts` → `router.call('understand_*', …)` → 渲染层 `AgentToolExecutor` → `ApiService.understand()` → new-api 网关 `http://175.178.198.17:3000/v1/chat/completions`,model=`qwen3.7-max-dashscope`,`Authorization: Bearer <Miau 令牌>`。Path B 在 `model_providers` map 追加 `qwen` 条目(不改 active provider),子代理按线程选 `modelProvider="qwen"`。

**Tech Stack:** Electron, electron-vite, TypeScript, React, `@modelcontextprotocol/server`, zod, vitest.

**Spec:** `docs/superpowers/specs/2026-06-23-qwen-dashscope-understanding-design.md`

**手册依据:** `c:\Users\27996\Downloads\25-原生qwen3.7max接入详解-功能与步骤.md`

---

## 约定常量

- new-api 网关 host:`http://175.178.198.17:3000`(= `ApiService` 的 `antigravity` 站点 baseURL)。
- qwen 模型 id:`qwen3.7-max-dashscope`。
- Miau 令牌读取:渲染层 `localStorage.getItem('api_key_antigravity')`(`ApiService.getApiKey('antigravity')`);视觉 key 退化用 `vision_api_key_antigravity`。
- chat completions 端点:`${site.baseURL}/v1/chat/completions`(参考既有「图像理解流式」方法 `ApiService.ts` L1039)。

---

## File Structure

**Created:**
- `src/main/mcp/tools/understandTools.ts` — 三个理解工具的注册(薄层 → `router.call`)。
- `src/main/mcp/tools/__tests__/understandTools.test.ts` — 工具注册 + 入参校验测试。
- `src/renderer/src/services/api/__tests__/ApiService.understand.test.ts` — `understand()` 请求构造 + 健壮解析测试。
- `src/main/agent/firstPartySkills/catimation-understand.md`(或既有 skill 存放约定路径)— 第一方 skill 正文。

**Modified:**
- `src/renderer/src/services/api/ApiService.ts` — 新增 `understand()` 方法(qwen 多模态 + enable_search + 健壮解析)。
- `src/renderer/src/features/agent-chat/AgentToolExecutor.ts` — `call()` switch 加 3 个 case → 新 `callUnderstand()`。
- `src/main/mcp/tools/index.ts` — 调 `registerUnderstandTools`。
- `src/main/agent/codexLaunch.ts` — `appendProviderArgs` 旁新增 `appendExtraProviders`(追加 qwen map 条目,不改 active)。
- `src/main/agent/firstPartySkills.ts` — 注册 `catimation-understand` skill。
- Miau 令牌→主进程桥接:复用既有 provider/secret 持久化(见 Task 5)。

---

## Task 1: ApiService.understand()(渲染层模型调用 + 健壮解析)

**Files:**
- Create: `src/renderer/src/services/api/__tests__/ApiService.understand.test.ts`
- Modify: `src/renderer/src/services/api/ApiService.ts`

- [ ] **Step 1(RED): 写测试**

覆盖三种调用 + 健壮解析:
1. `understand({ kind:'video', mediaUrl, question })` → POST body.messages[0].content 含 `{type:'text',text:question}` + `{type:'video_url',video_url:{url:mediaUrl}}`,body.model=`qwen3.7-max-dashscope`,**不含** `result_format`,header `Authorization: Bearer <key>`。
2. `understand({ kind:'web', query })` → body 顶层 `enable_search:true`,content 为纯文本。
3. 健壮解析:`fetch` mock 返回 `{ ok:false, status:502, text:()=>'<html>502</html>' }` → 方法 resolve 成 `{ success:false, error }`(中文「服务器繁忙/上游无响应」),**不抛**;返回 200 但 body 非 JSON 同样 `{success:false}`;返回正常 JSON → `{ success:true, text }`(从 `choices[0].message.content` 提取)。

用 `vi.stubGlobal('fetch', …)` + `localStorage` mock(参考同目录 `ApiService.wan27.test.ts`)。

- [ ] **Step 2: 跑测试确认 RED**

`npx vitest run src/renderer/src/services/api/__tests__/ApiService.understand.test.ts`
预期 FAIL(`understand` 未定义)。

- [ ] **Step 3(GREEN): 实现 `understand()`**

在 `ApiService` 加方法(非流式,镜像 L1039「图像理解」但返回完整文本 + 健壮解析):

```ts
type UnderstandInput =
  | { kind: 'video'; mediaUrl: string; question: string; fps?: number }
  | { kind: 'document'; mediaUrl: string; question: string }
  | { kind: 'web'; query: string }

async understand(input: UnderstandInput): Promise<{ success: true; text: string } | { success: false; error: string }> {
  const site = this.apiSites['antigravity']
  const key = this.getApiKey('antigravity') || localStorage.getItem('vision_api_key_antigravity')
  if (!key) return { success: false, error: '未配置 Miau API 令牌,请到设置页填入 API Key 后重试。' }

  const content =
    input.kind === 'web'
      ? input.query
      : [
          { type: 'text', text: input.kind === 'video' ? input.question : input.question },
          input.kind === 'video'
            ? { type: 'video_url', video_url: { url: input.mediaUrl } }
            : { type: 'image_url', image_url: { url: input.mediaUrl } }, // 文档退化:截图/页面图走 image_url;纯文本 fileid 见 skill
        ]

  const body: Record<string, unknown> = {
    model: 'qwen3.7-max-dashscope',
    messages: [{ role: 'user', content }],
  }
  if (input.kind === 'web') body.enable_search = true

  try {
    const resp = await fetch(`${site.baseURL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
      body: JSON.stringify(body),
    })
    const raw = await resp.text()
    if (!resp.ok) {
      if ([502, 503, 504].includes(resp.status)) return { success: false, error: '上游服务器繁忙或无响应(502/503/504),请稍后重试。' }
      return { success: false, error: `qwen 理解请求失败:${resp.status} ${resp.statusText}` }
    }
    let json: any
    try { json = JSON.parse(raw) } catch { return { success: false, error: '上游返回了非 JSON 响应(可能是网关错误页),请重试。' } }
    const text = json?.choices?.[0]?.message?.content
    if (typeof text !== 'string' || !text) return { success: false, error: 'qwen 未返回可用文本。' }
    return { success: true, text }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : String(e) }
  }
}
```

> 注:`fps` 暂存而不发(qwen 帧列表模式后续再加);文档 `kind:'document'` 当前走 `image_url`(页面截图)路径,纯文本 `fileid://` 退化由 skill 指导 agent 预处理。实现细节以测试断言为准。

- [ ] **Step 4: 跑测试确认 GREEN + typecheck**

`npx vitest run src/renderer/src/services/api/__tests__/ApiService.understand.test.ts`
`npm run typecheck`(预期无新增错误;已知基线错误 `src/preload/index.ts` 与 `src/main/index.ts:443` 忽略)。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/src/services/api/ApiService.ts src/renderer/src/services/api/__tests__/ApiService.understand.test.ts
git commit -m "feat(understand): ApiService.understand() qwen multimodal + web_search with robust parse"
```

---

## Task 2: 渲染层 AgentToolExecutor 派发 understand_*

**Files:**
- Modify: `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`

- [ ] **Step 1: 在 `call()` switch 加 case**

在 `case 'canvas_search':` 区块旁加:

```ts
case 'understand_video':
case 'understand_document':
case 'web_research':
  return this.callUnderstand(toolName, params)
```

- [ ] **Step 2: 实现 `callUnderstand()`**

```ts
private async callUnderstand(toolName: string, params: Record<string, unknown>): Promise<unknown> {
  const api = ServiceRegistry.get(SERVICE_KEYS.apiService) // 用项目实际拿 ApiService 的方式
  if (toolName === 'web_research') {
    return api.understand({ kind: 'web', query: String(params.query ?? '') })
  }
  const question = String(params.question ?? '')
  const mediaUrl = await this.resolveMediaUrl(params) // *_url 直用;*_path 走上传管线转公网 URL,失败抛错
  return api.understand(
    toolName === 'understand_video'
      ? { kind: 'video', mediaUrl, question, fps: typeof params.fps === 'number' ? params.fps : undefined }
      : { kind: 'document', mediaUrl, question },
  )
}
```

`resolveMediaUrl`:`video_url`/`file_url` 直接用;`video_path`/`file_path` 复用现有附件/COS 上传得到公网 URL(参考 canvas `toLoadable`/`cosImageUpload` 既有逻辑);拿不到返回 `{success:false, error:'本机文件无法转为公网可达 URL,请改传 URL'}`(可在 main 工具层兜底成结构化错误)。

- [ ] **Step 3: typecheck**

`npm run typecheck`(无新增错误)。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/src/features/agent-chat/AgentToolExecutor.ts
git commit -m "feat(understand): dispatch understand_* renderer tools to ApiService"
```

---

## Task 3: main MCP understandTools + 注册

**Files:**
- Create: `src/main/mcp/tools/understandTools.ts`
- Create: `src/main/mcp/tools/__tests__/understandTools.test.ts`
- Modify: `src/main/mcp/tools/index.ts`

- [ ] **Step 1(RED): 写注册/校验测试**

仿 `__tests__/canvasTools.test.ts`:用 fake `McpServer`(记录 `registerTool` 调用)+ fake `ToolRouter`。断言:
- 注册了 `understand_video` / `understand_document` / `web_research` 三个工具;
- `understand_video` 缺 `video_url` 且缺 `video_path` → schema 校验失败;
- handler 调用 → `router.call('understand_video', params, threadId)` 被触发,`{success:false}` 返回被包成 `textResult`(含中文错误),`{success:true,text}` 被包成 `textResult(text)`。

- [ ] **Step 2: 确认 RED**

`npx vitest run src/main/mcp/tools/__tests__/understandTools.test.ts`(FAIL:模块不存在)。

- [ ] **Step 3(GREEN): 实现 `understandTools.ts`**

仿 `videoTools.ts`:`registerUnderstandTools(server, router)`,每个工具 `registerTool(name, {description, inputSchema: z.object({...})}, async (params, ctx) => { const threadId = extractCodexThreadId(ctx); const r = await router.call(name, params, threadId); return textResult(r.success ? r.text : `❌ ${r.error}\n` + JSON.stringify(r)) })`。

入参 schema:
- `understand_video`: `video_url?`, `video_path?`, `question`(min1), `fps?`(int)。描述里写明二选一 + 音频先转 MP4。
- `understand_document`: `file_url?`, `file_path?`, `question`。描述写明仅部分支持、必要时转截图。
- `web_research`: `query`(min1)。描述 = 联网扒资料(enable_search)。

description banner 沿用项目风格(短、显式「勿重试」、附 machine-readable 行)。

- [ ] **Step 4: 注册**

`src/main/mcp/tools/index.ts` 的 `registerTools` 末尾加 `registerUnderstandTools(server, router)` + import。

- [ ] **Step 5: GREEN + typecheck**

`npx vitest run src/main/mcp/tools/__tests__/understandTools.test.ts` && `npm run typecheck`。

- [ ] **Step 6: Commit**

```bash
git add src/main/mcp/tools/understandTools.ts src/main/mcp/tools/__tests__/understandTools.test.ts src/main/mcp/tools/index.ts
git commit -m "feat(understand): register understand_video/understand_document/web_research MCP tools"
```

---

## Task 4: catimation-understand 第一方 skill

**Files:**
- Create: skill 正文(按 `firstPartySkills.ts` 既有约定路径,如 `src/main/agent/firstPartySkills/catimation-understand.md` 或硬编码字符串)
- Modify: `src/main/agent/firstPartySkills.ts`(注册新 skill)

- [ ] **Step 1(RED): 扩展 firstPartySkills 测试**

在既有 `firstPartySkills` 测试加断言:`catimation-understand` skill 存在;正文含「understand_video / understand_document / web_research」三工具用法、「音频→ffmpeg→MP4」段、「联网用 web_research」、以及 Path B「spawn 一个 modelProvider=qwen 的子代理」段。

- [ ] **Step 2: 确认 RED**,跑对应测试文件。

- [ ] **Step 3(GREEN): 写 skill 正文 + 注册**

skill 内容要点(仿 `catimation-video` 结构):
- **When to Use**:用户要「理解/分析视频」「读这份文档/PDF」「上网查/扒资料」。
- **工具用法**:三工具入参 + 何时用 `*_url` vs `*_path`。
- **音频兜底**:音频不原生支持 → 用 `ffmpeg-win` skill 把音频转 MP4(音轨 + 占位画面),再 `understand_video`。
- **联网**:`web_research(query)` = enable_search 扒资料;给出引用。
- **Path B 子代理**:重活/并行/独立预算时,spawn `modelProvider="qwen"` + `model="qwen3.7-max-dashscope"` 的子代理(遵循 `catimation-subagents` 的「仅用户明确要求才 spawn」纪律);**未配置 Miau 令牌时 qwen 子代理不可用,降级用三工具**。
- **边界**:文档仅部分支持(fileid 退化文本/截图);真人脸限制沿用既有规则。

- [ ] **Step 4: GREEN + typecheck**,跑测试 + `npm run typecheck`。

- [ ] **Step 5: Commit**

```bash
git add src/main/agent/firstPartySkills.ts <skill 正文路径> <skill 测试文件>
git commit -m "feat(understand): add catimation-understand first-party skill (tools + audio→MP4 + qwen subagent)"
```

---

## Task 5: Path B — Miau 令牌桥接主进程 + 追加 qwen model_provider

**Files:**
- Modify: `src/main/agent/codexLaunch.ts`(新增 `appendExtraProviders`)
- Modify: codex 启动调用处(把 qwen provider 传进去,gated on token)
- Modify: 令牌桥接(渲染层保存 Miau key 时持久化到主进程可读存储;复用 `CodexProviderStore` 同款明文 JSON 模式)

- [ ] **Step 1(RED): codexLaunch 测试**

新增/扩展 `codexLaunch` 单测:
- 给定 `extraProviders=[{id:'qwen', name, baseUrl:'http://175.178.198.17:3000/v1', envKey:'MIAU_API_KEY', wireApi:'responses'}]` → args 含 `model_providers.qwen.{name,base_url,env_key,wire_api}`,且 **不** 含第二个 `model_provider="qwen"`(active 仍是原 provider)。
- `extraProviders=[]` 或令牌缺失 → 不出现任何 `model_providers.qwen.*`。

- [ ] **Step 2: 确认 RED。**

- [ ] **Step 3(GREEN): 实现 `appendExtraProviders`**

```ts
export function appendExtraProviders(args: string[], extras: readonly CodexProviderConfig[]): string[] {
  for (const p of extras) {
    args.push(
      '-c', `model_providers.${p.id}.name="${p.name}"`,
      '-c', `model_providers.${p.id}.base_url="${p.baseUrl}"`,
      '-c', `model_providers.${p.id}.env_key="${p.envKey}"`,
      '-c', `model_providers.${p.id}.wire_api="responses"`,
    )
  }
  return args
}
```

在 `buildCodexLaunchArgs` 里:active provider 仍走 `appendProviderArgs`;之后 `appendExtraProviders(args, options.extraProviders ?? [])`。`extraProviders` 仅当 Miau 令牌存在时由调用方注入 `{id:'qwen', …}`。

- [ ] **Step 4: 令牌注入 env**

codex spawn 时,若有 Miau 令牌,设进程 env `MIAU_API_KEY=<token>`(在现有 spawn env 组装处加);令牌来源 = 主进程可读存储(Step 5 桥接)。无令牌则不注入 qwen provider 且不设 env。

- [ ] **Step 5: 渲染层→主进程令牌桥接**

用户在设置页保存出图/Miau key 时,除写 `localStorage.api_key_antigravity` 外,经 IPC 持久化一份到主进程(复用 `CodexProviderStore` 或新增极简 secret 文件)。codex 启动读取它决定是否注入 qwen provider + `MIAU_API_KEY`。
> 实现以最小改动为准:若已有「自定义 provider」存储能放任意 key,直接复用;否则加一个 `understand:set-miau-token` IPC + 明文 JSON。

- [ ] **Step 6: GREEN + typecheck**,跑 codexLaunch 测试 + `npm run typecheck`。

- [ ] **Step 7: Commit**

```bash
git add src/main/agent/codexLaunch.ts <桥接相关文件> <测试>
git commit -m "feat(understand): register qwen model_provider for subagents + bridge Miau token to main"
```

---

## Task 6: 端到端验收(热更新发布前手测)

> 非自动化;`npm run dev:vite` 起 app,在 Codex 聊天里逐条验。

- [ ] 发「理解这个视频 <https://….mp4> 在干什么」→ 调 `understand_video` → 返回中文画面/动作/字幕描述。
- [ ] 发「上网查一下今天的 AI 新闻」→ `web_research`(enable_search)→ 返回联网结果 + 引用。
- [ ] 给一段音频 → agent 按 skill 用 ffmpeg 转 MP4 → `understand_video` 试。
- [ ] 「开个子代理分头读这三份文档并汇总」→ Codex spawn `modelProvider=qwen` 子代理 → 汇总(需 Miau 令牌已配)。
- [ ] 断网/上游 502 → agent 收到「服务器繁忙,请重试」而非 `not valid JSON`。
- [ ] 未配置 Miau 令牌 → 三工具返回友好提示,qwen 子代理不可用且 skill 已说明降级。

---

## 全量回归(发布前)

- [ ] `npm run typecheck`(无新增错误)。
- [ ] `npx vitest run src/main/mcp/tools src/renderer/src/services/api src/main/agent`(相关套件全绿)。
- [ ] `npm run build:vite`(构建通过)。

---

## 备注 / 已核实事实

- Codex `model_providers` 是 map(可追加多 provider,内置 id 不可覆盖);subagent = 带 `parentThreadId` 的 thread,**每线程自带 `modelProvider`** —— 已用 context7 `/openai/codex` 核实,Path B 可行。
- qwen3.7-max-dashscope 上游**不收 audio**(手册 §2/§6),故无独立 audio 工具。
- new-api 网关已做 OpenAI→DashScope 转换,客户端只发标准 OpenAI content parts;多模态请求**不要**带 `result_format`(手册 §2 注)。
- 已知基线 typecheck 错误(`src/preload/index.ts`、`src/main/index.ts:443`)与本功能无关,勿误判为本次引入。
