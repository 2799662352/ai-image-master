# Director Pipeline Quality Improvements

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix system prompt alignment, code review issues, and UI improvements to dramatically improve LangChain Director output quality.

**Architecture:** Update `cinematicGemSystemPrompt` to describe all 14 schema fields, fix `buildFinalPrompt` redundancy, complete `lastParsedPanels` field mapping, add missing tests.

**Tech Stack:** TypeScript, Zod 4, Vitest, Electron, electron-vite

---

### Task 1: Fix buildFinalPrompt scene spread redundancy (C1)

**Files:**
- Modify: `src/renderer/src/services/LangChainDirectorService.ts:188-194`
- Test: `tests/services/LangChainDirectorService.test.ts`

**Step 1: Write failing test for scene output**

```typescript
it('should output scene fields without duplication', () => {
  const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
  const result = service.buildFinalPrompt(makeResponse(), 'g', 's', 'd', 'x')
  const parsed = JSON.parse(result)
  expect(parsed.scene.bgm.base).toBe('ambient drone')
  expect(parsed.scene.tension).toBe('test dramatic tension')
  expect(parsed.scene.shot_flow).toContain('S1')
  expect(Object.keys(parsed.scene)).toEqual(['d', 'cap', 'env', 'bgm', 'tension', 'shot_flow'])
})
```

**Step 2: Run test to verify it passes (existing code is functionally correct, just redundant)**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: PASS (spread + explicit assignment produces same result)

**Step 3: Simplify buildFinalPrompt scene construction**

Replace lines 188-194:
```typescript
// BEFORE (redundant):
scene: {
  ...response.scene,
  bgm: response.scene.bgm,
  tension: response.scene.tension,
  shot_flow: response.scene.shot_flow
},

// AFTER (clean):
scene: response.scene,
```

**Step 4: Run test to verify it still passes**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: ALL pass

**Step 5: Commit**

```bash
git add src/renderer/src/services/LangChainDirectorService.ts tests/services/LangChainDirectorService.test.ts
git commit -m "fix: remove redundant scene spread in buildFinalPrompt (C1)"
```

---

### Task 2: Add 9-shot integration tests

**Files:**
- Modify: `tests/services/LangChainDirectorService.test.ts`

**Step 1: Add test helpers for 9-shot responses**

```typescript
const make9Response = () => ({
  ...SCENE_FIELDS,
  character_anchor: 'Young woman, black hair',
  shots: Array.from({ length: 9 }, (_, i) => makeShot({
    kf: `KF${i + 1} - ${['EWS', 'WS', 'FS', 'MCU', 'CU', 'ECU', 'FS', 'WS', 'CU'][i]} - ${i + 1}s`,
    lens: `${[24, 35, 50, 85, 85, 105, 50, 35, 85][i]}mm static`,
    label: `分镜${i + 1}`,
    micro_expression: i % 2 === 0 ? `composure -> shift -> resolve (shot ${i + 1})` : null,
    color_grade: i < 5 ? '#CBBFA2 warm amber, Kodak grain' : null,
    atmosphere: i % 3 === 0 ? 'dust density 5/10' : null,
    body_physics: i === 0 ? 'lean 10deg forward against wind' : null,
    composition: i === 4 ? 'rule of thirds, subject at intersection' : null,
    emotion_target: i < 3 ? `tension level ${i + 1}` : null,
    seq: i > 0 ? `match cut from KF${i}` : null,
    motion: i === 2 ? 'arms: high, legs: low' : null
  }))
})
```

**Step 2: Add 9-shot buildFinalPrompt test**

```typescript
describe('9-shot integration', () => {
  it('should produce valid JSON for 9-shot response', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = service.buildFinalPrompt(make9Response(), 'grid 3x3', 'cinematic', 'story', 'constraints')
    const parsed = JSON.parse(result)
    expect(parsed.p).toHaveLength(9)
    expect(parsed.p[0].sh).toContain('KF1')
    expect(parsed.p[8].sh).toContain('KF9')
  })

  it('should include filled nullable fields across 9 shots', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const result = service.buildFinalPrompt(make9Response(), 'g', 's', 'd', 'x')
    const parsed = JSON.parse(result)
    const filledME = parsed.p.filter((p: any) => p.me).length
    const filledCG = parsed.p.filter((p: any) => p.cg).length
    expect(filledME).toBe(5)
    expect(filledCG).toBe(5)
  })

  it('should produce readable natural language for 9 shots', () => {
    const service = new LangChainDirectorService({ apiKey: 'k', baseURL: 'https://test.com' })
    const nl = service.shotsToNaturalLanguage(make9Response().shots)
    const lines = nl.split('\n')
    expect(lines).toHaveLength(9)
    expect(lines[0]).toStartWith('1.')
    expect(lines[8]).toStartWith('9.')
    expect(nl).toContain('composure -> shift -> resolve')
  })
})
```

**Step 3: Run tests**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: ALL pass

**Step 4: Commit**

```bash
git add tests/services/LangChainDirectorService.test.ts
git commit -m "test: add 9-shot integration tests for buildFinalPrompt and shotsToNaturalLanguage"
```

---

### Task 3: Fix lastParsedPanels field mapping (C2)

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:2195-2198`

**Step 1: Locate and update lastParsedPanels mapping**

Replace lines 2195-2198:
```typescript
// BEFORE (missing 6 nullable fields):
this.lastParsedPanels = shotsResponse.shots.map((shot, i) => ({
  id: i + 1, shot: shot.kf, lens: shot.lens,
  spatial: shot.spatial, action: shot.action, light: shot.light
}))

// AFTER (complete fields):
this.lastParsedPanels = shotsResponse.shots.map((shot, i) => ({
  id: i + 1,
  shot: shot.kf,
  lens: shot.lens,
  spatial: shot.spatial,
  action: shot.action,
  light: shot.light,
  ...(shot.micro_expression && { micro_expression: shot.micro_expression }),
  ...(shot.color_grade && { color_grade: shot.color_grade }),
  ...(shot.atmosphere && { atmosphere: shot.atmosphere }),
  ...(shot.body_physics && { body_physics: shot.body_physics }),
  ...(shot.composition && { composition: shot.composition }),
  ...(shot.emotion_target && { emotion_target: shot.emotion_target })
}))
```

**Step 2: Update JsonPromptPanel type if needed**

Check `JsonPromptPanel` type definition and add optional fields if missing.

**Step 3: Run build to verify no TypeScript errors**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "fix: add 6 nullable fields to lastParsedPanels mapping (C2)"
```

---

### Task 4: Align system prompt output_format with 14-field schema (I2)

**Files:**
- Modify: `src/renderer/src/pages/DirectorPage.ts:447-486` (cinematicGemSystemPrompt)

**Step 1: Update `<output_format>` from 8 to 14 fields**

Replace LAYER 3 section (lines 459-470):
```
LAYER 3 — Shots (per-keyframe):
Required (always fill):
- kf: KF number + shot type + duration (e.g. "KF3 - MCU - 2s")
- lens: focal length + camera movement (e.g. "85mm slow push-in")
- spatial: {fg, mg, bg} three depth layers
- action: anchor verb + manner words (e.g. "leans forward against wind, coat pressed flat")
- light: source + direction + quality + color temp (e.g. "upper-left window, hard warm 4500K, key-to-fill 3:1")
- label: panel label (e.g. "分镜3")

Nullable (fill when applicable, null ONLY when genuinely N/A):
- micro_expression: Start → transition → end micro-arc (null for non-character or wide shots)
- color_grade: dominant HEX + accent + film texture (null only if default neutral palette)
- atmosphere: physical medium + density between camera and subject (null only if perfectly clear air)
- body_physics: body-environment force interaction (null only if completely static pose)
- composition: composition principle applied (null only if standard centered framing)
- emotion_target: intended audience emotion for this shot (null only if emotionally neutral)
- seq: connection/transition to neighboring shots (null only if standalone)
- motion: per-body-part motion intensity (null only if completely static)

FILL RATE GOAL: For cinematic sequences, aim to fill 6+ of 8 nullable fields per shot. Null means "genuinely not applicable", not "I forgot".
```

**Step 2: Rewrite `<director_thinking_guide>` to reference output fields**

Replace lines 472-486:
```
<director_thinking_guide>
When designing shots, use these guides to fill the corresponding output fields:
- scene.d: Narrative arc with 3 beats (Setup → Build/Turn → Payoff)
- scene.tension: Core dramatic tension driving the sequence
- scene.bgm: Sound design layers (ambient + environment + foley + melody/silence)
- character_anchor: Invariant visual anchors across all shots
- shots[].seq: Shot-to-shot flow (match cuts, reverse angles, time jumps)
- shots[].composition: Multi-granularity changes (coarse composition, medium action, fine shadow)
- shots[].body_physics: How gravity, wind, fatigue, temperature affect posture
- shots[].color_grade: Dominant/accent color hierarchy (80/20 rule), film texture
- shots[].emotion_target: Emotion-shot type matching (CU→vulnerability, EWS→isolation)
</director_thinking_guide>
```

**Step 3: Remove conflicting "combine into" instructions from action and light field descriptions**

In the output_format, action should NOT say "(combine physical forces into this field)" and light should NOT say "(combine color grading into this field)".

**Step 4: Build and verify**

Run: `npm run build:vite`
Expected: Build succeeds

**Step 5: Commit**

```bash
git add src/renderer/src/pages/DirectorPage.ts
git commit -m "feat: align system prompt output_format with 14-field Zod schema (I2)"
```

---

### Task 5: Remove dead code and cleanup (M1, M3)

**Files:**
- Modify: `src/renderer/src/services/LangChainDirectorService.ts:66`
- Modify: `src/renderer/src/services/ServiceBridge.ts:1011`

**Step 1: Remove ShotsResponseSchema alias**

Delete line 66:
```typescript
// DELETE THIS LINE:
export const ShotsResponseSchema = SceneResponseSchema
```

Check if it's imported anywhere first:
Run: `rg "ShotsResponseSchema" src/`

**Step 2: Hash API key in cache key to prevent log leaks**

Replace line 1011:
```typescript
// BEFORE:
const cacheKey = `${apiKey}|${baseURL}|${model || ''}`

// AFTER:
const keyHash = apiKey.slice(-4)
const cacheKey = `***${keyHash}|${baseURL}|${model || ''}`
```

**Step 3: Run tests**

Run: `npx vitest run tests/services/LangChainDirectorService.test.ts`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/LangChainDirectorService.ts src/renderer/src/services/ServiceBridge.ts
git commit -m "chore: remove dead ShotsResponseSchema alias, mask API key in cache key (M1, M3)"
```

---

### Task 6: Remove unused @langchain/google dependency

**Files:**
- Modify: `package.json`

**Step 1: Verify no imports**

Run: `rg "@langchain/google" src/`
Expected: No matches

**Step 2: Uninstall**

Run: `npm uninstall @langchain/google`

**Step 3: Verify tests still pass**

Run: `npx vitest run`
Expected: ALL pass

**Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: remove unused @langchain/google dependency"
```

---

### Task 7: Build and verify all changes

**Step 1: Run full test suite**

Run: `npx vitest run`
Expected: 22+ tests pass (19 existing + 3 new)

**Step 2: Build production**

Run: `npm run build:vite`
Expected: Build succeeds

**Step 3: Manual verification in Electron**

1. Ctrl+R to reload
2. Go to Director Mode → select cinematic template + 9grid
3. Check console for `LangChain final prompt length` and nullable field counts
4. Go to Understand page → verify textarea is taller (250px min-height)
5. Press F12 → verify DevTools opens

**Step 4: Final commit if any adjustments**

```bash
git add -A
git commit -m "verify: all quality improvements working"
git push
```
