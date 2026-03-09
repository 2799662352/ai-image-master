# 自然语言角色内联 (expandCharacterTags 重构) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将角色描述从括号标注 `(anchor)` 重构为自然语言内联 `a figure with ... wearing ...`，使 diffusion model 的 cross-attention 能正确将外观属性绑定到各自角色的空间区域。

**Architecture:** 改动集中在 `expandCharacterTags` + 一个新辅助函数 `buildNaturalDescriptor`，`assembleCoherentPrompt` 需要微调分段逻辑以配合新的 `;\n` 分隔符。所有改动在纯函数层面，不涉及 LLM 调用或 pipeline 状态。

**Tech Stack:** TypeScript, Vitest

---

## 现状 vs 目标

**当前输出** (assembleCoherentPrompt → expandCharacterTags):
```
medium shot, on the left, (long mint-green hair, dark teal military coat, white folding fan) lunges forward with a fan, on the right, (silver-white twin tails, navy blue sailor uniform, blue beret) blocks the strike, Two warriors in a tense standoff, stone courtyard with arched columns, warm golden hour side-light
```

**目标输出**:
```
medium shot.
In the foreground left, a figure with long mint-green hair wearing a dark teal military coat lunges forward wielding a white folding fan;
in the foreground right, a figure with silver-white twin tails wearing a navy blue sailor uniform and blue beret blocks the strike.
Stone courtyard with arched columns, warm golden hour side-light.
```

**维度对比:**

| 维度 | 现在 | 改后 |
|------|------|------|
| 角色描述 | 括号标注 `(anchor)` | 自然语言 `a figure with ... wearing ...` |
| 属性绑定 | 扁平 token 序列 | 每角色自包含段落 |
| 动作绑定 | 逗号后接动作 | 动作紧跟 wearing 子句 |
| 空间锚定 | `on the left/right` | `in the foreground left/right` |
| 角色间分隔 | `, ` | `;\n` (减少 cross-attention 泄漏) |
| 场景/光照 | 逗号连接在末尾 | 独立句子 `.` 分隔 |

---

### Task 1: 新增 `buildNaturalDescriptor` 函数 + 测试

**Files:**
- Modify: `temp-ai-image-master-source/src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `temp-ai-image-master-source/src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts`

**Step 1: Write the failing tests**

在 `assembleCoherentPrompt.test.ts` 文件顶部 import 区追加 `buildNaturalDescriptor`，然后在文件末尾追加新 describe：

```typescript
// 在 import 行追加
import { assembleCoherentPrompt, expandCharacterTags, buildNaturalDescriptor } from '../DirectorPipeline'
```

```typescript
describe('buildNaturalDescriptor', () => {
  it('converts flat anchor to natural language with "a figure with ... wearing ..."', () => {
    const result = buildNaturalDescriptor({
      anchor: 'long mint-green hair, dark teal military coat, white folding fan',
    })
    expect(result).toContain('a figure with long mint-green hair')
    expect(result).toContain('wearing')
    expect(result).not.toContain('(')
    expect(result).not.toContain(')')
  })

  it('uses structured fields when face and outfit are available', () => {
    const result = buildNaturalDescriptor({
      anchor: 'long mint-green hair, dark teal military coat',
      face: 'round face, green eyes, long mint-green hair',
      outfit: 'dark teal military coat with gold buttons',
      markers: 'white folding fan',
    })
    expect(result).toContain('a figure with')
    expect(result).toContain('wearing')
    expect(result).not.toContain('(')
  })

  it('falls back gracefully for single-trait anchor', () => {
    const result = buildNaturalDescriptor({ anchor: 'red hat' })
    expect(result).toContain('a figure with red hat')
    expect(result).not.toContain('wearing')
  })

  it('returns empty string for empty anchor', () => {
    const result = buildNaturalDescriptor({ anchor: '' })
    expect(result).toBe('')
  })

  it('handles anchor with only one comma-separated part', () => {
    const result = buildNaturalDescriptor({ anchor: 'silver armor' })
    expect(result).toContain('a figure with silver armor')
  })
})
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`
Expected: FAIL — `buildNaturalDescriptor` is not exported / doesn't exist

**Step 3: Implement `buildNaturalDescriptor`**

在 `DirectorPipeline.ts` 中 `expandCharacterTags` 函数之前（约 line 692 附近），插入：

```typescript
/**
 * Convert a character's anchor (and optional structured fields) into a
 * natural-language descriptor for diffusion prompt embedding.
 *
 * Structured fields (face, outfit, markers) produce higher quality output.
 * When only the flat `anchor` string is available, heuristically splits
 * on commas: first part → "a figure with {trait}", remaining → "wearing {rest}".
 */
export function buildNaturalDescriptor(
  char: { anchor?: string; face?: string; outfit?: string; markers?: string },
): string {
  if (char.face || char.outfit) {
    const parts: string[] = []
    if (char.face) parts.push(`a figure with ${char.face.trim()}`)
    else parts.push('a figure')
    if (char.outfit) parts.push(`wearing ${char.outfit.trim()}`)
    if (char.markers) parts.push(`carrying ${char.markers.trim()}`)
    return parts.join(', ')
  }

  const anchor = char.anchor?.trim()
  if (!anchor) return ''

  const segments = anchor.split(',').map(s => s.trim()).filter(Boolean)
  if (segments.length === 0) return ''
  if (segments.length === 1) return `a figure with ${segments[0]}`

  const primary = segments[0]
  const rest = segments.slice(1).join(', ')
  return `a figure with ${primary}, wearing ${rest}`
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git add src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts
git commit -m "feat(pipeline): add buildNaturalDescriptor for natural-language character descriptions

Converts flat anchor strings (or structured face/outfit/markers fields)
into 'a figure with X, wearing Y' format instead of parenthetical notation.
This reduces cross-attention bleed in diffusion models."
```

---

### Task 2: 升级 `getSpatialAnchors` — foreground 空间定位

**Files:**
- Modify: `temp-ai-image-master-source/src/renderer/src/services/pipeline/DirectorPipeline.ts:728-739`
- Test: `temp-ai-image-master-source/src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`

**Step 1: Write the failing test**

在 `DirectorPipeline.recovery.test.ts` 文件末尾追加（需要先导出 `getSpatialAnchors` 或通过 `expandCharacterTags` 间接测试）：

```typescript
describe('expandCharacterTags foreground spatial anchors', () => {
  it('uses "in the foreground" instead of "on the" for 2 characters', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] attacks. [char2] defends.',
      [
        { name: 'A', anchor: 'red hair, red coat' },
        { name: 'B', anchor: 'blue hat, blue jacket' },
      ],
    )
    expect(result).toContain('in the foreground left')
    expect(result).toContain('in the foreground right')
    expect(result).not.toContain('on the left')
    expect(result).not.toContain('on the right')
  })

  it('uses "in the foreground center" for 3 characters', () => {
    const result = (DirectorPipelineModule as any).expandCharacterTags(
      '[char1] a. [char2] b. [char3] c.',
      [
        { name: 'A', anchor: 'red hair' },
        { name: 'B', anchor: 'blue hat' },
        { name: 'C', anchor: 'green scarf' },
      ],
    )
    expect(result).toContain('in the foreground left')
    expect(result).toContain('in the foreground center')
    expect(result).toContain('in the foreground right')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: FAIL — still uses `on the left/right`

**Step 3: Update `getSpatialAnchors`**

Replace lines 728-739:

**Current code:**
```typescript
function getSpatialAnchors(count: number): string[] {
  if (count <= 1) return ['']
  if (count === 2) return ['on the left', 'on the right']
  if (count === 3) return ['on the left', 'in the center', 'on the right']
  const anchors: string[] = []
  for (let i = 0; i < count; i++) {
    const pos = count <= 4
      ? ['on the far left', 'on the center-left', 'on the center-right', 'on the far right'][i]
      : `in position ${i + 1} from left`
    anchors.push(pos)
  }
  return anchors
}
```

**New code:**
```typescript
function getSpatialAnchors(count: number): string[] {
  if (count <= 1) return ['']
  if (count === 2) return ['in the foreground left', 'in the foreground right']
  if (count === 3) return ['in the foreground left', 'in the foreground center', 'in the foreground right']
  const anchors: string[] = []
  for (let i = 0; i < count; i++) {
    const pos = count <= 4
      ? ['in the far left', 'in the center-left', 'in the center-right', 'in the far right'][i]
      : `in position ${i + 1} from left`
    anchors.push(pos)
  }
  return anchors
}
```

**Step 4: Update existing tests that assert `on the left/right`**

In `DirectorPipeline.recovery.test.ts`, update assertions in existing `expandCharacterTags spatial binding` tests:

- `expect(result).not.toContain('(Aria:')` — keep
- Wherever tests check spatial words: update expectations to `in the foreground left/right`

In `assembleCoherentPrompt.test.ts`, update the integration test (`full prompt assembly pipeline` describe):

```typescript
    // Spatial separation
    expect(expanded).toContain('in the foreground left')
    expect(expanded).toContain('in the foreground right')
```

**Step 5: Run all tests to verify**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git add src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
git add src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts
git commit -m "feat(pipeline): upgrade spatial anchors to foreground-based positions

Changes 'on the left/right' to 'in the foreground left/right' for
stronger spatial grounding in diffusion model attention."
```

---

### Task 3: 重构 `expandCharacterTags` 核心逻辑

**Files:**
- Modify: `temp-ai-image-master-source/src/renderer/src/services/pipeline/DirectorPipeline.ts:692-726`
- Test: `temp-ai-image-master-source/src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts`
- Test: `temp-ai-image-master-source/src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`

**Step 1: Write the failing integration test**

在 `assembleCoherentPrompt.test.ts` 末尾，重写 `full prompt assembly pipeline` 的期望，新增一个 target-format 测试：

```typescript
describe('expandCharacterTags natural language output', () => {
  it('produces self-contained character paragraphs with natural language', () => {
    const input = '[char1] lunges forward with a fan, [char2] blocks the strike'
    const chars = [
      { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan' },
      { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret' },
    ]
    const result = expandCharacterTags(input, chars)

    // Natural language — no parentheses wrapping
    expect(result).not.toContain('(long mint-green')
    expect(result).not.toContain('(silver-white')

    // Natural language descriptors
    expect(result).toContain('a figure with long mint-green hair')
    expect(result).toContain('wearing')
    expect(result).toContain('a figure with silver-white twin tails')

    // Actions still present and bound
    expect(result).toContain('lunges forward')
    expect(result).toContain('blocks the strike')

    // Semicolon separation between characters
    expect(result).toContain(';')

    // Foreground spatial anchors
    expect(result).toContain('in the foreground left')
    expect(result).toContain('in the foreground right')
  })

  it('uses structured fields when available for richer output', () => {
    const input = '[char1] runs.'
    const chars = [
      {
        name: 'Aria',
        anchor: 'green hair girl',
        face: 'round face, green eyes, long mint-green hair',
        outfit: 'dark teal military coat with gold buttons',
        markers: 'white folding fan',
      },
    ]
    const result = expandCharacterTags(input, chars)

    expect(result).toContain('a figure with round face')
    expect(result).toContain('wearing dark teal military coat')
    expect(result).toContain('runs')
    expect(result).not.toContain('(')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`
Expected: FAIL — still uses parenthetical format

**Step 3: Refactor `expandCharacterTags`**

Replace lines 692-726:

**Current code:**
```typescript
export function expandCharacterTags(
  text: string,
  characters: Array<{ name?: string; anchor?: string }>,
): string {
  if (!characters.length) return text
  const sorted = sortCharacters(characters)

  const tagsPresent = sorted.map((_, i) => `[char${i + 1}]`).filter(tag => text.includes(tag))
  if (tagsPresent.length === 0) return text

  const spatialAnchors = getSpatialAnchors(tagsPresent.length)

  let result = text
  let spatialIdx = 0
  sorted.forEach((c, i) => {
    const tag = `[char${i + 1}]`
    if (!result.includes(tag)) return

    const anchor = c.anchor || ''
    const spatial = spatialAnchors[spatialIdx] || ''
    spatialIdx++
    const prefix = spatial ? `${spatial}, ` : ''
    const descriptor = anchor
      ? `${prefix}(${anchor})`
      : prefix || tag

    result = result.split(tag).join(descriptor)
  })

  if (tagsPresent.length > 1) {
    result = result.replace(/\.\s+/g, '; ')
  }

  return result
}
```

**New code:**
```typescript
export function expandCharacterTags(
  text: string,
  characters: Array<{ name?: string; anchor?: string; face?: string; build?: string; outfit?: string; markers?: string }>,
): string {
  if (!characters.length) return text
  const sorted = sortCharacters(characters)

  const tagsPresent = sorted.map((_, i) => `[char${i + 1}]`).filter(tag => text.includes(tag))
  if (tagsPresent.length === 0) return text

  const spatialAnchors = getSpatialAnchors(tagsPresent.length)

  let result = text
  let spatialIdx = 0
  sorted.forEach((c, i) => {
    const tag = `[char${i + 1}]`
    if (!result.includes(tag)) return

    const descriptor = buildNaturalDescriptor(c)
    const spatial = spatialAnchors[spatialIdx] || ''
    spatialIdx++

    const replacement = descriptor
      ? spatial ? `${spatial}, ${descriptor}` : descriptor
      : spatial || tag

    result = result.split(tag).join(replacement)
  })

  if (tagsPresent.length > 1) {
    result = result.replace(/\.\s+/g, ';\n')
  }

  return result
}
```

**关键变化:**
1. 函数签名扩展为接受 `face?`, `build?`, `outfit?`, `markers?`
2. `(anchor)` 替换为 `buildNaturalDescriptor(c)` — 自然语言
3. `. ` 替换为 `;\n` — 更强的 token 边界

**Step 4: Update existing tests**

在 `DirectorPipeline.recovery.test.ts` 中的 `expandCharacterTags spatial binding` 测试块，更新断言：

旧断言：
```typescript
expect(result).toContain('mint-green hair')
```
新断言（更精确）：
```typescript
expect(result).toContain('a figure with long mint-green hair')
expect(result).toContain('wearing')
```

对于 `handles single character without spatial prefix` 测试：
```typescript
// 旧
expect(result).toContain('mint-green hair')
// 新
expect(result).toContain('a figure with long mint-green hair')
expect(result).toContain('wearing dark teal military coat')
```

对于 `handles 3+ characters with spatial distribution` 测试：
```typescript
// 旧
expect(result).toContain('red hair')
expect(result).toContain('blue armor')
expect(result).toContain('black cloak')
// 新
expect(result).toContain('a figure with red hair')
expect(result).toContain('a figure with blue armor')
expect(result).toContain('a figure with black cloak')
```

同样更新 `assembleCoherentPrompt.test.ts` 中的集成测试断言。

**Step 5: Run all affected tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git add src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts
git add src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts
git commit -m "refactor(pipeline): expandCharacterTags uses natural language inline

Replaces parenthetical (anchor) format with 'a figure with X wearing Y'
natural language. Each character becomes a self-contained paragraph with
spatial anchor, appearance, and action tightly bound together.
Semicolons + newlines between characters reduce cross-attention bleed."
```

---

### Task 4: 调整 `assembleCoherentPrompt` 分段逻辑

**Files:**
- Modify: `temp-ai-image-master-source/src/renderer/src/services/pipeline/DirectorPipeline.ts:640-680`
- Test: `temp-ai-image-master-source/src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts`

**Step 1: Write the failing test**

```typescript
describe('assembleCoherentPrompt scene separation', () => {
  it('separates shot + characters from scene context with period', () => {
    const panel = {
      shot: 'medium shot',
      desc: '[char1] and [char2] clash',
      lighting: 'warm golden hour side-light',
      characterAction: '[char1] lunges with fan, [char2] blocks defensively',
      background: 'stone courtyard with arched columns',
    }
    const prompt = { prompt: 'Two warriors face off' }

    const result = assembleCoherentPrompt(panel, prompt)

    // Shot should be its own clause followed by period or comma
    expect(result).toMatch(/medium shot[.,]/)

    // Background + lighting should appear as a scene sentence
    // not comma-joined with the character action
    const bgIdx = result.indexOf('stone courtyard')
    const actionIdx = result.indexOf('lunges with fan')
    expect(bgIdx).toBeGreaterThan(actionIdx)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`
Expected: FAIL or PASS depending on current behavior — verify which

**Step 3: Adjust `assembleCoherentPrompt`**

Replace lines 640-680:

**New code:**
```typescript
export function assembleCoherentPrompt(
  panel: { shot?: string; desc?: string; lighting?: string; characterAction?: string; background?: string },
  prompt: { prompt: string },
): string {
  const shot = panel.shot?.trim() || ''
  const action = panel.characterAction?.trim() || ''
  const desc = panel.desc?.trim() || ''
  const lighting = panel.lighting?.trim() || ''
  const bg = panel.background?.trim() || ''
  const basePrompt = prompt.prompt?.trim() || ''

  if (!action && !desc && !shot && !lighting) {
    return basePrompt
  }

  const coreAction = action || desc

  // Section 1: Shot framing
  const framingParts: string[] = []
  if (shot) framingParts.push(shot)

  // Section 2: Character action (will contain [charN] tags for later expansion)
  const actionParts: string[] = []
  if (coreAction) {
    actionParts.push(coreAction)
    const descHasCharTags = /\[char\d+\]/.test(desc)
    if (desc && action && !descHasCharTags && !action.includes(desc.slice(0, 20))) {
      actionParts.push(desc)
    }
    const promptIsRedundant = basePrompt
      && (coreAction.includes(basePrompt.slice(0, 30))
        || basePrompt.includes(coreAction.slice(0, 30)))
    if (basePrompt && !promptIsRedundant) {
      actionParts.push(basePrompt)
    }
  } else {
    actionParts.push(basePrompt)
  }

  // Section 3: Scene context (background + lighting) — separate sentence
  const sceneParts: string[] = []
  if (bg) sceneParts.push(bg)
  if (lighting) sceneParts.push(lighting)

  const framing = framingParts.join(', ')
  const characters = actionParts.join(', ')
  const scene = sceneParts.join(', ')

  const sections = [framing, characters, scene].filter(Boolean)
  return sections.join('.\n')
}
```

**关键变化:** 场景上下文 (background + lighting) 用 `.\n` 与角色动作分隔，而非 `,` 混在一起。这确保 expandCharacterTags 处理后的最终 prompt 结构清晰：
```
{shot}.\n{spatial character paragraphs with ; separators}.\n{scene context}.
```

**Step 4: Update existing tests**

需要更新 `assembleCoherentPrompt` 测试中依赖逗号分隔的断言。主要变化：
- 光照和背景不再与角色动作逗号连接
- 改为 `.` 分隔的独立句子

遍历每个 test case 确认 split 逻辑仍然正确。注意 `falls back to prompt field when no structured fields exist` 测试应该不受影响。

**Step 5: Run all tests**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`
Expected: All PASS

**Step 6: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git add src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts
git commit -m "refactor(pipeline): assembleCoherentPrompt separates scene context

Shot, character actions, and scene context (bg + lighting) are now
separated by period+newline instead of commas. This creates clear
sections that align with the natural language character expansion."
```

---

### Task 5: 端到端验证 + 调用点兼容性检查

**Files:**
- Check: `temp-ai-image-master-source/src/renderer/src/services/pipeline/DirectorPipeline.ts` (所有 `expandCharacterTags` 调用点)

**Step 1: 确认所有调用点类型兼容**

`expandCharacterTags` 的调用点在:
- `extractVarsForContactSheet` line ~818: `expandCharacterTags(raw, characters)`
- 其中 `characters = state.characters?.characters || []`

这些 `characters` 来自 `CharacterAnchorSchema`，包含 `face?`, `build?`, `outfit?`, `markers?` 字段。新签名向后兼容（所有新字段都是 optional），无需改调用点。

同样检查 `buildCharacterIdentityLock` (line ~119) — 它独立使用 characters，不受影响。

**Step 2: 运行所有 pipeline 测试**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`
Expected: All PASS

**Step 3: Print final output sample**

在 integration 测试的 `console.log` 中确认最终格式符合目标。

**Step 4: Commit (final)**

```bash
git add -A
git commit -m "test(pipeline): verify natural language character expansion end-to-end

All pipeline tests pass with new expandCharacterTags format.
Backward compatible — call sites unchanged."
```

---

## 验证清单

完成所有 Task 后逐项确认：

- [ ] `buildNaturalDescriptor` 将 anchor 转为 `a figure with X, wearing Y` 格式
- [ ] `buildNaturalDescriptor` 优先使用 `face`/`outfit`/`markers` 结构化字段
- [ ] `getSpatialAnchors` 返回 `in the foreground left/right/center`
- [ ] `expandCharacterTags` 输出不含 `(anchor)` 括号标注
- [ ] `expandCharacterTags` 多角色用 `;\n` 分隔
- [ ] `assembleCoherentPrompt` 场景/光照与角色动作 `.` 分隔
- [ ] 函数签名向后兼容（所有新字段 optional）
- [ ] `npx vitest run src/renderer/src/services/pipeline/__tests__/` 全部通过
- [ ] 无新增 lint 错误

## 最终效果样例

输入:
```
panel.shot = 'medium shot'
panel.characterAction = '[char1] lunges forward with a fan, [char2] blocks the strike'
panel.background = 'stone courtyard with arched columns'
panel.lighting = 'warm golden hour side-light'
characters = [
  { name: 'Aria', anchor: 'long mint-green hair, dark teal military coat, white folding fan' },
  { name: 'Kael', anchor: 'silver-white twin tails, navy blue sailor uniform, blue beret' },
]
```

输出:
```
medium shot.
in the foreground left, a figure with long mint-green hair, wearing dark teal military coat, white folding fan lunges forward with a fan;
in the foreground right, a figure with silver-white twin tails, wearing navy blue sailor uniform, blue beret blocks the strike.
stone courtyard with arched columns, warm golden hour side-light.
```
