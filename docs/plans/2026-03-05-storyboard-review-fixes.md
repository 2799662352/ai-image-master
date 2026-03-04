# StoryboardPro Review Fixes — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix 2 Important + 3 Minor issues from code review of StoryboardProPipeline.

**Architecture:** Pure code fixes, no new features.

**Tech Stack:** TypeScript, Vitest

---

### Task 1: Fix I1 — Parallel Node Updates Only Takes First Entry

**Problem:** In `execute()` line 634, `entries[0]` only takes the first node's output. When parallel nodes (sceneDecompose + characterExtract) complete in the same superstep, one node's data may be lost.

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` (line ~631-637)

**Step 1: Fix the updates handler**

Replace:

```typescript
          } else if (mode === 'updates') {
            const updatesData = data && typeof data === 'object' ? data : {}
            const entries = Object.entries(updatesData)
            if (entries.length > 0) {
              const [, output] = entries[0] as [string, any]
              finalState = { ...finalState, ...output }
            }
          }
```

With:

```typescript
          } else if (mode === 'updates') {
            const updatesData = data && typeof data === 'object' ? data : {}
            for (const [, output] of Object.entries(updatesData)) {
              if (output && typeof output === 'object') {
                finalState = { ...finalState, ...(output as any) }
              }
            }
          }
```

**Step 2: Apply same fix to DirectorPipeline**

The same pattern exists in `src/renderer/src/services/pipeline/DirectorPipeline.ts` at line ~1724-1730. Replace:

```typescript
          } else if (mode === 'updates') {
            const updatesData = data
            const entries = Object.entries(updatesData)
            if (entries.length > 0) {
              const [, output] = entries[0] as [string, any]
              finalState = { ...finalState, ...output }
            }
            if (Object.prototype.hasOwnProperty.call(updatesData, 'generateImages')) {
```

With:

```typescript
          } else if (mode === 'updates') {
            const updatesData = data
            for (const [, output] of Object.entries(updatesData)) {
              if (output && typeof output === 'object') {
                finalState = { ...finalState, ...(output as any) }
              }
            }
            if (Object.prototype.hasOwnProperty.call(updatesData, 'generateImages')) {
```

IMPORTANT: Keep the `generateImages` special handling block (lines 1731-1737) unchanged — it handles the terminal break for image generation.

**Step 3: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 4: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts src/renderer/src/services/pipeline/DirectorPipeline.ts
git commit -m "fix: merge all parallel node outputs in updates handler, not just first entry"
```

---

### Task 2: Fix I2 — Null Report Routes to deepVerify Instead of End

**Problem:** `routeAfterCodeVerify` returns `'end'` when `report` is null. This silently passes unverified data. Should route to `deepVerify` for safety.

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts` (line ~506-511)

**Step 1: Fix the routing function**

Replace:

```typescript
    const routeAfterCodeVerify = (state: StoryboardState): 'end' | 'deepVerify' => {
      const report = state.report
      if (!report) return 'end'
      if (report.score >= SCORE_THRESHOLD && report.ok) return 'end'
      return 'deepVerify'
    }
```

With:

```typescript
    const routeAfterCodeVerify = (state: StoryboardState): 'end' | 'deepVerify' => {
      const report = state.report
      if (!report) return 'deepVerify'
      if (report.score >= SCORE_THRESHOLD && report.ok) return 'end'
      return 'deepVerify'
    }
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "fix: route to deepVerify when codeVerify report is null for safety"
```

---

### Task 3: Fix I3 — Replace Hardcoded `true` with `undefined` for Unchecked Fields

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/storyboard-verify.ts`

**Step 1: Fix the return value**

Replace:

```typescript
    spatialCoherence: true,
    lightingContinuity: true,
```

With:

```typescript
    spatialCoherence: undefined,
    lightingContinuity: undefined,
```

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/storyboard-verify.ts
git commit -m "fix: return undefined for unchecked verify fields instead of misleading true"
```

---

### Task 4: Fix M3 — Use Non-Greedy Regex for JSON Extraction

**Files:**
- Modify: `src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts`

**Step 1: Replace greedy regex patterns**

Search for all `[\s\S]*` in regex patterns and replace with `[\s\S]*?` (non-greedy):

There are 3 regex patterns to fix:

1. **sceneDecompose** (line ~206): `match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)` → `match(/\{[\s\S]*?"d"\s*:[\s\S]*?\}/)`
2. **characterExtract** (line ~263): `match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)` → `match(/\{[\s\S]*?"objs"\s*:\s*\[[\s\S]*?\][\s\S]*?\}/)`
3. **shotDesign L1 fallback**: Find the regex matching `"seq"` or `"panels"` and apply the same `*?` non-greedy conversion

Note: Keep the outer `\{...\}` matching — we want the smallest valid JSON object, not the largest.

**Step 2: Run tests**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer/src/services/storyboard-pipeline/StoryboardProPipeline.ts
git commit -m "fix: use non-greedy regex for JSON extraction fallback to avoid false matches"
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
git commit -m "fix: resolve any remaining issues from storyboard review fixes"
```
