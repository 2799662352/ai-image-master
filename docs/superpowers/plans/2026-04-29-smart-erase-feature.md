# Smart Subtitle Removal (`智能去字幕`) Implementation Plan

**Date:** 2026-04-30
**Spec:** [`docs/specs/2026-04-29-smart-erase-feature-design.md`](../../specs/2026-04-29-smart-erase-feature-design.md) (v1.1)
**Prerequisite:** `2026-04-29-tencent-cloud-job-runner-refactor.md` ✅ merged (commits `46718df`, `534aa5c`, `9dc5ed3`, `7ef7454`, `40e907c`, `8a28a97`)
**Status:** Draft, ready to execute

---

## 0. Lessons learned from refactor (READ FIRST)

The refactor surfaced a real production regression that took ~2 weeks of work green and shipped a `Cannot read properties of undefined (reading 'mps')` crash to the next user action. Root cause was an "innocent" import-shape change in a shared module that all unit tests *accepted* because the mock was more permissive than the real package.

**Mandatory rules carried into every task in this plan:**

1. **Never touch `src/main/services/tencent/*` in this feature** — that layer is now the trunk for both `storyboardSplit` and `smartErase`. Any "small fix" to that layer must come in a separate, separately-reviewed PR. If a task wants to extend it, that's a flag to STOP and re-plan.
2. **Mocks must mirror real package shape, not the test author's hopes.** When mocking an npm package, run `node -e "console.log(Object.keys(require('pkg')), 'default?', typeof require('pkg').default)"` first and shape the mock to match.
3. **Type-safety on imports**: prefer named imports over `import X from 'pkg'` for any package whose CJS exports do not include an explicit `default`. When uncertain, run the smoke test in rule 2.
4. **`as any` is debt**: every `(x as any).y.z` chain must be either justified in the same file or refactored into a typed adapter. Each one is a candidate undefined-crash site.
5. **Build smoke is not enough**: after any task touches `src/main/index.ts` or `src/preload/index.ts`, the implementer must launch `npm run dev`, drive the existing `storyboardSplit` flow end-to-end (drop image → see split result), and paste the dev console output into the review.
6. **Regression checklist runs every task**: see §3.

---

## 1. Architecture summary

This feature is a **thin runner on top of the shared `tencent/*` layer**. It shares: credentials, JobQueue, COS client (uploadStream/cancelUpload/getPresignedUrl/deleteObjects), and MPS client. It adds: video-specific runner, ffmpeg poster generator, ffprobe wrapper, COS reaper for cancelled-but-still-processing tasks, IPC handlers, and a React tab.

```
src/
├── types/smartErase.ts                                    NEW
├── main/services/
│   ├── tencent/                                           DO NOT TOUCH
│   ├── storyboardSplit/                                   DO NOT TOUCH
│   └── smartErase/                                        NEW (5 files)
│       ├── config.ts                                      defaults + re-exports
│       ├── posterGen.ts                                   ffmpeg local thumbnail
│       ├── probe.ts                                       ffprobe wrapper (concurrency-capped)
│       ├── runner.ts                                      uploadStream → ProcessMedia → poll → presign
│       ├── reaper.ts                                      cancelled-task COS cleanup queue
│       └── index.ts                                       composes JobQueue + IPC handler exports
├── main/index.ts                                          MODIFIED (additive)
├── preload/index.ts                                       MODIFIED (additive)
└── renderer/src/
    ├── pages-react/
    │   ├── SmartErasePage.tsx                             NEW
    │   └── smart-erase/                                   NEW (5 files)
    │       ├── EraseUploader.tsx
    │       ├── EraseQueue.tsx
    │       ├── EraseResultPanel.tsx
    │       ├── EraseHistoryDrawer.tsx
    │       └── useEraseEvents.ts
    ├── stores/                                            (zustand stores live here, parallel to useSplit*)
    │   ├── useEraseSessionStore.ts                        NEW
    │   └── useErasePersistStore.ts                        NEW
    └── utils/idbKeyValStore.ts                            NEW (zustand persist storage adapter)
```

**Files modified (count: 4)** — every modification is purely additive; no existing exports renamed:

| File | Change kind | Risk |
|---|---|---|
| `src/main/index.ts` | + 6 IPC handlers, + `setEraseMainWindow`, + `cancelAllActiveSmartEraseTasks()` in `window-all-closed`, + extend CSP `media-src` | HIGH (shared shell) |
| `src/preload/index.ts` | + `IPC_CHANNELS.SMART_ERASE`, + `SMART_ERASE_EVENTS`, + 8 API methods, + `getFilePath` | MED (shared shell) |
| `src/renderer/index.html` | + 1 tab button, + 1 `<div id="smart-erase-react-root">` | LOW |
| `package.json` | + `ffmpeg-static`, + `ffprobe-static` (or `@ffmpeg-installer/ffmpeg`), + `idb-keyval` | LOW |

NOT modified (despite being mentioned in spec §3.2): `src/renderer/src/react-app/main.tsx` and `src/renderer/src/services/ServiceBridge.ts`. After exploring the renderer structure these are not the right hook points for this feature; the existing `StoryboardSplitPage` mounts via the page-level React entry, and we mirror that pattern. **If a task discovers the spec was wrong and these files are needed, STOP and amend the spec.**

---

## 2. Regression protection principles

Each task has a **Regression Protection** section with three parts:

- **Files NOT to touch**: explicit allowlist; if the implementer modifies anything else in `src/main/services/tencent/*` or `src/main/services/storyboardSplit/*`, the review fails.
- **Smoke after task**: the literal commands the implementer must run, plus the existing-feature scenarios they must drive in `npm run dev`.
- **Tests that must stay green**: explicit list of test files. Currently 26 unit tests across 4 files in `tencent/__tests__/`. None of them may regress.

The final task (Task 8) runs an **end-to-end matrix** that includes both features side-by-side.

---

## 3. Task list

| # | Title | Risk | Subagent depth |
|---|---|---|---|
| 1 | Types + IPC contract + preload + dependencies | LOW | 1 implementer + 1 reviewer |
| 2 | Local ffmpeg poster generator (`posterGen.ts`) | LOW | 1 + 1 |
| 3 | ffprobe wrapper (`probe.ts`) | LOW | 1 + 1 |
| 4 | Smart erase runner (`runner.ts`) — TDD heavy, MPS response shape | MED | 1 + 2 (spec + quality) |
| 5 | Reaper (`reaper.ts`) for cancelled-task cleanup | LOW | 1 + 1 |
| 6 | Service composer (`index.ts`) — JobQueue wiring, in-memory state, exports | MED | 1 + 1 |
| 7 | Main process integration (`src/main/index.ts`) — **highest regression risk** | **HIGH** | 1 implementer + 2 reviewers + manual smoke |
| 8 | Renderer feature (page + components + stores + tab + html) + final E2E manual smoke | HIGH | 1 + 1 + manual |

---

## 4. Tasks

### Task 1 — Types, IPC contract, preload, dependencies

**Goal:** Stand up the type contract and surface area (no runtime logic). This is the cheapest change; lets every later task type-check against the same shapes.

**Files NEW:**
- `src/types/smartErase.ts` — copy directly from spec §5.1; verify field names match spec character-for-character.

**Files MODIFIED:**
- `src/preload/index.ts` — surgically add:
  - In `IPC_CHANNELS`: a new `SMART_ERASE` block (mirroring `STORYBOARD_SPLIT` block at lines 97–105) and `SMART_ERASE_EVENTS` array (mirroring lines 106–110).
  - In `ElectronAPI` interface: 8 new methods + `getFilePath(file: File): string`.
  - In `electronAPI` const: implementations using `safeInvoke` and `ipcRenderer.on` + the `webUtils.getPathForFile` import from `electron`.
  - In `on` and `off` allowedChannels arrays: append `...IPC_CHANNELS.SMART_ERASE_EVENTS`.
- `package.json` — add deps:
  - `ffmpeg-static` (binary path provider for ffmpeg)
  - `ffprobe-static` (binary path provider for ffprobe)
  - `idb-keyval` (renderer-side IndexedDB wrapper)

**Implementation notes:**
- `getFilePath`: in preload, `import { webUtils } from 'electron'`; expose `getFilePath: (file: File) => webUtils.getPathForFile(file)`. Returns `""` for synthetic File objects (e.g., browser drag-from-tab) — **do not** throw.
- The `onSmartEraseEvent` callback signature should match the existing `onStoryboardSplitEvent` (channel name + data) so the React hook pattern carries over.
- **Do not** delete or rename `STORYBOARD_SPLIT` constants. Use `git diff src/preload/index.ts` to verify only additions exist.

**TDD test plan:** Type-only task, no runtime tests. Build acceptance is the test.

**Regression Protection:**
- **Files NOT to touch**: anything outside the 3 files listed above. In particular, `src/main/services/**/*` is forbidden in this task.
- **Smoke after task**:
  ```bash
  npm install                                    # picks up new deps
  npm run build                                   # full build (main + preload + renderer)
  npm run test:run -- src/main/services/tencent/  # 26 tests must stay green
  ```
- **Tests that must stay green**: `tencent/__tests__/{credentials,jobQueue,cosClient,mpsClient}.test.ts` (26).
- **Manual smoke**: `npm run dev`, drop one image into 宫格拆图, confirm it still completes. Capture console.

**Acceptance criteria:**
- TypeScript build passes.
- `window.electronAPI.smartEraseSubmit` typechecks (verify in any `.ts` file under renderer; can use a throwaway `void window.electronAPI.smartEraseSubmit(...)`).
- `window.electronAPI.getFilePath(new File([], "x"))` returns `""` at runtime (manual smoke in DevTools console).
- 26 tencent unit tests still green; storyboardSplit drop-image still works.

---

### Task 2 — Local ffmpeg poster generator

**Goal:** Pure function that takes a video path and returns a ~10 KB base64 JPEG of the 0.5s frame. Replaces COS-CI snapshot from spec v1.0.

**Files NEW:**
- `src/main/services/smartErase/posterGen.ts`
- `src/main/services/smartErase/__tests__/posterGen.test.ts`

**Implementation notes:**
- Use `ffmpeg-static` (resolves to a binary path at runtime). Spawn:
  ```ts
  spawn(ffmpegPath, ['-ss', '0.5', '-i', videoPath, '-frames:v', '1', '-vf', 'scale=320:-1', '-f', 'mjpeg', 'pipe:1'])
  ```
- Collect stdout into a buffer; on close exit code 0, return `'data:image/jpeg;base64,' + buf.toString('base64')`.
- On non-zero exit OR no stdout, throw `Error` with code `POSTER_FAILED`.
- 5-second hard timeout (`childProc.kill('SIGKILL')`); throw `POSTER_TIMEOUT`.
- Export shape: `export async function generatePosterDataUrl(videoPath: string): Promise<string>`.

**TDD test plan (write tests FIRST):**
- Test 1: spawn args include `-ss 0.5`, `-i videoPath`, `-frames:v 1`, `scale=320:-1`, `-f mjpeg`, `pipe:1`.
- Test 2: stdout chunks → exit 0 → returns `data:image/jpeg;base64,...`.
- Test 3: exit code 1 → throws `POSTER_FAILED`.
- Test 4: process never exits → after timeout throws `POSTER_TIMEOUT` and calls `kill('SIGKILL')`.
- Test 5: empty stdout buffer + exit 0 → throws `POSTER_FAILED` (defensive).

Mock `child_process.spawn` via `vi.mock`; use a fake EventEmitter that yields `stdout`/`stderr`/`close`/`error`.

**Regression Protection:**
- **Files NOT to touch**: anything outside `smartErase/` and its test folder.
- **Smoke after task**:
  ```bash
  npm run test:run -- src/main/services/smartErase/__tests__/posterGen.test.ts
  npm run test:run -- src/main/services/tencent/
  ```
- **Tests that must stay green**: all 26 tencent tests.

**Acceptance criteria:**
- 5 unit tests pass.
- Manual smoke optional: in dev mode, write a one-off node script that calls `generatePosterDataUrl` on a real .mp4 and confirms < 50 KB base64 string.

---

### Task 3 — ffprobe wrapper

**Goal:** Probe a batch of file paths to extract `{ filename, fileSize, durationSeconds }`, with concurrency cap of 4 simultaneous ffprobe processes. Used by the cost-confirmation dialog.

**Files NEW:**
- `src/main/services/smartErase/probe.ts`
- `src/main/services/smartErase/__tests__/probe.test.ts`

**Implementation notes:**
- Single-file probe: `spawn(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', filePath])`. Parse JSON from stdout.
- Local-readability check before ffprobe: `fs.statSync(path)` + read first byte. If either throws or hangs >2s, return `{ warning: 'FILE_NOT_LOCAL' }`.
- Empty path string → `{ warning: 'FILE_PATH_UNAVAILABLE' }`.
- ffprobe non-zero exit OR malformed JSON → `{ warning: 'PROBE_FAILED' }`.
- Batch entry point with concurrency cap: `probeBatch(paths: string[]): Promise<EraseProbeResult[]>` — uses a simple semaphore (or import `JobQueue` from tencent layer? **NO** — keep this self-contained; the JobQueue is feature-agnostic but adding probe to it muddles its purpose).
- A 5-line semaphore inline is fine.

**TDD test plan (write tests FIRST):**
- Test 1: `probeBatch([])` → `[]`.
- Test 2: empty string in batch → `warning: 'FILE_PATH_UNAVAILABLE'`, no spawn call.
- Test 3: `statSync` throws → `warning: 'FILE_NOT_LOCAL'`.
- Test 4: ffprobe exits 0 with `{ format: { duration: "12.34" } }` → returns `durationSeconds: 12.34`.
- Test 5: ffprobe exits 1 → `warning: 'PROBE_FAILED'`.
- Test 6: 10 paths → at most 4 concurrent spawn calls observed (track with a counter in the mock).

**Regression Protection:**
- **Files NOT to touch**: anything outside `smartErase/`.
- **Smoke**: `npm run test:run -- src/main/services/smartErase/`.
- **Tests stay green**: all 26 tencent + 5 posterGen.

**Acceptance criteria:** 6 unit tests pass.

---

### Task 4 — Smart erase runner

**Goal:** The video equivalent of `storyboardSplit/runner.ts`. Streams a local file to COS, calls `ProcessMedia` with `SmartEraseTask`, polls `DescribeTaskDetail`, navigates the nested response, presigns the output. **This is the heaviest TDD task in the plan because the MPS response shape is the bug surface flagged in spec §5.2.**

**Files NEW:**
- `src/main/services/smartErase/runner.ts`
- `src/main/services/smartErase/__tests__/runner.test.ts`

**Implementation notes (verbatim from spec §5.2 + §3 data flow):**

```ts
export interface EraseJobInput {
  taskId: string
  filePath: string                      // absolute, validated by probe
  filename: string
  durationSeconds: number               // from probe; used for dynamic timeout
  posterDataUrl: string                 // pre-generated by posterGen
  config: EraseConfig                   // { definitionId, autoCleanupRemoteAfterDays, ... }
}

export interface EraseJobOutput {
  videoUrl: string                      // 7-day presigned
  videoExpiresAt: number
  outputCosKey: string                  // leading slash stripped
  inputCosKey: string
  posterDataUrl: string                 // passes through unchanged for the IPC event
  mpsTaskId: string
}
```

Pipeline (each step emits `events.onProgress`):
1. `inputCosKey = 'smart-erase/${taskId}/input/${filename}'`
2. `uploadStream({ key, filePath, signal, onTaskReady, onProgress })` — capture COS taskId in `onTaskReady` so external `cancelUpload(cosTaskId)` can abort it (see spec §8.1).
3. `ProcessMedia({ InputInfo: { Type: 'COS', CosInputInfo: {...} }, MediaProcessTask: { SmartEraseTaskSet: [{ Definition: config.definitionId }] }, OutputDir: '/smart-erase/${taskId}/output/', OutputStorage: { Type: 'COS', CosOutputStorage: { Bucket, Region } } })` — capture `resp.MediaProcessTask` ... actually wait, **verify the MPS response field name here**. Spec §5.2 says `WorkflowTask.SmartEraseTaskResult`. The `ProcessMedia` response wraps `TaskId`, `TaskType`, etc. **Implementer must read the SDK typedef at `node_modules/tencentcloud-sdk-nodejs-mps/tencentcloud/services/mps/v20190612/mps_models.d.ts`** before writing this and confirm the polling shape.
4. Polling loop: 5s × 6 → 10s × 30 → 15s thereafter. Each iteration:
   - `DescribeTaskDetail({ TaskId })` → `resp`.
   - If `resp.Status` is `'WAITING' | 'PROCESSING'` → continue.
   - If `resp.Status === 'FINISH'`:
     - `result = resp.WorkflowTask?.SmartEraseTaskResult` (per spec §5.2)
     - If `!result` → throw `OUTPUT_NOT_FOUND`.
     - If `result.Status === 'FAIL'` → throw `MPS_TASK_FAILED` with `${result.ErrCodeExt}: ${result.Message}`.
     - If `result.Status === 'SUCCESS'`:
       - `path = result.Output?.Path` → if missing throw `OUTPUT_NOT_FOUND`.
       - `outputCosKey = path.replace(/^\//, '')` — strip leading slash.
       - `videoUrl = await getPresignedUrl({ key: outputCosKey, expireSeconds: 7 * 86400 })`
       - return `{ videoUrl, videoExpiresAt: now + 7d, outputCosKey, inputCosKey, posterDataUrl, mpsTaskId }`.
5. Timeout: `max(60min, durationSeconds * 4 * 1000)`. On expiry throw `POLL_TIMEOUT`.

**TDD test plan (write tests FIRST):**
Mock `cosClient.uploadStream`, `cosClient.getPresignedUrl`, `mpsClient.getMpsClient` (returns `{ ProcessMedia, DescribeTaskDetail }` mocks). Each test:

- Test 1: happy path → uploadStream called once with key matching pattern, ProcessMedia called once with `Definition: 303`, polling sees one PROCESSING then one FINISH+SUCCESS, output URL returned with leading slash stripped.
- Test 2: `Output.Path = '/smart-erase/abc/output.mp4'` → `outputCosKey = 'smart-erase/abc/output.mp4'` (no leading slash).
- Test 3: poll returns `WorkflowTask.SmartEraseTaskResult.Status === 'FAIL'` with `ErrCodeExt='X'`, `Message='msg'` → throws Error with code `MPS_TASK_FAILED` and message containing `X: msg`.
- Test 4: `Status === 'FINISH'` but `WorkflowTask.SmartEraseTaskResult` is missing → throws `OUTPUT_NOT_FOUND`.
- Test 5: `Status === 'FINISH'`, `result.Status === 'SUCCESS'`, but `Output.Path` is `''` → throws `OUTPUT_NOT_FOUND`.
- Test 6: `Status === 'FINISH'`, `result.Status === 'SUCCESS'`, but `result.Output` is undefined → throws `OUTPUT_NOT_FOUND`.
- Test 7: dynamic timeout: 90-min source → timeout = `90 * 60 * 4 * 1000` ms (≈6h), not the 60-min floor. (Test by injecting a fake clock; verify the deadline math, do NOT actually wait 6 hours).
- Test 8: 5-min source → timeout = 60-min floor (`5*60*4*1000 = 1.2M ms < 60min = 3.6M ms`).
- Test 9: `signal.aborted` after upload → throws `TASK_CANCELLED` BEFORE calling `ProcessMedia`.
- Test 10: `signal.aborted` mid-poll → throws `TASK_CANCELLED`; no further `DescribeTaskDetail` calls happen.
- Test 11: `ProcessMedia` rejects with `{ code: 'InvalidParameterValue.Definition' }` → throws `TEMPLATE_NOT_FOUND`.

**MPS SDK shape verification (MANDATORY — direct reference to lessons learned §0):**

Before writing the runner, the implementer must paste this output into the PR description:

```bash
node -e "const m = require('tencentcloud-sdk-nodejs-mps'); console.log('mps:', typeof m.mps); console.log('Client:', typeof m.mps?.v20190612?.Client); const C = m.mps.v20190612.Client; console.log('ProcessMedia:', typeof C.prototype.ProcessMedia); console.log('DescribeTaskDetail:', typeof C.prototype.DescribeTaskDetail);"
```

Expected: all four `function`/`object`. If any is `undefined`, **stop the task** and ping the planner — the SDK shape is wrong and the rest of the runner won't work.

Also paste `grep -n "SmartEraseTaskResult\|WorkflowTask\|DescribeTaskDetail" node_modules/tencentcloud-sdk-nodejs-mps/tencentcloud/services/mps/v20190612/mps_models.d.ts | head -30` so the response navigation is grounded in the actual SDK types, not on the spec's prose.

**Regression Protection:**
- **Files NOT to touch**: anything in `tencent/`, `storyboardSplit/`, or other smartErase files (only `runner.ts` and its test in this task).
- **Smoke**: `npm run test:run -- src/main/services/`.
- **Tests stay green**: all 26 tencent + 5 posterGen + 6 probe = 37 unit tests.

**Acceptance criteria:** 11 unit tests pass; SDK shape verification output is in PR description.

---

### Task 5 — Reaper

**Goal:** `Map<mpsTaskId, { inputCosKey, signal }>` of cancelled-but-still-processing tasks. Polls each entry until terminal, then deletes both COS objects. Process-lifetime only; not persisted across restarts (spec §8.1).

**Files NEW:**
- `src/main/services/smartErase/reaper.ts`
- `src/main/services/smartErase/__tests__/reaper.test.ts`

**Implementation notes:**
- Public API:
  ```ts
  export function trackForReaping(mpsTaskId: string, inputCosKey: string): void
  export function untrackAndCleanupAll(): Promise<void>     // called by cancelAllActive
  export function getReapingSize(): number                  // for debug
  ```
- Internally a single `setInterval` (5s) iterates the map; each iteration calls `DescribeTaskDetail`. On terminal status (`FINISH` regardless of inner success/fail), calls `deleteObjects([inputCosKey, outputCosKey])` best-effort and removes the entry.
- Logs warnings on cleanup failure but never throws back into the caller.

**TDD test plan:**
- Test 1: `trackForReaping` then poll returns `FINISH+SUCCESS` with output → `deleteObjects` called with both keys; entry removed.
- Test 2: `FINISH+FAIL` → `deleteObjects` still called with `[inputCosKey]` only (no output). Entry removed.
- Test 3: `PROCESSING` → entry stays.
- Test 4: `deleteObjects` rejects → entry still removed; warning logged. Reaper does not crash.
- Test 5: `untrackAndCleanupAll` → all entries cleared; interval stopped; pending poll-in-flight is allowed to finish (best-effort).

**Regression Protection:**
- **Files NOT to touch**: tencent, storyboardSplit. Only this task's two files.
- **Smoke**: `npm run test:run -- src/main/services/smartErase/`.
- **Tests stay green**: all 37 from prior tasks.

**Acceptance criteria:** 5 unit tests pass.

---

### Task 6 — Service composer (`smartErase/index.ts`)

**Goal:** The same shape as `storyboardSplit/index.ts`: instantiate `JobQueue<EraseJobInput, EraseJobOutput>`, expose `submitErase`, `cancelTask`, `cancelAllActiveSmartEraseTasks`, `getConfig`, `setCredentialsFromUI`, `deleteRemoteObjects`, `setMainWindow`. Plus posterGen + probe + reaper integration.

**Files NEW:**
- `src/main/services/smartErase/index.ts`
- `src/main/services/smartErase/config.ts` — small file: re-exports `getCredentials/setCredentials/getCredentialState` from `tencent/credentials` (for callers that don't want to know about the shared layer) plus `DEFAULT_ERASE_CONFIG` constant.
- `src/main/services/smartErase/__tests__/index.test.ts` (integration test using mocked runner + reaper).

**Implementation notes:**
- **Two JobQueue instances**, hand-off via in-process state:
  - `uploadQueue = new JobQueue({ maxConcurrent: 3, runner: runUploadOnly, ... })`
  - `processQueue = new JobQueue({ maxConcurrent: 40, runner: runProcessOnly, ... })`
  - **OR** simpler: single JobQueue with maxConcurrent: 40, but use a per-task semaphore inside the runner gating only the upload phase. Pick one and document the choice in the PR.
  - Default recommendation: **single JobQueue + upload semaphore**, fewer moving parts; but be clear about which the implementer chose.
- IPC handler for `smart-erase:probe-batch` calls `probeBatch` from `probe.ts`; this is synchronous-ish (no JobQueue), happens at drop time before any submit.
- `submitErase`: generates posterDataUrl (calls `posterGen`), then enqueues. If poster fails, still enqueue with empty posterDataUrl (poster is non-essential).
- Cancel during `processing` calls `reaper.trackForReaping(mpsTaskId, inputCosKey)` and removes from active set.
- `setMainWindow` mirrors storyboardSplit's pattern verbatim. Use `safeSend` helper.

**TDD test plan (integration-leaning):**
- Test 1: `submitErase` → `getActiveCount()` becomes 1; runner is invoked with the right input.
- Test 2: cancel during `processing` (mock runner stays in progress) → `reaper.trackForReaping` called; task removed from active set; `erase:progress` emits `cancelled`.
- Test 3: `cancelAllActiveSmartEraseTasks()` → all active tasks cancelled; reaper retains in-flight entries (does NOT clear).
- Test 4: poster generation throws → submit still proceeds; warning logged; `posterDataUrl` is `""`.

Mock `runner` and `reaper` via `vi.mock`. Do NOT exercise the real runner here (Task 4 covers that).

**Regression Protection:**
- **Files NOT to touch**: tencent, storyboardSplit. Other smartErase files only via imports (don't modify them).
- **Smoke**: `npm run test:run -- src/main/services/`.
- **Manual**: NOT required this task (no UI yet); main-process file not yet wired.
- **Tests stay green**: all from prior tasks.

**Acceptance criteria:** 4 integration tests pass; service shape matches `storyboardSplit/index.ts` (same exports modulo names).

---

### Task 7 — Main process integration ⚠️ HIGH RISK

**Goal:** Wire the smartErase service into Electron's main process: 6 IPC handlers, setMainWindow, `cancelAllActiveSmartEraseTasks` in `window-all-closed`, **CSP `media-src` extension to allow `https:`**.

**Files MODIFIED:**
- `src/main/index.ts` — additive only.

**Why HIGH risk:** This file is the shared shell. The image-drop crash from the refactor regressed *exactly* because changes to a shared file weren't smoke-tested end-to-end. Same trap is present here: if the implementer accidentally:
- Changes a `media-src` value used by a different feature → that feature's media stops loading.
- Modifies the `window-all-closed` hook structure → existing `cancelAllActiveTasks()` for storyboardSplit is dropped or out-of-order.
- Conflicts an IPC channel name with an existing one → silent override.

**Implementation steps:**
1. **Read `src/main/index.ts` end-to-end first.** Take notes on what's already there.
2. Imports: add at top, near the existing storyboardSplit import block (lines 1–15):
   ```ts
   import {
     submitErase,
     cancelEraseTask,
     cancelAllActiveSmartEraseTasks,
     getEraseConfig,
     setEraseCredentialsFromUI,
     deleteEraseRemoteObjects,
     probeBatch as probeEraseBatch,
     setMainWindow as setEraseMainWindow,
   } from './services/smartErase'
   ```
3. CSP at line 232 — change one literal:
   - Before: `"media-src 'self' data: blob:"`
   - After: `"media-src 'self' data: blob: https:"`

   Add inline comment: `// allow COS HTTPS presigned URLs for smart erase video playback`.
4. After `setSplitMainWindow(currentWindow)` (around line 523, mirroring updater.setMainWindow), add `setEraseMainWindow(currentWindow)` on the next line.
5. In `window-all-closed` hook (around line 541): change the existing single call to:
   ```ts
   cancelAllActiveTasks()
   cancelAllActiveSmartEraseTasks()
   ```
   Order does not matter; both are best-effort fire-and-forget.
6. After the existing `storyboard-split:*` IPC block (line 1062–1086), add a new section starting at line 1087 or so:
   ```ts
   // ==================== 智能去字幕 IPC ====================
   ipcMain.handle('smart-erase:probe-batch', async (_e, paths) => probeEraseBatch(paths))
   ipcMain.handle('smart-erase:submit', async (_e, payload) => submitErase(payload))
   ipcMain.handle('smart-erase:cancel', async (_e, { taskId }) => cancelEraseTask(taskId))
   ipcMain.handle('smart-erase:get-config', async () => getEraseConfig())
   ipcMain.handle('smart-erase:set-credentials', async (_e, creds) => setEraseCredentialsFromUI(creds))
   ipcMain.handle('smart-erase:delete-remote', async (_e, keys) => deleteEraseRemoteObjects(keys))
   ```

**TDD test plan:** This file has no unit tests today and adding a Vitest harness for the Electron main process is out of scope. Acceptance is **manual smoke + diff review**.

**Regression Protection (CRITICAL):**

- **Files NOT to touch**: anything outside `src/main/index.ts`. Specifically NOT `tencent/*`, `storyboardSplit/*`, preload, renderer.
- **`git diff src/main/index.ts` review checklist**:
  - Only **additions** for IPC handlers (6 lines + 1 comment).
  - One **literal change** to CSP `media-src` line.
  - One **literal change** to `window-all-closed` body (1 line added).
  - One **addition** of `setEraseMainWindow(currentWindow)` line.
  - One **addition** to imports.
  - **Nothing else.** If the diff shows any other change, the review fails.
- **Smoke after task** (mandatory; do NOT skip — this is the regression we just suffered):
  ```bash
  npm run build                                  # must succeed
  npm run dev                                     # launch dev mode
  ```
  Then in the running app:
  1. Open 宫格拆图 tab.
  2. Drop one image (any 9-grid jpg).
  3. **Confirm**: image is uploaded, MPS task submits, polling progresses, results render.
  4. Open settings drawer; confirm credential state still shows.
  5. Quit the app. Watch dev terminal for any "Cannot read properties of undefined" errors.

  Paste the entire dev console output (from `[Performance] App ready` to app quit) into the PR description.

- **Tests stay green**: all 37+4 = 41 unit tests.

**Acceptance criteria:**
- Diff matches checklist exactly.
- Manual smoke output pasted; storyboardSplit drop-image still works.
- App quits cleanly (no `cancelAllActive*` errors in console).

---

### Task 8 — Renderer feature + final E2E

**Goal:** Build the React tab and components, register in HTML, mount/unmount, and run the full end-to-end matrix from spec §12.

This is intentionally one big task (vs. splitting into 3) because the components are tightly coupled and the manual E2E matrix is the only meaningful acceptance gate — splitting would add review overhead without adding signal.

**Files NEW (10):**
- `src/renderer/src/utils/idbKeyValStore.ts` — thin zustand-compatible storage wrapper around `idb-keyval`. Pattern:
  ```ts
  export function createIdbStorage<T>(key: string): StateStorage { /* get/set/remove via idb-keyval */ }
  ```
- `src/renderer/src/stores/useEraseSessionStore.ts` — ephemeral; mirror `useSplitSessionStore` structure.
- `src/renderer/src/stores/useErasePersistStore.ts` — uses `idbKeyValStore`; spec §7.2 shape.
- `src/renderer/src/pages-react/SmartErasePage.tsx` — top-level page; mirror `StoryboardSplitPage.tsx` structure.
- `src/renderer/src/pages-react/smart-erase/EraseUploader.tsx` — drag/drop + ffprobe pre-flight + cost confirm dialog.
- `src/renderer/src/pages-react/smart-erase/EraseQueue.tsx` — 3 counters: queued / uploading / processing.
- `src/renderer/src/pages-react/smart-erase/EraseResultPanel.tsx` — processed video + side-by-side compare toggle (spec §10).
- `src/renderer/src/pages-react/smart-erase/EraseHistoryDrawer.tsx` — 50 cap, idb-keyval-backed.
- `src/renderer/src/pages-react/smart-erase/useEraseEvents.ts` — subscribes to `onSmartEraseEvent`; updates session store.

**Files MODIFIED (1):**
- `src/renderer/index.html` — add tab button + `<div id="smart-erase-react-root">`. Mirror the `<div id="storyboard-split-react-root">` block.

**Implementation notes:**
- **Tab integration**: read how `StoryboardSplitPage` is mounted today. Whatever mechanism it uses (`pages-react/index.ts` re-export?), extend it the same way. Do NOT invent a new bridge.
- **Cost confirm dialog**: when `probeResults.totalDuration > 60min` OR `count > 10`, show a modal before calling `smart-erase:submit`. User clicks "继续" → submit; "取消" → no-op.
- **Side-by-side compare**: two `<video>` elements with synced `currentTime`; if `originalFilePath` doesn't exist (`fs.existsSync` via a new `electronAPI.fileExists`?), show "原视频不可用" placeholder instead. **Avoid** adding a new IPC; instead, attempt to set `<video src="file://...">` and listen for `onerror` to fall back.
- **History persistence**: `useErasePersistStore` MUST use `idb-keyval`, NOT `localStorage`. Verify by checking that `localStorage` is not mentioned in the file.

**TDD test plan:** Renderer testing in this codebase is uneven; existing storyboardSplit components have minimal unit coverage. Match that level — **don't over-invest**. Specifically:
- `useEraseSessionStore`: 2 tests (set/get task patch, removeTask).
- `useErasePersistStore`: 2 tests (pushHistory caps at 50, removeHistory removes by id). Mock `idb-keyval` with `vi.mock`.
- One Uploader smoke: dropping a synthetic File with no path → expect a `FILE_PATH_UNAVAILABLE` toast (spy on `window.electronAPI.getFilePath` returning `""`).

That's it for renderer unit tests. Heavy lifting is in manual E2E.

**Manual E2E matrix (spec §12, must execute and paste outcomes into PR description):**

| # | Scenario | Expected | Pass? |
|---|---|---|---|
| 1 | **Storyboard split still works** | Drop 1 image → split → finished | ⬜ |
| 2 | Drop 1 small mp4 (≤30s) | Probe → upload → process → video plays in result panel | ⬜ |
| 3 | Drop 12 mp4 (mixed) | Cost dialog appears (>10 count) → confirm → max 3 uploading at once | ⬜ |
| 4 | Drop file from OneDrive placeholder (if available) | `FILE_NOT_LOCAL` toast | ⬜ |
| 5 | Drop file dragged from browser tab | `FILE_PATH_UNAVAILABLE` toast | ⬜ |
| 6 | Cancel during upload | Upload aborts within ~5s | ⬜ |
| 7 | Cancel during processing | Local removed; reaper logs poll until terminal; both COS objects deleted | ⬜ |
| 8 | Wrong credentials | `INVALID_CREDENTIALS` → settings auto-open | ⬜ |
| 9 | Definition: 999999 (nonexistent) | `TEMPLATE_NOT_FOUND` toast + manual fallback link | ⬜ |
| 10 | Switch tabs mid-task | Background processing continues; events still dispatched | ⬜ |
| 11 | App restart | History preserved (idb-keyval); reaping queue NOT preserved | ⬜ |
| 12 | Side-by-side with original moved/deleted | "原视频不可用" placeholder; processed still plays | ⬜ |
| 13 | Window closed during upload | `cancelAllActiveSmartEraseTasks` flushes; uploads abort | ⬜ |
| 14 | After all of above: re-run scenario #1 | Storyboard split STILL works (no creeping regression) | ⬜ |

**Regression Protection:**
- **Files NOT to touch**: `src/main/services/tencent/*`, `src/main/services/storyboardSplit/*`, `src/main/index.ts` (already done in Task 7), `src/preload/index.ts` (already done in Task 1).
- **Smoke**: `npm run build && npm run dev`, then walk the matrix above.
- **Tests stay green**: all 41+ unit tests.

**Acceptance criteria:**
- All 14 manual scenarios pass; outcomes pasted in PR.
- No new console errors when running storyboardSplit.
- Final commit message includes `Closes-spec: docs/specs/2026-04-29-smart-erase-feature-design.md`.

---

## 5. Final review pass

After Task 8, dispatch one `ce-correctness-reviewer` + one `ce-maintainability-reviewer` over the entire smartErase feature delta (`git diff main...feature-branch -- src/main/services/smartErase src/types/smartErase.ts src/preload/index.ts src/renderer/src/pages-react/smart-erase src/renderer/src/stores/useEraseSessionStore.ts src/renderer/src/stores/useErasePersistStore.ts`).

Both reviewers must read this plan's §0 first; the lessons-learned rules apply to their assessment.

---

## 6. Rollback

All changes additive. To roll back:
1. Delete the 16 new files.
2. Revert the 4 modified files (use `git checkout main -- <file>` to be precise).
3. Uninstall added deps: `npm uninstall ffmpeg-static ffprobe-static idb-keyval`.

The shared `tencent/*` layer and `storyboardSplit` are untouched throughout this plan; if rollback is needed, neither is at risk.

---

## 7. Open verification items inherited from spec §16

1. Real-account `Definition: 303` smoke — run during Task 4 once credentials are in dev env. If it fails with `TEMPLATE_NOT_FOUND`, surface the manual copy-template fallback before Task 8 ships.
2. ffprobe latency on 5 GB file (Task 3 — measure during dev, decide if probe needs to be deferred to background after enqueueing).
3. `<video>` with 7-day COS presigned URL (Task 8 manual E2E — verify Range request behavior; if scrubbing is broken, document as known limitation).
4. `ffmpeg-static` install size impact on packaged app (Task 1 — note bundle size before/after; if > 50 MB increase, ask user before merging).

These are flagged for the implementer to surface in PR description, not gate the merge unless they reveal a deal-breaker.
