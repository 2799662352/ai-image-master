# 参考图像一致性强制令 (Reference Image Fidelity Mandate) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 在 DirectorPipeline 和 StoryboardProPipeline 所有 Pass 的系统提示词中注入统一的「参考图像一致性强制令」，要求 LLM 在分析、提取、设计、校验各阶段都严格以用户输入图像为唯一真相源。

**Architecture:** 新建一个共享的 `buildReferenceImageFidelityMandate()` 函数，按 Pass 类型生成三种强度的提示注入：analysis（分析阶段）、design（设计阶段）、verify（校验阶段）。通过修改 prompt 模板 (.md) 和 DirectorPipeline / StoryboardProPipeline 的 inline fallback 将其注入所有 Pass。

**Tech Stack:** TypeScript, Zod, Vitest, Markdown prompt templates

---

## 现状分析

| Pass | 当前有无参考图一致性要求 | 问题 |
|------|------------------------|------|
| Pass 1 场景分析 | 有弱引导: "Reference images define the visual foundation" (仅在有 sceneDescription 时) | 无 sceneDescription 时完全没有；且没有"禁止臆造"的强约束 |
| Pass 2 角色锚点 | 无 | 只说 "Extract from provided images"，没有 "MUST match exactly" |
| Pass 3 风格锚点 | 无 | 只说 "Focus on style attributes only" |
| Pass 4 分镜设计 | 有: `buildCharacterIdentityLock` + `buildReferenceImageRoleRules` | 最强，但仅在生成阶段；且不接收参考图（vision: false） |
| Pass 5 一致性校验 | 有校验维度但无参考图 | 只能文本校验，没法和原图对比 |
| Pass 6 图像生成 | 有: `reference_image_role_rules` | 已较完善 |
| StoryboardPro Pass 1/2 | 完全没有 | 零参考图一致性约束 |

---

### Task 1: 新建 `buildReferenceImageFidelityMandate` 共享函数

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (在 `buildCharacterIdentityLock` 附近插入)
- Test: `src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts`

**Step 1: Write the failing test**

在 `assembleCoherentPrompt.test.ts` 底部添加：

```typescript
import { buildReferenceImageFidelityMandate } from '../DirectorPipeline'

describe('buildReferenceImageFidelityMandate', () => {
  it('returns analysis-tier mandate for extraction passes', () => {
    const result = buildReferenceImageFidelityMandate('analysis')
    expect(result).toContain('REFERENCE IMAGE FIDELITY')
    expect(result).toContain('SINGLE SOURCE OF TRUTH')
    expect(result).toContain('DO NOT hallucinate')
  })

  it('returns design-tier mandate for design passes', () => {
    const result = buildReferenceImageFidelityMandate('design')
    expect(result).toContain('REFERENCE IMAGE FIDELITY')
    expect(result).toContain('MUST reproduce')
    expect(result).toContain('character appearance')
  })

  it('returns verify-tier mandate for verification passes', () => {
    const result = buildReferenceImageFidelityMandate('verify')
    expect(result).toContain('REFERENCE IMAGE FIDELITY')
    expect(result).toContain('ground truth')
    expect(result).toContain('deduction')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`

Expected: FAIL — `buildReferenceImageFidelityMandate` is not exported

**Step 3: Write minimal implementation**

在 `DirectorPipeline.ts` 中，`buildCharacterIdentityLock` 函数之前（约 line 117）插入：

```typescript
export function buildReferenceImageFidelityMandate(
  tier: 'analysis' | 'design' | 'verify',
): string {
  const header = '## REFERENCE IMAGE FIDELITY MANDATE (BINDING)'

  if (tier === 'analysis') {
    return [
      header,
      'The attached reference images are the SINGLE SOURCE OF TRUTH.',
      '- Describe ONLY what is visually present in the images.',
      '- DO NOT hallucinate, infer, or add features not visible in the reference.',
      '- If a detail is ambiguous or occluded, mark it as "(partially visible)" rather than guessing.',
      '- Character appearance MUST be extracted exactly as shown: hair color, eye color, outfit, accessories.',
      '- Environmental details MUST match the reference: lighting direction, color palette, spatial layout.',
    ].join('\n')
  }

  if (tier === 'design') {
    return [
      header,
      'The reference images are the SINGLE SOURCE OF TRUTH for all character and scene identity.',
      '- Every panel MUST reproduce character appearance exactly as shown in the reference images.',
      '- DO NOT alter: face structure, hairstyle, hair color, eye color, outfit design, signature accessories.',
      '- MAY vary: pose, expression, action, camera angle, lighting intensity (for dramatic effect).',
      '- If a character appears in the reference, their visual identity is LOCKED — no creative reinterpretation.',
      '- Scene elements visible in the reference (architecture, props, vegetation) MUST maintain visual continuity.',
    ].join('\n')
  }

  // tier === 'verify'
  return [
    header,
    'Verify all prompts against the reference images as ground truth.',
    '- Any character description that contradicts the reference image is a CRITICAL error (deduction: -3).',
    '- Hair color/style mismatch with reference: -2 per occurrence.',
    '- Outfit or accessory deviation from reference: -2 per occurrence.',
    '- Environmental element contradicting reference (e.g., indoor→outdoor): -2 per occurrence.',
    '- Style medium mismatch (e.g., photo reference but anime prompt): -3 per occurrence.',
    '- When in doubt, the reference image wins over any text description.',
  ].join('\n')
}
```

**Step 4: Run test to verify it passes**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`

Expected: PASS

**Step 5: Commit**

---

### Task 2: 注入 Analysis Mandate 到 Pass 1/2/3 prompt 模板

**Files:**
- Modify: `config/prompts/director/pass1-scene-analysis.md`
- Modify: `config/prompts/director/pass2-character-anchors.md`
- Modify: `config/prompts/storyboard/pass1-scene-decompose.md`
- Modify: `config/prompts/storyboard/pass2-character-extract.md`

**Step 1: 修改 pass1-scene-analysis.md**

在文件末尾（line 16 之后）追加：

```markdown

## REFERENCE IMAGE FIDELITY (BINDING)
The attached reference images are the SINGLE SOURCE OF TRUTH.
- Describe ONLY what is visually present. DO NOT hallucinate features not in the images.
- If a detail is ambiguous, mark it as "(partially visible)" rather than guessing.
- Character appearance, environmental details, and lighting MUST match the reference exactly.
```

**Step 2: 修改 pass2-character-anchors.md**

在文件末尾（line 18 之后）追加：

```markdown

## REFERENCE IMAGE FIDELITY (BINDING)
The attached reference images are the SINGLE SOURCE OF TRUTH for character appearance.
- Extract ONLY what is visually present. DO NOT hallucinate features not visible in the images.
- Hair color, eye color, outfit, accessories MUST be described exactly as shown — use precise color names, not vague terms.
- If a feature is occluded or ambiguous (e.g., character's back is turned), note "(not visible)" rather than guessing.
- Two different characters must have clearly distinguishable anchors — do not copy attributes between characters.
```

**Step 3: 修改 pass1-scene-decompose.md (StoryboardPro)**

在 `Focus on WHAT IS HAPPENING` 行之后追加：

```markdown

## REFERENCE IMAGE FIDELITY (BINDING)
The attached reference images are the SINGLE SOURCE OF TRUTH.
- Describe ONLY what is visually present. DO NOT add or infer content not shown in the images.
- Environmental details (lighting, colors, spatial layout) MUST match the reference exactly.
```

**Step 4: 修改 pass2-character-extract.md (StoryboardPro)**

在 `{{user_context}}` 行之后追加：

```markdown

## REFERENCE IMAGE FIDELITY (BINDING)
The attached reference images are the SINGLE SOURCE OF TRUTH for character appearance.
- Extract ONLY what is visually present. DO NOT hallucinate features not visible in the images.
- Cross-shot consistency anchor (t field) MUST be derived from actual visual features, not assumed ones.
```

**Step 5: Commit**

---

### Task 3: 注入 Analysis Mandate 到 Pass 1/2/3 inline fallback prompts

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (Pass 1, 2, 3 的 inline fallback 字符串)
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` (Pass 1, 2 的 inline fallback)

**Step 1: 修改 DirectorPipeline Pass 1 inline fallback**

在 `analyzeSceneFn` 中找到 inline fallback（约 line 1048）：

```
: 'You are an expert scene analyst. Analyze the provided images and describe the scene in structured detail.'
```

改为：

```typescript
: 'You are an expert scene analyst. Analyze the provided images and describe the scene in structured detail.\n\nREFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH. Describe ONLY what is visually present. DO NOT hallucinate features not in the images.'
```

**Step 2: 修改 DirectorPipeline Pass 2 inline fallback**

在 `extractCharacterAnchorsFn` 中找到 inline fallback（约 line 1131）：

```
: 'You are a character consistency expert. Extract character anchors from the provided images for image generation consistency.'
```

改为：

```typescript
: 'You are a character consistency expert. Extract character anchors from the provided images for image generation consistency.\n\nREFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH. Extract ONLY what is visually present. DO NOT hallucinate features not visible in the reference.'
```

**Step 3: 修改 DirectorPipeline Pass 1 user message (无 sceneDescription 情况)**

在 `analyzeSceneFn` 中找到（约 line 1066）：

```
: 'Analyze this image scene. Output in English first; optional concise Japanese support in parentheses.'
```

改为：

```typescript
: 'Analyze this image scene. The reference images are ground truth — describe only what is visible. Output in English first; optional concise Japanese support in parentheses.'
```

**Step 4: 修改 StoryboardProPipeline Pass 1 inline fallback**

在 `sceneDecomposeFn` 中找到 inline fallback（约 line 248）：

```
'You are a professional film storyboard analyst. Decompose the scene from the provided images. Output structured data covering: narrative arc (d), structured caption (cap), environment with lighting params (env), 4-layer sound design (bgm), and timeline with shots.'
```

追加：

```typescript
'You are a professional film storyboard analyst. Decompose the scene from the provided images. Output structured data covering: narrative arc (d), structured caption (cap), environment with lighting params (env), 4-layer sound design (bgm), and timeline with shots.\n\nREFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH. Describe ONLY what is visually present.'
```

**Step 5: 修改 StoryboardProPipeline Pass 2 inline fallback**

在 `characterExtractFn` 中找到 inline fallback（约 line 351）：

```
'You are a character analysis expert for storyboard production. Extract ALL characters and significant objects from the provided images.'
```

改为：

```typescript
'You are a character analysis expert for storyboard production. Extract ALL characters and significant objects from the provided images.\n\nREFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH. Extract ONLY visually present features. DO NOT hallucinate attributes not shown.'
```

**Step 6: Commit**

---

### Task 4: 注入 Design Mandate 到 Pass 4 设计阶段

**Files:**
- Modify: `config/prompts/director/pass34-design-and-assemble.md`
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (designAndAssemble buildSystemPrompt 逻辑)

**Step 1: 修改 pass34-design-and-assemble.md**

在 `Keep character descriptions consistent across all panels.` 行（line 35）之后追加：

```markdown

## REFERENCE IMAGE FIDELITY (BINDING)
The reference images provided by the user are the SINGLE SOURCE OF TRUTH for character identity.
- Every panel MUST reproduce character appearance exactly as extracted in the Character Identity Lock.
- DO NOT alter face structure, hairstyle, hair color, outfit design, or signature accessories.
- MAY vary: pose, expression, action, camera angle, lighting intensity.
- If a character's appearance is described differently in the user brief vs the reference image, the REFERENCE IMAGE WINS.
- Scene elements visible in the reference (architecture, props) MUST maintain visual continuity across panels.
```

**Step 2: 在 DirectorPipeline 的 `extractVarsForDesign` 中注入 mandate**

在 `extractVarsForDesign` 函数返回的 vars 对象中，添加一个新的模板变量。找到 `return {` 块（约 line 260），在 `character_identity_lock:` 之后添加：

```typescript
    reference_fidelity_mandate: buildReferenceImageFidelityMandate('design'),
```

同时在 pass34 模板中引用：`{{reference_fidelity_mandate}}`

**但注意：** pass34 模板已经有足够的位置放 binding rules。更简洁的做法是直接把文本写在 .md 模板里（Step 1 已完成），无需模板变量。

所以 Step 2 可以跳过 — 直接在模板中写死即可。

**Step 3: Commit**

---

### Task 5: 强化 Verify Mandate 到 Pass 5 校验阶段

**Files:**
- Modify: `config/prompts/director/pass5-verify-consistency.md`

**Step 1: 修改 pass5-verify-consistency.md**

在 `## Scoring` 部分之前（line 51 之前），插入新的校验维度：

```markdown

### 6. Reference Image Fidelity
- Compare character descriptions in prompts against the CHARACTER ANCHORS extracted from reference images
- The reference image is ground truth — any deviation from extracted anchors is a fidelity violation
- Flag if a character's hair color/style in a prompt contradicts the anchor
- Flag if outfit details are altered or omitted compared to the anchor
- Flag if unique markers (weapons, glasses, scars) are missing or changed

```

在 `## Scoring` 部分（line 52 之后），添加：

```markdown
- Reference fidelity violation (character): -2 per occurrence
- Reference fidelity violation (environment): -1 per occurrence
```

**Step 2: Commit**

---

### Task 6: 强化 Contact Sheet 生成提示

**Files:**
- Modify: `config/prompts/director/pass6-contact-sheet.md`

**Step 1: 修改 pass6-contact-sheet.md**

在 `{{character_identity_section}}` 行（line 24）之后、`Panel descriptions:` 行之前插入：

```markdown

REFERENCE IMAGE FIDELITY (BINDING):
- Characters MUST look identical to the reference images in EVERY panel.
- DO NOT reinterpret or stylize characters beyond what is shown in the reference.
- Face, hair, outfit, accessories are LOCKED to the reference — no creative deviation.

```

**Step 2: Commit**

---

### Task 7: 端到端验证

**Step 1: 运行 Director pipeline 全量测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All tests pass

**Step 2: 运行 Storyboard pipeline 全量测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/ --reporter=verbose`

Expected: All tests pass

**Step 3: Commit**

---

## 改动总结

| Pass | 改动位置 | Mandate 强度 |
|------|----------|-------------|
| **Pass 1** 场景分析 | `.md` 模板 + inline fallback + user message | analysis: "描述所见，不臆造" |
| **Pass 2** 角色锚点 | `.md` 模板 + inline fallback | analysis: "提取所见，不猜测" |
| **Pass 3** 风格锚点 | 无改动（风格分析本身就是提取性质） | — |
| **Pass 4** 分镜设计 | `.md` 模板 | design: "严格复现，不偏离" |
| **Pass 5** 一致性校验 | `.md` 模板 + 新扣分维度 | verify: "对照扣分" |
| **Pass 6** 图像生成 | `.md` 模板 | design: "锁定外观" |
| **StoryboardPro Pass 1** | `.md` 模板 + inline fallback | analysis |
| **StoryboardPro Pass 2** | `.md` 模板 + inline fallback | analysis |
| **共享函数** | `buildReferenceImageFidelityMandate()` | 三档可复用 |

**核心原则：** "参考图像是唯一真相源。所有阶段都必须以用户输入图像为准，不臆造、不偏离、不重新诠释。"
