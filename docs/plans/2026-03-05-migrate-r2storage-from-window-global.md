# Migrate HistoryPage from window.r2Storage to getR2StorageService() Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Eliminate all 5 deprecated `(window as any).r2Storage` usages in `HistoryPage.ts` by replacing them with the singleton accessor `getR2StorageService()`, restoring full type safety and silencing the dev-mode deprecation warning.

**Architecture:** Add a single `import { getR2StorageService }` at the top of `HistoryPage.ts`. Replace each `(window as any).r2Storage` call site with `getR2StorageService()`. The singleton returns the same instance as the window getter, so behavior is identical — only the access path changes.

**Tech Stack:** TypeScript, Vitest

**Root Cause (verified 2026-03-05):**
- `R2StorageService.ts:511-523` defines a `window.r2Storage` getter that prints `[DEPRECATED]` on first access in dev mode
- `HistoryPage.ts` has 5 call sites using `(window as any).r2Storage` (lines 793, 1253, 1297, 1337, 1403)
- The correct API is `getR2StorageService()` exported from `../services/r2-storage`

---

### Task 1: Add import and replace all 5 call sites

**Files:**
- Modify: `src/renderer/src/pages/HistoryPage.ts:1,793,1253,1297,1337,1403`

**Step 1: Add the import**

At line 3 (after existing imports, before the `// Types` section), add:

```typescript
import { getR2StorageService } from '../services/r2-storage'
```

The file header should become:

```typescript
import { BasePage, type AppInterface } from './BasePage'
import { getHistoryManager } from '../features/history/HistoryManager'
import { VirtualScroller } from '../core/VirtualScroller'
import { isValidImageUrl, isPendingUrl, filterValidImageUrls, getFirstValidThumbnail } from '../utils/url-validator'
import { getR2StorageService } from '../services/r2-storage'
```

**Step 2: Replace all 5 call sites**

Each replacement is mechanical — change `(window as any).r2Storage` to `getR2StorageService()`:

| Line | Before | After |
|------|--------|-------|
| 793 | `const r2Storage = (window as any).r2Storage` | `const r2Storage = getR2StorageService()` |
| 1253 | `const r2Storage = (window as any).r2Storage` | `const r2Storage = getR2StorageService()` |
| 1297 | `const r2Storage = (window as any).r2Storage` | `const r2Storage = getR2StorageService()` |
| 1337 | `const r2Storage = (window as any).r2Storage` | `const r2Storage = getR2StorageService()` |
| 1403 | `const r2Storage = (window as any).r2Storage` | `const r2Storage = getR2StorageService()` |

**Step 3: Run existing tests to verify no regressions**

Run: `npx vitest run src/renderer/src/pages/__tests__/ --reporter=verbose`
Expected: ALL PASS

**Step 4: Verify no remaining deprecated usages**

Run: `Select-String -Path "src\renderer\src\pages\HistoryPage.ts" -Pattern "(window as any).r2Storage"`
Expected: No matches

**Step 5: Commit**

```bash
git add src/renderer/src/pages/HistoryPage.ts
git commit -m "refactor: migrate HistoryPage from window.r2Storage to getR2StorageService()"
```

---

### Task 2: Run full test suite and push

**Step 1: Run all tests**

Run: `npx vitest run --reporter=verbose`
Expected: ALL PASS

**Step 2: Push**

```bash
git push origin main
```

---

## Verification Checklist

After deploying, manually verify in the Electron app:
- [ ] Open History tab → no `[DEPRECATED] window.r2Storage` warning in console
- [ ] Cloud storage status still displays correctly
- [ ] Migrate to cloud still works
- [ ] Delete history item with cloud images still works
- [ ] Clear all history still works

## Summary of Changes

| File | Change | Lines |
|------|--------|-------|
| `HistoryPage.ts:3` | Add `import { getR2StorageService }` | +1 line |
| `HistoryPage.ts:793,1253,1297,1337,1403` | Replace `(window as any).r2Storage` → `getR2StorageService()` | 5 lines modified |
