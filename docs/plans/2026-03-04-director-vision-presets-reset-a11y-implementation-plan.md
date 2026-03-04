# Director Vision Presets + Reset + A11y Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Director vision-detail presets robust by fixing reset behavior and adding explicit active preset accessibility feedback in UI.

**Architecture:** Keep state source-of-truth in Zustand store, compute preset semantics from current 4-pass detail values, and render UI with `aria-pressed` active states. Use TDD for each behavior: write failing tests first, then minimal implementation.

**Tech Stack:** React, Zustand, TypeScript, Vitest, Testing Library

---

### Task 1: Fix reset to read latest persisted config

**Files:**
- Modify: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts`
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`
- Test: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts`

**Step 1: Write the failing test**

Add test case:
- update vision detail value via action (writes localStorage)
- call `reset()`
- expect reset state equals latest persisted value (not stale module snapshot)

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- "src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts"`  
Expected: FAIL for reset behavior

**Step 3: Write minimal implementation**

Implement dynamic config initialization:
- replace static-only reset source with `createInitialConfigState()` function
- `reset()` should spread `createInitialConfigState()` at call time

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- "src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts"`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts
git commit -m "fix: reset director vision details from latest persisted state"
```

---

### Task 2: Add preset detection semantics for UI active state

**Files:**
- Modify: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
- Modify: `src/renderer/src/react-app/stores/useDirectorStore.ts`
- Test: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`

**Step 1: Write the failing test**

Add tests for pure helper semantics:
- speed pattern => `speed`
- quality pattern => `quality`
- balanced pattern => `balanced`
- other combinations => `custom`

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- "src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts"`  
Expected: FAIL for missing helper behavior

**Step 3: Write minimal implementation**

Add pure exported helper:
- `detectVisionDetailPreset(...) => 'speed' | 'balanced' | 'quality' | 'custom'`

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- "src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts"`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/stores/useDirectorStore.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts
git commit -m "feat: add vision preset detection helper for UI state"
```

---

### Task 3: Render accessible active state for preset buttons

**Files:**
- Modify: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`

**Step 1: Write the failing test**

Add UI assertions:
- initial active preset should be reflected via `aria-pressed`
- clicking `一键预设：质量` updates `aria-pressed` states

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx"`  
Expected: FAIL for missing aria active state behavior

**Step 3: Write minimal implementation**

In `DirectorApp.tsx`:
- compute `activePreset` from current 4-pass values via store helper
- set `aria-pressed` for preset buttons
- add active/inactive classes with clear contrast

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx"`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx
git commit -m "feat: add accessible active states for vision preset buttons"
```

---

### Task 4: Regression verification

**Files:**
- Validate: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
- Validate: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts`
- Validate: `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`
- Validate: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- Validate: `src/renderer/src/services/pipeline/__tests__/director-vision-detail.test.ts`

**Step 1: Run focused regression suite**

Run:  
`npm run test:run -- "src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts" "src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts" "src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts" "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx" "src/renderer/src/services/pipeline/__tests__/director-vision-detail.test.ts"`  
Expected: PASS

**Step 2: Run lint check on edited files**

Run: `ReadLints` for changed files  
Expected: no new errors

**Step 3: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx src/renderer/src/react-app/stores/useDirectorStore.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx
git commit -m "fix: sync preset UI state and reset with persisted vision detail config"
```
