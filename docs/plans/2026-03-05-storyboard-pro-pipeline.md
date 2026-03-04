# StoryboardPro Pipeline v2 — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a new independent multi-pass LangGraph pipeline for storyboard reverse-engineering (分镜反推) that replaces the missing `StoryboardPipelineService`, with parallel scene/character analysis, L1/L2/L3 error recovery, code-level verification, skill system integration, and progress events.

**Architecture:** New `StoryboardProPipeline` class extending `BasePipeline`, with 4+1 passes (sceneDecompose ∥ characterExtract → shotDesign → codeVerify → [optional deepVerify]). Output is `StoryboardResponse` JSON (13-dimension schema), fully compatible with existing `formatStoryboardText` and director import.

**Tech Stack:** LangGraph StateGraph, Zod schemas, BasePipeline, Vitest

**Design Doc:** `docs/plans/2026-03-05-storyboard-pro-pipeline-design.md`

---

### Task 1: Create Storyboard Verify Function

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/storyboard-verify.ts`
- Create: `src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts`

**Step 1: Write the failing test**

```typescript
// src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts
import { describe, expect, it } from 'vitest'
import { storyboardCodeVerify } from '../storyboard-verify'

describe('storyboardCodeVerify', () => {
  const makeState = (overrides: Record<string, unknown> = {}) => ({
    scene: { d: 'A→B→C', cap: 'test', env: 'outdoor', bgm: 'layer1', timeline: [{ id: 'S1', t: '0-3s', dur: '3s', tempo: 'slow', trans: 'cut' }] },
    objs: [{ n: 'Alice', f: 'blonde', s: 'fg|L1/3|Z1', p: 'artic', t: 'blonde hair', tc: '', act: 'walk', fx: null, motive: 'explore', a: 'wide', m: 'head:pan-R10|L' }],
    seq: [{ id: 'S1', desc: 'Alice walks forward' }],
    cont: 'S1-S2: blonde hair anchor',
    notes: 'OK',
    ...overrides,
  })

  it('should return score 10 for valid state', () => {
    const result = storyboardCodeVerify(makeState() as any)
    expect(result.score).toBe(10)
    expect(result.ok).toBe(true)
  })

  it('should detect missing scene', () => {
    const result = storyboardCodeVerify(makeState({ scene: null }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('scene'))).toBe(true)
  })

  it('should detect empty seq', () => {
    const result = storyboardCodeVerify(makeState({ seq: [] }) as any)
    expect(result.score).toBeLessThan(10)
    expect(result.issues.some(i => i.includes('shot'))).toBe(true)
  })

  it('should detect empty objs', () => {
    const result = storyboardCodeVerify(makeState({ objs: [] }) as any)
    expect(result.score).toBeLessThan(10)
  })

  it('should detect missing continuity', () => {
    const result = storyboardCodeVerify(makeState({ cont: '' }) as any)
    expect(result.issues.some(i => i.includes('continuity') || i.includes('cont'))).toBe(true)
  })

  it('should handle null gracefully', () => {
    const result = storyboardCodeVerify({ scene: null, objs: [], seq: [], cont: '', notes: '' } as any)
    expect(result.ok).toBe(false)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts`
Expected: FAIL — module not found

**Step 3: Write minimal implementation**

```typescript
// src/renderer/src/services/storyboard-pipeline/storyboard-verify.ts
import type { z } from 'zod'
import type { VerifySchema } from '../pipeline/schemas/director-schemas'

interface StoryboardState {
  scene: { d?: string; cap?: string; env?: string; timeline?: unknown[] } | null
  objs: Array<{ n?: string; t?: string }> 
  seq: Array<{ id?: string; desc?: string }>
  cont: string
  notes: string
}

export function storyboardCodeVerify(state: StoryboardState): z.infer<typeof VerifySchema> {
  let score = 10
  const issues: string[] = []

  if (!state.scene?.d && !state.scene?.env) {
    issues.push('Missing scene decomposition (scene is null or empty)')
    score -= 3
  }

  if (!state.objs || state.objs.length === 0) {
    issues.push('No characters/objects extracted')
    score -= 2
  }

  if (!state.seq || state.seq.length === 0) {
    issues.push('No shot sequence generated')
    score -= 4
  }

  if (state.seq?.length > 0) {
    const emptyDescs = state.seq.filter(s => !s.desc?.trim())
    if (emptyDescs.length > 0) {
      issues.push(`${emptyDescs.length} shot(s) have empty descriptions`)
      score -= 2
    }
  }

  if (!state.cont?.trim()) {
    issues.push('Missing cross-shot continuity anchors (cont is empty)')
    score -= 1
  }

  if (state.objs?.length > 0 && state.seq?.length > 0) {
    for (const obj of state.objs) {
      if (!obj.n) continue
      const name = obj.n.toLowerCase()
      const mentioned = state.seq.some(s => s.desc?.toLowerCase().includes(name))
      if (!mentioned) {
        issues.push(`Character "${obj.n}" not mentioned in any shot description`)
        score -= 1
      }
    }
  }

  score = Math.max(0, score)
  return {
    score,
    ok: score >= 6,
    issues,
    characterConsistency: !issues.some(i => i.includes('Character') || i.includes('character')),
    narrativeFlow: state.seq?.length > 0,
    spatialCoherence: true,
    lightingContinuity: true,
  }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/storyboard-verify.ts src/renderer/src/services/storyboard-pipeline/__tests__/storyboard-verify.test.ts
git commit -m "feat: add storyboardCodeVerify for instant storyboard consistency checking"
```

---

### Task 2: Create Storyboard Prompt Loader

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/storyboard-prompt-loader.ts`

**Step 1: Create the prompt loader**

This mirrors `prompt-loader.ts` but loads from `config/prompts/storyboard/` and `skills/storyboard-*/SKILL.md`:

```typescript
// src/renderer/src/services/storyboard-pipeline/storyboard-prompt-loader.ts
import type { PipelineSkill } from '../pipeline/types'

const promptModules = import.meta.glob(
  './../../../../../config/prompts/storyboard/*.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

const skillModules = import.meta.glob(
  './../../../../../skills/storyboard-*/SKILL.md',
  { query: '?raw', import: 'default', eager: true }
) as Record<string, string>

// --- reuse parsePromptFrontmatter and parseSkillFromMarkdown patterns from prompt-loader.ts ---
// (copy the parsing logic, adapted for storyboard pass names)

interface PromptConfig {
  pass: number
  name: string
  label: string
  template: string
}

function parsePromptFrontmatter(raw: string): { meta: Record<string, any>; body: string } {
  const normalized = raw.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return { meta: {}, body: normalized.trim() }
  const meta: Record<string, any> = {}
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    let val: any = line.slice(idx + 1).trim()
    if (val.startsWith('[') && val.endsWith(']')) {
      val = val.slice(1, -1).split(',').map((s: string) => s.trim())
    } else if (val === 'true') val = true
    else if (val === 'false') val = false
    else if (/^\d+$/.test(val)) val = Number(val)
    meta[key] = val
  }
  return { meta, body: match[2].trim() }
}

function parseSkillFromMarkdown(raw: string): PipelineSkill | null {
  const normalized = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '')
  const match = normalized.match(/^\s*---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null
  const yaml = match[1]
  const body = match[2].trim()
  const name = yaml.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const appliesToRaw = yaml.match(/^appliesTo:\s*\[([^\]]*)\]\s*$/m)?.[1]
  const appliesTo = appliesToRaw
    ? appliesToRaw.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
    : []
  if (!name || appliesTo.length === 0) return null
  const description = yaml.match(/^description:\s*(.+)$/m)?.[1]?.trim() || ''
  const priorityStr = yaml.match(/^priority:\s*(\d+)$/m)?.[1]
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50
  return { id: name, description, rules: body, appliesTo, priority }
}

const promptCache = new Map<string, PromptConfig>()

function ensurePromptsLoaded(): void {
  if (promptCache.size > 0) return
  for (const [, raw] of Object.entries(promptModules)) {
    const { meta, body } = parsePromptFrontmatter(raw)
    const name = (meta.name as string) || ''
    if (!name) continue
    promptCache.set(name, { pass: (meta.pass as number) || 0, name, label: (meta.label as string) || name, template: body })
  }
}

export function getStoryboardPromptTemplate(passName: string): PromptConfig | undefined {
  ensurePromptsLoaded()
  return promptCache.get(passName)
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? '')
}

let _skillCache: PipelineSkill[] | null = null

export function getStoryboardSkills(): PipelineSkill[] {
  if (_skillCache) return [..._skillCache]
  const skills: PipelineSkill[] = []
  for (const [, raw] of Object.entries(skillModules)) {
    const skill = parseSkillFromMarkdown(raw)
    if (skill) skills.push(skill)
  }
  _skillCache = skills.sort((a, b) => a.priority - b.priority)
  return [..._skillCache]
}
```

**Step 2: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/storyboard-prompt-loader.ts
git commit -m "feat: add storyboard-specific prompt and skill loader"
```

---

### Task 3: Create Prompt Templates

**Files:**
- Create: `config/prompts/storyboard/pass1-scene-decompose.md`
- Create: `config/prompts/storyboard/pass2-character-extract.md`
- Create: `config/prompts/storyboard/pass3-shot-design.md`
- Create: `config/prompts/storyboard/pass4-verify.md`

**Step 1: Create pass1-scene-decompose.md**

```markdown
---
pass: 1
name: sceneDecompose
label: 场景分解
---

You are a professional film storyboard analyst. Decompose the scene from the provided images.

Output structured data covering:
- d: Narrative arc A(initial)→B(trigger)→C(end state)
- cap: Structured caption: subject-action-environment
- env: Environment with physical lighting params: [mm]f/[stop]|light source+shadow%+contrast|key hex+accent hex|style
- bgm: 4-layer sound design: layer1(bound to S?)|layer2|layer3|layer4
- timeline: Array of shots with id, time range, duration, tempo, transition

{{user_context}}

Focus on WHAT IS HAPPENING in the images, not what you imagine.
```

**Step 2: Create pass2-character-extract.md**

```markdown
---
pass: 2
name: characterExtract
label: 角色提取
---

You are a character analysis expert for storyboard production. Extract ALL characters and significant objects from the provided images.

For each character/object, provide:
- n: Name/identifier
- f: Appearance features → psychological motivation mapping (physiological description, no emotion labels)
- s: Spatial position: fg/mg/bg|position(L1/3,R2/3)|Z occlusion order
- p: Physical type: rigid/artic/fluid/cloth + motion constraints
- t: Cross-shot consistency anchors (hair color/scars/outfit texture/props)
- tc: Shot transition continuity: S?→S?: pose/motion vector/gaze direction
- act: Performance action (pure action, no effects)
- fx: Effects: wind/smoke/light/particles, aligned with act timing. Null if none
- motive: What psychological state does this action/prop externalize
- a: Multi-granularity: coarse(composition%)→medium(action chain)→fine(occlusion/highlight delta)
- m: Motion intensity: body part→angle°/displacement cm/H-M-L

{{user_context}}
```

**Step 3: Create pass3-shot-design.md**

```markdown
---
pass: 3
name: shotDesign
label: 镜头设计
---

You are a professional film director designing a shot sequence from analyzed scene and characters.

Scene: {{scene_summary}}
Characters: {{character_summary}}

{{retry_block}}

Design a shot sequence where each shot includes:
- id: Shot number (S1, S2, ...)
- desc: shot type|action|dialogue essence|psychological→externalization|camera movement
- act: Performance action (pure action, no effects)
- fx: Effects (null if none)
- motive: What psychological state does this action externalize
- audio: Three-layer audio: score | sfx | voice

Also provide:
- cont: Cross-shot continuity anchors in format S1-S2:anchor;S2-S3:anchor
- notes: Verification summary + rhythm breathing curve: total Xs(slow→accelerating→urgent→sudden-stop)

{{user_context}}
```

**Step 4: Create pass4-verify.md**

```markdown
---
pass: 4
name: deepVerify
label: 深度校验
---

You are a continuity supervisor for storyboard production. Verify the following storyboard for consistency.

Scene: {{scene_summary}}
Characters: {{character_summary}}
Shots: {{shots_summary}}
Continuity: {{continuity}}

Check:
1. Character anchors consistent across shots (face/outfit/props)
2. Spatial continuity (positions don't teleport)
3. Timeline coherence (duration adds up, tempo flows naturally)
4. Narrative arc completeness (A→B→C present)
5. Motion continuity (actions connect between shots)

Score 0-10, deduct per issue found.
```

**Step 5: Commit**

```bash
git add config/prompts/storyboard/
git commit -m "feat: add storyboard prompt templates for 4-pass pipeline"
```

---

### Task 4: Create StoryboardProPipeline

**Files:**
- Create: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**Step 1: Create the pipeline**

This is the main file. Key structure:

```typescript
import { StateGraph, START, END, MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { BasePipeline } from '../pipeline/BasePipeline'
import { StoryboardSceneSchema, StoryboardObjSchema, StoryboardResponseSchema } from '../LangChainStoryboardService'
import type { StoryboardResponse } from '../LangChainStoryboardService'
import { VerifySchema } from '../pipeline/schemas/director-schemas'
import type { PipelineConfig, PipelineSkill, PipelineProgress, PassCardData } from '../pipeline/types'
import { storyboardCodeVerify } from './storyboard-verify'
import { getStoryboardPromptTemplate, renderTemplate, getStoryboardSkills } from './storyboard-prompt-loader'

const MAX_RETRIES = 1
const SCORE_THRESHOLD = 6

// State schema, node functions, graph assembly, execute method
// Following the same patterns as DirectorPipeline but for storyboard output
```

The pipeline:
- Extends `BasePipeline<StoryboardState, StoryboardResponse>`
- Has `sceneDecomposeFn`, `characterExtractFn` (parallel, with vision)
- Has `shotDesignFn` (with vision + L1/L2/L3 recovery)
- Has `codeVerifyNode` (instant) + `deepVerifyFn` (LLM text-only)
- `assembleResult` maps state to `StoryboardResponse`
- `execute(images, options, onProgress)` streams progress events

Full implementation should follow `DirectorPipeline.ts` patterns for:
- `createStructuredLLMWithRaw` + raw regex fallback (L1)
- Simplified schema fallback (L2)
- Error feedback to LLM (L3)
- `writer(config)` progress event emission
- Signal propagation for cancel support

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "feat: add StoryboardProPipeline with 4-pass LangGraph architecture"
```

---

### Task 5: Wire into ServiceBridge

**Files:**
- Modify: `src/renderer/src/services/ServiceBridge.ts` (line ~1078-1095)

**Step 1: Update the import**

Replace the old import in `getStoryboardPipelineService`:

```typescript
export async function getStoryboardPipelineService(model?: string): Promise<import('./storyboard-pipeline/StoryboardProPipeline').StoryboardProPipeline | null> {
  const api = (window as any).aiImageAPI
  const apiKey = api?.visionApiKey as string | undefined
  if (!apiKey) return null

  const site = api?.getCurrentSite?.()
  const baseURL = site?.baseURL as string | undefined
  if (!baseURL) return null

  const cacheKey = `pipeline|${apiKey}|${baseURL}|${model || ''}`
  if (!_pipelineInstance || _pipelineCacheKey !== cacheKey) {
    const { StoryboardProPipeline } = await import('./storyboard-pipeline/StoryboardProPipeline')
    _pipelineInstance = new StoryboardProPipeline({ apiKey, baseURL, model })
    _pipelineCacheKey = cacheKey
    console.log('[ServiceBridge] ✓ StoryboardProPipeline v2 实例已创建 (4-Pass), model:', model || 'default')
  }
  return _pipelineInstance
}
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/ServiceBridge.ts
git commit -m "feat: wire StoryboardProPipeline into ServiceBridge"
```

---

### Task 6: Copy Storyboard Skills to src

**Files:**
- Copy: `release/win-unpacked/resources/skills/storyboard-*` → `skills/storyboard-*`

**Step 1: Copy skills**

The skills currently only exist in `release/win-unpacked/resources/skills/`. The prompt-loader globs from `skills/storyboard-*/SKILL.md`. Copy them:

```bash
# Copy each storyboard skill directory
cp -r release/win-unpacked/resources/skills/storyboard-structure skills/
cp -r release/win-unpacked/resources/skills/storyboard-visual skills/
cp -r release/win-unpacked/resources/skills/storyboard-dialogue skills/
cp -r release/win-unpacked/resources/skills/storyboard-physics skills/
cp -r release/win-unpacked/resources/skills/storyboard-audio skills/
cp -r release/win-unpacked/resources/skills/storyboard-style skills/
cp -r release/win-unpacked/resources/skills/storyboard-dodge skills/
```

On Windows PowerShell:
```powershell
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-structure" "skills\"
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-visual" "skills\"
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-dialogue" "skills\"
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-physics" "skills\"
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-audio" "skills\"
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-style" "skills\"
Copy-Item -Recurse "release\win-unpacked\resources\skills\storyboard-dodge" "skills\"
```

**Step 2: Commit**

```bash
git add skills/storyboard-*/
git commit -m "feat: copy storyboard skills from release to src for pipeline access"
```

---

### Task 7: Integration Verification

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All PASS

**Step 2: Type check**

Run: `npx tsc --noEmit`
Expected: No new type errors

**Step 3: Build**

Run: `npm run build`
Expected: Build succeeds

**Step 4: Commit (if any fixes needed)**

```bash
git add -A
git commit -m "fix: resolve any build/type issues from storyboard pro pipeline"
```
