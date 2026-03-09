# L1 Prompt Coherence Fix — 消除碎片化拼接

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 让 L1 的最终图像生成 prompt 和 L2 一样是一个自洽的完整句子，消除武器/特效/道具在角色间串联的问题。

**Architecture:** 在 `enhanced_panel_descriptions` 中停止拼接 `characterAction`/`desc`/`shot`/`lighting` 到图像 prompt（这些字段仍保留在 `panels[]` 供 Pass 5 一致性校验使用）。同时强化 `DesignAndAssembleSchema.prompt` 的 `.describe()`，要求 LLM 在 `prompt` 字段中包含所有必要的镜头、动作、灯光信息，产出一个完整自洽的句子。

**Tech Stack:** TypeScript, Zod, Vitest

---

## Root Cause Analysis

### L2 (works correctly)
```
SimplePanelSchema → { id, prompt }
                  ↓
makePanelsAndPrompts → panels[].shot/desc/lighting = '' (empty)
                  ↓
enhanced_panel_descriptions → parts = [prompt] (no extras)
                  ↓
Final: "Panel 1: [shot cut] <style>, <one coherent sentence>"
```

### L1 (attribute cross-contamination)
```
DesignAndAssembleSchema → { id, prompt, characterAction, desc, shot, lighting, ... }
                       ↓
makePanelsAndPrompts → panels[].shot/desc/lighting/characterAction populated
                       ↓
enhanced_panel_descriptions → parts = [prompt, characterAction, desc, shot, lighting]
                           → parts.join('. ')  ← FRAGMENTED!
                       ↓
Final: "Panel 1: [shot cut] <style>, <prompt>. <characterAction>. <desc>. <shot>. <lighting>"
```

The fragmented multi-sentence prompt causes Gemini Image to cross-contaminate attributes between characters (weapons, props, special effects appearing on the wrong character).

---

### Task 1: Strengthen `DesignAndAssembleSchema.prompt` description

**Files:**
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts:34`

**Step 1: Write the failing test**

```typescript
// File: src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
import { DesignAndAssembleSchema } from '../schemas/director-schemas'

describe('DesignAndAssembleSchema prompt field', () => {
  it('prompt description requires self-contained scene sentence with shot/action/lighting', () => {
    const promptField = DesignAndAssembleSchema.shape.panels.element.shape.prompt
    const desc = promptField.description || ''
    expect(desc).toContain('self-contained')
    expect(desc).toContain('shot type')
    expect(desc).toContain('lighting')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: FAIL — current description doesn't contain 'self-contained'

**Step 3: Update the schema prompt description**

In `director-schemas.ts`, change line 34 from:
```typescript
prompt: z.string().describe('Full English image generation prompt. Use [char1] [char2] tags for character references as defined in the Character Identity Lock. Write detailed scene descriptions around the tags.'),
```
to:
```typescript
prompt: z.string().describe('Self-contained English image generation prompt as ONE fluent sentence. Must include: shot type and angle, all character actions with [char1] [char2] tags bound to their specific weapons/props/effects, lighting direction and color temperature, and background context. Do NOT split information across other fields — this prompt alone will be sent to the image model. Example: "Medium shot at eye-level, [char1] swings her white folding fan defensively while [char2] lunges forward with his katana, warm golden-hour side-light from the left illuminating the cherry-blossom courtyard."'),
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/schemas/director-schemas.ts
git add src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
git commit -m "feat: strengthen DesignAndAssembleSchema prompt to require self-contained scene"
```

---

### Task 2: Stop concatenating extra fields in `enhanced_panel_descriptions`

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts:758-765`

**Step 1: Write the failing test**

```typescript
// File: src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
import { extractVarsForContactSheet } from '../DirectorPipeline'

describe('extractVarsForContactSheet enhanced_panel_descriptions', () => {
  it('uses only p.prompt without concatenating panel metadata fields', () => {
    const state = {
      prompts: [{ id: 1, prompt: 'Wide shot of [char1] charging with katana', negativePrompt: '' }],
      panels: [{
        id: 1,
        shot: 'wide angle low',
        desc: '[char1] charges forward aggressively',
        lighting: 'dramatic orange rim light',
        characterAction: '[char1] raises katana overhead, [char2] blocks with shield',
        background: 'burning castle courtyard',
      }],
      characters: {
        characters: [
          { name: 'Aria', anchor: 'long green hair, white coat' },
        ],
      },
      scene: { env: 'castle' },
      layout: { rows: 1, cols: 1, panelCount: 1 },
      ratio: '16:9',
      sceneDescription: '',
      styleInstructions: '',
      inputImages: [],
      template: 'storyboard',
    } as any

    const vars = extractVarsForContactSheet(state)
    const enhanced = vars.enhanced_panel_descriptions

    // Should NOT contain the characterAction or lighting fragments
    expect(enhanced).not.toContain('raises katana overhead')
    expect(enhanced).not.toContain('dramatic orange rim light')
    expect(enhanced).not.toContain('charges forward aggressively')
    // Should contain the original prompt
    expect(enhanced).toContain('Wide shot of')
    expect(enhanced).toContain('charging with katana')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: FAIL — current code concatenates all fields

**Step 3: Remove field concatenation from enhanced_panel_descriptions**

In `DirectorPipeline.ts`, replace lines 758-765:
```typescript
      const enhanced = prompts.map(p => {
        const panel = panels.find((pn: any) => pn.id === p.id)
        const parts = [p.prompt]
        if (panel?.characterAction) parts.push(panel.characterAction)
        if (panel?.desc) parts.push(panel.desc)
        if (panel?.shot) parts.push(panel.shot)
        if (panel?.lighting) parts.push(panel.lighting)
        const raw = parts.join('. ')
        const base = expandCharacterTags(raw, characters)
```
with:
```typescript
      const enhanced = prompts.map(p => {
        const base = expandCharacterTags(p.prompt, characters)
```

This is the minimal change: we keep `expandCharacterTags` (which replaces [charN] → full anchor), keep style prefix logic, keep everything else. We only stop concatenating metadata fields.

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: PASS

**Step 5: Run ALL existing tests to verify no regressions**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`
Expected: All tests PASS

**Step 6: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: use only prompt field in enhanced_panel_descriptions, stop fragmenting"
```

---

### Task 3: Verify the fix end-to-end with a manual trace

**Step 1: Add a temporary console.log to verify prompt output**

Add right after line 770 (the `return` inside `enhanced`'s `.map()`):
```typescript
// Temporary debug — remove after verification
console.log(`[DEBUG enhanced_panel] Panel ${p.id} prompt length: ${prefixed.length} chars`)
```

**Step 2: Run a test generation through the UI**

1. Open the app in development mode
2. Run a 2x2 storyboard with 2+ characters that have distinct weapons
3. Check the console output:
   - L1 success: each panel prompt should be ~40-70 words (not ~120+ words)
   - The prompt should read as one fluent sentence
   - Weapons/props should be correctly bound to their characters

**Step 3: Remove debug logging and commit**

```bash
git add -A
git commit -m "fix: L1 prompt coherence — eliminate attribute cross-contamination"
```

---

## Summary of Changes

| File | Change | Lines |
|------|--------|-------|
| `schemas/director-schemas.ts` | Strengthen `prompt` description to require self-contained scene | L34 |
| `DirectorPipeline.ts` | Remove `characterAction`/`desc`/`shot`/`lighting` concatenation in `enhanced_panel_descriptions` | L758-765 |

**What stays the same:**
- `panels[]` object still stores `shot`, `desc`, `lighting`, `characterAction`, `background` (used by Pass 5 verify)
- `makePanelsAndPrompts` unchanged
- `expandCharacterTags` still expands [charN] → full anchor in the prompt
- Style prefix logic unchanged
- L2/L3 fallback behavior unchanged (they already only have `prompt`)

**What changes:**
- L1's final image generation prompt goes from fragmented multi-sentence → one coherent sentence (matching L2's behavior)
- LLM is instructed to write a complete prompt in the `prompt` field instead of spreading info across fields
