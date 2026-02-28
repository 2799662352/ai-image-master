# LangChain 结构化分镜输出 — 图像理解页面 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 复用导演模式的 LangChain 技术栈，为图像理解页面的 Sora分镜角色提供 Zod schema 结构化输出，确保台词嵌入、动机绑定、声画对位、特效/动作分离。

**Architecture:** 新建 `LangChainStoryboardService`，定义演出导向的 Zod schema（含 `lines`/`motive`/`act`/`fx` 字段），复用 `LangChainDirectorService` 的 LLM 初始化模式和 `buildImageContent` 图片处理逻辑。UnderstandPage 在检测到 `sora-storyboard` 角色时，走 LangChain 结构化输出路径替代纯文本流式 API。失败自动回退到流式路径。

**Tech Stack:** LangChain.js (@langchain/core, @langchain/openai, @langchain/google), Zod 4 (^4.3.6), TypeScript 5

**context7 文档参考：**
- LangChain: `ChatGoogle.withStructuredOutput(zodSchema)` 直接支持 Zod ([source](https://docs.langchain.com/oss/javascript/integrations/chat/google))
- LangChain: multimodal 图片通过 `image_url` + base64 data URI 传入 `HumanMessage.content`
- Zod 4: `z.record()` 必须传两个参数 `z.record(keySchema, valueSchema)` ([source](https://zod.dev/v4/changelog))
- 现有 `LangChainDirectorService` 已验证可用的模式: Gemini/OpenAI 自动检测 + `withStructuredOutput`

---

### Task 1: 创建 LangChainStoryboardService

**Files:**
- Create: `src/renderer/src/services/LangChainStoryboardService.ts`

**Step 1: 创建完整的服务文件**

```typescript
import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogle } from '@langchain/google'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ==================== Zod Schemas (演出导向) ====================

export const StoryboardObjSchema = z.object({
  n: z.string().describe('角色/物体名'),
  f: z.string().describe('外观特征→心理动机映射(生理描述,禁用情绪标签)'),
  s: z.string().describe('空间位置: fg/mg/bg|位置(L1/3,R2/3)|Z遮挡序'),
  p: z.string().describe('物理类型: rigid/artic/fluid/cloth + 运动约束'),
  t: z.string().describe('跨镜头一致性锚点(发色/伤疤/服装纹理/道具)'),
  tc: z.string().describe('镜头衔接延续: S?→S?: 姿态/运动向量/视线方向'),
  act: z.string().describe('演出动作(纯动作,不含特效)'),
  fx: z.nullable(z.string()).describe('特效: 风/烟/光/粒子,与act时间对齐. Null if none'),
  motive: z.string().describe('动机: 这个动作/道具外化了什么心理'),
  a: z.string().describe('多粒度: 粗(构图%)→中(动作链)→细(遮挡/高光delta)'),
  m: z.record(z.string(), z.string()).describe('运动强度: 部位→角度°/位移cm/H-M-L')
})

export const StoryboardTimelineEntrySchema = z.object({
  t: z.string().describe('时间范围 e.g. 0-3s'),
  dur: z.string().describe('持续时长 e.g. 3s'),
  tempo: z.string().describe('节奏: slow/accelerating/urgent/sudden-stop'),
  trans: z.string().describe('转场: cut/match-cut/whip-pan/smash-cut')
})

export const StoryboardSceneSchema = z.object({
  d: z.string().describe('叙事弧线: A(初始)→B(触发)→C(终态)'),
  cap: z.string().describe('结构化标题: 主体-动作-环境'),
  env: z.string().describe('环境: [mm]f/[stop]|光源+阴影%+对比|主色hex+点缀色hex|风格'),
  bgm: z.string().describe('4层声画对位: 层1(绑定S?)|层2(绑定S?)|层3(绑定S?)|层4'),
  timeline: z.record(z.string(), StoryboardTimelineEntrySchema)
})

// seq 的 value 格式: "景别|动作|'台词精华'|心理→外化|运镜"
export const StoryboardResponseSchema = z.object({
  scene: StoryboardSceneSchema,
  objs: z.array(StoryboardObjSchema),
  seq: z.record(z.string(), z.string().describe('S[n]: 景别|动作|台词精华|心理→外化|运镜')),
  cont: z.record(z.string(), z.string()).describe('跨镜头连续性锚点'),
  notes: z.string().describe('验证总结 + 节奏呼吸曲线: 总Xs(慢→渐快→急促→骤停)')
})

export type StoryboardResponse = z.infer<typeof StoryboardResponseSchema>
export type StoryboardObj = z.infer<typeof StoryboardObjSchema>

// ==================== Service Types ====================

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface StoryboardInput {
  images: ImageInput[]
  rolePrompt: string
  context?: string
}

// ==================== Service ====================

export class LangChainStoryboardService {
  private llm: ChatOpenAI | ChatGoogle
  private structuredLlm: any

  constructor(config: { apiKey: string; baseURL: string; model?: string }) {
    const modelName = config.model || 'gemini-3-pro-preview'
    const isGemini = modelName.toLowerCase().includes('gemini')
    const cleanBaseURL = config.baseURL.replace(/\/v1\/?$/, '')

    if (isGemini) {
      const hostname = cleanBaseURL.replace(/^https?:\/\//, '')
      this.llm = new ChatGoogle({
        model: modelName,
        apiKey: config.apiKey,
        endpoint: hostname,
        maxOutputTokens: 8192,
        maxRetries: 2
      })
    } else {
      this.llm = new ChatOpenAI({
        model: modelName,
        apiKey: config.apiKey,
        maxRetries: 2,
        maxTokens: 8192,
        configuration: { baseURL: `${cleanBaseURL}/v1` }
      })
    }

    this.structuredLlm = this.llm.withStructuredOutput(StoryboardResponseSchema)
  }

  private buildImageContent(images: ImageInput[], text: string) {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: string } }
    > = [{ type: 'text', text }]
    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' }
      })
    }
    return content
  }

  async analyze(input: StoryboardInput): Promise<StoryboardResponse> {
    const systemPrompt = `你是专业的电影分镜师和AI视频预生产专家。一切为了演出，不要为描述而描述。
每个字段必须服务于演出：道具→外化动机，声效→绑定动作，台词→嵌入镜头。
输出严格遵循JSON schema。`

    let userPrompt = input.rolePrompt
    if (input.context) {
      userPrompt += `\n\n--- 剧本/附加要求 ---\n${input.context}`
    }

    const systemMsg = new SystemMessage(systemPrompt)
    const humanMsg = new HumanMessage({
      content: this.buildImageContent(input.images, userPrompt)
    })

    return await this.structuredLlm.invoke([systemMsg, humanMsg]) as StoryboardResponse
  }

  toJSON(response: StoryboardResponse): string {
    return JSON.stringify(response, null, 2)
  }

  toCompactJSON(response: StoryboardResponse): string {
    return JSON.stringify(response)
  }
}
```

**Step 2: 验证文件语法**

Run: `cd D:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit --skipLibCheck src/renderer/src/services/LangChainStoryboardService.ts`
Expected: 无错误输出

**Step 3: Commit**

```bash
git add src/renderer/src/services/LangChainStoryboardService.ts
git commit -m "feat: add LangChainStoryboardService with performance-oriented Zod schema"
```

---

### Task 2: 在 ServiceBridge 中注册懒加载 getter

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts`

**Step 1: 添加 import 和懒加载函数**

在 `ServiceBridge.ts` 的 `getLangChainDirectorService` 函数之后（约 line 1019），添加：

```typescript
import { LangChainStoryboardService } from './LangChainStoryboardService'

let _langchainStoryboardInstance: LangChainStoryboardService | null = null
let _storyboardCacheKey: string | null = null

export function getLangChainStoryboardService(model?: string): LangChainStoryboardService | null {
  const api = (window as any).aiImageAPI
  const apiKey = api?.visionApiKey as string | undefined
  if (!apiKey) return null

  const site = api?.getCurrentSite?.()
  const baseURL = site?.baseURL as string | undefined
  if (!baseURL) return null

  const cacheKey = `${apiKey}|${baseURL}|${model || ''}`
  if (!_langchainStoryboardInstance || _storyboardCacheKey !== cacheKey) {
    _langchainStoryboardInstance = new LangChainStoryboardService({ apiKey, baseURL, model })
    _storyboardCacheKey = cacheKey
  }
  return _langchainStoryboardInstance
}
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|Error|built in"`
Expected: 三个 "built in" 无 error

**Step 3: Commit**

```bash
git add src/renderer/src/services/ServiceBridge.ts
git commit -m "feat: register LangChainStoryboardService lazy getter in ServiceBridge"
```

---

### Task 3: UnderstandPage 集成 LangChain 结构化路径

**Files:**
- Modify: `src/renderer/src/pages/UnderstandPage.ts`

**Step 1: 在 `analyzeImages()` 方法中添加 LangChain 分支**

在 `analyzeImages()` 的 `try {` 块内（约 line 952），在 `await api.analyzeImagesStream(...)` 之前插入 LangChain 路径：

```typescript
// LangChain 结构化输出路径 (sora-storyboard 角色)
if (this.currentRole === 'sora-storyboard') {
  const { getLangChainStoryboardService } = await import('../services/ServiceBridge')
  const storyboardService = getLangChainStoryboardService(modelToUse)
  if (storyboardService) {
    try {
      const images = this.uploadedImages.map(img => ({
        base64: img.base64, mimeType: img.mimeType || 'image/jpeg'
      }))
      const promptInput = this.getElement<HTMLTextAreaElement>('understandPrompt')
      const rolePrompt = promptInput?.value?.trim() || ''
      const contextEl = document.getElementById('understandContext') as HTMLTextAreaElement
      const context = contextEl?.value?.trim() || undefined

      const result = await storyboardService.analyze({ images, rolePrompt, context })
      const jsonOutput = storyboardService.toJSON(result)

      this.appendResultChunk(jsonOutput)
      this.onStreamComplete(jsonOutput, modelToUse)
      this.showToast('LangChain 结构化分析完成！', 'success')
      this.isAnalyzing = false
      return
    } catch (error: any) {
      console.warn('[UnderstandPage] LangChain structured output failed, falling back to stream:', error.message)
      // 回退到下方的流式路径
    }
  }
}
```

注意：这段代码在现有的 `await api.analyzeImagesStream(...)` 之前。如果 LangChain 成功，直接 `return`。如果失败，落入下方的流式路径作为回退。

**Step 2: Build 验证**

Run: `npm run build:vite`
Expected: 构建成功

**Step 3: Commit**

```bash
git add src/renderer/src/pages/UnderstandPage.ts
git commit -m "feat: integrate LangChain structured storyboard output in UnderstandPage"
```

---

### Task 4: 构建 + 运行时验证

**Step 1: 完整构建**

Run: `npm run build:vite`
Expected: 退出码 0，零 error，零 circular 警告

**Step 2: 运行时验证清单**

1. 打开应用 → 图像理解页
2. 选择 **Sora分镜** 角色
3. 上传参考图 + 在剧本区域输入测试剧本
4. 点击分析
5. 验证输出包含：
   - `seq.S[n]` 中有台词精华
   - `objs[].motive` 有动机说明
   - `objs[].act` 和 `objs[].fx` 分离
   - `scene.bgm` 有声画对位（绑定 S 编号）
6. 切换到 **万物识别** 角色 → 确认仍走流式路径（不受影响）
7. 断开 API → 选 Sora分镜 → 确认回退到流式路径

**Step 3: Commit + Build**

```bash
git add -A
git commit -m "chore: verify LangChain storyboard integration"
npm run build:win
```

---

## 关键设计决策

| 决策 | 选择 | 理由 | context7 依据 |
|------|------|------|--------------|
| 新建 Service vs 复用 DirectorService | 新建 | Schema 完全不同（演出导向 vs 生成导向） | — |
| LLM 初始化 | 复用相同模式 | Gemini/OpenAI 自动检测已验证 | LangChain docs: ChatGoogle.withStructuredOutput |
| Zod record 用法 | 双参数 `z.record(z.string(), value)` | Zod 4 破坏性变更 | zod.dev/v4/changelog |
| 图片传入方式 | `image_url` + base64 data URI | 兼容 OpenAI + Gemini | LangChain multimodal docs |
| 失败回退 | 回退到流式文本 | 不是所有 API 支持 structured output | 生产健壮性 |
| 字符限制 | 不需要 | Zod schema 控制格式，不靠字符限制 | — |
| import 方式 | 动态 `import()` | 避免在非 sora-storyboard 角色时加载 LangChain | 性能优化 |
