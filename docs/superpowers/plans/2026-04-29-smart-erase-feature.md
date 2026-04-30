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
6. **Dependency API surface verification**: tasks that depend on the shared `tencent/*` layer (Task 4 runner, Task 6 composer) must, before writing the call site, paste the **current exported signatures** they consume from the trunk into the PR description. If a future trunk PR changes those signatures, this paper trail makes the breakage obvious.
7. **Regression checklist runs every task**: see §3.

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

**Goal:** Stand up the type contract and IPC surface (no runtime logic in main process). Subsequent tasks compile against these shapes.

**Files:**
- Create: `src/types/smartErase.ts`
- Modify: `src/preload/index.ts`
- Modify: `package.json`

**Files NOT to touch:** `src/main/services/tencent/*`, `src/main/services/storyboardSplit/*`, `src/main/index.ts`, `src/renderer/**`, anything else.

**Tests that must stay green throughout:** `src/main/services/tencent/__tests__/{credentials,jobQueue,cosClient,mpsClient}.test.ts` (26).

---

#### Step 1.1 — Install runtime deps

- [ ] **Run:**
  ```bash
  npm install --save ffmpeg-static@^5 ffprobe-static@^3 idb-keyval@^6
  ```
- [ ] **Verify package shapes locally** (regression-protection rule §0.2 — mocks must mirror real shape; check the FULL surface we depend on, not just one symbol, otherwise we're blind to partial-shape regressions):
  ```bash
  node -e "console.log('ffmpeg-static:', typeof require('ffmpeg-static')); const fp=require('ffprobe-static'); console.log('ffprobe-static keys:', Object.keys(fp), '.path:', typeof fp.path); const idb=require('idb-keyval'); console.log('idb-keyval keys:', Object.keys(idb).filter(k=>['get','set','del','clear','update','keys'].includes(k)).sort())"
  ```
  **Expected (verbatim — Task 8 mocks, persist store, and reaper depend on all of these):**
  ```
  ffmpeg-static: string
  ffprobe-static keys: [ 'path' ] .path: string
  idb-keyval keys: [ 'clear', 'del', 'get', 'keys', 'set', 'update' ]
  ```
  If any line differs (missing methods, different return type, extra/missing keys), STOP and update the plan — the package shape changed and Tasks 2/3/8 mocks would be wrong.
- [ ] **Verify tencent tests still green:**
  ```bash
  npm run test:run -- src/main/services/tencent/
  ```
  **Expected:** `Test Files  4 passed (4)` and `Tests  26 passed (26)`.

#### Step 1.2 — Add `build.asarUnpack` config

The `ffmpeg-static` / `ffprobe-static` binaries cannot be executed from inside `app.asar` (verified Context7: electron-builder packages everything into asar by default). **The current `package.json` has NO top-level `"build"` object** (only a `"build"` script entry; electron-builder is running on defaults). Therefore Task 1 must CREATE the config block.

- [ ] **Re-verify** `package.json` has no top-level `"build"` key (only the `"scripts"` `"build"` entry). If you find a real `"build"` config block, STOP and amend the plan — the merge strategy changes.
- [ ] **Add** a new top-level `"build"` object in `package.json`, placed AFTER `"main"` and BEFORE `"scripts"` (alphabetical-ish ordering keeps the diff readable). Insert exactly:
  ```jsonc
  "build": {
    "asarUnpack": [
      "**/node_modules/ffmpeg-static/**",
      "**/node_modules/ffprobe-static/**"
    ]
  },
  ```
  ⚠️ Mind the trailing comma on the closing brace if `"main"` already has one (it does — line 5 ends with `","`). Add a comma after `}` of `"build"` so `"scripts"` parses.
- [ ] **Verify JSON is still valid:**
  ```bash
  node -e "console.log('OK', !!require('./package.json').build.asarUnpack[0])"
  ```
  **Expected:** `OK true`.
- [ ] **Verify diff:**
  ```bash
  git diff package.json
  ```
  **Expected:** additions to `dependencies` (3 entries from Step 1.1) PLUS new `"build"` block. Zero deletions.

#### Step 1.3 — Create `src/types/smartErase.ts`

- [ ] **Create file** with exactly the following content (literal copy from spec §5.1, verified character-for-character against `docs/specs/2026-04-29-smart-erase-feature-design.md` lines 152–229):
  ```ts
  export interface EraseConfig {
    mode: 'definition'              // ScheduleId deferred to Phase 2
    definitionId: number            // default 303 = 系统预设·去字幕-至尊版
    autoCleanupRemoteAfterDays: number
  }

  export const DEFAULT_ERASE_CONFIG: EraseConfig = {
    mode: 'definition',
    definitionId: 303,
    autoCleanupRemoteAfterDays: 7,
  }

  export interface EraseSubmitPayload {
    filePath: string                // absolute local path from webUtils.getPathForFile
    filename: string
    fileSize: number
    durationSeconds: number         // from ffprobe
  }

  export interface EraseProbeResult {
    filePath: string
    filename: string
    fileSize: number
    durationSeconds: number
    warning?: 'FILE_PATH_UNAVAILABLE' | 'FILE_NOT_LOCAL' | 'PROBE_FAILED'
  }

  export interface EraseTask {
    id: string
    filename: string
    fileSize: number
    durationSeconds: number
    status: 'queued-upload' | 'uploading' | 'queued-process' | 'submitting' | 'processing' | 'finished' | 'failed' | 'cancelled'
    uploadProgress?: number         // 0-100
    mpsTaskId?: string
    startedAt: number
    finishedAt?: number
    errorCode?: string
    errorMessage?: string
  }

  export interface EraseHistoryItem {
    id: string
    filename: string
    fileSize: number
    durationSeconds: number
    videoUrl: string                // COS presigned, 7 days
    videoExpiresAt: number
    posterDataUrl: string           // local ffmpeg base64 jpeg, ~10 KB; never expires
    outputCosKey: string
    inputCosKey: string
    originalFilePath: string        // for side-by-side compare; may not exist anymore — UI handles missing gracefully
    createdAt: number
  }

  export interface EraseProgressEvent {
    taskId: string
    status: EraseTask['status']
    uploadProgress?: number
    mpsTaskId?: string
  }

  export interface EraseFinishedEvent {
    taskId: string
    videoUrl: string
    videoExpiresAt: number
    outputCosKey: string
    inputCosKey: string
  }

  export interface EraseFailedEvent {
    taskId: string
    errorCode: string               // SCREAMING_SNAKE_CASE; see spec §8
    errorMessage: string
    stage: 'probe' | 'upload' | 'submit' | 'poll' | 'output' | 'unknown'
  }
  ```
- [ ] **Verify:**
  ```bash
  npx tsc --noEmit
  ```
  **Expected:** exit 0, no errors involving `smartErase.ts`. (Pre-existing errors in unrelated files are OK as long as no new ones appear.)

#### Step 1.4 — Add `SMART_ERASE` to `IPC_CHANNELS` in preload

`src/preload/index.ts` currently has a `STORYBOARD_SPLIT` block at lines ~97–110. Mirror it for smart-erase.

- [ ] **Add `webUtils` to imports** at the top of the file (currently only `ipcRenderer, IpcRendererEvent` are imported from electron). Change line 10 from:
  ```ts
  import { ipcRenderer, IpcRendererEvent } from 'electron'
  ```
  to:
  ```ts
  import { ipcRenderer, IpcRendererEvent, webUtils } from 'electron'
  ```
- [ ] **Add type imports** at the import block (after the existing `from '../types/storyboardSplit'` import). Append a new import statement:
  ```ts
  import type {
    EraseSubmitPayload,
    EraseConfig,
    EraseProgressEvent,
    EraseFinishedEvent,
    EraseFailedEvent,
    EraseProbeResult,
  } from '../types/smartErase'
  ```
- [ ] **Inside `IPC_CHANNELS`**, immediately after the `STORYBOARD_SPLIT_EVENTS` closing bracket and BEFORE the trailing `} as const`, insert:
  ```ts
    // 智能去字幕
    SMART_ERASE: {
      PROBE_BATCH: 'smart-erase:probe-batch',
      SUBMIT: 'smart-erase:submit',
      CANCEL: 'smart-erase:cancel',
      GET_CONFIG: 'smart-erase:get-config',
      SET_CREDENTIALS: 'smart-erase:set-credentials',
      DELETE_REMOTE: 'smart-erase:delete-remote',
    },
    SMART_ERASE_EVENTS: [
      'erase:progress',
      'erase:finished',
      'erase:failed',
    ] as const,
  ```
  ⚠️ Channel names match spec §6 exactly: outgoing channels prefixed `smart-erase:`, incoming events prefixed `erase:` (different prefix is intentional — incoming events use the shorter name for renderer-side consistency with existing `onStoryboardSplitEvent` callback channel pattern).
- [ ] **Verify diff is additive only:**
  ```bash
  git diff src/preload/index.ts
  ```
  **Expected:** zero deletions, only additions in the lines reviewed above.

#### Step 1.5 — Add 9 methods to `ElectronAPI` interface

- [ ] In `src/preload/index.ts`, find the `// 宫格拆图` block in the `ElectronAPI` interface (currently around lines 214–222). Immediately after `removeStoryboardSplitListeners: () => void` and before `// 通用事件监听`, insert:
  ```ts
    // 智能去字幕
    smartEraseProbeBatch: (paths: string[]) => Promise<EraseProbeResult[]>
    smartEraseSubmit: (payload: EraseSubmitPayload) => Promise<{ success: boolean; taskId?: string; error?: string; errorCode?: string }>
    smartEraseCancel: (taskId: string) => Promise<{ success: boolean }>
    smartEraseGetConfig: () => Promise<{ success: boolean; defaults: EraseConfig; credentials: { hasCredentials: boolean; secretId?: string; bucket?: string; region?: string } }>
    smartEraseSetCredentials: (creds: { secretId: string; secretKey: string; bucket: string; region: string }) => Promise<{ success: boolean }>
    smartEraseDeleteRemote: (cosPaths: string[]) => Promise<{ success: boolean; error?: string }>
    onSmartEraseEvent: (callback: (channel: string, data: EraseProgressEvent | EraseFinishedEvent | EraseFailedEvent) => void) => void
    removeSmartEraseListeners: () => void
    // 文件路径访问（合成 File 对象返回 ""，非 File 对象抛异常被吞掉返回 ""）
    getFilePath: (file: File) => string
  ```
- [ ] **Verify TypeScript:**
  ```bash
  npx tsc --noEmit
  ```
  **Expected:** exit 0 (no error about missing implementations yet — types are declarations only).

#### Step 1.6 — Implement `electronAPI` methods

- [ ] In the `electronAPI: ElectronAPI = { ... }` literal, find the `removeStoryboardSplitListeners` block (around lines 427–431). Immediately after that and BEFORE the `// ============ 通用事件监听 ============` comment, insert:
  ```ts
    // ============ 智能去字幕 ============
    smartEraseProbeBatch: (paths: string[]) =>
      safeInvoke(IPC_CHANNELS.SMART_ERASE.PROBE_BATCH, paths),

    smartEraseSubmit: (payload: EraseSubmitPayload) =>
      safeInvoke(IPC_CHANNELS.SMART_ERASE.SUBMIT, payload),

    smartEraseCancel: (taskId: string) =>
      safeInvoke(IPC_CHANNELS.SMART_ERASE.CANCEL, { taskId }),

    smartEraseGetConfig: () =>
      safeInvoke(IPC_CHANNELS.SMART_ERASE.GET_CONFIG),

    smartEraseSetCredentials: (creds) =>
      safeInvoke(IPC_CHANNELS.SMART_ERASE.SET_CREDENTIALS, creds),

    smartEraseDeleteRemote: (cosPaths: string[]) =>
      safeInvoke(IPC_CHANNELS.SMART_ERASE.DELETE_REMOTE, cosPaths),

    onSmartEraseEvent: (callback) => {
      for (const ch of IPC_CHANNELS.SMART_ERASE_EVENTS) {
        ipcRenderer.on(ch, (_event: IpcRendererEvent, data: any) => callback(ch, data))
      }
    },

    removeSmartEraseListeners: () => {
      for (const ch of IPC_CHANNELS.SMART_ERASE_EVENTS) {
        ipcRenderer.removeAllListeners(ch)
      }
    },

    // 包裹 try/catch 是因为 webUtils.getPathForFile 在传入非 File 对象时会抛异常
    // （而合成 File 只是返回 ""，二者必须区分但对调用方都视作 FILE_PATH_UNAVAILABLE）
    getFilePath: (file: File): string => {
      try { return webUtils.getPathForFile(file) }
      catch { return '' }
    },
  ```
- [ ] **Verify build:**
  ```bash
  npm run build:vite
  ```
  **Expected:** Vite build succeeds for main, preload, renderer; preload `out/preload/index.js` exists. (If a TypeScript error fires for `getFilePath` arg type, double-check spelling against Step 1.5's interface signature.)

#### Step 1.7 — Append events to `on`/`off` allowedChannels

- [ ] In the `on:` method body (around line 436), the existing `allowedChannels` array is:
  ```ts
  const allowedChannels = [
    ...IPC_CHANNELS.UPDATE_EVENTS,
    IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED,
    'updater:download-retry',
    ...IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS,
  ]
  ```
  Append `...IPC_CHANNELS.SMART_ERASE_EVENTS,` as the last entry. Result:
  ```ts
  const allowedChannels = [
    ...IPC_CHANNELS.UPDATE_EVENTS,
    IPC_CHANNELS.SYSTEM.NATIVE_THEME_CHANGED,
    'updater:download-retry',
    ...IPC_CHANNELS.STORYBOARD_SPLIT_EVENTS,
    ...IPC_CHANNELS.SMART_ERASE_EVENTS,
  ]
  ```
- [ ] **Repeat for the `off:` method body** (around line 450). Same change.
- [ ] **Verify diff is exactly two single-line additions:**
  ```bash
  git diff src/preload/index.ts | grep -E "^\+" | grep -v "^\+\+\+"
  ```
  Count of `+...IPC_CHANNELS.SMART_ERASE_EVENTS,` lines should be exactly **2** (one for `on`, one for `off`).

#### Step 1.8 — Full smoke

- [ ] **Build full app:**
  ```bash
  npm run build
  ```
  **Expected:** exit 0; `out/preload/index.js` and `out/main/index.js` and renderer bundle all produced.
- [ ] **Run all unit tests:**
  ```bash
  npm run test:run
  ```
  **Expected:** the same `26 passed` total as before Task 1 started, no new failures, no new tests yet (Task 2 adds the first new tests).
- [ ] **Manual dev smoke (regression-protection §0.5 — MANDATORY):**
  ```bash
  npm run dev
  ```
  - Wait for the app window to open.
  - Click into the **宫格拆图** tab.
  - Drop one 9-grid jpg/png from disk.
  - **Confirm:** image uploads to COS, MPS task submits, polling progresses, 9 split images render.
  - Open settings drawer; confirm credential state still shows correctly.
  - In the dev DevTools console (Ctrl+Shift+I), run:
    ```js
    window.electronAPI.getFilePath(new File([], "synthetic.txt"))
    ```
    **Expected:** returns `""` (string, no exception).
  - Run also:
    ```js
    typeof window.electronAPI.smartEraseSubmit
    ```
    **Expected:** `"function"`.
  - Quit the app via the close button. Watch dev terminal — must NOT see `Cannot read properties of undefined` or any `cancelAllActive*` errors.
- [ ] **Paste the dev terminal output** (from `[Performance] App ready` to app quit) into the PR description for review.

#### Step 1.9 — Commit

- [ ] **Stage and commit:**
  ```bash
  git add src/types/smartErase.ts src/preload/index.ts package.json package-lock.json
  git status   # verify exactly these 4 files staged, nothing else
  git commit -m "feat(smart-erase): types + IPC contract + preload + deps (Task 1/8)

  Add type definitions, 6 IPC channels (smart-erase:*), 3 event channels
  (erase:*), 9 preload API methods including getFilePath() wrapping
  webUtils.getPathForFile defensively. Add ffmpeg-static, ffprobe-static,
  idb-keyval deps and asarUnpack patterns so binaries are executable in
  packaged builds.

  Pure additive: storyboardSplit IPC and runtime untouched. Manual smoke:
  9-grid split still works, electronAPI.getFilePath(synthetic File) returns
  '' as documented.

  Refs: docs/superpowers/plans/2026-04-29-smart-erase-feature.md Task 1"
  ```

**Acceptance criteria for Task 1:**
- All 9 step checkboxes ticked above.
- Diff scope: exactly 4 files (`src/types/smartErase.ts` new + `src/preload/index.ts` modified + `package.json` modified + `package-lock.json` modified). No other files touched.
- 26 tencent unit tests still green.
- Manual storyboardSplit smoke succeeded; dev terminal output pasted in PR.
- `window.electronAPI.smartEraseSubmit` typechecks and is a function at runtime; `window.electronAPI.getFilePath(synthetic File)` returns `""`.

---

### Task 2 — Local ffmpeg poster generator

**Goal:** Pure function that takes a video path and returns a ~10 KB base64 JPEG of the 0.5s frame. Replaces COS-CI snapshot from spec v1.0.

**Files NEW:**
- `src/main/services/smartErase/posterGen.ts`
- `src/main/services/smartErase/__tests__/posterGen.test.ts`

**Implementation notes:**
- Use `ffmpeg-static` (resolves to a binary path at runtime).
- **Production-build path patch (MANDATORY)** — `require('ffmpeg-static')` returns a string that, in a packaged app, points inside `app.asar`. `child_process.spawn` cannot exec inside asar. Compose the runtime path as:
  ```ts
  import ffmpegStatic from 'ffmpeg-static'
  const ffmpegPath = (ffmpegStatic ?? '').replace('app.asar', 'app.asar.unpacked')
  if (!ffmpegPath) throw new Error('ffmpeg-static binary not found')
  ```
  Same pattern applies to `ffprobe-static.path` in Task 3. The `asarUnpack` config from Task 1 makes the `.unpacked` directory exist; this string replace makes the path resolve to it.
- Spawn:
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
- Resolve the binary path the same way as ffmpeg in Task 2:
  ```ts
  import ffprobeStatic from 'ffprobe-static'
  const ffprobePath = (ffprobeStatic.path ?? '').replace('app.asar', 'app.asar.unpacked')
  if (!ffprobePath) throw new Error('ffprobe-static binary not found')
  ```
  Note: `ffprobe-static` exports `{ path }`, not the bare string (different from `ffmpeg-static`). Verify with `node -e "console.log(require('ffprobe-static'))"` before coding.
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
3. **Submit `ProcessMedia` — exact shape verified against SDK typedef `mps_models.d.ts:9383` (ProcessMediaRequest), `:7430` (SmartEraseTaskInput):**
   ```ts
   const resp = await client.ProcessMedia({
     InputInfo: {
       Type: 'COS',
       CosInputInfo: { Bucket: creds.bucket, Region: creds.region, Object: '/' + inputCosKey },
     },
     OutputStorage: { Type: 'COS', CosOutputStorage: { Bucket: creds.bucket, Region: creds.region } },
     OutputDir: `/smart-erase/${taskId}/output/`,
     SmartEraseTask: { Definition: config.definitionId },        // ← TOP-LEVEL field, single object
   })
   const mpsTaskId = resp.TaskId
   ```

   ⚠️ **Common pitfall the spec §3 prose hinted at but is easy to mis-read:** `SmartEraseTask` is a **sibling** of `MediaProcessTask` inside `ProcessMediaRequest`, NOT nested inside it. It is also NOT a `*Set` array (unlike `TranscodeTaskSet` etc. inside `MediaProcessTaskInput`). Single object, single Definition.

4. **Polling loop — exact shape verified against `mps_models.d.ts:18403` (DescribeTaskDetailResponse), `:22483` (WorkflowTask), `:15545` (SmartEraseTaskResult), `:15433` (AiAnalysisTaskDelLogoOutput).**

   Cadence: 5s × 6 → 10s × 30 → 15s thereafter. Each iteration:
   ```ts
   const resp = await client.DescribeTaskDetail({ TaskId: mpsTaskId })

   // Top-level Status: 'WAITING' | 'PROCESSING' | 'FINISH'
   if (resp.Status === 'WAITING' || resp.Status === 'PROCESSING') continue

   if (resp.Status !== 'FINISH') throw err('UNKNOWN_ERROR', `Unexpected resp.Status=${resp.Status}`, 'poll')

   const wf = resp.WorkflowTask
   if (!wf) throw err('OUTPUT_NOT_FOUND', 'FINISH but no WorkflowTask', 'poll')

   // Source-level failure (corrupt media, COS unreachable, etc.) — wf.ErrCode is number, 0 = ok
   if (typeof wf.ErrCode === 'number' && wf.ErrCode !== 0) {
     throw err('MPS_SOURCE_ERROR', `${wf.ErrCode}: ${wf.Message ?? ''}`, 'poll')
   }

   const result = wf.SmartEraseTaskResult                          // single object, NOT array
   if (!result) throw err('OUTPUT_NOT_FOUND', 'FINISH but no SmartEraseTaskResult', 'poll')

   if (result.Status === 'PROCESSING') continue                    // possible per typedef line 15549
   if (result.Status === 'FAIL') {
     throw err('MPS_TASK_FAILED', `${result.ErrCodeExt ?? ''}: ${result.Message ?? ''}`, 'poll')
   }
   if (result.Status === 'SUCCESS') {
     const path = result.Output?.Path                              // Output is AiAnalysisTaskDelLogoOutput
     if (!path) throw err('OUTPUT_NOT_FOUND', 'SUCCESS but no Output.Path', 'output')
     const outputCosKey = path.replace(/^\//, '')                  // strip leading slash
     const videoUrl = await getPresignedUrl({ key: outputCosKey, expireSeconds: 7 * 86400 })
     return { videoUrl, videoExpiresAt: Date.now() + 7 * 86400 * 1000, outputCosKey, inputCosKey, posterDataUrl, mpsTaskId }
   }
   throw err('UNKNOWN_ERROR', `Unexpected SmartEraseTaskResult.Status=${result.Status}`, 'poll')
   ```

5. Timeout: `max(60min, durationSeconds * 4 * 1000)`. On expiry throw `POLL_TIMEOUT`.

**New error code added:** `MPS_SOURCE_ERROR` (source-level error per `WorkflowTask.ErrCode != 0`, distinct from `MPS_TASK_FAILED` per `SmartEraseTaskResult.Status === 'FAIL'`). Update spec §8 error table when implementing.

**TDD test plan (write tests FIRST):**
Mock `cosClient.uploadStream`, `cosClient.getPresignedUrl`, `mpsClient.getMpsClient` (returns `{ ProcessMedia, DescribeTaskDetail }` mocks). Each test:

- Test 1: happy path → uploadStream called once with key matching pattern; ProcessMedia called once with `SmartEraseTask: { Definition: 303 }` AT TOP LEVEL (not inside MediaProcessTask); polling sees one PROCESSING then one FINISH+SUCCESS; output URL returned with leading slash stripped.
- Test 2: `Output.Path = '/smart-erase/abc/output.mp4'` → `outputCosKey = 'smart-erase/abc/output.mp4'` (no leading slash).
- Test 3: poll returns `WorkflowTask.SmartEraseTaskResult.Status === 'FAIL'` with `ErrCodeExt='X'`, `Message='msg'` → throws Error with code `MPS_TASK_FAILED` and message containing `X: msg`.
- Test 4: poll returns `WorkflowTask.ErrCode = 1234` with `Message='source corrupt'` (source-level failure) → throws `MPS_SOURCE_ERROR` with `1234: source corrupt`. **`SmartEraseTaskResult` may or may not exist in this case; ErrCode check happens FIRST.**
- Test 5: `Status === 'FINISH'` but `WorkflowTask` is missing entirely → throws `OUTPUT_NOT_FOUND`.
- Test 6: `Status === 'FINISH'` + `WorkflowTask.ErrCode = 0` + `SmartEraseTaskResult` missing → throws `OUTPUT_NOT_FOUND`.
- Test 7: `Status === 'FINISH'`, `result.Status === 'SUCCESS'`, but `Output.Path` is `''` → throws `OUTPUT_NOT_FOUND`.
- Test 8: `Status === 'FINISH'`, `result.Status === 'SUCCESS'`, but `result.Output` is undefined → throws `OUTPUT_NOT_FOUND`.
- Test 9: top-level `resp.Status === 'WAITING'` → continues polling (does not throw).
- Test 10: `SmartEraseTaskResult.Status === 'PROCESSING'` even though `resp.Status === 'FINISH'` → continues polling. (Per typedef: SmartEraseTaskResult.Status has values `PROCESSING | SUCCESS | FAIL`; defensively handle the unusual case where the wrapper says FINISH but the inner task says still processing.)
- Test 11: dynamic timeout: 90-min source → timeout = `90 * 60 * 4 * 1000` ms (≈6h), not the 60-min floor. (Test by injecting a fake clock; verify the deadline math, do NOT actually wait 6 hours).
- Test 12: 5-min source → timeout = 60-min floor (`5*60*4*1000 = 1.2M ms < 60min = 3.6M ms`).
- Test 13: `signal.aborted` after upload → throws `TASK_CANCELLED` BEFORE calling `ProcessMedia`.
- Test 14: `signal.aborted` mid-poll → throws `TASK_CANCELLED`; no further `DescribeTaskDetail` calls happen.
- Test 15: `ProcessMedia` rejects with `{ code: 'InvalidParameterValue.Definition' }` → throws `TEMPLATE_NOT_FOUND`.

**MPS SDK shape verification (MANDATORY — direct reference to lessons learned §0):**

Already done by the planner; results documented here so the implementer can refer to them rather than re-deriving:

| Check | Result | typedef line |
|---|---|---|
| `require('tencentcloud-sdk-nodejs-mps').mps` | `object` | — |
| `mps.v20190612.Client` | `function` | — |
| `Client.prototype.ProcessMedia` | `function` | — |
| `Client.prototype.DescribeTaskDetail` | `function` | — |
| `ProcessMediaRequest.SmartEraseTask` field | `SmartEraseTaskInput?` (single) | `mps_models.d.ts:9436` |
| `SmartEraseTaskInput.Definition` | `number?` | `mps_models.d.ts:7434` |
| `DescribeTaskDetailResponse.WorkflowTask` | `WorkflowTask?` | `mps_models.d.ts:18436` |
| `WorkflowTask.SmartEraseTaskResult` | `SmartEraseTaskResult?` (single, NOT array) | `mps_models.d.ts:22542` |
| `SmartEraseTaskResult.Status` | `'PROCESSING' \| 'SUCCESS' \| 'FAIL'` | `mps_models.d.ts:15549` |
| `SmartEraseTaskResult.Output` | `AiAnalysisTaskDelLogoOutput?` (NOT custom shape) | `mps_models.d.ts:15567` |
| `AiAnalysisTaskDelLogoOutput.Path` | `string?` (with leading `/`) | `mps_models.d.ts:15437` |

The implementer should re-run the first 4 rows once locally before starting (single `node -e ...` line) to guard against the dependency being upgraded between planning and implementation. The other rows are stable across SDK 4.1.x.

**Regression Protection:**
- **Files NOT to touch**: anything in `tencent/`, `storyboardSplit/`, or other smartErase files (only `runner.ts` and its test in this task).
- **Smoke**: `npm run test:run -- src/main/services/`.
- **Tests stay green**: all 26 tencent + 5 posterGen + 6 probe = 37 unit tests.

**Acceptance criteria:** 15 unit tests pass; SDK shape verification re-run pasted in PR description.

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
- **Use TWO JobQueue instances** with in-process hand-off:
  - `uploadQueue = new JobQueue({ maxConcurrent: 3, runner: runUploadOnly, ... })`
  - `processQueue = new JobQueue({ maxConcurrent: 40, runner: runProcessOnly, ... })`
  - On `runUploadOnly` resolve: enqueue into `processQueue` with `{ inputCosKey, mpsTaskId? }` carried over.
  - **Why not single queue + semaphore?** A task in the runner holds a worker slot for both phases. With single `maxConcurrent: 40`, all 40 slots can enter upload phase first (semaphore lets through 3 actively, 37 awaiting the semaphore) — but those 37 awaiters still occupy queue slots and block any new submissions. Dual queues separate the bookkeeping cleanly: upload waits do not back-pressure new submissions, and the process queue is never starved.
  - **State machine**: `task.phase: 'queued-upload' | 'uploading' | 'queued-process' | 'processing' | 'done' | 'failed' | 'cancelled'`. Cancel routes:
    - cancel during `queued-upload` / `uploading` → uploadQueue cancels, never enters processQueue.
    - cancel during `queued-process` → processQueue cancels, no MPS submission yet.
    - cancel during `processing` → MPS task already submitted: route to `reaper.trackForReaping(mpsTaskId, inputCosKey)` and remove from `processQueue` active set.
- **Active-task accounting**: `getActiveCount()` should sum BOTH queues plus reaper size for accurate UI counters.
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

   **Do NOT touch `connect-src`** — current value already includes `https:` (line 231), which is what `<video src="https://...">` actually uses for the byte-range fetches. If you find yourself editing `connect-src` you've gone too far; back out.
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
- **Async hydration handling (CRITICAL — idb-keyval is async, unlike localStorage)** — zustand's `persist` middleware loads asynchronously when storage is async. Until hydration finishes, `useErasePersistStore.getState()` returns the schema defaults (empty `history`, default `config`). Two consequences the implementer MUST handle:
  1. **`HistoryDrawer` reads must be gated.** Show a one-line "加载历史中…" placeholder until `useErasePersistStore.persist.hasHydrated() === true`. Pattern (per zustand docs, https://zustand.docs.pmnd.rs/integrations/persisting-store-data#how-can-i-check-if-my-store-has-been-hydrated):
     ```ts
     const hydrated = useErasePersistStore(s => s._hasHydrated) // see store wiring below
     if (!hydrated) return <LoadingPlaceholder />
     ```
  2. **`config` reads at submit time must wait for hydration**, otherwise the user's persisted `definitionId` (e.g. a custom template they set in settings on a prior run) will be silently overridden by `DEFAULT_ERASE_CONFIG` on first launch. The Uploader's submit button should be disabled-with-spinner until `hasHydrated()` is true.
  
  Wire the `_hasHydrated` flag inside `useErasePersistStore` per zustand docs — define `_hasHydrated: false` in initial state and set it true in `onRehydrateStorage`'s returned callback. **Test it** in the renderer unit tests (Test 3 below).
- **Atomic history mutations** — all history mutations go ONLY through the zustand store actions (`pushHistory`, `removeHistory`, `clearHistory`). Never call `idb-keyval`'s `set('erase-history', …)` directly from outside the store. (idb-keyval docs explicitly warn that direct get-then-set is racy; `update()` is the atomic primitive, but using zustand's single-writer model sidesteps the concern entirely.)

**TDD test plan:** Renderer testing in this codebase is uneven; existing storyboardSplit components have minimal unit coverage. Match that level — **don't over-invest**. Specifically:
- `useEraseSessionStore`: 2 tests (set/get task patch, removeTask).
- `useErasePersistStore`: 3 tests:
  1. `pushHistory` caps at 50 (mock `idb-keyval` with `vi.mock`).
  2. `removeHistory` removes by id.
  3. `_hasHydrated` is `false` initially, becomes `true` after `onRehydrateStorage` callback fires (simulate rehydrate via `useErasePersistStore.persist.rehydrate()` — see zustand docs).
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
| 11 | App restart | History preserved (idb-keyval); reaping queue NOT preserved; HistoryDrawer briefly shows "加载历史中…" then populates | ⬜ |
| 11b | Drop a file IMMEDIATELY after launch (before hydration completes) | Uploader is disabled with spinner until hydrate finishes; persisted `definitionId` (NOT default 303) is used at submit | ⬜ |
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

1. ✅ **RESOLVED 2026-04-30**: Definition 303 = "去字幕-至尊版" / 系统预设 — confirmed in Tencent Cloud console at `console.cloud.tencent.com/mps/templates/intel?tab=erase`. Last updated by Tencent 2026-04-17. The `TEMPLATE_NOT_FOUND` fallback path stays in spec §11 as a defensive measure for future Tencent-side template removal.
2. ffprobe latency on 5 GB file (Task 3 — measure during dev, decide if probe needs to be deferred to background after enqueueing).
3. `<video>` with 7-day COS presigned URL (Task 8 manual E2E — verify Range request behavior; if scrubbing is broken, document as known limitation).
4. `ffmpeg-static` install size impact on packaged app (Task 1 — note bundle size before/after; if > 50 MB increase, ask user before merging).

## 8. Service preconditions (resolved 2026-04-30, recorded for future reference)

Before Task 8 E2E can run, the user's Tencent Cloud account needs:

- ✅ **MPS service activated** — verified `console.cloud.tencent.com/mps/index` shows "👏 你好，欢迎使用媒体处理服务" (was previously redirecting to `/state/unactivated`).
- ✅ **MPS-to-COS service role authorized** — verified the dashboard's 服务角色授权 panel shows green "✓ COS已授权". This is the CAM role that lets `ProcessMedia` read input from / write output to the user's COS bucket; without it, tasks fail with permission errors.
- ⚠️ Account balance: 0 用量 / 0 元 as of activation; user is on **日结计费** (next-day-12pm-to-6pm settlement). At Task 8 E2E time, recommend running scenarios #2 and #6 first (1 small file ≤30s) and waiting one billing cycle to read actual cost before stress-running the full matrix.
- ⚠️ Resource pack: not purchased yet. For personal-use rate (the user's stated context), pay-as-you-go is fine; revisit if monthly usage exceeds the resource-pack break-even point.

These are flagged for the implementer to surface in PR description, not gate the merge unless they reveal a deal-breaker.
