# Codex 聊天图片生成 —— vip 稳定渠道 / 聊天内展示 / 历史记录

- 状态: 设计待批
- 日期: 2026-06-05
- 范围: Codex 智能体聊天 (`AgentChatPanel`) 的图片生成链路 + `gpt-image-2-vip` 的 quality 能力修正

## 1. 背景与问题

`gpt-image-2-codex`(组织级官逆)近期触发 OpenAI **组织级限速**(input-images 4000/min 共享额度打满)。官方建议切到 `gpt-image-2-vip`(同 images API,size 等参数兼容)。

当前 Codex 聊天里有 `generate_image` 工具,但:

1. 工具结果只作为 JSON 文本回灌给 agent —— **聊天栏里看不到图**。
2. 生成的图 **不进历史记录页**,关软件即丢。
3. `generate_image` 的 schema 只有 `prompt/model?/ratio?/referenceImages?`,**缺 resolution / quality**,而 model 又可被随意指定,不保证走稳定的 vip 渠道。

## 2. 决策(已与用户确认)

| # | 决策 | 说明 |
|---|------|------|
| 1 | **渠道固定 vip** | Codex 的 `generate_image` 一律用 `gpt-image-2-vip`,忽略传入 model |
| 2 | **保留 images 端点 + b64_json** | 不切 chat-completions;其 R2 CDN URL 国内可能打不开。实测 vip 默认就返回 b64_json |
| 3 | **新独立助手气泡** | 生成图作为**新的一条 assistant 消息**(`ArtifactItem`),不塞进已有文字气泡 |
| 4 | **缩略图 + 点击全屏** | 复用现有 `ArtifactCard` → `MediaThumbnail` + `Lightbox` |
| 5 | **历史类型 `'codex'`** | `addToHistory('codex', ...)`,base64→R2 由现有逻辑处理 |
| 6 | **schema 加 resolution + quality** | 1K/2K/4K + auto/low/medium/high |
| 7 | **quality 全 app 修正** | 实测 vip 支持 quality,修 `buildGptImage2JsonPayload` 让 vip 真发 quality(Generate/Batch 同享) |

### 2.1 实测依据(quality)

对 `https://b.apiyi.com/v1/images/generations` model=`gpt-image-2-vip` size=`1280x1280`:

| 请求 | 结果 |
|------|------|
| 无 quality | `200`,返回 `b64_json` |
| `quality:"high"` | `200`,返回 `b64_json` |
| `quality:"zzz_invalid"` | `400` "不合法的quality" |

结论: vip **校验并真实支持** quality。代码注释/测试里"vip 不支持 quality"的旧判断 **是错的**,需翻转。

## 3. 改动清单

### A. MCP 工具 schema —— `src/main/mcp/tools/imageTools.ts`
给 `generate_image.inputSchema` 增加:
- `resolution: z.enum(['1K','2K','4K']).optional()`(默认由渲染层补 `1K`)
- `quality: z.enum(['auto','low','medium','high']).optional()`
- 每个字段补 `.describe(...)`,让 codex 能合理选档。
- `model` 字段保留但在执行层被强制覆盖为 vip(描述里注明)。

### B. ApiService quality 全 app 生效 —— `src/renderer/src/services/api/ApiService.ts`
1. `resolvedQuality`: `isOfficial` → `(isOfficial || isVip)`。
2. `buildGptImage2JsonPayload`: `if (isOfficial && quality)` → `if ((isOfficial || isVip) && quality)`。
3. `makeGptImage2FormDataRequest`: 同上 `(isOfficial || isVip) && quality`。
4. `'gpt-image-2-vip'` modelConfig: 增加 `qualities`(auto/low/medium/high)、`defaultQuality: 'auto'`、`features.qualityControl: true`。
5. 修正相关注释("仅官转支持"→"官转与 vip 均支持")。

> 影响面: Generate / Batch 页的 vip 路径自动获得 quality 下拉(对齐三轴 ratio×resolution×quality 目标)。这是用户确认的 app-wide 范围。

### C. Codex 执行层 —— `src/renderer/src/features/agent-chat/AgentToolExecutor.ts`
`generateImage(params)` 重写:
1. 强制 `model: 'gpt-image-2-vip'`,透传 `prompt/ratio/resolution/quality/referenceImages`,补 `resolution` 默认 `1K`。
2. 调 `api.generateImage`;失败则把 error 抛回(现有 try/catch 已处理)。
3. 成功后,对返回的图片 URL/b64:
   - `historyData.addToHistory('codex', prompt, urls, ratio, 'gpt-image-2-vip', { referenceImages })`。
   - `useAgentChatStore.getState().appendArtifactMessage(artifacts)` 插入新助手气泡。
4. **回灌给 agent 的结果**只含紧凑摘要(`{ ok:true, count:n }` + 简短文字),**绝不回传 b64**(防 token 爆炸)。

### D. 聊天 store 新增 action —— `src/renderer/src/features/agent-chat/store.ts`
新增 `appendArtifactMessage(artifacts: AttachmentRef[])`:
- 构造一条全新 `Message { role:'assistant', items:[ArtifactItem] }` 直接 push 到 `messages`(不复用 `upsertItemInLastMessage`,因为要独立气泡)。
- b64/url → `AttachmentRef { kind:'image', name, mime:'image/png', size, uri }`。

### E. 渲染验证 —— `cards/ArtifactCard.tsx`
`ArtifactCard` 已渲染 `ArtifactItem` → `MediaThumbnail` + 全局 `Lightbox`。需确认 `MediaThumbnail`/`useDisplaySrc` 能吃 `data:` URI(预期可以,Generate/Batch 已用 dataURL)。如不行,补 dataURL→blob 转换。

## 4. TDD 测试计划

1. **ApiService.gptImage2Vip.test.ts**(翻转旧断言): vip 的 JSON payload 与 FormData **包含** quality;`quality:'auto'`/非法值仍被 `resolveGptImage2Quality` 过滤为不发。
2. **imageTools schema**: 接受 `resolution`/`quality`;非法枚举被 zod 拒绝。
3. **AgentToolExecutor.generateImage**:
   - 无论传入什么 model,实际调用 `api.generateImage` 时 model === `'gpt-image-2-vip'`。
   - 成功后调用 `addToHistory` 且 type === `'codex'`。
   - 调用 `appendArtifactMessage` 且 artifacts 数 === 图片数。
   - 回灌结果不含 b64 字段。
4. **store.appendArtifactMessage**: push 一条新 assistant 消息,含 1 个 `ArtifactItem`,原有消息不被改。

## 5. 风险与边界

- **token 爆炸**: b64 必须只进 history/chat-store,不回灌 agent。
- **大图渲染**: 走现有 `useDisplaySrc`(dataURL→blob URL),避免 DOM 里塞 MB 级 base64。
- **R2 异步上传**: 复用 `HistoryDataService` 既有占位+后台上传逻辑,断网/未配 R2 时回退存 base64。
- **model 覆盖的副作用**: ratio/resolution/quality 仍透传,仅 model 被钉死 vip。
- **app-wide quality**: Generate/Batch 的 vip 现在会发 quality;已确认是期望行为,非回归。

## 6. 不做(out of scope)

- 不切 chat-completions / R2 CDN URL 传输。
- 不改官逆 `gpt-image-2-all`(仍不支持 size/quality)。
- 不在本次动 Codex CLI 本体或 MCP 传输协议。
