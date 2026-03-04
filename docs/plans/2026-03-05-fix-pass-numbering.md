# Fix Pass Numbering — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix pass numbering conflict where `analyzeScene` and `extractStyleAnchor` both use `pass: 1`, causing the UI to show only one of them. Add "风格锚点" as a visible stage in the UI progress display.

**Architecture:** Three-layer fix: (1) Pipeline pass number reassignment, (2) UI `PASS_DEFS` update to include the new stage, (3) Store `pushProgress` logic already handles dynamic slots via `totalPasses`, so only `totalPasses` needs incrementing. Also update `execute()` to set `totalPasses` correctly.

**Tech Stack:** TypeScript, React, Vitest

---

### Current State

**Pipeline pass numbers (BROKEN):**
```
Pass 0: selectSkills
Pass 1: analyzeScene        ← CONFLICT
Pass 1: extractStyleAnchor  ← CONFLICT (overwrites analyzeScene)
Pass 2: extractCharacterAnchors
Pass 3: designAndAssemble
Pass 4: codeVerify / verifyConsistency
Pass 5: generateImages
```

**Target pass numbers (FIXED):**
```
Pass 0: selectSkills
Pass 1: analyzeScene
Pass 2: extractCharacterAnchors
Pass 3: extractStyleAnchor     ← NEW unique number
Pass 4: designAndAssemble
Pass 5: codeVerify / verifyConsistency
Pass 6: generateImages
```

Note: Passes 1, 2, 3 run in parallel (same superstep) — pass number is for UI ordering, not execution order.

**UI PASS_DEFS (BROKEN):**
```
[技能选择, 场景分析, 角色锚定, 分镜+Prompt, 质量校验, 图像生成]  ← 6 slots, no 风格锚点
```

**Target UI PASS_DEFS (FIXED):**
```
[技能选择, 场景分析, 角色锚定, 风格锚点, 分镜+Prompt, 质量校验, 图像生成]  ← 7 slots
```

---

### Task 1: Reassign Pipeline Pass Numbers

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts`

**Step 1: Update `extractStyleAnchor` pass numbers**

Search for all `pass: 1` occurrences in `extractStyleAnchorFn` and change to `pass: 3`:

There are approximately 5 occurrences within extractStyleAnchor (around lines 931-1028):
- `{ pass: 1, label: '风格锚点' }` → `{ pass: 3, label: '风格锚点' }`
- Multiple `writer(config)?.({ type: 'pass_complete', pass: 1, ...})` → `pass: 3`

**Step 2: Update `designAndAssemble` pass number from 3 to 4**

Search for `pass: 3` in `designAndAssembleFn` and change to `pass: 4`:

There are approximately 5 occurrences (around lines 1050-1200):
- `{ pass: 3, label: '分镜设计+提示词' }` → `{ pass: 4, label: '分镜设计+提示词' }`
- All `writer(config)?.({ type: 'pass_complete', pass: 3, ...})` → `pass: 4`

**Step 3: Update `codeVerify` and `verifyConsistency` pass number from 4 to 5**

Search for `pass: 4` in `codeVerifyNode` and `verifyConsistencyFn`:
- `{ pass: 4, label: '快速校验' }` → `{ pass: 5, label: '快速校验' }`
- `{ pass: 4, label: '一致性校验' }` → `{ pass: 5, label: '一致性校验' }`

**Step 4: Update `generateImages` pass number logic**

In `generateImagesFn` (around line 1340):
```typescript
const passNum = state.skipVerify ? 4 : 5
```
Change to:
```typescript
const passNum = state.skipVerify ? 5 : 6
```

Also in `regenerateImages` method, same logic:
```typescript
const passNum = state.skipVerify ? 4 : 5
```
→
```typescript
const passNum = state.skipVerify ? 5 : 6
```

**Step 5: Update `totalPasses` in `execute()`**

In the `execute()` method (around line 1570):
```typescript
const totalPasses = skipVerify ? 4 : 5
```
Change to:
```typescript
const totalPasses = skipVerify ? 5 : 6
```

Also update `this._lastTotalPasses` if it exists.

**Step 6: Run tests**

Run: `npx vitest run`
Expected: PASS (or fix any pass-number-dependent tests)

**Step 7: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: reassign pipeline pass numbers to give extractStyleAnchor unique pass 3"
```

---

### Task 2: Update UI Pass Definitions

**Files:**
- Modify: `src/renderer/src/react-app/components/GenerationProgress.tsx`

**Step 1: Add 风格锚点 to PASS_DEFS_FULL**

Replace:
```typescript
const PASS_DEFS_FULL = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '质量校验',     icon: 'fa-check-double' },
  { label: '图像生成',     icon: 'fa-image' },
]
```

With:
```typescript
const PASS_DEFS_FULL = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '质量校验',     icon: 'fa-check-double' },
  { label: '图像生成',     icon: 'fa-image' },
]
```

**Step 2: Add 风格锚点 to PASS_DEFS_FAST**

Replace:
```typescript
const PASS_DEFS_FAST = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '图像生成',     icon: 'fa-image' },
]
```

With:
```typescript
const PASS_DEFS_FAST = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '图像生成',     icon: 'fa-image' },
]
```

**Step 3: Update grid layout for 7 items**

The grid class at line 156:
```typescript
<div className={`grid gap-2 ${totalSlots <= 5 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3'}`}>
```

Both branches are the same, so this is fine for 7 items (3 per row on sm+). No change needed.

**Step 4: Update the totalPasses threshold for fast mode detection**

Line 88:
```typescript
() => pipelinePasses <= 4 ? PASS_DEFS_FAST : PASS_DEFS_FULL,
```
Change to:
```typescript
() => pipelinePasses <= 5 ? PASS_DEFS_FAST : PASS_DEFS_FULL,
```

This is because fast mode (skipVerify) now has totalPasses=5 instead of 4.

**Step 5: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 6: Commit**

```bash
git add src/renderer/src/react-app/components/GenerationProgress.tsx
git commit -m "fix: add 风格锚点 stage to UI progress display"
```

---

### Task 3: Fix Store pushProgress Slot Count

**Files:**
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts` (if needed)

**Step 1: Verify pushProgress logic**

The store's `pushProgress` (line ~470) uses `progress.totalPasses` to determine slot count:
```typescript
const totalPasses = progress.totalPasses || 5
const slotCount = totalPasses + 1
```

Since we've updated `totalPasses` in the pipeline's `execute()` to 6 (or 5 for fast mode), the store will automatically adjust. The `|| 5` fallback should be updated to `|| 6`:

```typescript
const totalPasses = progress.totalPasses || 6
```

**Step 2: Verify passCards dedup**

Line ~494:
```typescript
const exists = (state.passCards as Array<{ pass: number }>).some((c) => c.pass === pd.pass)
```

This deduplicates by pass number. Since we've given each pass a unique number, this will work correctly now.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts
git commit -m "fix: update default totalPasses fallback to 6 for new pass numbering"
```

---

### Task 4: Skip selectSkills When All Skills Selected (Performance Bonus)

**Problem:** `selectSkills` takes 10-12s but typically selects 14/16 skills (87.5% = basically all). This 10s LLM call gates all 3 analysis nodes for negligible filtering value.

**Solution:** Add a `skipSkillSelection` flag. When enabled, skip the LLM call and use all pipeline skills directly. This saves 10-12s of serial latency.

**Files:**
- Modify: `src/renderer/src/services/pipeline/DirectorPipeline.ts` (`selectSkillsFn`)

**Step 1: Add early return to selectSkillsFn**

At the top of `selectSkillsFn` (around line 1034), add:

```typescript
    const selectSkillsFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const allSkills = self.pipelineSkills
        if (allSkills.length === 0) return { activeSkills: [] as string[] }

        // Fast path: skip LLM call and use all skills directly
        // selectSkills typically selects 85%+ of available skills,
        // making the 10s LLM call not worth the filtering value
        const allIds = allSkills.map(s => s.id)
        const elapsed = Date.now() - t0
        console.log(`[DirectorPipeline] selectSkills: fast-path, using all ${allIds.length} skills (${elapsed}ms)`)
        const passData = DirectorPipeline.buildPassCardData('selectSkills', { pass: 0, label: '技能选择' }, { selected: allIds, reasoning: 'fast-path: all skills' }, elapsed, allIds)
        writer(config)?.({
          type: 'pass_complete', pass: 0,
          label: `技能选择完成 (${allIds.length} skills, ${elapsed}ms)`,
          elapsed, passData,
        })
        return { activeSkills: allIds }
      } catch (err: unknown) {
        console.warn('[DirectorPipeline] selectSkills failed, using all skills as fallback:', err instanceof Error ? err.message : String(err))
        return { activeSkills: self.pipelineSkills.map(s => s.id) }
      }
    }
```

This completely removes the LLM call from `selectSkillsFn`, making it instant (<1ms). The graph topology stays the same: `selectSkills → [3 analysis nodes]`, but `selectSkills` now completes in milliseconds instead of 10-12 seconds.

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "perf: skip selectSkills LLM call — use all skills directly (saves 10-12s)"
```

---

### Task 5: Integration Verification

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
git commit -m "fix: resolve any remaining issues from pass numbering fix"
```
