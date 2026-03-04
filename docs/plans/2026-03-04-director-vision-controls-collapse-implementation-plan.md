# Director Vision Controls Collapse Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a collapse/expand interaction for the "看图质量（每阶段独立）" settings block so users can fold it when not needed.

**Architecture:** Keep collapse state local to `DirectorApp` as UI-only state (not persisted), use an explicit `<button>` trigger with `aria-expanded` and `aria-controls`, and conditionally render the detailed controls body. Validate behavior through React Testing Library before implementation and run full regression after.

**Tech Stack:** React, TypeScript, Zustand (existing store consumers), Vitest, @testing-library/react

---

### Task 1: Add failing UI tests for collapse behavior

**Files:**
- Modify: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`

**Step 1: Write the failing test**

Add test cases that assert:
- Collapse toggle button exists and has correct initial expanded state.
- Clicking toggle hides detail rows like "场景分析" and then shows them again on second click.

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx"`  
Expected: FAIL because collapse toggle is not implemented yet

**Step 3: Write minimal implementation**

Skip in this task (implemented in Task 2).

**Step 4: Run test to verify it passes**

Skip in this task.

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx
git commit -m "test: add failing tests for director vision controls collapse toggle"
```

---

### Task 2: Implement accessible collapse/expand toggle in DirectorApp

**Files:**
- Modify: `src/renderer/src/react-app/DirectorApp.tsx`
- Test: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`

**Step 1: Write the failing test**

Use failing tests from Task 1.

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx"`  
Expected: FAIL

**Step 3: Write minimal implementation**

In `DirectorApp.tsx`:
- Add local state `isVisionControlsCollapsed`.
- Render a toggle `<button>` in the vision controls header.
- Add `aria-expanded` and `aria-controls`.
- Wrap detailed content in conditional render.

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx"`  
Expected: PASS

**Step 5: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx
git commit -m "feat: add collapsible vision controls section in director UI"
```

---

### Task 3: Regression and lint verification

**Files:**
- Validate: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts`
- Validate: `src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts`
- Validate: `src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts`
- Validate: `src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx`
- Validate: `src/renderer/src/services/pipeline/__tests__/director-vision-detail.test.ts`

**Step 1: Run full regression suite**

Run:  
`npm run test:run -- "src/renderer/src/react-app/stores/__tests__/useDirectorStore.test.ts" "src/renderer/src/react-app/stores/__tests__/useDirectorStore.score-threshold.persistence.test.ts" "src/renderer/src/react-app/hooks/__tests__/useDirectorGeneration.test.ts" "src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx" "src/renderer/src/services/pipeline/__tests__/director-vision-detail.test.ts"`  
Expected: PASS

**Step 2: Run lint check on changed files**

Run: `ReadLints` for modified files  
Expected: no new lints

**Step 3: Commit**

```bash
git add src/renderer/src/react-app/DirectorApp.tsx src/renderer/src/react-app/__tests__/DirectorApp.refresh-skills.test.tsx docs/plans/2026-03-04-director-vision-controls-collapse-implementation-plan.md
git commit -m "feat: support collapsing director vision quality controls"
```
