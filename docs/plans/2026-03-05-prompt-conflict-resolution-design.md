# Prompt-Image Conflict Resolution — Design Document

**Date:** 2026-03-05
**Status:** Approved
**Problem:** 多模态生图调用（Gemini Native 等）中，参考图与 prompt 文本产生冲突，模型不知道该从图中学什么、该听文字哪部分，导致生成结果偏离用户意图。

---

## 1. Problem Analysis

### 1.1 Root Cause

Gemini Native API 的 `parts` 数组中，参考图（`inline_data`）和文本 prompt 并列发送。模型同时看到两者，但缺乏**角色边界**——不知道该从图中提取什么（身份？风格？构图？全部？），也不知道文字和图的优先级。

### 1.2 Current Prompt Structure

```
[1] Grid geometry rules (STRICT GRID...)
[2] Character identity section
[3] Style directive section (Template prefix/suffix)
[4] Style anchor section (from extractStyleAnchor)
[5] Panel descriptions
```

问题：
- 风格指令被埋在中间，不够显眼
- "MATCH the visual style of the reference images exactly" 与用户 Template 可能矛盾
- 每个 panel prompt 由 LLM 生成，可能遗漏风格 token
- negativePrompt 是通用的，不根据 Template 排斥冲突风格

### 1.3 Constraint

**零额外 LLM 调用** — 所有优化必须在现有 pass 内完成，通过修改 prompt 模板和代码级 prompt 后处理。

---

## 2. Design

### 2.1 Component A: Reference Image Role Separation

在 compositePrompt 中显式定义参考图的角色边界。

新增模板变量 `{{reference_image_role_rules}}`：

```
REFERENCE IMAGE USAGE RULES (BINDING):
- From reference images, extract ONLY:
  ✅ Character identity: face structure, hairstyle, body proportions, outfit details
  ✅ Character props: weapons, accessories, distinctive items
  ✅ Scene spatial layout (if applicable to the story)
- From reference images, DO NOT extract:
  ❌ Rendering medium or art style (follow TEXT directive instead)
  ❌ Color grading or palette (follow style anchor instead)
  ❌ Lighting setup (follow panel-specific lighting in prompts)
- If reference images conflict with the text style directive:
  → TEXT WINS. Always. No exceptions.
```

**生成逻辑**：`extractVarsForContactSheet()` 新增 `reference_image_role_rules` 变量。当用户选了 Template 时，生成上述规则。无 Template 时使用宽松版本（允许从图中提取风格）。

### 2.2 Component B: Prompt Structure Inversion

将 compositePrompt 结构从当前顺序反转为**风格优先**：

```
[1] STYLE CONTRACT (NON-NEGOTIABLE) ← 新的最高优先级
[2] REFERENCE IMAGE USAGE RULES ← Component A
[3] Grid geometry rules
[4] Character identity section
[5] Panel descriptions (each with injected style prefix)
```

关键改动：

**B1: 模板结构反转**

修改 `pass6-contact-sheet.md` 将风格相关内容前置。

**B2: Panel Prompt 风格 Token 注入**

在 `generateImagesFn` 中，代码级为每个 panel prompt 前置风格标签：

```typescript
function resolveStylePrefix(
  styleAnchor: StyleAnchor | null,
  templateKey: string,
  styleInstructions: string,
): string {
  if (styleAnchor?.medium) {
    return styleAnchor.medium
  }
  // 从 Template 推断 medium
  const TEMPLATE_MEDIUM_MAP: Record<string, string> = {
    cinematic: 'photorealistic, cinematic photography',
    movie: 'cinematic film still',
    anime: 'anime screencap, TV anime',
    manga: 'manga panel, black and white',
    theatrical: 'theatrical anime film screenshot',
    webtoon: 'webtoon style, full color',
    comic: 'american comic style',
    illustration: 'detailed illustration',
  }
  return TEMPLATE_MEDIUM_MAP[templateKey] || ''
}
```

在 compositePrompt 的 panel descriptions 中，每个 panel prompt 自动追加：

```typescript
const stylePrefix = resolveStylePrefix(state.styleAnchor, state.template, state.styleInstructions)
// 修改 extractVarsForContactSheet 中的 perShotSection
const enhancedPrompt = stylePrefix
  ? `${stylePrefix}, ${p.prompt}`
  : p.prompt
```

这确保即使 LLM 在 designAndAssemble 阶段忘记加风格 token，代码也会强制注入。

### 2.3 Component C: Adaptive Negative Prompt

根据 Template 和 StyleAnchor 自动生成针对性的 negativePrompt。

```typescript
const STYLE_EXCLUSION_MAP: Record<string, string[]> = {
  cinematic: ['anime', 'cartoon', 'illustration', 'cel shading', '2D', 'drawn', 'painting', 'sketch'],
  movie: ['anime', 'cartoon', 'illustration', 'cel shading', '2D', 'drawn', 'painting'],
  anime: ['photorealistic', 'real person', 'photograph', 'live-action', '3D render', 'CGI'],
  theatrical: ['photorealistic', 'real person', 'photograph', 'live-action', '3D render'],
  manga: ['photorealistic', 'real person', 'color', '3D render', 'anime coloring'],
  webtoon: ['photorealistic', 'real person', 'black and white', 'monochrome', '3D render'],
  comic: ['photorealistic', 'real person', 'anime', 'soft shading', '3D render'],
  illustration: ['photorealistic', 'real person', 'anime screencap', '3D render'],
}

function buildAdaptiveNegativePrompt(
  baseNegative: string,
  templateKey: string,
  styleAnchor: StyleAnchor | null,
): string {
  const exclusions = STYLE_EXCLUSION_MAP[templateKey] || []
  const existing = baseNegative.split(',').map(s => s.trim().toLowerCase())
  const newTerms = exclusions.filter(e => !existing.includes(e.toLowerCase()))
  if (newTerms.length === 0) return baseNegative
  return `${baseNegative}, ${newTerms.join(', ')}`
}
```

在 `generateImagesFn` 和 `regenerateImages` 中，替换 negativePrompt 构建逻辑。

---

## 3. Affected Files

| 文件 | 改动 |
|------|------|
| `config/prompts/director/pass6-contact-sheet.md` | 结构反转 + 新增 `{{reference_image_role_rules}}` 占位符 |
| `src/renderer/src/services/pipeline/DirectorPipeline.ts` | `extractVarsForContactSheet()` 新增变量 + `generateImagesFn` / `regenerateImages` negativePrompt 增强 + panel prompt 风格注入 |
| `skills/director-style-consistency/SKILL.md` | 补充图文冲突解决规则（如已创建） |

---

## 4. Data Flow

```
User Input:
  ├── referenceImages[] (anime character images)
  ├── currentTemplate = "cinematic" → "photorealistic, 8K..."
  └── sceneDescription = "赛博朋克雨夜追逐"

Pipeline (existing passes, no new LLM calls):
  extractStyleAnchor → styleAnchor = { medium: "photorealistic", ... }
  
  generateImages:
    1. resolveStylePrefix("cinematic") → "photorealistic, cinematic photography"
    2. buildAdaptiveNegativePrompt(base, "cinematic") → base + "anime, cartoon, illustration..."
    3. compositePrompt structure:
       [STYLE CONTRACT: photorealistic, non-negotiable]
       [REFERENCE IMAGE RULES: identity only, no style]
       [Grid: 2x3, 16:9]
       [Characters: ...]
       [Panel 1: photorealistic, cinematic photography, ...]
       [Panel 2: photorealistic, cinematic photography, ...]
    4. negativePrompt: "blurry... + anime, cartoon, illustration, cel shading..."

  → Gemini sees: "use photorealistic" (text, top priority)
                + anime reference images (for identity only)
                + negative: "anime, cartoon" (reinforcement)
  → Result: photorealistic images with correct character identity
```

---

## 5. Error Handling

- **No Template selected**: 不生成 role separation 严格版，使用宽松版 "Follow the visual style of the reference images"
- **No styleAnchor**: `resolveStylePrefix` 回退到 Template medium map
- **No Template + No styleAnchor**: 不注入任何风格前缀，行为与当前一致
- **Unknown Template key**: `STYLE_EXCLUSION_MAP` 返回空数组，negativePrompt 不变

---

## 6. Scope

**In scope:**
- compositePrompt 结构反转
- reference image role rules 注入
- panel prompt 风格 token 代码级注入
- adaptive negativePrompt
- 更新 director-style-consistency skill

**Not in scope:**
- 新增 LLM 调用节点
- UI 变更
- API 层修改
