# History Pending Upload Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Prevent history items from becoming permanently unviewable when the app closes during R2 upload, and make pending records recoverable after restart.

**Architecture:** Keep minimal pending placeholders for UI, but persist recoverable source data for in-flight uploads and resume upload on service init. Add deterministic fallback rendering for pending items by using recoverable source URLs when available. Cover with focused unit tests for service-level resume behavior and URL-selection behavior.

**Tech Stack:** Electron, TypeScript, Vitest, renderer history modules (`HistoryDataService`, `StorageBridge`, `HistoryPage`)

---

### Task 1: Persist recoverable data for in-flight uploads

**Files:**
- Modify: `src/renderer/src/services/storage/StorageBridge.ts`
- Test: `tests/features/HistoryDataService.test.ts`

**Step 1: Write the failing test**

Add a test case in `tests/features/HistoryDataService.test.ts` that simulates an uploading item persisted via storage and asserts that recoverable source data (`originalUrls`) is not stripped while `uploading === true`.

```ts
it('keeps originalUrls for uploading records when persisting history', async () => {
  const bridge = mockedGetStorageBridge()
  const item = {
    id: 1,
    prompt: 'pending upload',
    urls: ['pending:1'],
    originalUrls: ['data:image/png;base64,test'],
    uploading: true,
  }
  await bridge.saveHistory([item as any])
  const payload = vi.mocked((window as any).electronAPI.saveHistory).mock.calls[0][0]
  expect(payload[0].originalUrls).toEqual(['data:image/png;base64,test'])
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/features/HistoryDataService.test.ts`
Expected: FAIL because `StorageBridge.saveHistory` currently deletes `originalUrls`.

**Step 3: Write minimal implementation**

In `StorageBridge.saveHistory()`:
- Keep current base64 trimming rules for non-uploading records.
- Preserve `originalUrls` only when `newItem.uploading === true` and `originalUrls` is a non-empty array.
- Keep deleting `originalUrls` for non-uploading records.

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/features/HistoryDataService.test.ts`
Expected: PASS for the new test and existing `HistoryDataService` tests.

**Step 5: Commit**

```bash
git add tests/features/HistoryDataService.test.ts src/renderer/src/services/storage/StorageBridge.ts
git commit -m "fix(history): preserve in-flight upload source data for recovery"
```

---

### Task 2: Resume pending uploads on service initialization

**Files:**
- Modify: `src/renderer/src/features/history/HistoryDataService.ts`
- Test: `tests/features/HistoryDataService.test.ts`

**Step 1: Write the failing test**

Add a test that preloads history with an uploading item (`uploading: true`, `urls` contains `pending:`, `originalUrls` contains base64), calls `service.init()`, and verifies resume upload path is invoked.

```ts
it('resumes pending uploads on init', async () => {
  const base64 = 'data:image/png;base64,test'
  vi.mocked(mockStorageBridge.loadHistory).mockResolvedValue([
    { id: 42, prompt: 'resume', urls: ['pending:42'], originalUrls: [base64], uploading: true } as any,
  ])
  vi.mocked(mockR2Storage.isAvailable).mockReturnValue(true)
  vi.mocked(mockR2Storage.batchProcess).mockResolvedValue(['https://r2.example.com/42.png'])

  await service.init()
  await new Promise((r) => setTimeout(r, 50))

  expect(mockR2Storage.batchProcess).toHaveBeenCalledWith([base64])
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/features/HistoryDataService.test.ts`
Expected: FAIL because init currently does not resume pending uploads.

**Step 3: Write minimal implementation**

In `HistoryDataService`:
- Add `resumePendingUploads()` called during `init()` after manager init.
- Find records where:
  - `uploading === true`
  - `originalUrls` exists and non-empty
  - at least one `urls` entry is `pending:`
- Fire-and-forget `uploadBase64ToR2(item, item.originalUrls)` for each recoverable item.
- Add guard logging for non-recoverable pending items (pending without original source).

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/features/HistoryDataService.test.ts`
Expected: PASS including the new resume test.

**Step 5: Commit**

```bash
git add tests/features/HistoryDataService.test.ts src/renderer/src/features/history/HistoryDataService.ts
git commit -m "fix(history): resume pending r2 uploads after restart"
```

---

### Task 3: Make pending cards viewable when source exists

**Files:**
- Modify: `src/renderer/src/pages/HistoryPage.ts`
- Test: `tests/pages/HistoryPage.test.ts`

**Step 1: Write the failing test**

Add tests for URL selection behavior:
1) pending `urls` + valid `originalUrls` should use original for thumbnail/view.
2) pending `urls` + no source should remain non-viewable.

Prefer extracting a small helper function in `HistoryPage` for testability.

```ts
it('uses originalUrls as fallback for pending item display', () => {
  const item = {
    id: 1,
    type: 'generate',
    prompt: 'p',
    urls: ['pending:1'],
    originalUrls: ['https://example.com/fallback.png'],
    uploading: true,
    timestamp: new Date().toISOString(),
  } as any
  const page = new HistoryPage(createMockApp() as any)
  const urls = (page as any).getDisplayUrlsForItem(item)
  expect(urls).toEqual(['https://example.com/fallback.png'])
})
```

**Step 2: Run test to verify it fails**

Run: `npm run test:run -- tests/pages/HistoryPage.test.ts`
Expected: FAIL because current card logic only uses `item.urls`.

**Step 3: Write minimal implementation**

In `HistoryPage`:
- Add helper `getDisplayUrlsForItem(item)`:
  - Use `filterValidImageUrls(item.urls)`.
  - If empty and item has pending placeholder, fallback to `filterValidImageUrls(item.originalUrls ?? [])`.
- Use helper in:
  - thumbnail selection
  - `view` action URL source
  - button enable/disable logic (view/download shown only when display URLs exist)

**Step 4: Run test to verify it passes**

Run: `npm run test:run -- tests/pages/HistoryPage.test.ts`
Expected: PASS with new pending fallback tests.

**Step 5: Commit**

```bash
git add tests/pages/HistoryPage.test.ts src/renderer/src/pages/HistoryPage.ts
git commit -m "fix(history): allow pending cards to preview via recoverable source urls"
```

---

### Task 4: Verify behavior + regression coverage

**Files:**
- Modify: `tests/features/HistoryDataService.test.ts` (if minor assertions needed)
- Modify: `tests/pages/HistoryPage.test.ts` (if minor assertions needed)
- Optional docs note: `docs/plans/2026-03-04-history-pending-upload-recovery-implementation-plan.md`

**Step 1: Write/adjust failing regression assertions**

Add/adjust small assertions for:
- pending without source remains non-viewable
- resume path does not crash when R2 unavailable

**Step 2: Run targeted tests**

Run: `npm run test:run -- tests/features/HistoryDataService.test.ts tests/pages/HistoryPage.test.ts`
Expected: PASS.

**Step 3: Run broader safety check**

Run: `npm run test:run -- tests/react-app/__tests__/useDirectorGeneration.nonblocking-history.test.tsx`
Expected: PASS (non-blocking history behavior preserved).

**Step 4: Final verification**

Run: `npm run typecheck`
Expected: PASS with no new type errors from modified files.

**Step 5: Commit**

```bash
git add tests/features/HistoryDataService.test.ts tests/pages/HistoryPage.test.ts src/renderer/src/features/history/HistoryDataService.ts src/renderer/src/services/storage/StorageBridge.ts src/renderer/src/pages/HistoryPage.ts
git commit -m "fix(history): recover and resume pending uploads safely"
```
