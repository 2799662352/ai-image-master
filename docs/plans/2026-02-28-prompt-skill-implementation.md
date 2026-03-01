# Prompt Skill System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 StoryboardPipeline 硬编码规则重构为可组合 PromptSkill 模块系统 + 创建外部 AI Skill + 修复 sanitizer bug。

**Architecture:** 新建 `prompt-skills.ts` 模块定义 6 个内置 skills，修改 Service 构造函数注入 skills，替换 4 个 node 函数的 hardRules 为 `buildRulesForPass()`，PipelineState 新增 `previousShots` 字段支持连续性锁定。Graph 拓扑不变。

**Tech Stack:** LangGraphJS (StateGraph/Annotation), Zod, TypeScript, Agent Skills Specification

---

### Task 1: 新建 prompt-skills.ts 模块

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/prompt-skills.ts`

**Step 1: 创建 PromptSkill 接口和类型**

```typescript
// src/renderer/src/services/storyboard-pipeline/prompt-skills.ts
import type { CharacterAnchor, ShotData } from './schemas'

export type PassType = 'scene' | 'character' | 'shot' | 'verify'

export interface PipelineStateSlice {
  retryFeedback?: string
  previousShots?: Array<{ id: string; desc: string }> | null
  characters?: CharacterAnchor[] | null
}

export interface PromptSkill {
  id: string
  rules: string | ((state: PipelineStateSlice) => string)
  appliesTo: PassType[]
  priority: number
}
```

**Step 2: 定义 6 个内置 Skills**

```typescript
const CORE_RULES = `Core Rules:
1. Physical lighting: 80% deep shadows + single rim light, never emotion adjectives
2. Color hierarchy: dominated by [key] + faint [accent], never equal warm+cool
3. Lens: always [mm] f/[stop], never "8k/masterpiece"
4. Mid-action snapshot: freeze at peak tension, never "then/after"
5. Micro-expression: physiological (brow furrowed 2mm) not emotional (happy/sad)
6. Z-axis mandatory: fg occluder / mg subject / bg environment
7. 2-4s per shot, ONE core action`

const DIALOGUE_RULES = `Dialogue Rules:
8. If screenplay provides character names, USE THEM EXACTLY. Never guess from visual style.
9. If screenplay provides dialogue, EXTRACT VERBATIM. Never fabricate lines.`

const PHYSICS_RULES = `Physics Rules:
- Physical description only: skin texture, muscle tension, bone structure
- Motion vectors: angle°/displacement cm/velocity m·s⁻¹
- Micro-expression quantification: brow furrowed Xmm, pupil dilation Xmm`

const STYLE_RULES = `Style Rules:
- Color palette: dominated by [hex] + accent [hex], ratio ≥ 7:3
- Light source: specify type (rim/fill/key), angle, intensity %
- Shadow depth: percentage of frame in shadow`

const DODGE_RULES = `Artistic Dodge Rules (MANDATORY for all output text):
D1. NEVER use explicit anatomical terms — replace with contour/silhouette/curvature
D2. NEVER use explicit action verbs (thrust/penetrate/insert) — use rhythmic pulsing/deep connection/intertwined
D3. Intimate scenes: describe via physics (pressure, velocity, amplitude) not biology
D4. Skin contact: use "glistening sheen / oil texture / sweat micro-beads" not explicit fluids
D5. Violence: use force vectors (impact 200N / compression 3cm) not graphic injury
D6. Nudity: "bare skin contour in shadow" or "fabric slipping off shoulder line"
D7. Sound: "breathless gasp / vocal tremor / synced exhalation" not explicit vocalization
D8. Always wrap sensitive zones with: artistic shadow / shallow DOF blur / fabric silhouette / steam diffusion`

function buildContinuityLock(state: PipelineStateSlice): string {
  if (!state.retryFeedback || !state.previousShots) return ''

  const shotSummary = state.previousShots
    .map(s => `${s.id}: ${s.desc}`)
    .join('\n')

  const anchors = state.characters
    ?.map(c => `[${c.n}] ${c.t}`)
    .join('; ') || ''

  return `CONTINUITY LOCK (严格遵守):
以下为上一轮生成的参考帧，本次仅修正被指出的问题，其余完全保持不变。
角色锚点锁定: ${anchors}

参考帧:
${shotSummary}

规则: 未被 retryFeedback 提及的镜头 → 原样保留，禁止修改。`
}

export const BUILTIN_SKILLS: PromptSkill[] = [
  { id: 'core',       rules: CORE_RULES,       appliesTo: ['scene', 'character', 'shot', 'verify'], priority: 0 },
  { id: 'dialogue',   rules: DIALOGUE_RULES,   appliesTo: ['shot', 'verify'],                      priority: 10 },
  { id: 'physics',    rules: PHYSICS_RULES,     appliesTo: ['character', 'shot'],                   priority: 10 },
  { id: 'style',      rules: STYLE_RULES,       appliesTo: ['scene'],                               priority: 10 },
  { id: 'dodge',      rules: DODGE_RULES,       appliesTo: ['scene', 'character', 'shot', 'verify'], priority: 20 },
  { id: 'continuity', rules: buildContinuityLock, appliesTo: ['shot'],                              priority: 30 },
]
```

**Step 3: 实现 buildRulesForPass**

```typescript
export function buildRulesForPass(
  pass: PassType,
  skills: PromptSkill[],
  state?: PipelineStateSlice
): string {
  return skills
    .filter(s => s.appliesTo.includes(pass))
    .sort((a, b) => a.priority - b.priority)
    .map(s => typeof s.rules === 'function' ? s.rules(state || {}) : s.rules)
    .join('\n\n')
}
```

**Step 4: 验证文件完整性**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit src/renderer/src/services/storyboard-pipeline/prompt-skills.ts`
Expected: 无类型错误（或仅 import 路径相关的错误，因为在隔离编译时可能缺少 tsconfig path）

**Step 5: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/prompt-skills.ts
git commit -m "feat: add PromptSkill module with 6 builtin skills and buildRulesForPass"
```

---

### Task 2: 修改 schemas.ts 添加 previousShots 导出类型

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/schemas.ts:54` (在 ShotData 类型导出后)

**Step 1: 在 schemas.ts 末尾 (ConsistencyReport 类型之后) 添加 PreviousShot 类型**

在文件末尾（第 73 行 `export type ConsistencyReport` 之后）添加:

```typescript
// Simplified shot reference for continuity lock during retry
export type PreviousShot = Pick<ShotData, 'id' | 'desc'>
```

**Step 2: 验证**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit`
Expected: 无新增错误

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/schemas.ts
git commit -m "feat: add PreviousShot type for continuity lock state"
```

---

### Task 3: 修改 StoryboardPipelineService.ts — PipelineState + 构造函数

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 更新 import 语句**

将第 1-13 行的 import 替换为:

```typescript
import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogle } from '@langchain/google'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  SceneAnalysisSchema, CharacterAnchorsSchema,
  ShotSequenceSchema, ConsistencyReportSchema,
  type SceneAnalysis, type CharacterAnchor, type ShotData, type ConsistencyReport,
  type PreviousShot
} from './schemas'
import { aggregateToStoryboardResponse } from './aggregate'
import { sanitizeStoryboardResponse } from './sanitizer'
import { buildRulesForPass, BUILTIN_SKILLS, type PromptSkill } from './prompt-skills'
import type { StoryboardResponse } from '../LangChainStoryboardService'
```

**Step 2: 在 PipelineState 中添加 previousShots 字段**

在 `retryFeedback` 字段之后（第 67 行之前的 `})`）添加:

```typescript
  previousShots: Annotation<PreviousShot[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
```

完整 PipelineState 变为:

```typescript
const PipelineState = Annotation.Root({
  scene: Annotation<SceneAnalysis | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  characters: Annotation<CharacterAnchor[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  shots: Annotation<ShotData[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  report: Annotation<ConsistencyReport | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  retryCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  retryFeedback: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  previousShots: Annotation<PreviousShot[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
})
```

**Step 3: 修改 class 定义和构造函数**

将 class 开头（第 73-99 行）替换为:

```typescript
export class StoryboardPipelineService {
  private llm: ChatOpenAI | ChatGoogle
  private skills: PromptSkill[]

  constructor(config: PipelineConfig, skills?: PromptSkill[]) {
    this.skills = skills || BUILTIN_SKILLS

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
```

**Step 4: 验证**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit`
Expected: 可能有关于 `hardRules` 引用的错误（下一个 Task 会删除），但结构性编译应通过

**Step 5: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "feat: add skills injection to constructor and previousShots to PipelineState"
```

---

### Task 4: 修改 StoryboardPipelineService.ts — 替换 hardRules 为 buildRulesForPass

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 删除 hardRules 常量，在 analyze 方法中引用 this.skills**

在 `analyze()` 方法内部，删除第 131-150 行的整个 `const hardRules = ...` 块。

同时在 `analyze()` 方法开头新增一个局部变量:

```typescript
    const skills = this.skills
```

**Step 2: 替换 analyzeScene 中的 hardRules**

将 `analyzeScene` 函数中的:
```typescript
        `你是专业电影分镜师和AI视频预生产专家。分析图片的场景环境，输出叙事弧线、环境参数、音乐设计和时间轴。${timelineHint}\n${hardRules}`
```
替换为:
```typescript
        `你是专业电影分镜师和AI视频预生产专家。分析图片的场景环境，输出叙事弧线、环境参数、音乐设计和时间轴。${timelineHint}\n${buildRulesForPass('scene', skills)}`
```

**Step 3: 替换 extractCharacters 中的 hardRules**

将 `extractCharacters` 函数中的:
```typescript
每个角色必须有motive字段：基于剧本和画面，用一句话描述该角色在此场景中想要达成什么。\n${hardRules}`
```
替换为:
```typescript
每个角色必须有motive字段：基于剧本和画面，用一句话描述该角色在此场景中想要达成什么。\n${buildRulesForPass('character', skills)}`
```

**Step 4: 替换 generateShots 中的 hardRules，注入 continuity state**

将 `generateShots` 函数中的:
```typescript
台词规则：从剧本原文中逐字提取台词，格式"台词..."(表演方式)。禁止编造台词。无台词标注(无台词)或描写非语言声效。\n${hardRules}`
```
替换为:
```typescript
台词规则：从剧本原文中逐字提取台词，格式"台词..."(表演方式)。禁止编造台词。无台词标注(无台词)或描写非语言声效。\n${buildRulesForPass('shot', skills, { retryFeedback: state.retryFeedback, previousShots: state.previousShots, characters: state.characters })}`
```

**Step 5: 替换 verifyConsistency 中的 hardRules**

将 `verifyConsistency` 函数中的:
```typescript
输出连续性锚点、节奏总结和评分(1-10)。如发现角色名或台词与剧本不符，评分不超过5。\n${hardRules}`
```
替换为:
```typescript
输出连续性锚点、节奏总结和评分(1-10)。如发现角色名或台词与剧本不符，评分不超过5。\n${buildRulesForPass('verify', skills)}`
```

**Step 6: 验证**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit`
Expected: 无关于 hardRules 的错误

**Step 7: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "refactor: replace hardRules with modular buildRulesForPass in all 4 nodes"
```

---

### Task 5: 修改 prepareRetry 保存 previousShots

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts`

**Step 1: 修改 prepareRetry 函数**

将当前的 `prepareRetry` 函数:

```typescript
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
```

替换为:

```typescript
    function prepareRetry(state: typeof PipelineState.State) {
      const feedback = state.report?.issues
        ?.map(i => `[${i.shotId}] ${i.field}: ${i.problem} → ${i.suggestion}`)
        .join('\n') || ''

      const previousShots = state.shots?.map(s => ({ id: s.id, desc: s.desc })) || null

      return {
        retryFeedback: feedback,
        retryCount: state.retryCount + 1,
        previousShots,
        shots: null,
        report: null
      }
    }
```

**Step 2: 验证**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit`
Expected: 编译通过

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
git commit -m "feat: save previousShots in prepareRetry for continuity lock"
```

---

### Task 6: 修复 sanitizer.ts SM 词边界 bug

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/sanitizer.ts:38`

**Step 1: 修复正则表达式**

将第 38 行:
```typescript
  { pattern: /SM|虐待/g, safe: '权力交换' },
```
替换为:
```typescript
  { pattern: /\bSM\b|虐待/g, safe: '权力交换' },
```

**Step 2: 验证**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx tsc --noEmit`
Expected: 编译通过

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/sanitizer.ts
git commit -m "fix: add word boundary to SM regex to prevent false matches"
```

---

### Task 7: 创建外部 AI Skill — SKILL.md

**Files:**
- Create: `.cursor/skills/storyboard-prompt-engineering/SKILL.md`

**Step 1: 创建 SKILL.md**

```markdown
---
name: storyboard-prompt-engineering
description: >
  AI video storyboard prompt engineering toolkit for multi-pass LLM pipelines.
  Use when: optimizing prompts for video generation (Kling/Jimeng/Seedance),
  implementing filter bypass/dodge layers for sensitive content,
  adding continuity lock for cross-shot consistency in retries,
  modularizing prompt rules into composable PromptSkill modules,
  or building 4-pass storyboard pipelines with LangGraph.
  Triggers: "dodge layer", "filter bypass", "continuity lock",
  "prompt modular", "storyboard pipeline", "分镜提示词".
metadata:
  version: "1.0"
  author: tecx
---

# Storyboard Prompt Engineering

Multi-pass LLM pipeline prompt 工程工具包，用于 AI 视频分镜生产。

## Quick Reference

| 模块 | 功能 | 参考文档 |
|------|------|---------|
| PromptSkill 系统 | 可组合的 prompt 规则模块 | `references/modular-rules.md` |
| Dodge Layer | 过滤器绕过/艺术化回避 | `references/dodge-patterns.md` |
| Continuity Lock | 重试时跨镜头一致性锁定 | `references/continuity-lock.md` |

## Architecture

```
Pipeline (LangGraph StateGraph)
├── Pass 1: Scene Analysis     ← core + style + dodge
├── Pass 2: Character Extract  ← core + physics + dodge
├── Pass 3: Shot Generation    ← core + dialogue + physics + dodge + continuity*
├── Pass 4: Verify Consistency ← core + dialogue + dodge
└── Retry Loop (if score < 10) ← prepareRetry saves previousShots → continuity activates
```

*continuity skill 仅在 retry 时激活（state.retryFeedback 非空）

## PromptSkill Interface

```typescript
type PassType = 'scene' | 'character' | 'shot' | 'verify'

interface PromptSkill {
  id: string
  rules: string | ((state: PipelineStateSlice) => string)
  appliesTo: PassType[]
  priority: number  // lower = earlier in prompt
}
```

## 6 Built-in Skills

| id | type | appliesTo | priority |
|----|------|-----------|----------|
| core | static | all | 0 |
| dialogue | static | shot, verify | 10 |
| physics | static | character, shot | 10 |
| style | static | scene | 10 |
| dodge | static | all | 20 |
| continuity | dynamic | shot | 30 |

## Key Patterns

### 1. Dodge Layer (双层防护)

**LLM 层**: system prompt 中注入 D1-D8 规则，引导模型生成安全文本
**后处理层**: `sanitizer.ts` 执行正则替换 + 回避层修饰注入

详见 `references/dodge-patterns.md`

### 2. Continuity Lock (重试锁定)

当 verify 评分 < 10 触发 retry 时:
1. `prepareRetry` 保存当前 shots 为 `previousShots: { id, desc }[]`
2. `buildContinuityLock(state)` 动态生成锁定规则
3. 未被 feedback 提及的镜头强制原样保留

详见 `references/continuity-lock.md`

### 3. 模块化组合

```typescript
buildRulesForPass('shot', skills, state)
// → filter by appliesTo → sort by priority → resolve dynamic rules → join
```

详见 `references/modular-rules.md`

## Usage

### 添加自定义 Skill

```typescript
const customSkill: PromptSkill = {
  id: 'horror',
  rules: `Horror Rules:\n- Emphasize shadow depth > 85%\n- Sound: low-frequency drone + sudden silence`,
  appliesTo: ['scene', 'shot'],
  priority: 15
}

const service = new StoryboardPipelineService(config, [...BUILTIN_SKILLS, customSkill])
```

### 禁用某个 Skill

```typescript
const skills = BUILTIN_SKILLS.filter(s => s.id !== 'dodge')
const service = new StoryboardPipelineService(config, skills)
```
```

**Step 2: Commit**

```bash
git add .cursor/skills/storyboard-prompt-engineering/SKILL.md
git commit -m "feat: add storyboard-prompt-engineering external AI skill"
```

---

### Task 8: 创建外部 AI Skill — references 文档

**Files:**
- Create: `.cursor/skills/storyboard-prompt-engineering/references/dodge-patterns.md`
- Create: `.cursor/skills/storyboard-prompt-engineering/references/continuity-lock.md`
- Create: `.cursor/skills/storyboard-prompt-engineering/references/modular-rules.md`

**Step 1: 创建 dodge-patterns.md**

```markdown
# Dodge Patterns Reference

## D1-D8 规则详解

| Rule | 禁止 | 替换为 | 示例 |
|------|------|--------|------|
| D1 | 解剖学术语 | contour/silhouette/curvature | 胸部 → 曲线 |
| D2 | 显式动作动词 | rhythmic pulsing/deep connection | 插入 → 深度连接 |
| D3 | 生物学描述 | 物理参数(压力/速度/振幅) | |
| D4 | 体液描述 | glistening sheen/oil texture | 体液 → 光泽质感 |
| D5 | 暴力伤害 | 力向量(impact N/compression cm) | |
| D6 | 裸露 | shadow contour/fabric slipping | |
| D7 | 显式声音 | breathless gasp/vocal tremor | 呻吟 → 气息急促 |
| D8 | 敏感区域 | shadow/DOF blur/fabric/steam | |

## 后处理替换表

### 中文替换

| 危险词 | 安全替换 |
|--------|---------|
| 性交/做爱/交合 | 亲密交融 |
| 插入/进入体内 | 深度连接 |
| 抽插/抽送/冲撞 | 律动起伏 |
| 射精/射了/高潮 | 颤栗释放 |
| 裸体/全裸/赤裸 | 肌肤裸露 |
| 强奸/强暴 | 强制压制 |
| SM/虐待 | 权力交换 |

### English 替换

| Pattern | Safe |
|---------|------|
| fucking/sex/intercourse | intimacy |
| thrusting/pounding | rhythmic pulsing |
| penetrate/insert | deep connection |
| cum/ejaculate/orgasm | shuddering release |
| naked/nude | bare skin |

## 回避层修饰 (DODGE_LAYERS)

当检测到亲密/暴力信号时，自动附加:

```typescript
const DODGE_LAYERS = {
  MOTION_BLUR: 'motion blur on intimate zone, soft mist overlay',
  SHADOW_VEIL: 'artistic deep shadows obscuring contact, chiaroscuro low-key lighting',
  FABRIC_DISSOLVE: 'sheer fabric dissolve artistically, clothing silhouette implication',
  STEAM_FOG: 'atmospheric steam/fog diffusion covering lower body',
  DEPTH_BLUR: 'extreme shallow DOF f/1.2, bokeh dissolve on sensitive area',
  LIGHT_FLARE: 'volumetric light flare washing out explicit detail, lens bloom'
}
```
```

**Step 2: 创建 continuity-lock.md**

```markdown
# Continuity Lock Reference

## 触发条件

Continuity Lock 在以下条件下激活:
1. `state.retryFeedback` 非空（verify 评分 < 10 触发了 retry）
2. `state.previousShots` 非空（prepareRetry 已保存上轮镜头）

## 工作机制

### prepareRetry 阶段

```typescript
const previousShots = state.shots?.map(s => ({ id: s.id, desc: s.desc })) || null
```

只保存 `{ id, desc }` 以控制 token 预算（完整 ShotData 包含 act/fx/motive，重试时不需要）。

### buildContinuityLock 动态规则

```typescript
function buildContinuityLock(state: PipelineStateSlice): string {
  if (!state.retryFeedback || !state.previousShots) return ''

  const shotSummary = state.previousShots
    .map(s => `${s.id}: ${s.desc}`)
    .join('\n')

  const anchors = state.characters
    ?.map(c => `[${c.n}] ${c.t}`)
    .join('; ') || ''

  return `CONTINUITY LOCK (严格遵守):
以下为上一轮生成的参考帧...
角色锚点锁定: ${anchors}
参考帧:
${shotSummary}
规则: 未被 retryFeedback 提及的镜头 → 原样保留，禁止修改。`
}
```

### 关键约束

- 未被 feedback 提及的镜头 **禁止修改**
- 角色锚点（发色/伤疤/服装纹理/道具）跨重试 **锁定不变**
- 仅修正 verify 指出的具体问题

## Token 预算分析

| 数据 | 估算 tokens | 说明 |
|------|------------|------|
| 9 个镜头 `{ id, desc }` | ~800 | 5 段式 desc 平均 80 tokens |
| 角色锚点 4 人 | ~200 | `[name] anchor` 格式 |
| 锁定指令模板 | ~100 | 固定文本 |
| **合计** | **~1100** | 占 8192 max tokens 的 ~13% |
```

**Step 3: 创建 modular-rules.md**

```markdown
# Modular Rules Reference

## buildRulesForPass 机制

```typescript
function buildRulesForPass(
  pass: PassType,
  skills: PromptSkill[],
  state?: PipelineStateSlice
): string {
  return skills
    .filter(s => s.appliesTo.includes(pass))  // 按 Pass 过滤
    .sort((a, b) => a.priority - b.priority)   // 按优先级排序
    .map(s => typeof s.rules === 'function'    // 解析动态规则
      ? s.rules(state || {})
      : s.rules)
    .join('\n\n')                               // 双换行拼接
}
```

## 各 Pass 规则组合

| Pass | Skills 组合 | 估算规则行数 |
|------|------------|-------------|
| scene | core(7) + style(3) + dodge(8) | ~18 |
| character | core(7) + physics(3) + dodge(8) | ~18 |
| shot | core(7) + dialogue(2) + physics(3) + dodge(8) + continuity*(~15) | ~20-35 |
| verify | core(7) + dialogue(2) + dodge(8) | ~17 |

*continuity 仅在 retry 时有内容

## 自定义 Skill 开发

### 接口

```typescript
interface PromptSkill {
  id: string                                        // 唯一标识
  rules: string | ((state: PipelineStateSlice) => string)  // 静态或动态
  appliesTo: PassType[]                             // 适用的 Pass
  priority: number                                   // 越小越靠前
}
```

### 最佳实践

1. **id**: 使用 kebab-case，如 `horror-style`
2. **rules**: 静态规则用字符串，需要 state 数据时用函数
3. **appliesTo**: 最小范围原则，只注入真正需要的 Pass
4. **priority**: 0-9 核心, 10-19 领域, 20-29 安全, 30+ 上下文

### 示例: 添加恐怖风格 Skill

```typescript
const horrorSkill: PromptSkill = {
  id: 'horror',
  rules: `Horror Rules:
- Shadow depth > 85% of frame
- Sound: low-frequency drone 30-50Hz + sudden silence gaps
- Color: desaturated palette, single accent color (blood red or toxic green)
- Motion: slow dolly / static locked → sudden whip-pan`,
  appliesTo: ['scene', 'shot'],
  priority: 15
}
```
```

**Step 4: Commit**

```bash
git add .cursor/skills/storyboard-prompt-engineering/references/
git commit -m "docs: add dodge-patterns, continuity-lock, modular-rules references"
```

---

### Task 9: 创建外部 AI Skill — 代码模板

**Files:**
- Create: `.cursor/skills/storyboard-prompt-engineering/templates/prompt-skill-template.ts`

**Step 1: 创建模板**

```typescript
/**
 * PromptSkill Template
 *
 * Copy this file and modify to create a custom prompt skill.
 * Then pass it to StoryboardPipelineService constructor:
 *
 *   import { BUILTIN_SKILLS } from './prompt-skills'
 *   const service = new StoryboardPipelineService(config, [...BUILTIN_SKILLS, mySkill])
 */

import type { PromptSkill, PipelineStateSlice, PassType } from './prompt-skills'

// Static skill example
export const myStaticSkill: PromptSkill = {
  id: 'my-static-skill',
  rules: `My Custom Rules:
- Rule 1: description
- Rule 2: description`,
  appliesTo: ['scene', 'shot'] satisfies PassType[],
  priority: 15,
}

// Dynamic skill example (has access to pipeline state)
export const myDynamicSkill: PromptSkill = {
  id: 'my-dynamic-skill',
  rules: (state: PipelineStateSlice) => {
    if (!state.characters) return ''
    const names = state.characters.map(c => c.n).join(', ')
    return `Character-aware rules for: ${names}`
  },
  appliesTo: ['shot'],
  priority: 25,
}
```

**Step 2: Commit**

```bash
git add .cursor/skills/storyboard-prompt-engineering/templates/
git commit -m "feat: add prompt-skill-template.ts for custom skill development"
```

---

### Task 10: 全量构建验证

**Files:**
- 无新增修改，仅验证

**Step 1: 运行 TypeScript 编译**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npm run build:vite`
Expected: 构建成功，无新增错误

**Step 2: 检查最终文件结构**

Run: `find src/renderer/src/services/storyboard-pipeline/ -name "*.ts" | sort`
Expected:
```
src/renderer/src/services/storyboard-pipeline/aggregate.ts
src/renderer/src/services/storyboard-pipeline/prompt-skills.ts   ← NEW
src/renderer/src/services/storyboard-pipeline/sanitizer.ts
src/renderer/src/services/storyboard-pipeline/schemas.ts
src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService.ts
```

**Step 3: 检查 skill 文件结构**

Run: `find .cursor/skills/storyboard-prompt-engineering/ -type f | sort`
Expected:
```
.cursor/skills/storyboard-prompt-engineering/SKILL.md
.cursor/skills/storyboard-prompt-engineering/references/continuity-lock.md
.cursor/skills/storyboard-prompt-engineering/references/dodge-patterns.md
.cursor/skills/storyboard-prompt-engineering/references/modular-rules.md
.cursor/skills/storyboard-prompt-engineering/templates/prompt-skill-template.ts
```

**Step 4: Final commit**

```bash
git add -A
git commit -m "chore: prompt skill system implementation complete"
```

---

## Summary

| Task | 描述 | 文件 | 估算时间 |
|------|------|------|---------|
| 1 | 新建 prompt-skills.ts | 1 create | 5 min |
| 2 | schemas.ts 添加 PreviousShot | 1 modify | 2 min |
| 3 | Service 构造函数 + State | 1 modify | 5 min |
| 4 | 替换 hardRules | 1 modify | 5 min |
| 5 | prepareRetry 保存 previousShots | 1 modify | 3 min |
| 6 | sanitizer SM bug fix | 1 modify | 2 min |
| 7 | 外部 Skill SKILL.md | 1 create | 5 min |
| 8 | 外部 Skill references | 3 create | 5 min |
| 9 | 外部 Skill template | 1 create | 3 min |
| 10 | 全量构建验证 | 0 | 3 min |
| **Total** | | **5 create + 3 modify** | **~38 min** |
