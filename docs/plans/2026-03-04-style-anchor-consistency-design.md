# Style Anchor Extraction & User Intent Priority — Design Document

**Date:** 2026-03-04
**Status:** Approved
**Problem:** 导演模式 Pipeline 生成的多张图 / Contact Sheet 内部面板之间风格不统一；用户意图（Template / sceneDescription）与 LLM 对参考图的分析产生冲突，LLM 可能覆盖用户的风格选择。

---

## 1. Problem Analysis

### 1.1 Root Cause

当前 Pipeline 缺乏 **结构化的风格锚点** 和 **明确的优先级仲裁**：

1. `analyzeScene` 提取的 `style` 字段是自由文本，下游无法强约束
2. `designAndAssemble` 的 `CRITICAL STYLE RULE` 要求 "MUST match reference images EXACTLY"，这让参考图风格优先级高于用户 Template 选择
3. `verifyConsistency` 的 4 个校验维度中没有 "风格一致性"
4. 每次 `generateImage` 调用都有随机性，同批次多张图之间缺乏风格锚定

### 1.2 Conflict Scenarios

| 场景 | 用户意图 | LLM 分析 | 结果 |
|------|----------|----------|------|
| 用户选了 "影院级写实" Template，上传了 anime 参考图 | photorealistic | anime cel | 冲突 → LLM 可能选择 anime |
| 用户选了 "日式动画" Template，写了 "赛博朋克场景" | anime + cyberpunk | anime | 部分对齐，但可能丢失 cyberpunk 色调 |
| 用户没选 Template，只上传了参考图 | 无显式风格 | 从图分析 | 应以图为准 |

### 1.3 Research References

- **ConsiStyle (2025)** — 风格与内容解耦，训练免调的一致性方法
- **Story2Board (2025)** — Latent Panel Anchoring 跨面板一致性
- **SLD (Self-correcting LLM-controlled Diffusion)** — LLM 评估 → 闭环自修正
- **PRIS (2025)** — 推理时根据视觉反馈迭代修正 prompt
- **LangGraph Evaluator-Optimizer Pattern** — 生成 → 评估 → 反馈循环最佳实践

---

## 2. Design

### 2.1 Architecture Overview

```
START → selectSkills ─┬→ analyzeScene ──────────┐
                      ├→ extractStyleAnchor ─────┤ (NEW, parallel)
                      └→ extractCharacterAnchors ┘
                              ↓
                      validateAnalysis
                              ↓
                      designAndAssemble  ← 注入 styleAnchor + 用户意图优先链
                              ↓
                      verifyConsistency  ← 新增 "风格一致性" 维度
                              ↓
                      generateImages    ← compositePrompt 包含 styleAnchor
                              ↓
                             END
```

`extractStyleAnchor` 与 `analyzeScene` / `extractCharacterAnchors` **并行执行**，不增加延迟。

### 2.2 Style Anchor Schema

```typescript
const StyleAnchorSchema = z.object({
  medium: z.string().describe('Rendering medium: photorealistic, anime cel, 3D CGI, watercolor, etc.'),
  palette: z.array(z.string()).describe('Dominant color hex codes, 2-5 colors'),
  paletteRatio: z.string().describe('Color ratio, e.g. "7:2:1"'),
  lightSource: z.string().describe('Light type + angle + intensity, e.g. "rim light, 45° top-left, 70%"'),
  shadowDepth: z.string().describe('% of frame in shadow'),
  texture: z.string().describe('Surface quality: film grain, cel shading, painterly strokes, etc.'),
  colorTemperature: z.string().describe('Warm/cool + Kelvin estimate'),
  contrastLevel: z.string().describe('Contrast description: high/medium/low'),
})
```

### 2.3 User Intent Priority Chain

**三层优先级（高覆盖低）：**

```
Priority 1: USER EXPLICIT  → Template prefix/suffix + negativePrompt
Priority 2: USER NARRATIVE  → sceneDescription 中的风格相关词
Priority 3: IMAGE ANALYSIS  → extractStyleAnchor 从参考图提取
```

**合并规则：**
- 如果用户选了 Template（`currentTemplate !== null`），Template 的 `medium` 定义无条件优先
- sceneDescription 中检测到风格词（如 "watercolor", "cyberpunk neon"）→ 覆盖 IMAGE ANALYSIS 的对应字段
- 无冲突的字段从 IMAGE ANALYSIS 补充
- 冲突记录到 `styleAnchor.conflicts[]`，下游可见

### 2.4 extractStyleAnchor Node

**输入：** 参考图 + Template 信息 + sceneDescription
**输出：** `{ styleAnchor: StyleAnchorSchema, conflicts: ConflictEntry[] }`

System prompt:

```
You are a visual style analyst. Extract the VISUAL STYLE (not content) from the reference images.

Output the style anchor as structured data covering: medium, palette, light, shadow, texture, color temperature, contrast.

IMPORTANT — User Style Authority:
The user has selected template: "{templateName}" with style directive: "{styleDirective}".
{userSceneDescription ? "The user also described: " + userSceneDescription : ""}

If the reference images show a DIFFERENT medium/style than what the user selected:
- Report the conflict in the "conflicts" field
- The final "medium" and related fields MUST reflect the USER'S choice, NOT the reference image
- Use the reference image ONLY for fields the user did NOT explicitly specify (palette, lightSource, shadowDepth, etc.)
```

### 2.5 designAndAssemble Modification

在现有 system prompt 中替换 `CRITICAL STYLE RULE` 为：

```
## Style Authority Chain (BINDING)

The following style directives are in strict priority order:

1. USER EXPLICIT STYLE: {resolvedStyleDirective}
   Fields locked by user: {userLockedFields}
   → These are NON-NEGOTIABLE. Do NOT override with reference image analysis.

2. STYLE ANCHOR (from reference analysis): {styleAnchorSummary}
   → Use these for fields NOT covered by user explicit style.

3. CONFLICTS RESOLVED:
   {conflictsLog}

EVERY panel prompt MUST include:
- Medium: {styleAnchor.medium}
- Palette reference: {styleAnchor.palette}
- Lighting: {styleAnchor.lightSource}
- Texture: {styleAnchor.texture}

These style tokens must appear in EVERY panel prompt to ensure cross-panel consistency.
```

### 2.6 verifyConsistency Modification

新增第 5 个校验维度：

```markdown
### 5. Style Consistency
- All panels must share the same rendering medium (all photorealistic OR all anime, never mixed)
- Color temperature must not shift between panels unless motivated by time-of-day change
- Texture quality (film grain, cel shading, etc.) must remain uniform
- Flag if any panel prompt uses style keywords contradicting the style anchor
- Deduct 3 points per medium mismatch, 1 point per color temperature drift
```

### 2.7 generateImages Modification

`extractVarsForContactSheet()` 输出新增 `style_anchor_section` 变量，注入到 compositePrompt：

```
STYLE ANCHOR (apply to ALL panels uniformly):
Medium: {styleAnchor.medium}
Palette: {styleAnchor.palette} at ratio {styleAnchor.paletteRatio}
Lighting: {styleAnchor.lightSource}, shadow depth {styleAnchor.shadowDepth}
Texture: {styleAnchor.texture}
Color temperature: {styleAnchor.colorTemperature}
DO NOT deviate from this style in any panel.
```

### 2.8 State Schema Changes

```typescript
// 新增字段
styleAnchor: StyleAnchorSchema.nullable().default(null),
styleConflicts: z.array(z.object({
  field: z.string(),
  userWants: z.string(),
  imageShows: z.string(),
})).default([]),
```

### 2.9 Store Changes

不需要新增 UI 状态 — styleAnchor 是 Pipeline 内部计算的中间数据，用户通过现有的 Template 选择和 sceneDescription 来表达意图。

### 2.10 Skill Changes

新增一个 director skill: `director-style-consistency/SKILL.md`

```yaml
name: style-consistency
description: Use when extracting style anchors or verifying cross-panel style uniformity
appliesTo: [extractStyleAnchor, verifyConsistency, designAndAssemble]
priority: 1
```

---

## 3. Data Flow

```
User Input:
  ├── referenceImages[]
  ├── currentTemplate → "cinematic" → prefix: "photorealistic, 8K..."
  └── sceneDescription → "赛博朋克雨夜追逐"

Pipeline State Flow:
  extractStyleAnchor:
    IN:  referenceImages + template + sceneDescription
    OUT: styleAnchor = { medium: "photorealistic", palette: [...], ... }
         conflicts = [{ field: "medium", userWants: "photorealistic", imageShows: "anime" }]

  designAndAssemble:
    IN:  scene + characters + styleAnchor + conflicts
    OUT: panels + prompts (every prompt contains style tokens from styleAnchor)

  verifyConsistency:
    IN:  panels + prompts + styleAnchor
    OUT: report (includes style consistency score)
    → If style score < threshold → retry → designAndAssemble re-assembles with feedback

  generateImages:
    IN:  prompts + styleAnchor → compositePrompt with style anchor section
    OUT: images (style-consistent)
```

---

## 4. Error Handling

- **extractStyleAnchor fails:** Fallback to current behavior (no style anchor, use template prefix/suffix as-is)
- **No reference images:** Skip extractStyleAnchor, use only Template style
- **No Template selected:** Use extractStyleAnchor analysis as sole source
- **Both empty:** Use generic "Match reference image style" instruction (current default)

---

## 5. Testing Strategy

1. **Unit test:** StyleAnchor schema validation, conflict detection logic, priority merging
2. **Unit test:** shouldRetryAnalysis with style anchor skip flag
3. **Unit test:** extractVarsForDesignAndAssemble includes style authority chain
4. **Unit test:** verifyConsistency scoring includes style dimension
5. **Integration test:** Full pipeline with Template + conflicting reference images → verify user intent wins

---

## 6. Scope and Non-Goals

**In scope:**
- extractStyleAnchor node (parallel with Pass 1/2)
- Style authority chain in designAndAssemble
- Style consistency dimension in verifyConsistency
- Style anchor injection in generateImages prompt
- director-style-consistency skill

**Not in scope (future iterations):**
- Diffusion-level style anchoring (ConsiStyle / Story2Board approaches) — requires model-level changes
- Post-generation visual evaluation loop (方案 C) — too costly for v1
- UI for manual style anchor override — current Template + description is sufficient
