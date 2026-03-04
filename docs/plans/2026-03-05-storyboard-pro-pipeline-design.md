# StoryboardPro Pipeline v2 — Design Document

**Date:** 2026-03-05
**Status:** Approved
**Problem:** `StoryboardPipelineService` 源码缺失（只有 dist 编译产物），现有 `LangChainStoryboardService` 是单次 LLM 调用，存在输出质量不稳定、无校验、多图跨图关联弱、无进度反馈四个问题。

---

## 1. Architecture

全新独立 LangGraph Pipeline，继承 `BasePipeline`，复用已验证的模式（skill 系统、L1/L2/L3 错误恢复、codeVerify、progress event）。

```
START → selectSkills
  → sceneDecompose ∥ characterExtract (并行, Pass 1+2)
  → validateAnalysis (fan-in)
  → shotDesign (Pass 3)
  → codeVerify (instant, Pass 4)
    → score >= threshold → END (输出 StoryboardResponse)
    → score < threshold → deepVerify (LLM text-only) → [retry shotDesign | END]
```

### 与 DirectorPipeline 的区别

| 维度 | DirectorPipeline | StoryboardProPipeline |
|------|------------------|----------------------|
| 目的 | 从参考图生成新图 | 从图片反推分镜描述 |
| 输出 | 生成的图片 URL | StoryboardResponse JSON |
| 最终 Pass | generateImages (调 API 生图) | 无生图，输出 JSON |
| Schema | DesignAndAssembleSchema | StoryboardResponseSchema (13维) |
| 基类 | BasePipeline | BasePipeline (共享) |

---

## 2. File Structure

```
src/renderer/src/services/storyboard-pipeline/
  StoryboardProPipeline.ts      ← 主 Pipeline
  storyboard-verify.ts          ← codeVerify for storyboard
  storyboard-prompt-loader.ts   ← storyboard-specific prompt/skill loader
  __tests__/
    storyboard-verify.test.ts
    storyboard-pipeline.test.ts

config/prompts/storyboard/
  pass1-scene-decompose.md
  pass2-character-extract.md
  pass3-shot-design.md
  pass4-verify.md
```

---

## 3. State Schema

```typescript
const storyboardStateSchema = z.object({
  scene: StoryboardSceneSchema.nullable().default(null),
  objs: z.array(StoryboardObjSchema).default([]),
  seq: z.array(z.object({
    id: z.string(), desc: z.string(),
    act: z.string().optional(), fx: z.nullable(z.string()).optional(),
    motive: z.string().optional(), audio: z.string().optional(),
  })).default([]),
  cont: z.string().default(''),
  notes: z.string().default(''),
  retryCount: z.number().default(0),
  analysisRetryCount: z.number().default(0),
  retryFeedback: z.string().default(''),
  report: VerifySchema.nullable().default(null),
  inputImages: z.array(z.object({ data: z.string(), mimeType: z.string() })).default([]),
  rolePrompt: z.string().default(''),
  context: z.string().default(''),
  activeSkills: z.array(z.string()).default([]),
})
```

---

## 4. Integration

`ServiceBridge.ts` 中 `getStoryboardPipelineService` 的 import 路径指向新文件：

```typescript
const { StoryboardProPipeline } = await import('./storyboard-pipeline/StoryboardProPipeline')
_pipelineInstance = new StoryboardProPipeline({ apiKey, baseURL, model })
```

`analyze()` 方法签名保持与旧实现兼容：

```typescript
async analyze(
  images: ImageInput[],
  options: { rolePrompt: string; context?: string },
  onProgress?: (progress: PipelineProgress) => void,
): Promise<StoryboardResponse>
```

`UnderstandPage.ts` 调用代码零修改。

---

## 5. Prompt Templates

### pass1-scene-decompose.md
从图片提取 `StoryboardSceneSchema`：叙事弧线、环境、timeline、声画对位。

### pass2-character-extract.md
从图片提取 `StoryboardObjSchema[]`：角色外观/动机/空间/物理/锚点/运动。

### pass3-shot-design.md
基于 scene + objs + 图片，组装镜头序列 `seq[]` + 跨镜头连续性 `cont` + 校验笔记 `notes`。

### pass4-verify.md
LLM 深度校验（text-only），检查跨镜头一致性、角色锚点连贯性、时间轴节奏。

---

## 6. Skill Integration

Skills 从 `skills/storyboard-*/SKILL.md` 加载，`appliesTo` 映射到新 Pipeline 的 pass name：
- `storyboard-structure` → sceneDecompose, shotDesign
- `storyboard-visual` → sceneDecompose, shotDesign
- `storyboard-dialogue` → shotDesign, deepVerify
- `storyboard-physics` → characterExtract
- `storyboard-audio` → shotDesign
- `storyboard-style` → sceneDecompose
- `storyboard-dodge` → shotDesign

注意：当前 skills 的 `appliesTo` 使用导演模式的 pass name（analyzeScene, designAndAssemble 等），需要更新为分镜 Pipeline 的 pass name，或在 prompt-loader 中做映射。
