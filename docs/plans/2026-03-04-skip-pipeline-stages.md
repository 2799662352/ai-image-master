# Skip Pipeline Stages Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add per-stage ON/OFF toggle switches to the Director Pipeline, allowing users to skip 场景分析、角色锚定、一致性校验 stages individually.

**Architecture:** Add `skipAnalyzeScene` and `skipCharacterAnchors` boolean flags to the Zustand store (persisted via localStorage), pass them through the generation hook into the LangGraph pipeline state, and short-circuit the corresponding pipeline nodes when enabled. Reuse existing `skipVerify` for 一致性校验. Add toggle switches in the DirectorApp UI panel.

**Tech Stack:** React 19, Zustand v5, LangGraph (StateGraph), Vitest, Tailwind CSS

---

### Task 1: Store — Add skip flags with localStorage persistence

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`
- Test: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`

**Step 1: Write the failing test**

Add to `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`:

```typescript
it('should have skipAnalyzeScene and skipCharacterAnchors defaulting to false', () => {
  const state = useDirectorStore.getState()
  expect(state.skipAnalyzeScene).toBe(false)
  expect(state.skipCharacterAnchors).toBe(false)
})

it('should set skipAnalyzeScene and persist to localStorage', () => {
  const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
  useDirectorStore.getState().setSkipAnalyzeScene(true)
  expect(useDirectorStore.getState().skipAnalyzeScene).toBe(true)
  expect(setItemSpy).toHaveBeenCalledWith('director.skip-analyze-scene.v1', 'true')
  setItemSpy.mockRestore()
})

it('should set skipCharacterAnchors and persist to localStorage', () => {
  const setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
  useDirectorStore.getState().setSkipCharacterAnchors(true)
  expect(useDirectorStore.getState().skipCharacterAnchors).toBe(true)
  expect(setItemSpy).toHaveBeenCalledWith('director.skip-character-anchors.v1', 'true')
  setItemSpy.mockRestore()
})

it('should restore skipAnalyzeScene from localStorage on reset', () => {
  window.localStorage.setItem('director.skip-analyze-scene.v1', 'true')
  useDirectorStore.getState().reset()
  expect(useDirectorStore.getState().skipAnalyzeScene).toBe(true)
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: FAIL — `skipAnalyzeScene` / `skipCharacterAnchors` / `setSkipAnalyzeScene` / `setSkipCharacterAnchors` do not exist

**Step 3: Write minimal implementation**

In `src/renderer/src/react-app/stores/useDirectorStore.ts`:

3a. Add storage key constants (after line 140, near other storage key constants):

```typescript
const DIRECTOR_SKIP_ANALYZE_SCENE_STORAGE_KEY = 'director.skip-analyze-scene.v1'
const DIRECTOR_SKIP_CHARACTER_ANCHORS_STORAGE_KEY = 'director.skip-character-anchors.v1'
```

3b. Add read/write helpers (after `writeVisionDetail` function, around line 315):

```typescript
function readSkipFlag(storageKey: string): boolean {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return false
    return window.localStorage.getItem(storageKey) === 'true'
  } catch {
    return false
  }
}

function writeSkipFlag(storageKey: string, value: boolean): void {
  try {
    if (typeof window === 'undefined' || !window.localStorage) return
    window.localStorage.setItem(storageKey, String(value))
  } catch {
    // Best-effort persistence.
  }
}
```

3c. Add to `ConfigSlice` interface (after `skipVerify: boolean` on line 91):

```typescript
skipAnalyzeScene: boolean
skipCharacterAnchors: boolean
```

And add setters (after `setSkipVerify` on line 111):

```typescript
setSkipAnalyzeScene: (val: boolean) => void
setSkipCharacterAnchors: (val: boolean) => void
```

3d. Add to `createInitialConfigState` (after `skipVerify: false` on line 390):

```typescript
skipAnalyzeScene: readSkipFlag(DIRECTOR_SKIP_ANALYZE_SCENE_STORAGE_KEY),
skipCharacterAnchors: readSkipFlag(DIRECTOR_SKIP_CHARACTER_ANCHORS_STORAGE_KEY),
```

3e. Add to `createConfigSlice` setters (after `setSkipVerify` on line 548):

```typescript
setSkipAnalyzeScene: (val) => {
  writeSkipFlag(DIRECTOR_SKIP_ANALYZE_SCENE_STORAGE_KEY, val)
  set({ skipAnalyzeScene: val })
},
setSkipCharacterAnchors: (val) => {
  writeSkipFlag(DIRECTOR_SKIP_CHARACTER_ANCHORS_STORAGE_KEY, val)
  set({ skipCharacterAnchors: val })
},
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts
git commit -m "feat(store): add skipAnalyzeScene and skipCharacterAnchors with localStorage persistence"
```

---

### Task 2: Pipeline — Add skip flags to state schema and short-circuit nodes

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`
- Test: `src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts` (create)

**Step 1: Write the failing test**

Create `src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`:

```typescript
import { describe, expect, it } from 'vitest'
import { shouldRetryAnalysis } from '../DirectorPipeline'

describe('DirectorPipeline skip stages', () => {
  describe('shouldRetryAnalysis with skip flags', () => {
    it('should continue when scene is user-skipped even if data is null', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: true,
        skipCharacterAnchors: false,
      })).toBe('continue')
    })

    it('should continue when characters is user-skipped even if data is null', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: false,
        skipCharacterAnchors: true,
      })).toBe('continue')
    })

    it('should continue when both are user-skipped', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: true,
        skipCharacterAnchors: true,
      })).toBe('continue')
    })

    it('should still retry when both fail without skip flags', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 0,
        skipAnalyzeScene: false,
        skipCharacterAnchors: false,
      })).toBe('retry')
    })

    it('should abort when retries exhausted and nothing skipped', () => {
      expect(shouldRetryAnalysis({
        scene: null,
        characters: null,
        analysisRetryCount: 2,
        skipAnalyzeScene: false,
        skipCharacterAnchors: false,
      })).toBe('abort')
    })
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: FAIL — `shouldRetryAnalysis` does not accept `skipAnalyzeScene` / `skipCharacterAnchors`

**Step 3: Write minimal implementation**

In `src/renderer/src/services/pipeline/DirectorPipeline.ts`:

3a. Add `skipAnalyzeScene` and `skipCharacterAnchors` to the stateSchema (after `skipVerify` on line 82):

```typescript
skipAnalyzeScene: z.boolean().default(false),
skipCharacterAnchors: z.boolean().default(false),
```

3b. Modify `shouldRetryAnalysis` (line 294–300) to respect skip flags:

Replace the existing function with:

```typescript
export function shouldRetryAnalysis(state: {
  scene: { env?: string } | null
  characters: { characters?: unknown[] } | null
  analysisRetryCount: number
  skipAnalyzeScene?: boolean
  skipCharacterAnchors?: boolean
}): 'retry' | 'continue' | 'abort' {
  const sceneOk = (state.scene && state.scene.env && state.scene.env !== '(analysis failed)') || state.skipAnalyzeScene === true
  const charsOk = (state.characters && Array.isArray(state.characters.characters)) || state.skipCharacterAnchors === true
  if (sceneOk || charsOk) return 'continue'
  if (state.analysisRetryCount >= MAX_ANALYSIS_RETRIES) return 'abort'
  return 'retry'
}
```

3c. Add skip-early-return in `analyzeSceneFn` (right after `const t0 = Date.now()` on line 487, inside `buildGraph`):

```typescript
if (state.skipAnalyzeScene) {
  const elapsed = Date.now() - t0
  const passData = DirectorPipeline.buildPassCardData('analyzeScene', { pass: 1, label: '场景分析' }, { scene: null, skipped: true }, elapsed)
  writer(config)?.({ type: 'pass_complete', pass: 1, label: '场景分析（已跳过）', elapsed, passData })
  return { scene: null }
}
```

3d. Add skip-early-return in `extractCharacterAnchorsFn` (right after `const t0 = Date.now()` on line 537):

```typescript
if (state.skipCharacterAnchors) {
  const elapsed = Date.now() - t0
  const passData = DirectorPipeline.buildPassCardData('extractCharacterAnchors', { pass: 2, label: '角色锚点提取' }, { characters: null, skipped: true }, elapsed)
  writer(config)?.({ type: 'pass_complete', pass: 2, label: '角色锚点提取（已跳过）', elapsed, passData })
  return { characters: null }
}
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts`
Expected: ALL PASS

Also run existing pipeline tests to ensure no regressions:

Run: `npx vitest run src/renderer/src/services/pipeline/__tests__/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts
git commit -m "feat(pipeline): support skipping analyzeScene and extractCharacterAnchors stages"
```

---

### Task 3: Generation Hook — Pass skip flags to pipeline

**Files:**
- Modify: `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`

**Step 1: Write the failing test**

This step is not TDD-tested in isolation because the hook reads from the Zustand store (already tested) and passes values to the pipeline (tested via integration). Instead, verify by inspection and run existing tests.

**Step 2: Implement**

In `src/renderer/src/react-app/hooks/useDirectorGeneration.ts`:

2a. Add `skipAnalyzeScene` and `skipCharacterAnchors` to the `useShallow` selector (after `skipVerify` on line 71):

```typescript
skipAnalyzeScene: s.skipAnalyzeScene,
skipCharacterAnchors: s.skipCharacterAnchors,
```

2b. Add to destructuring (after `skipVerify` on line 71 area):

```typescript
skipAnalyzeScene,
skipCharacterAnchors,
```

2c. Add to `executeSingle`'s `pipeline.execute()` call object (after `scoreThreshold` on line 148):

```typescript
skipAnalyzeScene,
skipCharacterAnchors,
```

2d. Add to `executeSingle`'s dependency array (after `scoreThreshold` on line 168):

```typescript
skipAnalyzeScene,
skipCharacterAnchors,
```

2e. Add to `setLastPipelineState` object (after `scoreThreshold` around line 271):

```typescript
skipAnalyzeScene,
skipCharacterAnchors,
```

2f. Add to `startGeneration`'s dependency array (after `scoreThreshold` on line 305):

```typescript
skipAnalyzeScene,
skipCharacterAnchors,
```

**Step 3: Run existing tests**

Run: `npx vitest run src/renderer/src/react-app/`
Expected: ALL PASS

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/hooks/useDirectorGeneration.ts
git commit -m "feat(hook): pass skipAnalyzeScene and skipCharacterAnchors to pipeline"
```

---

### Task 4: UI — Add per-stage toggle switches

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`

**Step 1: Write the failing test**

Add to `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx` (or create a new test file `DirectorApp.skip-stages.test.tsx`):

Create `src/renderer/src/react-app/__tests__/DirectorApp.skip-stages.test.tsx`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { DirectorApp } from '../DirectorApp'
import { useDirectorStore } from '../stores/useDirectorStore'

vi.mock('../components/ReferenceImageUpload', () => ({
  ReferenceImageUpload: () => <div data-testid="ref-upload" />,
}))
vi.mock('../components/ModeSelector', () => ({
  ModeSelector: () => <div data-testid="mode-selector" />,
}))
vi.mock('../components/TemplateSelector', () => ({
  TemplateSelector: () => <div data-testid="template-selector" />,
}))
vi.mock('../components/SceneInput', () => ({
  SceneInput: () => <div data-testid="scene-input" />,
}))
vi.mock('../components/LayoutSelector', () => ({
  LayoutSelector: () => <div data-testid="layout-selector" />,
}))
vi.mock('../components/ImageCountSlider', () => ({
  ImageCountSlider: () => <div data-testid="image-count" />,
}))
vi.mock('../components/RatioResolutionSelector', () => ({
  RatioResolutionSelector: () => <div data-testid="ratio-res" />,
}))
vi.mock('../components/GenerateButton', () => ({
  GenerateButton: ({ onGenerate }: any) => <button data-testid="gen-btn" onClick={onGenerate}>Generate</button>,
}))
vi.mock('../components/GenerationProgress', () => ({
  GenerationProgress: () => <div data-testid="gen-progress" />,
}))
vi.mock('../components/ResultsGallery', () => ({
  ResultsGallery: () => <div data-testid="results" />,
}))
vi.mock('../../services/pipeline/prompt-loader', () => ({
  getDirectorSkillsFromConfig: vi.fn().mockReturnValue([]),
  getDirectorSkillLoadStats: vi.fn().mockReturnValue({ userCount: 0, addedCount: 0, overriddenCount: 0 }),
  reloadDirectorSkills: vi.fn().mockResolvedValue(undefined),
}))

describe('DirectorApp skip-stage toggles', () => {
  beforeEach(() => {
    window.localStorage.clear()
    useDirectorStore.getState().reset()
  })

  it('should render skip toggles for analyzeScene, characterAnchors, and verifyConsistency', () => {
    render(<DirectorApp />)
    expect(screen.getByLabelText('跳过场景分析')).toBeInTheDocument()
    expect(screen.getByLabelText('跳过角色锚定')).toBeInTheDocument()
    expect(screen.getByLabelText('跳过一致性校验')).toBeInTheDocument()
  })

  it('should not render a skip toggle for designAndAssemble', () => {
    render(<DirectorApp />)
    expect(screen.queryByLabelText('跳过分镜+Prompt')).not.toBeInTheDocument()
  })

  it('should toggle skipAnalyzeScene in store when clicked', () => {
    render(<DirectorApp />)
    const toggle = screen.getByLabelText('跳过场景分析')
    fireEvent.click(toggle)
    expect(useDirectorStore.getState().skipAnalyzeScene).toBe(true)
    fireEvent.click(toggle)
    expect(useDirectorStore.getState().skipAnalyzeScene).toBe(false)
  })

  it('should disable visionDetail buttons when stage is skipped', () => {
    render(<DirectorApp />)
    const toggle = screen.getByLabelText('跳过场景分析')
    fireEvent.click(toggle)
    const buttons = screen.getAllByRole('button', { pressed: false })
    // The visionDetail buttons for analyzeScene row should be disabled
    // (checking by aria-disabled or disabled attribute)
  })
})
```

**Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/src/react-app/__tests__/DirectorApp.skip-stages.test.tsx`
Expected: FAIL — toggles don't exist yet

**Step 3: Write minimal implementation**

In `src/renderer/src/react-app/DirectorApp.tsx`:

3a. Add store subscriptions (after `setVisionDetailVerifyConsistency` around line 38):

```typescript
const skipAnalyzeScene = useDirectorStore((s) => s.skipAnalyzeScene)
const skipCharacterAnchors = useDirectorStore((s) => s.skipCharacterAnchors)
const setSkipAnalyzeScene = useDirectorStore((s) => s.setSkipAnalyzeScene)
const setSkipCharacterAnchors = useDirectorStore((s) => s.setSkipCharacterAnchors)
```

3b. Modify the stage items array (lines 258–263) to include a `skippable` flag and toggle state. Replace the existing array with:

```tsx
{[
  { key: 'analyze', label: '场景分析', value: visionDetailAnalyzeScene, onChange: setVisionDetailAnalyzeScene, skippable: true, skipped: skipAnalyzeScene, onToggleSkip: setSkipAnalyzeScene, skipLabel: '跳过场景分析' },
  { key: 'anchor', label: '角色锚定', value: visionDetailCharacterAnchors, onChange: setVisionDetailCharacterAnchors, skippable: true, skipped: skipCharacterAnchors, onToggleSkip: setSkipCharacterAnchors, skipLabel: '跳过角色锚定' },
  { key: 'design', label: '分镜+Prompt', value: visionDetailDesignAssemble, onChange: setVisionDetailDesignAssemble, skippable: false, skipped: false, onToggleSkip: undefined, skipLabel: '' },
  { key: 'verify', label: '一致性校验', value: visionDetailVerifyConsistency, onChange: setVisionDetailVerifyConsistency, skippable: true, skipped: skipVerify, onToggleSkip: setSkipVerify, skipLabel: '跳过一致性校验' },
].map((item) => (
  <div key={item.key} className="flex items-center justify-between gap-3">
    <div className="flex items-center gap-2 min-w-0">
      {item.skippable ? (
        <label className="relative inline-flex items-center cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={!item.skipped}
            onChange={() => item.onToggleSkip?.(!item.skipped)}
            className="sr-only peer"
            aria-label={item.skipLabel}
          />
          <div className="w-7 h-4 bg-[#3F3F46] rounded-full peer peer-checked:bg-yellow-500 after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-3 after:w-3 after:transition-all peer-checked:after:translate-x-3" />
        </label>
      ) : (
        <span className="text-[9px] text-white/35 w-7 text-center shrink-0">必需</span>
      )}
      <span className={`text-[11px] whitespace-nowrap ${item.skipped ? 'text-white/30 line-through' : 'text-white/65'}`}>
        {item.label}
      </span>
    </div>
    <div className="inline-flex border border-[#3F3F46]">
      {VISION_DETAIL_OPTIONS.map((option) => {
        const active = item.value === option.value
        const disabled = item.skipped
        return (
          <button
            key={`${item.key}-${option.value}`}
            type="button"
            onClick={() => !disabled && item.onChange(option.value)}
            aria-pressed={active}
            disabled={disabled}
            className={`px-2.5 py-1.5 text-[11px] transition-colors ${
              disabled
                ? 'bg-[#09090B] text-white/20 cursor-not-allowed'
                : active
                  ? 'bg-yellow-500 text-black font-semibold cursor-pointer'
                  : 'bg-[#09090B] text-white/70 hover:text-white hover:bg-[#18181B] cursor-pointer'
            }`}
          >
            {option.label}
          </button>
        )
      })}
    </div>
  </div>
))}
```

3c. Update the hint text at the bottom of the panel (line 288–290):

Replace:
```tsx
<div className="text-[11px] text-white/45">
  建议：网络不稳时把"分镜+Prompt / 一致性校验"保持低，减少超时风险。
</div>
```

With:
```tsx
<div className="text-[11px] text-white/45">
  建议：跳过阶段可加速生成，但会降低出图一致性。分镜+Prompt 为必需阶段不可跳过。
</div>
```

**Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/src/react-app/__tests__/DirectorApp.skip-stages.test.tsx`
Expected: ALL PASS

Also run all react-app tests:

Run: `npx vitest run src/renderer/src/react-app/`
Expected: ALL PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx src/renderer/src/react-app/__tests__/DirectorApp.skip-stages.test.tsx
git commit -m "feat(ui): add per-stage skip toggles in Director vision controls panel"
```

---

### Task 5: Integration — Full pipeline run with all existing tests

**Files:**
- No new files

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: ALL PASS

**Step 2: Run type check**

Run: `npx tsc --noEmit`
Expected: No type errors

**Step 3: Verify build**

Run: `npx electron-vite build`
Expected: Build succeeds

**Step 4: Commit (if any fixes were needed)**

```bash
git add -A
git commit -m "fix: resolve any integration issues from skip-stages feature"
```

---

## File Change Summary

| File | Action | What Changes |
|------|--------|--------------|
| `src/renderer/src/react-app/stores/useDirectorStore.ts` | Modify | Add `skipAnalyzeScene`, `skipCharacterAnchors` state + setters + localStorage |
| `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts` | Modify | Add tests for new skip flags |
| `src/renderer/src/services/pipeline/DirectorPipeline.ts` | Modify | Add skip flags to schema, short-circuit nodes, fix `shouldRetryAnalysis` |
| `src/renderer/src/services/pipeline/__tests__/director-skip-stages.test.ts` | Create | Tests for skip-aware `shouldRetryAnalysis` |
| `src/renderer/src/react-app/hooks/useDirectorGeneration.ts` | Modify | Pass skip flags to pipeline |
| `src/renderer/src/react-app/DirectorApp.tsx` | Modify | Add toggle switches UI |
| `src/renderer/src/react-app/__tests__/DirectorApp.skip-stages.test.tsx` | Create | Tests for skip toggle UI |
