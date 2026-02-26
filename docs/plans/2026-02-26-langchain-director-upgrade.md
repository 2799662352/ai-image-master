# LangChain.js Director Pipeline Upgrade - Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the hand-rolled AI call + regex JSON parse pipeline in DirectorPage with LangChain.js `ChatGoogle.withStructuredOutput(Zod)` for type-safe, validated structured output from Gemini.

**Architecture:** Extract all LLM interactions into a new `LangChainDirectorService` class. It uses `ChatGoogle` with Zod schemas to get validated structured responses directly from Gemini. DirectorPage becomes a thin UI layer that delegates to the service and handles fallback.

**Tech Stack:** LangChain.js (`@langchain/google`, `@langchain/core`), Zod (already installed), TypeScript, Vitest

---

### Task 1: Install LangChain dependencies

**Files:**
- Modify: `package.json`

**Step 1: Install packages**

Run: `npm install @langchain/google @langchain/core`
Expected: packages added to `dependencies` in package.json

**Step 2: Verify installation**

Run: `node -e "const { ChatGoogle } = require('@langchain/google'); console.log('ChatGoogle loaded:', typeof ChatGoogle)"`
Expected: `ChatGoogle loaded: function`

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add @langchain/google and @langchain/core dependencies"
```

---

### Task 2: Create LangChainDirectorService with Zod schemas

**Files:**
- Create: `src/renderer/src/services/LangChainDirectorService.ts`

**Step 1: Write failing test**

Create: `tests/services/LangChainDirectorService.test.ts`

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { LangChainDirectorService, ShotsResponseSchema, ShotSchema } from '../../src/renderer/src/services/LangChainDirectorService'

describe('Zod Schema Validation', () => {
  it('should validate a well-formed shot', () => {
    const validShot = {
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      spatial: { fg: 'rain-streaked glass', mg: 'woman at table', bg: 'blurred city' },
      action: 'gazes down, bites lower lip',
      light: 'upper-left window, soft, warm 4500K',
      label: '分镜1'
    }
    const result = ShotSchema.safeParse(validShot)
    expect(result.success).toBe(true)
  })

  it('should reject shot missing required field', () => {
    const badShot = {
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      // missing spatial, action, light
      label: '分镜1'
    }
    const result = ShotSchema.safeParse(badShot)
    expect(result.success).toBe(false)
  })

  it('should reject shot with wrong spatial type', () => {
    const badShot = {
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      spatial: 'flat string instead of object',
      action: 'walks forward',
      light: 'natural ambient',
      label: '分镜1'
    }
    const result = ShotSchema.safeParse(badShot)
    expect(result.success).toBe(false)
  })

  it('should validate a full ShotsResponse', () => {
    const response = {
      character_anchor: 'Young woman, black hair, blue eyes',
      shots: [{
        kf: 'KF1 - CU - 2s',
        lens: '85mm static',
        spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
        action: 'gazes down',
        light: 'soft warm 4500K',
        label: '分镜1'
      }]
    }
    const result = ShotsResponseSchema.safeParse(response)
    expect(result.success).toBe(true)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: FAIL with "Cannot find module" (file doesn't exist yet)

**Step 3: Write minimal implementation**

Create `src/renderer/src/services/LangChainDirectorService.ts` with:

```typescript
import { z } from 'zod'
import { ChatGoogle } from '@langchain/google'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ==================== Zod Schemas ====================

export const ShotSchema = z.object({
  kf: z.string().describe('KF number + shot type + duration, e.g. "KF1 - CU - 2s"'),
  lens: z.string().describe('Focal length + camera movement, e.g. "85mm static"'),
  spatial: z.object({
    fg: z.string().describe('Foreground depth layer'),
    mg: z.string().describe('Midground depth layer (primary subject)'),
    bg: z.string().describe('Background depth layer')
  }),
  action: z.string().describe('One anchor verb + manner words, no verb stacking'),
  light: z.string().describe('Source + direction + quality + color temperature'),
  label: z.string().describe('Panel label like 分镜1')
})

export const ShotsResponseSchema = z.object({
  character_anchor: z.string().describe('Precise character appearance: gender, age, hair, eyes, skin, outfit, build'),
  shots: z.array(ShotSchema)
})

export type ShotData = z.infer<typeof ShotSchema>
export type ShotsResponse = z.infer<typeof ShotsResponseSchema>

// ==================== Service Types ====================

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface ShotGenInput {
  imageAnalysis: string
  sceneDescription: string
  panelCount: number
  layoutRows: number
  layoutCols: number
  layoutRatio: string
  viewDistribution: string
  styleInstructions: string
  additionalRules: string
  images: ImageInput[]
  systemPrompt: string
}

export interface StyleConfig {
  prefix: string
  suffix: string
  negative: string
}

// ==================== Service ====================

export class LangChainDirectorService {
  private llm: ChatGoogle
  private structuredLlm: ReturnType<ChatGoogle['withStructuredOutput']>

  constructor(config: { apiKey: string; model?: string }) {
    this.llm = new ChatGoogle({
      model: config.model || 'gemini-2.5-flash',
      apiKey: config.apiKey,
      maxRetries: 2
    })
    this.structuredLlm = this.llm.withStructuredOutput(ShotsResponseSchema)
  }

  async analyzeImage(images: ImageInput[], sceneHint?: string): Promise<string> {
    const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> = [
      { type: 'text', text: sceneHint || 'Analyze this reference image. Identify all key subjects, spatial relationships, lighting conditions, color palette, and mood.' }
    ]
    for (const img of images) {
      contentBlocks.push({ type: 'image', mimeType: img.mimeType, data: img.base64 })
    }
    const message = new HumanMessage({ content: contentBlocks })
    const res = await this.llm.invoke([message])
    return typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
  }

  async generateShots(input: ShotGenInput): Promise<ShotsResponse> {
    const systemMsg = new SystemMessage(input.systemPrompt)
    const userPrompt = this.buildUserPrompt(input)

    const contentBlocks: Array<{ type: 'text'; text: string } | { type: 'image'; mimeType: string; data: string }> = [
      { type: 'text', text: userPrompt }
    ]
    for (const img of input.images) {
      contentBlocks.push({ type: 'image', mimeType: img.mimeType, data: img.base64 })
    }
    const humanMsg = new HumanMessage({ content: contentBlocks })

    return await this.structuredLlm.invoke([systemMsg, humanMsg])
  }

  private buildUserPrompt(input: ShotGenInput): string {
    return `## 参考图分析结果
${input.imageAnalysis}

## 用户场景描述
${input.sceneDescription || '根据参考图生成连续的分镜画面'}

## 布局要求
- 分镜数量: ${input.panelCount}
- 布局: ${input.layoutRows}行 x ${input.layoutCols}列
- 画幅比例: ${input.layoutRatio}

## 视角分布要求
${input.viewDistribution}

## 风格要求
${input.styleInstructions}

请输出 ${input.panelCount} 个分镜。
${input.additionalRules}`
  }

  shotsToNaturalLanguage(shots: ShotData[]): string {
    return shots.map((shot, i) => {
      const parts = [shot.kf, shot.lens, shot.action]
      const sp = shot.spatial
      parts.push(`FG: ${sp.fg}, MG: ${sp.mg}, BG: ${sp.bg}`)
      parts.push(shot.light)
      return `${i + 1}. ${parts.filter(Boolean).join(', ')}`
    }).join('\n')
  }

  buildFinalPrompt(
    shots: ShotsResponse,
    composition: string,
    style: string,
    story: string,
    constraints: string,
    negative?: string
  ): string {
    const compact = {
      c: composition,
      s: shots.character_anchor,
      st: style,
      d: story,
      p: shots.shots.map((shot, i) => ({
        i: i + 1,
        sh: shot.kf,
        l: shot.lens,
        sp: shot.spatial,
        a: shot.action,
        li: shot.light
      })),
      x: constraints,
      ...(negative && { n: negative })
    }
    return JSON.stringify(compact)
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: PASS (4 schema tests)

**Step 5: Commit**

```bash
git add src/renderer/src/services/LangChainDirectorService.ts tests/services/LangChainDirectorService.test.ts
git commit -m "feat: add LangChainDirectorService with Zod schemas and structured output"
```

---

### Task 3: Add Service unit tests for analyzeImage and generateShots

**Files:**
- Modify: `tests/services/LangChainDirectorService.test.ts`

**Step 1: Add mock-based tests**

Append to the test file:

```typescript
describe('LangChainDirectorService', () => {
  it('should call ChatGoogle with image content blocks in analyzeImage', async () => {
    // Mock ChatGoogle at module level
    const mockInvoke = vi.fn().mockResolvedValue({ content: 'Analysis result text' })
    const mockWithStructuredOutput = vi.fn().mockReturnValue({ invoke: vi.fn() })

    vi.mock('@langchain/google', () => ({
      ChatGoogle: vi.fn().mockImplementation(() => ({
        invoke: mockInvoke,
        withStructuredOutput: mockWithStructuredOutput
      }))
    }))

    const service = new LangChainDirectorService({ apiKey: 'test-key' })
    const result = await service.analyzeImage([
      { base64: 'dGVzdA==', mimeType: 'image/jpeg' }
    ])

    expect(result).toBe('Analysis result text')
    expect(mockInvoke).toHaveBeenCalledOnce()
  })

  it('should produce readable natural language from shots', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key' })
    const shots = [{
      kf: 'KF1 - CU - 2s',
      lens: '85mm static',
      spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
      action: 'gazes down',
      light: 'warm 4500K',
      label: '分镜1'
    }]
    const nl = service.shotsToNaturalLanguage(shots)
    expect(nl).toContain('KF1 - CU - 2s')
    expect(nl).toContain('85mm static')
    expect(nl).toContain('gazes down')
    expect(nl).not.toContain('{')
    expect(nl).not.toContain('}')
  })

  it('should build compact JSON prompt from ShotsResponse', () => {
    const service = new LangChainDirectorService({ apiKey: 'test-key' })
    const shots = {
      character_anchor: 'Young woman, black hair',
      shots: [{
        kf: 'KF1 - CU - 2s',
        lens: '85mm static',
        spatial: { fg: 'glass', mg: 'woman', bg: 'city' },
        action: 'gazes down',
        light: 'warm 4500K',
        label: '分镜1'
      }]
    }
    const result = service.buildFinalPrompt(shots, 'comp', 'style', 'story', 'constraints')
    const parsed = JSON.parse(result)
    expect(parsed.s).toBe('Young woman, black hair')
    expect(parsed.p[0].l).toBe('85mm static')
    expect(parsed.p[0].sp.fg).toBe('glass')
  })
})
```

**Step 2: Run tests**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: PASS

**Step 3: Commit**

```bash
git add tests/services/LangChainDirectorService.test.ts
git commit -m "test: add LangChainDirectorService unit tests"
```

---

### Task 4: Register LangChainDirectorService in ServiceBridge

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts` (around L40, L460-470, L520-527)

**Step 1: Add import and lazy initialization**

At the import section (near L40), add:
```typescript
import { LangChainDirectorService } from './LangChainDirectorService'
```

In the service registration area, add a factory method that creates the service on demand using the current visionApiKey:
```typescript
private langchainService: LangChainDirectorService | null = null

getLangChainDirectorService(): LangChainDirectorService | null {
  const apiKey = window.aiImageAPI?.visionApiKey
  if (!apiKey) return null
  if (!this.langchainService) {
    this.langchainService = new LangChainDirectorService({ apiKey })
  }
  return this.langchainService
}
```

**Step 2: Build to verify no errors**

Run: `npx electron-vite build`
Expected: exit 0

**Step 3: Commit**

```bash
git add src/renderer/src/services/ServiceBridge.ts
git commit -m "feat: register LangChainDirectorService in ServiceBridge"
```

---

### Task 5: Integrate LangChain into DirectorPage.generateComicPrompt

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

This is the core integration task. Modify `generateComicPrompt()` (L2058-2100) to:
1. Try `LangChainDirectorService.generateShots()` first
2. On success, use `service.buildFinalPrompt()` or pass structured data to existing `buildJsonPrompt()`
3. On failure, fall back to existing `generateTemplatePrompt()`

**Step 1: Add import and service accessor**

Near top of file, add:
```typescript
import { LangChainDirectorService, type ShotsResponse } from '../services/LangChainDirectorService'
```

Add a method to get the service:
```typescript
private getLangChainService(): LangChainDirectorService | null {
  const api = this.getApi()
  if (!api?.visionApiKey) return null
  if (!this._langchainService) {
    this._langchainService = new LangChainDirectorService({ apiKey: api.visionApiKey })
  }
  return this._langchainService
}
private _langchainService: LangChainDirectorService | null = null
```

**Step 2: Modify generateComicPrompt to use LangChain first**

Replace the `generateJsonShots` call block (L2077-2092) with:

```typescript
// Try LangChain structured output first
const langchainService = this.getLangChainService()
if (langchainService && this.referenceImages.length > 0) {
  try {
    console.log('[DirectorPage] Using LangChain structured output...')
    const images = this.referenceImages.map(img => ({
      base64: img.base64, mimeType: img.mimeType || 'image/jpeg'
    }))
    const shotsResponse = await langchainService.generateShots({
      imageAnalysis, sceneDescription, panelCount,
      layoutRows: layout.rows, layoutCols: layout.cols,
      layoutRatio: layout.ratio || '16:9',
      viewDistribution: this.calculateViewDistribution(panelCount),
      styleInstructions: styleConfig.styleInstructions,
      additionalRules: styleConfig.additionalRules,
      images,
      systemPrompt: this.getGemSystemPromptForTemplate()
    })
    console.log('[DirectorPage] LangChain success:', shotsResponse.shots.length, 'shots')

    this.lastCharacterAnchor = shotsResponse.character_anchor
    this.lastShotsResponse = shotsResponse

    // Convert to panels for existing buildJsonPrompt flow
    const panels = shotsResponse.shots.map((shot, i) => ({
      id: i + 1, shot: shot.kf, lens: shot.lens,
      spatial: shot.spatial, action: shot.action, light: shot.light
    }))
    this.lastParsedPanels = panels

    // Build shots array for backward compat (getGeneratedShots, Sora2)
    this.lastGeneratedShots = shotsResponse.shots.map((shot, i) => ({
      shot_number: shot.label || `分镜${i + 1}`,
      prompt_text: JSON.stringify(shot)
    }))

    return this.convertJsonShotsToPrompt(
      this.lastGeneratedShots, panelCount, layout,
      templatePrefix, templateSuffix, templateNegative
    )
  } catch (error) {
    console.warn('[DirectorPage] LangChain failed, falling back:', error)
  }
}

// Existing fallback: try legacy generateJsonShots, then template
```

**Step 3: Add lastShotsResponse field**

Near L2491-2493 (where lastParsedPanels is declared), add:
```typescript
private lastShotsResponse: ShotsResponse | null = null
```

Reset it in startSingleGeneration (L1792) and startMultiGeneration (L1873):
```typescript
this.lastShotsResponse = null
```

**Step 4: Build to verify**

Run: `npx electron-vite build`
Expected: exit 0

**Step 5: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "feat: integrate LangChain structured output in generateComicPrompt"
```

---

### Task 6: Fix generateSora2VideoPrompt for structured data

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts` (L2462-2479)

**Step 1: Rewrite to use lastShotsResponse or lastParsedPanels**

```typescript
generateSora2VideoPrompt(
  shots: Array<{ shot_number: string; prompt_text: string }>,
  characterCard: string = ''
): string {
  const langchainService = this.getLangChainService()

  const videoSequences = shots.map((shot, i) => {
    // Priority 1: Use lastShotsResponse from LangChain
    if (this.lastShotsResponse?.shots[i]) {
      return `${i + 1}. ${langchainService?.shotsToNaturalLanguage([this.lastShotsResponse.shots[i]]).replace(/^1\. /, '') || shot.prompt_text}`
    }
    // Priority 2: Use lastParsedPanels
    const panel = this.lastParsedPanels?.[i]
    if (panel?.lens && panel?.action) {
      const parts = [panel.shot, panel.lens, panel.action]
      if (panel.spatial) {
        parts.push(`FG: ${panel.spatial.fg}, MG: ${panel.spatial.mg}, BG: ${panel.spatial.bg}`)
      }
      if (panel.light) parts.push(panel.light)
      return `${i + 1}. ${parts.filter(Boolean).join(', ')}`
    }
    // Priority 3: Try JSON parse, then raw text
    try {
      const p = JSON.parse(shot.prompt_text)
      return `${i + 1}. ${[p.kf, p.lens, p.action, p.light].filter(Boolean).join(', ')}`
    } catch {
      return `${i + 1}. ${shot.prompt_text.replace(/'分镜\d+'.*/gi, '').trim()}`
    }
  }).join('\n')

  return this.sora2VideoPromptTemplate
    .replace('{CHARACTER_CARD}', characterCard)
    .replace('{VIDEO_SEQUENCES}', videoSequences)
}
```

**Step 2: Build to verify**

Run: `npx electron-vite build`
Expected: exit 0

**Step 3: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "fix: generateSora2VideoPrompt now handles structured JSON prompt_text"
```

---

### Task 7: Fix startMultiGeneration reset + cleanup

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts`

**Step 1: Add missing resets in startMultiGeneration (L1873)**

After `this.lastCharacterAnchor = null`, add:
```typescript
this.lastParsedPanels = null
this.lastShotsResponse = null
```

**Step 2: Build to verify**

Run: `npx electron-vite build`
Expected: exit 0

**Step 3: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "fix: reset lastParsedPanels and lastShotsResponse in startMultiGeneration"
```

---

### Task 8: Final verification

**Step 1: Full build**

Run: `npx electron-vite build`
Expected: exit 0

**Step 2: Run all tests**

Run: `npx vitest run`
Expected: all PASS

**Step 3: Lint check**

Check ReadLints for both modified files.
Expected: 0 new errors

**Step 4: Final commit + push**

```bash
git add -A
git commit -m "feat: complete LangChain.js director pipeline upgrade"
git push
```
