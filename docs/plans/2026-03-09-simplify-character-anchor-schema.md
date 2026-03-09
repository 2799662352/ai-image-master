# CharacterAnchorSchema 精简 (方案 C) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 将 CharacterAnchorSchema 从 6 字段精简到 4 字段 (name + face + outfit + markers)，去掉冗余的 anchor 和低价值的 build，减少 LLM 输出 token ~33%，同时删除已废弃的 SimpleCharacterSchema 降级路径。

**Architecture:** 修改 Zod schema 定义，更新下游 8 处 `.anchor` 引用为 `buildAnchorFromFields(c)`，更新 prompt 模板，删除 SimpleCharacterSchema 及相关测试。`buildNaturalDescriptor` 的结构化路径 (face + outfit + markers) 保持不变。

**Tech Stack:** TypeScript, Zod, Vitest, Markdown prompt templates

---

## 改动清单

### Schema 变更

| 字段 | 改前 | 改后 |
|------|------|------|
| `name` | required | 不变 |
| `anchor` | required | **删除** |
| `face` | optional | **required** |
| `build` | optional | **删除** |
| `outfit` | optional | **required** |
| `markers` | optional | 不变 (optional) |

### 下游 `.anchor` 引用 (共 8 处需改)

| 位置 | 行号 | 当前 | 改为 |
|------|------|------|------|
| `sortCharacters` 类型签名 | 111 | `{ name?; anchor? }` | `{ name?; face?; outfit? }` |
| `sortCharacters` fallback key | 113-114 | `a.name \|\| a.anchor` | `a.name \|\| a.face` |
| `buildAnchorFromFields` | 128-131 | `[face, build, outfit, markers]` | `[face, outfit, markers]` |
| `extractVarsForDesign` | 263-264 | `c.anchor` | `buildAnchorFromFields(c)` |
| `extractVarsForVerify` | 306-307 | `c.anchor` | `buildAnchorFromFields(c)` |
| `buildNaturalDescriptor` fallback | 707-716 | `char.anchor?.trim()` | 删除 fallback 分支 (结构字段总是存在) |
| Contact sheet global section | 786 | `c.anchor` | `buildAnchorFromFields(c)` |
| `character_anchor_line` | 834 | `c.anchor` | `buildAnchorFromFields(c)` |

---

### Task 1: 修改 CharacterAnchorSchema + 删除 SimpleCharacterSchema

**Files:**
- Modify: `src/renderer/src/services/pipeline/schemas/director-schemas.ts:12-23,56-63`
- Test: `src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`

**Step 1: Write the failing test**

修改 `DirectorPipeline.recovery.test.ts`，删除 `SimpleCharacterSchema` 测试，替换为新 schema 测试：

```typescript
import { CharacterAnchorSchema } from '../schemas/director-schemas'

describe('CharacterAnchorSchema (simplified 4-field)', () => {
  it('accepts name + face + outfit + markers', () => {
    const result = CharacterAnchorSchema.parse({
      characters: [{
        name: 'Aria',
        face: 'pale skin, oval face, green eyes, long mint-green hair',
        outfit: 'dark teal military coat with gold buttons, black boots',
        markers: 'white folding fan',
      }],
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].name).toBe('Aria')
    expect(result.characters[0].face).toContain('mint-green')
    expect(result.characters[0].outfit).toContain('teal')
  })

  it('accepts characters without markers (optional)', () => {
    const result = CharacterAnchorSchema.parse({
      characters: [{
        name: 'Kael',
        face: 'dark skin, sharp eyes, silver-white twin tails',
        outfit: 'navy blue sailor uniform',
      }],
    })
    expect(result.characters).toHaveLength(1)
    expect(result.characters[0].markers).toBeUndefined()
  })

  it('rejects characters missing face (required)', () => {
    expect(() => CharacterAnchorSchema.parse({
      characters: [{ name: 'Bad', outfit: 'red dress' }],
    })).toThrow()
  })

  it('rejects characters missing outfit (required)', () => {
    expect(() => CharacterAnchorSchema.parse({
      characters: [{ name: 'Bad', face: 'brown eyes' }],
    })).toThrow()
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`

Expected: FAIL — old schema still has `anchor` required, `face` optional

**Step 3: Modify schema**

In `src/renderer/src/services/pipeline/schemas/director-schemas.ts`:

Replace `CharacterAnchorSchema` (lines 12-21):

```typescript
export const CharacterAnchorSchema = z.object({
  characters: z.array(z.object({
    name: z.string().describe('Character name or identifier, English first.'),
    face: z.string().describe('Hair color + style + length, eye color, skin tone, face shape.'),
    outfit: z.string().describe('Clothing top-to-bottom with exact colors, patterns, and accessories.'),
    markers: z.string().optional().describe('Props, weapons, scars, tattoos, glasses, jewelry. Omit if none.'),
  })),
})
```

Delete `SimpleCharacterSchema` (lines 56-63):

```typescript
// DELETE these lines:
export const SimpleCharacterSchema = z.object({
  characters: z.array(z.object({
    name: z.string().describe('Character name or identifier'),
    anchor: z.string().describe('Visual consistency anchor: distinguishing features in one phrase'),
  })),
})

export type SimpleCharacter = z.infer<typeof SimpleCharacterSchema>
```

**Step 4: Remove `SimpleCharacterSchema` import from DirectorPipeline.ts**

In `DirectorPipeline.ts` line 11, remove `SimpleCharacterSchema` from the import:

```typescript
// Before:
import {
  CharacterAnchorSchema,
  DesignAndAssembleSchema,
  SimplePanelSchema,
  SimpleCharacterSchema,
  VerifySchema,
} from './schemas/director-schemas'

// After:
import {
  CharacterAnchorSchema,
  DesignAndAssembleSchema,
  SimplePanelSchema,
  VerifySchema,
} from './schemas/director-schemas'
```

**Step 5: Run test to verify it passes**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts --reporter=verbose`

Expected: PASS

---

### Task 2: 更新下游 `.anchor` 引用 → `buildAnchorFromFields(c)`

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (8 处)
- Test: `src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts`

**Step 1: Write the failing test**

在 `assembleCoherentPrompt.test.ts` 中添加：

```typescript
import { buildCharacterIdentityLock, sortCharacters } from '../DirectorPipeline'

describe('schema-C downstream compatibility', () => {
  const chars = [
    { name: 'Aria', face: 'green eyes, mint-green hair', outfit: 'dark teal coat', markers: 'white fan' },
    { name: 'Kael', face: 'sharp eyes, silver twin tails', outfit: 'navy sailor uniform' },
  ]

  it('sortCharacters works without anchor field', () => {
    const sorted = sortCharacters(chars)
    expect(sorted).toHaveLength(2)
    expect(sorted[0].name).toBe('Aria')
    expect(sorted[1].name).toBe('Kael')
  })

  it('buildCharacterIdentityLock works with face+outfit (no anchor)', () => {
    const lock = buildCharacterIdentityLock(chars)
    expect(lock).toContain('mint-green hair')
    expect(lock).toContain('navy sailor uniform')
    expect(lock).toContain('white fan')
    expect(lock).toContain('Character Identity Lock')
  })
})
```

**Step 2: Run test to verify it fails**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`

Expected: FAIL or PASS (may already work since `buildAnchorFromFields` handles missing anchor). Run to check baseline.

**Step 3: Apply all 8 changes**

**3a. `sortCharacters` (line 111):**

```typescript
// Before:
export function sortCharacters<T extends { name?: string; anchor?: string }>(characters: T[]): T[] {
  return [...characters].sort((a, b) => {
    const ka = normalizeCharKey(a.name || a.anchor || '')
    const kb = normalizeCharKey(b.name || b.anchor || '')

// After:
export function sortCharacters<T extends { name?: string; face?: string }>(characters: T[]): T[] {
  return [...characters].sort((a, b) => {
    const ka = normalizeCharKey(a.name || a.face || '')
    const kb = normalizeCharKey(b.name || b.face || '')
```

**3b. `buildAnchorFromFields` (line 128-131):**

```typescript
// Before:
  const buildAnchorFromFields = (c: { face?: string; build?: string; outfit?: string; markers?: string; anchor?: string }): string => {
    const fields = [c.face, c.build, c.outfit, c.markers].filter(Boolean)
    if (fields.length >= 2) return fields.join('. ')
    return c.anchor || '(no anchor)'
  }

// After:
  const buildAnchorFromFields = (c: { face?: string; outfit?: string; markers?: string }): string => {
    const fields = [c.face, c.outfit, c.markers].filter(Boolean)
    if (fields.length > 0) return fields.join('. ')
    return '(no anchor)'
  }
```

**3c. `extractVarsForDesign` (line 263-264):**

```typescript
// Before:
    character_anchors_detail: state.characters?.characters?.map((c: any) =>
      `${c.name}: ${c.anchor}`
    ).join('\n') || '(none)',

// After:
    character_anchors_detail: state.characters?.characters?.map((c: any) =>
      `${c.name}: ${buildAnchorFromFields(c)}`
    ).join('\n') || '(none)',
```

注意：`buildAnchorFromFields` 是 `buildCharacterIdentityLock` 内部的局部函数。需要将它提取为模块级导出函数。

**3d. 提取 `buildAnchorFromFields` 为模块级函数**

将 `buildAnchorFromFields` 从 `buildCharacterIdentityLock` 内部移到它的前面，作为独立导出：

```typescript
export function buildAnchorFromFields(c: { face?: string; outfit?: string; markers?: string }): string {
  const fields = [c.face, c.outfit, c.markers].filter(Boolean)
  if (fields.length > 0) return fields.join('. ')
  return '(no anchor)'
}
```

然后 `buildCharacterIdentityLock` 内部直接调用 `buildAnchorFromFields(c)`（已有这个调用）。

**3e. `extractVarsForVerify` (line 306-307):**

```typescript
// Before:
  const characterAnchors = state.characters?.characters?.map((c: any) =>
    `- ${c.name}: ${c.anchor}`
  ).join('\n') || '(none)'

// After:
  const characterAnchors = state.characters?.characters?.map((c: any) =>
    `- ${c.name}: ${buildAnchorFromFields(c)}`
  ).join('\n') || '(none)'
```

**3f. `buildNaturalDescriptor` fallback (line 707-716):**

删除 `anchor` fallback 分支，因为 `face` 现在是 required：

```typescript
// Before:
export function buildNaturalDescriptor(
  char: { anchor?: string; face?: string; outfit?: string; markers?: string },
): string {
  if (char.face || char.outfit) {
    const parts: string[] = []
    parts.push(char.face ? `a figure with ${char.face.trim()}` : 'a figure')
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

// After:
export function buildNaturalDescriptor(
  char: { face?: string; outfit?: string; markers?: string },
): string {
  const parts: string[] = []
  parts.push(char.face ? `a figure with ${char.face.trim()}` : 'a figure')
  if (char.outfit) parts.push(`wearing ${char.outfit.trim()}`)
  if (char.markers) parts.push(`carrying ${char.markers.trim()}`)
  return parts.join(', ')
}
```

**3g. Contact sheet global section (line 786):**

```typescript
// Before:
    ...sortedChars.map((c: any, i: number) => `  [char${i + 1}]: ${c.anchor}`),

// After:
    ...sortedChars.map((c: any, i: number) => `  [char${i + 1}]: ${buildAnchorFromFields(c)}`),
```

**3h. `character_anchor_line` (line 834):**

```typescript
// Before:
    character_anchor_line: characters.map((c: any) => c.anchor).join('. '),

// After:
    character_anchor_line: characters.map((c: any) => buildAnchorFromFields(c)).join('. '),
```

**Step 4: Run test to verify it passes**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts --reporter=verbose`

Expected: PASS

---

### Task 3: 更新 prompt 模板

**Files:**
- Modify: `config/prompts/director/pass2-character-anchors.md`

**Step 1: 更新模板匹配新 schema**

Replace the entire body (lines 8-18) with:

```markdown
You are a character consistency expert. Extract character anchors from the provided images for cross-shot consistency in image generation.

For EACH character, provide these fields:
1. name: Character name or identifier in English
2. face: skin tone, face shape, eye color, hair color + style + length (e.g. "pale skin, oval face, blue eyes, long silver-white twin tails with navy ribbons")
3. outfit: exact garments top-to-bottom with colors and accessories (e.g. "navy blue sailor collar blouse with gold anchor buttons, dark blue pleated skirt, brown leather belt, white ankle boots, blue beret with white trim")
4. markers (optional): unique props, weapons, scars, tattoos, glasses, jewelry (e.g. "white folding fan, gold choker necklace"). Omit if character has no distinctive props.

Each field must be specific enough to reproduce the character identically in any new scene. Use exact colors, not vague terms. Minimum 30 words for face + outfit combined.
```

**Step 2: Commit**

---

### Task 4: 更新 expandCharacterTags 相关测试

**Files:**
- Modify: `src/renderer/src/services/pipeline/__tests__/DirectorPipeline.recovery.test.ts`
- Modify: `src/renderer/src/services/pipeline/__tests__/assembleCoherentPrompt.test.ts`

**Step 1: 更新 recovery test 中的 expandCharacterTags 测试数据**

将测试中使用 `anchor` 字段的地方改为 `face + outfit`。

例如 line 61-64 当前用 `anchor: 'long mint-green hair, dark teal military coat, white folding fan'`，改为：

```typescript
{ name: 'Aria', face: 'long mint-green hair', outfit: 'dark teal military coat', markers: 'white folding fan' },
{ name: 'Kael', face: 'silver-white twin tails', outfit: 'navy blue sailor uniform, blue beret' },
```

对所有使用 `anchor` 的 `expandCharacterTags` 测试用例做同样的替换。单字段的情况用 `face` 替代：

```typescript
// Before: { name: 'Aria', anchor: 'green hair girl' }
// After:  { name: 'Aria', face: 'green hair', outfit: 'casual clothes' }

// Before: { name: 'A', anchor: 'red hair' }
// After:  { name: 'A', face: 'red hair', outfit: 'red armor' }

// Before: { name: 'A', anchor: 'red hair, sword' }
// After:  { name: 'A', face: 'red hair', outfit: 'battle armor', markers: 'sword' }
```

**Step 2: 更新 assembleCoherentPrompt.test.ts 中的集成测试**

将 `full prompt assembly pipeline` 测试中的 `anchor` 字段改为 `face + outfit + markers`。

**Step 3: Run full test suite**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All tests pass

**Step 4: Commit**

---

### Task 5: 端到端验证

**Step 1: 运行完整 pipeline 测试**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx vitest run src/renderer/src/services/pipeline/__tests__/ --reporter=verbose`

Expected: All tests pass (除已知的 vision-detail pre-existing failure)

**Step 2: 验证无遗漏的 `.anchor` 引用**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx rg "\.anchor" src/renderer/src/services/pipeline/DirectorPipeline.ts`

Expected: 0 matches (所有 `.anchor` 引用都已替换)

**Step 3: 验证无遗漏的 `SimpleCharacterSchema` 引用**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx rg "SimpleCharacterSchema" src/renderer/src/services/pipeline/`

Expected: 0 matches

**Step 4: 验证无遗漏的 `.build` 引用**

Run: `cd d:\tecx\text\temp-ai-image-master-source && npx rg "\.build[^S\w]" src/renderer/src/services/pipeline/DirectorPipeline.ts`

Expected: 0 matches (不再引用 `.build` 字段，`buildGraph`, `buildSystemPrompt` 等方法名不受影响)

**Step 5: Commit**

---

## 改动总结

| 文件 | 改动类型 | 说明 |
|------|----------|------|
| `schemas/director-schemas.ts` | Schema 修改 | CharacterAnchorSchema: 4 字段; 删除 SimpleCharacterSchema |
| `DirectorPipeline.ts` | 8 处引用修改 | `.anchor` → `buildAnchorFromFields(c)`; 提取为模块级函数 |
| `DirectorPipeline.ts` | 函数精简 | `buildNaturalDescriptor` 删除 anchor fallback 分支 |
| `DirectorPipeline.ts` | import 清理 | 删除 `SimpleCharacterSchema` import |
| `pass2-character-anchors.md` | 模板更新 | 3 字段指令（face + outfit + markers） |
| `DirectorPipeline.recovery.test.ts` | 测试重写 | 新 schema 验证 + 测试数据更新 |
| `assembleCoherentPrompt.test.ts` | 测试更新 | 测试数据从 anchor → face+outfit |

**预期效果：** LLM 输出 token 减少 ~33%（每角色 4 字段 vs 6 字段），Pass 2 速度提升，`buildNaturalDescriptor` 结构化路径质量不变。
