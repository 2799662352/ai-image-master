# 4-Pass 多级分镜管线 实施计划

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将分镜Pro 从单次 LLM 调用升级为 4-Pass 管线（场景分析→角色提取→分镜生成→一致性校验），每步独立 schema，逐步展示中间结果。

**Architecture:** 使用 LangGraphJS StateGraph 编排 4 个顺序节点，每个节点内部用 `withStructuredOutput` + 独立 Zod schema。图片通过闭包传入不进 state。Pass 4 校验分数低于阈值时条件回退到 Pass 3 重试。通过 `graph.stream("updates")` 逐节点推送中间结果给 UI。

**Tech Stack:** `@langchain/langgraph@1.2.0`, `@langchain/langgraph/zod`, `zod@4.x`, `@langchain/openai`, `@langchain/google`, TypeScript, Electron renderer

---

### Task 1: 安装 @langchain/langgraph 依赖

**Files:**
- Modify: `package.json`

**Step 1: 安装依赖**

Run: `npm install @langchain/langgraph`

**Step 2: 验证安装**

Run: `npm ls @langchain/langgraph`
Expected: `@langchain/langgraph@1.x.x`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "feat: add @langchain/langgraph dependency for multi-pass pipeline"
```

---

### Task 2: 定义 4 个独立 Pass Schema

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/schemas.ts`

**Step 1: 创建 schema 文件**

```typescript
import { z } from 'zod'

// ==================== Pass 1: 场景分析 ====================

export const SceneAnalysisSchema = z.object({
  d: z.string().describe('叙事弧线: A(初始状态)→B(触发事件)→C(终态)'),
  cap: z.string().describe('结构化标题: 主体-动作-环境'),
  env: z.string().describe('环境: [mm]f/[stop]|光源+阴影%+对比|主色hex+点缀色hex|风格'),
  bgm: z.string().describe('4层声画对位: pad|env|sfx|melody'),
  timeline: z.array(z.object({
    id: z.string().describe('镜头编号 e.g. S1'),
    t: z.string().describe('时间范围 e.g. 0-3s'),
    dur: z.string().describe('持续时长 e.g. 3s'),
    tempo: z.string().describe('节奏: slow/accelerating/urgent/sudden-stop'),
    trans: z.string().describe('转场: cut/match-cut/whip-pan/smash-cut')
  }))
})

export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>

// ==================== Pass 2: 角色提取 ====================

export const CharacterAnchorSchema = z.object({
  n: z.string().describe('角色/物体名'),
  f: z.string().describe('外观特征→心理动机映射(生理描述,禁用情绪标签)'),
  s: z.string().describe('空间位置: fg/mg/bg|位置(L1/3,R2/3)|Z遮挡序'),
  p: z.string().describe('物理类型: rigid/artic/fluid/cloth + 运动约束'),
  t: z.string().describe('跨镜头一致性锚点(发色/伤疤/服装纹理/道具)'),
  tc: z.string().describe('镜头衔接延续: S?→S?: 姿态/运动向量/视线方向'),
  m: z.string().describe('运动强度: head:pan-R25°|M, torso:lean10°|L, ...')
})

export const CharacterAnchorsSchema = z.object({
  characters: z.array(CharacterAnchorSchema)
})

export type CharacterAnchor = z.infer<typeof CharacterAnchorSchema>

// ==================== Pass 3: 分镜生成 ====================

export const ShotSchema = z.object({
  id: z.string().describe('镜头编号 e.g. S1'),
  desc: z.string().describe('5段式: 景别|动作|台词精华|心理→外化|运镜'),
  act: z.string().describe('演出动作(纯动作,不含特效)'),
  fx: z.nullable(z.string()).describe('特效: 风/烟/光/粒子. Null if none'),
  motive: z.string().describe('动机: 这个动作外化了什么心理')
})

export const ShotSequenceSchema = z.object({
  shots: z.array(ShotSchema)
})

export type ShotData = z.infer<typeof ShotSchema>

// ==================== Pass 4: 一致性校验 ====================

export const ConsistencyIssueSchema = z.object({
  shotId: z.string().describe('有问题的镜头编号'),
  field: z.string().describe('有问题的字段名'),
  problem: z.string().describe('具体问题描述'),
  suggestion: z.string().describe('修正建议')
})

export const ConsistencyReportSchema = z.object({
  cont: z.string().describe('跨镜头连续性锚点: S1-S2:锚点; S2-S3:锚点'),
  notes: z.string().describe('验证总结 + 节奏呼吸曲线'),
  score: z.number().min(1).max(10).describe('一致性评分 1-10'),
  issues: z.nullable(z.array(ConsistencyIssueSchema)).describe('发现的不一致问题. Null if none')
})

export type ConsistencyReport = z.infer<typeof ConsistencyReportSchema>
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`
Expected: built in Xs, no errors

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/schemas.ts
git commit -m "feat: define 4 independent Zod schemas for multi-pass storyboard pipeline"
```

---

### Task 3: 创建聚合函数

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/aggregate.ts`

**Step 1: 创建聚合函数**

```typescript
import type { StoryboardResponse } from '../LangChainStoryboardService'
import type { SceneAnalysis, CharacterAnchor, ShotData, ConsistencyReport } from './schemas'

export function aggregateToStoryboardResponse(
  scene: SceneAnalysis,
  characters: CharacterAnchor[],
  shots: ShotData[],
  report: ConsistencyReport
): StoryboardResponse {
  return {
    scene: {
      d: scene.d,
      cap: scene.cap,
      env: scene.env,
      bgm: scene.bgm,
      timeline: scene.timeline
    },
    objs: characters.map(c => ({
      n: c.n,
      f: c.f,
      s: c.s,
      p: c.p,
      t: c.t,
      tc: c.tc,
      act: '',
      fx: null,
      motive: '',
      a: '',
      m: c.m
    })),
    seq: shots.map(s => ({
      id: s.id,
      desc: s.desc
    })),
    cont: report.cont,
    notes: report.notes
  }
}
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/aggregate.ts
git commit -m "feat: add aggregate function to merge 4-pass results into StoryboardResponse"
```

---

### Task 4: 创建 StateGraph 管线 Service

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 创建管线 Service**

```typescript
import { StateGraph, Annotation, START, END } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogle } from '@langchain/google'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import {
  SceneAnalysisSchema, CharacterAnchorsSchema,
  ShotSequenceSchema, ConsistencyReportSchema,
  type SceneAnalysis, type CharacterAnchor, type ShotData, type ConsistencyReport
} from './schemas'
import { aggregateToStoryboardResponse } from './aggregate'
import type { StoryboardResponse } from '../LangChainStoryboardService'

// ==================== State Definition ====================

const PipelineState = Annotation.Root({
  // 中间结果
  scene: Annotation<SceneAnalysis | null>({ default: () => null }),
  characters: Annotation<CharacterAnchor[] | null>({ default: () => null }),
  shots: Annotation<ShotData[] | null>({ default: () => null }),
  report: Annotation<ConsistencyReport | null>({ default: () => null }),
  // 控制
  retryCount: Annotation<number>({ default: () => 0 }),
  retryFeedback: Annotation<string>({ default: () => '' }),
})

// ==================== Types ====================

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface PipelineConfig {
  apiKey: string
  baseURL: string
  model?: string
}

export interface PipelineInput {
  rolePrompt: string
  context?: string
}

export interface PipelineProgress {
  pass: 1 | 2 | 3 | 4
  label: string
  data: any
}

// ==================== Service ====================

export class StoryboardPipelineService {
  private llm: ChatOpenAI | ChatGoogle

  constructor(config: PipelineConfig) {
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

  async analyze(
    images: ImageInput[],
    input: PipelineInput,
    onProgress?: (progress: PipelineProgress) => void
  ): Promise<StoryboardResponse> {
    const llm = this.llm

    const sceneLlm = llm.withStructuredOutput(SceneAnalysisSchema)
    const characterLlm = llm.withStructuredOutput(CharacterAnchorsSchema)
    const shotLlm = llm.withStructuredOutput(ShotSequenceSchema)
    const reportLlm = llm.withStructuredOutput(ConsistencyReportSchema)

    const buildImageMsg = (text: string) =>
      new HumanMessage({ content: this.buildImageContent(images, text) })
    const buildTextMsg = (text: string) =>
      new HumanMessage({ content: text })

    // ---- Pass 1: 场景分析 (带图) ----
    async function analyzeScene(state: typeof PipelineState.State) {
      const systemMsg = new SystemMessage(
        '你是专业电影分镜师。分析图片的场景环境，输出叙事弧线、环境参数、音乐设计和时间轴。物理参数优先，禁用情绪形容词。'
      )
      let userText = input.rolePrompt || '请分析这张图片的场景。'
      if (input.context) userText += `\n\n--- 剧本/附加要求 ---\n${input.context}`

      const result = await sceneLlm.invoke([systemMsg, buildImageMsg(userText)])
      return { scene: result }
    }

    // ---- Pass 2: 角色提取 (带图) ----
    async function extractCharacters(state: typeof PipelineState.State) {
      const sceneContext = JSON.stringify(state.scene)
      const systemMsg = new SystemMessage(
        '你是专业电影分镜师。基于场景分析结果，提取图片中所有角色/物体的外观锚点、物理属性和空间位置。每个角色必须有跨镜头一致性锚点。'
      )
      const userText = `场景分析结果:\n${sceneContext}\n\n请提取所有角色和关键物体。`

      const result = await characterLlm.invoke([systemMsg, buildImageMsg(userText)])
      return { characters: result.characters }
    }

    // ---- Pass 3: 分镜生成 (无图, 文本足够) ----
    async function generateShots(state: typeof PipelineState.State) {
      const sceneContext = JSON.stringify(state.scene)
      const charContext = JSON.stringify(state.characters)
      const systemMsg = new SystemMessage(
        '你是专业电影分镜师。基于场景和角色数据，生成分镜序列。每个镜头5段式: 景别|动作|台词精华|心理→外化|运镜。如有台词，格式为 "台词..."(表演方式)；无台词标注 (无台词)。'
      )
      let userText = `场景:\n${sceneContext}\n\n角色:\n${charContext}\n\n请生成分镜序列。`
      if (state.retryFeedback) {
        userText += `\n\n--- 校验反馈(请修正) ---\n${state.retryFeedback}`
      }

      const result = await shotLlm.invoke([systemMsg, buildTextMsg(userText)])
      return { shots: result.shots }
    }

    // ---- Pass 4: 一致性校验 (无图) ----
    async function verifyConsistency(state: typeof PipelineState.State) {
      const allData = JSON.stringify({
        scene: state.scene,
        characters: state.characters,
        shots: state.shots
      })
      const systemMsg = new SystemMessage(
        '你是电影连续性校验专家。检查场景、角色、分镜之间的一致性：角色锚点是否跨镜头保持、物理参数是否自洽、时间轴是否连贯。输出连续性锚点、节奏总结和评分(1-10)。'
      )
      const result = await reportLlm.invoke([
        systemMsg,
        buildTextMsg(`请校验以下分镜数据的一致性:\n${allData}`)
      ])
      return { report: result }
    }

    // ---- 条件路由: 校验分数 < 6 且未重试过 → 回到 Pass 3 ----
    function shouldRetry(state: typeof PipelineState.State) {
      if (state.report && state.report.score < 6 && state.retryCount < 1) {
        return 'retry'
      }
      return 'done'
    }

    function prepareRetry(state: typeof PipelineState.State) {
      const feedback = state.report?.issues
        ?.map(i => `[${i.shotId}] ${i.field}: ${i.problem} → ${i.suggestion}`)
        .join('\n') || ''
      return {
        retryFeedback: feedback,
        retryCount: state.retryCount + 1,
        shots: null,
        report: null
      }
    }

    // ---- 构建 StateGraph ----
    const graph = new StateGraph(PipelineState)
      .addNode('analyzeScene', analyzeScene)
      .addNode('extractCharacters', extractCharacters)
      .addNode('generateShots', generateShots)
      .addNode('verifyConsistency', verifyConsistency)
      .addNode('prepareRetry', prepareRetry)
      .addEdge(START, 'analyzeScene')
      .addEdge('analyzeScene', 'extractCharacters')
      .addEdge('extractCharacters', 'generateShots')
      .addEdge('generateShots', 'verifyConsistency')
      .addConditionalEdges('verifyConsistency', shouldRetry, {
        retry: 'prepareRetry',
        done: END
      })
      .addEdge('prepareRetry', 'generateShots')
      .compile()

    // ---- 流式执行 + 进度回调 ----
    let finalState: typeof PipelineState.State | null = null

    for await (const chunk of await graph.stream(
      {},
      { streamMode: 'updates' }
    )) {
      const [nodeName, nodeOutput] = Object.entries(chunk)[0]

      if (nodeName === 'analyzeScene' && onProgress) {
        onProgress({ pass: 1, label: '场景分析完成', data: nodeOutput.scene })
      } else if (nodeName === 'extractCharacters' && onProgress) {
        onProgress({ pass: 2, label: '角色提取完成', data: nodeOutput.characters })
      } else if (nodeName === 'generateShots' && onProgress) {
        onProgress({ pass: 3, label: '分镜生成完成', data: nodeOutput.shots })
      } else if (nodeName === 'verifyConsistency' && onProgress) {
        onProgress({ pass: 4, label: '一致性校验完成', data: nodeOutput.report })
      }

      finalState = { ...finalState, ...nodeOutput } as any
    }

    if (!finalState?.scene || !finalState?.characters || !finalState?.shots || !finalState?.report) {
      throw new Error('Pipeline incomplete: missing pass results')
    }

    return aggregateToStoryboardResponse(
      finalState.scene,
      finalState.characters,
      finalState.shots,
      finalState.report
    )
  }
}
```

**Step 2: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/
git commit -m "feat: implement 4-pass storyboard pipeline with StateGraph streaming"
```

---

### Task 5: 注册管线到 ServiceBridge

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts`（从 git 恢复后修改）

**Step 1: 恢复 ServiceBridge.ts**

Run: `git show 6969bd8:src/renderer/src/services/ServiceBridge.ts > src/renderer/src/services/ServiceBridge.ts`

**Step 2: 添加管线 Service 的 lazy getter**

在 `getLangChainStoryboardService` 函数之后添加:

```typescript
let _pipelineInstance: import('./storyboard-pipeline/StoryboardPipelineService').StoryboardPipelineService | null = null
let _pipelineCacheKey: string | null = null

export function getStoryboardPipelineService(model?: string): import('./storyboard-pipeline/StoryboardPipelineService').StoryboardPipelineService | null {
  const api = (window as any).aiImageAPI
  const apiKey = api?.visionApiKey as string | undefined
  if (!apiKey) return null

  const site = api?.getCurrentSite?.()
  const baseURL = site?.baseURL as string | undefined
  if (!baseURL) return null

  const cacheKey = `pipeline|${apiKey}|${baseURL}|${model || ''}`
  if (!_pipelineInstance || _pipelineCacheKey !== cacheKey) {
    const { StoryboardPipelineService } = require('./storyboard-pipeline/StoryboardPipelineService')
    _pipelineInstance = new StoryboardPipelineService({ apiKey, baseURL, model })
    _pipelineCacheKey = cacheKey
    console.log('[ServiceBridge] ✓ StoryboardPipelineService 实例已创建, model:', model || 'default')
  }
  return _pipelineInstance
}
```

**Step 3: Build 验证**

**Step 4: Commit**

```bash
git add src/renderer/src/services/ServiceBridge.ts
git commit -m "feat: register StoryboardPipelineService in ServiceBridge"
```

---

### Task 6: UnderstandPage 集成管线 + 进度 UI

**Files:**
- Modify: `src/renderer/src/pages/UnderstandPage.ts`

**Step 1: 在 analyzeImages() 的 LangChain 路径中，添加管线优先分支**

在现有的 `if (this.currentRole === 'sora-storyboard' || this.currentRole === 'sora-storyboard-pro')` 块内，在 `getLangChainStoryboardService` 调用之前，添加管线优先逻辑:

```typescript
// 尝试使用 4-Pass 管线 (sora-storyboard-pro 专用)
if (this.currentRole === 'sora-storyboard-pro') {
  try {
    const { getStoryboardPipelineService } = await import('../services/ServiceBridge')
    const pipelineService = getStoryboardPipelineService(modelToUse)
    if (pipelineService) {
      console.log('[UnderstandPage] Using 4-Pass storyboard pipeline...')
      const images = this.uploadedImages.map(img => ({
        base64: img.base64, mimeType: img.mimeType || 'image/jpeg'
      }))
      this.showPipelineProgress(0)

      const result = await pipelineService.analyze(
        images,
        { rolePrompt: prompt || '', context: contextText || undefined },
        (progress) => this.onPipelineProgress(progress)
      )

      const jsonOutput = JSON.stringify(result, null, 2)
      fullResult = jsonOutput
      this.appendResultChunk(jsonOutput)
      this.onStreamComplete(jsonOutput, modelToUse)
      this.showToast('4-Pass 分镜分析完成！', 'success')

      this._lastStoryboardResult = result
      this._lastAnalyzedImages = images
      this.showImportToDirectorButton()

      this.isAnalyzing = false
      return
    }
  } catch (pipelineError: any) {
    console.warn('[UnderstandPage] Pipeline failed, falling back to single-pass:', pipelineError.message)
  }
}
```

**Step 2: 添加进度展示方法**

```typescript
private showPipelineProgress(passIndex: number): void {
  const resultContainer = this.getElement<HTMLElement>('understandResult')
  if (!resultContainer) return

  const passes = [
    { icon: '🎬', label: 'Pass 1: 场景分析', status: 'waiting' },
    { icon: '👤', label: 'Pass 2: 角色提取', status: 'waiting' },
    { icon: '🎥', label: 'Pass 3: 分镜生成', status: 'waiting' },
    { icon: '✅', label: 'Pass 4: 一致性校验', status: 'waiting' }
  ]

  resultContainer.innerHTML = `
    <div class="mb-4">
      <h3 class="text-white text-lg font-semibold flex items-center mb-3">
        <i class="fas fa-brain text-blue-400 mr-2 animate-pulse"></i>
        4-Pass 分镜分析中...
      </h3>
      <div class="space-y-2" id="pipelineProgressBars">
        ${passes.map((p, i) => `
          <div class="flex items-center gap-3 text-sm" id="pipelinePass${i + 1}">
            <span class="text-xl">${p.icon}</span>
            <span class="text-white opacity-50">${p.label}</span>
            <span class="ml-auto text-white opacity-30">等待中</span>
          </div>
        `).join('')}
      </div>
    </div>
    <div id="pipelineResultArea" class="text-white" style="min-height: 200px; line-height: 1.8; white-space: pre-wrap;"></div>
  `
}

private onPipelineProgress(progress: { pass: number; label: string; data: any }): void {
  const passEl = document.getElementById(`pipelinePass${progress.pass}`)
  if (passEl) {
    const statusEl = passEl.querySelector('span:last-child')
    if (statusEl) {
      statusEl.textContent = '✓ 完成'
      statusEl.classList.remove('opacity-30')
      statusEl.classList.add('text-green-400')
    }
    passEl.querySelector('span:first-child')?.classList.add('opacity-100')
  }

  // 在下方追加中间结果摘要
  const resultArea = document.getElementById('pipelineResultArea')
  if (resultArea) {
    const summary = document.createElement('div')
    summary.className = 'mb-3 p-3 bg-white bg-opacity-5 rounded-lg'
    summary.innerHTML = `
      <div class="text-sm text-blue-300 font-medium mb-1">${progress.label}</div>
      <pre class="text-xs text-white opacity-70 overflow-auto max-h-40">${JSON.stringify(progress.data, null, 2)}</pre>
    `
    resultArea.appendChild(summary)
  }

  // 标记下一个 pass 为进行中
  const nextPassEl = document.getElementById(`pipelinePass${progress.pass + 1}`)
  if (nextPassEl) {
    const nextStatus = nextPassEl.querySelector('span:last-child')
    if (nextStatus) {
      nextStatus.textContent = '⏳ 进行中...'
      nextStatus.classList.remove('opacity-30')
      nextStatus.classList.add('text-yellow-400', 'animate-pulse')
    }
  }
}
```

**Step 3: Build 验证**

Run: `npm run build:vite 2>&1 | Select-String "error|built in"`

**Step 4: Commit**

```bash
git add src/renderer/src/pages/UnderstandPage.ts
git commit -m "feat: integrate 4-pass pipeline into UnderstandPage with progress UI"
```

---

### Task 7: 修正 prompt 文件 timeline 示例

**Files:**
- Modify: `src/renderer/public/data/prompts/sora-storyboard-pro.md`

**Step 1: 将 scene.timeline 示例从 object 改为 array 格式**

将当前的:

```json
{
  "S1": { "t": "0-3s", "dur": "3s", "tempo": "slow", "trans": "cut" },
  "S2": { "t": "3-5.5s", "dur": "2.5s", "tempo": "accelerating", "trans": "match-cut" }
}
```

替换为:

```
[
  { "id": "S1", "t": "0-3s", "dur": "3s", "tempo": "slow", "trans": "cut" },
  { "id": "S2", "t": "3-5.5s", "dur": "2.5s", "tempo": "accelerating", "trans": "match-cut" }
]
```

**Step 2: Build 验证**

**Step 3: Commit**

```bash
git add src/renderer/public/data/prompts/sora-storyboard-pro.md
git commit -m "fix: align timeline example with Zod array schema"
```

---

### Task 8: 构建 + 全量验证

**Step 1: Full Build**

Run: `npm run build:vite`

**Step 2: 验证清单**

1. `dist/` 中包含新的 pipeline chunk
2. prompt 文件传播到 `dist/renderer/data/prompts/`
3. 无编译错误

**Step 3: 运行时验证**（手动）

1. 打开应用 → 图像理解 → 选择分镜Pro
2. 上传图片 + 剧本 → 点击分析
3. 看到 4-Pass 进度条逐步完成
4. 每个 Pass 完成后中间结果卡片出现
5. 最终结果是完整的 StoryboardResponse JSON
6. 点击"导入到导演模式"仍然正常工作

---

## 关键设计决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 编排工具 | LangGraph StateGraph | stream("updates") 天然支持逐 Pass UI 更新 |
| Schema 策略 | 4 个独立 schema | 小 schema = 更精确填充，减少模型信息丢失 |
| 图片传递 | 闭包引用，不进 State | 避免 state 膨胀 |
| Pass 3+4 不传图 | 文本足够 | 节省 ~40% token |
| 重试策略 | Pass 4 score < 6 → 回到 Pass 3，最多 1 次 | 平衡质量和延迟 |
| 回退策略 | 管线失败 → 降级到单次 LangChain | 保证功能可用性 |
| 加载策略 | dynamic import | 不增加首屏 bundle size |
