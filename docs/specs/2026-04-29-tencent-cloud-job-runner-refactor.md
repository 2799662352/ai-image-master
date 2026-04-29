# Tencent Cloud Job Runner — Shared Main-Process Layer

**Date:** 2026-04-29
**Status:** Approved
**Scope:** Extract a shared `src/main/services/tencent/*` layer (credentials, COS client, MPS client, generic job queue) so that current and future Tencent Cloud features share one base instead of cloning sibling modules. Convert `storyboardSplit` to a thin consumer. Required prerequisite for `smartErase` (see `2026-04-29-smart-erase-feature-design.md` v1.1).

---

## 1. Problem

`storyboardSplit` (image processing via MPS `ProcessImage`) ships today as a self-contained module under `src/main/services/storyboardSplit/`. Roughly 60% of its code is generic Tencent Cloud plumbing:

| File | Generic content (LOC) | Feature-specific content (LOC) |
|---|---|---|
| `config.ts` (110 lines) | credentials store, env/builtin fallback, masked state, invalidation callbacks | nothing (just imports `SplitConfig` defaults) |
| `cosClient.ts` (100 lines) | lazy COS instance, presigned URL, batch delete | one feature-specific helper: `uploadOriginal(buffer, ext)` writes to `storyboard-split/{taskId}/input.{ext}` |
| `mpsClient.ts` (138 lines) | lazy MPS client, `getMpsClient`, polling-loop scaffold | `submitProcessImage` + result-set parsing (image-specific) |
| `index.ts` (170 lines) | queue, abort signal, dequeue loop, `safeSend`, `cancelAllActiveTasks` | `runTask` body composes feature-specific upload + submit + poll |

If we clone-sibling for `smartErase`, then later for `smartLogo`, `smartOcr`, `smartDubbing` (all listed in smartErase §15 as Phase 2), we replicate the generic plumbing 4 more times. Bug fixes (e.g. tightening the destroyed-window guard at `index.ts:30`, or fixing the credential-invalidation chain) get applied in one branch only and rot in the others. This is the predictable outcome of un-extracted shared code.

The cost of extracting *now* with one consumer (`storyboardSplit`) is ~half a day. The cost of extracting *after* `smartErase` ships is one week + a regression risk across two production code paths. Doing it before `smartErase` is the correct order.

## 2. Decision Summary

| Decision | Choice | Rationale |
|---|---|---|
| Refactor scope | Main-process services only | Renderer-side stores, IPC namespaces, types remain per-feature. Renderer doesn't see this change. |
| Backwards compatibility | Behavior-preserving for `storyboardSplit` | Test matrix passes pre and post |
| New module location | `src/main/services/tencent/` | Sibling to feature folders; feature folders import from it |
| Credential storage | Lift to `tencent/credentials.ts` + migrate to Electron `safeStorage` | Hardcoded `electron-store` encryptionKey in `storyboardSplit/config.ts:26` is obfuscation, not encryption; `safeStorage` uses OS keychain (DPAPI / Keychain / libsecret) |
| Job runner shape | `JobRunner<TInput, TOutput>` interface with `upload`, `submit`, `poll`, `parseResult` callbacks | Each feature plugs its own bodies; shared queue handles concurrency, abort, dequeue, lifecycle events |
| MPS client API | One generic `getMpsClient()` returning `sdk.mps.v20190612.Client` | Both image and video methods on the same client class — verified in `tencentcloud-sdk-nodejs-mps@^4.1.218` types |
| COS client API | Generic `getCosInstance()` + helpers: `uploadBuffer`, `uploadStream`, `getPresignedUrl`, `deleteObjects` | Adds `uploadStream` for `smartErase` video case while preserving `uploadBuffer` for image |
| Per-feature override | Each feature provides its own `cosKeyPrefix` and `outputDirPattern` | No leakage of feature-specific paths into shared layer |

## 3. Target Architecture

```
src/main/services/
├── tencent/                                 ← new shared layer
│   ├── credentials.ts        (was: storyboardSplit/config.ts credential half)
│   ├── cosClient.ts          (was: storyboardSplit/cosClient.ts generic half + new uploadStream)
│   ├── mpsClient.ts          (was: storyboardSplit/mpsClient.ts client-init half)
│   ├── jobQueue.ts           (was: storyboardSplit/index.ts queue/abort/dequeue half)
│   └── types.ts              (JobRunner<T>, JobLifecycleEvents, CredentialState)
│
├── storyboardSplit/                         ← becomes thin
│   ├── config.ts             (re-exports tencent/credentials + image defaults)
│   ├── runner.ts             (NEW: image-specific submit + poll + result parsing; ~80 LOC)
│   └── index.ts              (composes JobRunner via tencent/jobQueue; IPC handlers; ~80 LOC)
│
└── smartErase/                              ← built on top (in v1.1 spec)
    ├── config.ts             (re-exports tencent/credentials + erase defaults)
    ├── runner.ts             (NEW: video-specific submit + poll + result parsing)
    └── index.ts              (composes JobRunner via tencent/jobQueue; IPC handlers)
```

## 4. Module Contracts

### 4.1 `tencent/credentials.ts`

```ts
export interface Credentials {
  secretId: string
  secretKey: string
  bucket: string
  region: string
}

export interface CredentialState {
  hasCredentials: boolean
  credentialSource: 'store' | 'env' | 'builtin' | 'none'
  secretIdMasked?: string
  bucket?: string
  region?: string
}

// Three-tier resolution: safeStorage → process.env → cos-credentials.json
export function getCredentials(): Credentials
export function getCredentialState(): CredentialState
export function setCredentials(creds: Partial<Credentials>): void
export function onCredentialsInvalidated(cb: () => void): void
```

**Storage migration** — current `electron-store` with `encryptionKey: 'tencent-cred-v1'` (hardcoded in source, `aes-256-gcm`):

1. New install or post-upgrade: try `safeStorage.isEncryptionAvailable()`. If yes, persist via `safeStorage.encryptString(JSON.stringify(creds))` into a JSON file at `app.getPath('userData')/tencent-credentials.bin`.
2. On read: if old `electron-store` file exists AND new `.bin` does not, decrypt via electron-store, re-encrypt via safeStorage, delete old file (one-shot migration). Log migration event.
3. Fallback: if `safeStorage.isEncryptionAvailable()` returns false (Linux without libsecret, or user's keychain locked), fall back to in-memory only and emit a warning event the renderer can surface.

### 4.2 `tencent/cosClient.ts`

```ts
import type { TaskId } from 'cos-nodejs-sdk-v5'

export function getCosInstance(): COS                  // lazy, invalidated on credential change

export interface UploadBufferOptions {
  key: string
  body: Buffer
  contentType?: string
}
export function uploadBuffer(opts: UploadBufferOptions): Promise<void>

export interface UploadStreamOptions {
  key: string
  filePath: string
  contentType?: string
  onProgress?: (info: { loaded: number; total: number; percent: number; speed: number }) => void
  onTaskReady?: (taskId: TaskId) => void
}
export function uploadStream(opts: UploadStreamOptions): Promise<void>
// Internally: cos.sliceUploadFile({ Bucket, Region, Key, FilePath, onProgress, onTaskReady })

export function cancelUpload(taskId: TaskId): Promise<void>
// Internally: cos.cancelTask({ TaskId: taskId }) + cos.pauseTask + await abort callback

export interface GetPresignedUrlOptions {
  key: string
  expireSeconds: number
  query?: Record<string, any>      // for ci-process=snapshot etc.
  method?: 'GET' | 'PUT'
}
export function getPresignedUrl(opts: GetPresignedUrlOptions): Promise<string>

export function deleteObjects(keys: string[]): Promise<void>
// Best-effort, logs partial failures
```

`onCredentialsInvalidated(() => { cosInstance = null })` — registered once inside this module; consumers don't re-register.

### 4.3 `tencent/mpsClient.ts`

```ts
export function getMpsClient(): MpsV20190612Client    // lazy, invalidated on credential change
```

That's it. The shared layer does not wrap `ProcessImage` / `ProcessMedia` — feature-specific runners call them directly via `getMpsClient()`. Why? Because the response shapes differ enough between `DescribeImageTaskDetail` (flat) and `DescribeTaskDetail` (envelope: `WorkflowTask` / `ScheduleTask`) that a unified poll function ends up worse than two clear feature-specific ones. Lifted commonality is limited to client construction.

### 4.4 `tencent/jobQueue.ts`

```ts
export interface JobLifecycleEvents<TInput, TOutput> {
  onProgress?: (job: TInput, patch: { stage: string; progress: number; meta?: any }) => void
  onFinished?: (job: TInput, result: TOutput) => void
  onFailed?: (job: TInput, error: { code: string; message: string; stage: string }) => void
}

export interface JobQueueOptions<TInput, TOutput> {
  name: string                                // for logging
  maxConcurrent: number
  runner: (job: TInput, abortSignal: AbortSignal, events: JobLifecycleEvents<TInput, TOutput>) => Promise<TOutput>
  events: JobLifecycleEvents<TInput, TOutput>
  getJobId: (job: TInput) => string
}

export class JobQueue<TInput, TOutput> {
  constructor(opts: JobQueueOptions<TInput, TOutput>)

  enqueue(job: TInput): Promise<void>
  cancel(jobId: string): boolean              // returns true if found in active or pending
  cancelAll(): void
  getActiveCount(): number
  getQueuedCount(): number
}
```

The runner receives a real `AbortSignal` (not the bool flag in current `storyboardSplit/index.ts:55`). Feature runners pass it down to `cos.uploadStream` for actual abort, and check `signal.aborted` between awaits in the poll loop.

`smartErase` will compose **two** queues — one for upload (`maxConcurrent: 3`) and one for processing (`maxConcurrent: 40`) — with hand-off in the runner. The shared `JobQueue` doesn't know about that; it's a feature-side composition.

### 4.5 `tencent/types.ts`

Re-exports `Credentials`, `CredentialState`, `JobLifecycleEvents`, `JobQueueOptions`. No new types beyond those declared in §4.1–§4.4.

## 5. Migration of `storyboardSplit`

### 5.1 New `storyboardSplit/runner.ts` (~80 LOC)

```ts
import { uploadBuffer, getPresignedUrl } from '../tencent/cosClient'
import { getMpsClient } from '../tencent/mpsClient'
import { getCredentials } from '../tencent/credentials'
import type { SplitConfig, SplitResult } from '../../../types/storyboardSplit'

interface ImageJobInput {
  taskId: string
  buffer: Buffer
  filename: string
  config: SplitConfig
}

interface ImageJobOutput {
  results: SplitResult[]
  rows: number
  cols: number
  inputCosKey: string
}

export async function runImageJob(
  job: ImageJobInput,
  signal: AbortSignal,
  events: JobLifecycleEvents<ImageJobInput, ImageJobOutput>,
): Promise<ImageJobOutput> {
  const ext = job.filename.split('.').pop()?.toLowerCase() || 'jpg'
  const cosKey = `storyboard-split/${job.taskId}/input.${ext}`

  events.onProgress?.(job, { stage: 'uploading-cos', progress: 5 })
  await uploadBuffer({ key: cosKey, body: job.buffer, contentType: contentTypeForExt(ext) })

  if (signal.aborted) throw makeError('TASK_CANCELLED', 'Cancelled', 'upload')

  events.onProgress?.(job, { stage: 'submitting-mps', progress: 35 })
  const inputUrl = await getPresignedUrl({ key: cosKey, expireSeconds: 86400 })
  const mpsTaskId = await submitProcessImage(inputUrl, job.config, `/storyboard-split/${job.taskId}/output/`)

  events.onProgress?.(job, { stage: 'polling-mps', progress: 40, meta: { mpsTaskId } })
  const { results, rows, cols } = await pollImageUntilFinish(mpsTaskId, signal,
    (attempt, max) => events.onProgress?.(job, {
      stage: 'polling-mps',
      progress: 40 + Math.round((attempt / max) * 50),
    }))

  return { results, rows, cols, inputCosKey: cosKey }
}

// submitProcessImage and pollImageUntilFinish — image-specific bodies (current 32-67 + 84-137)
```

### 5.2 New `storyboardSplit/index.ts` (~80 LOC)

```ts
import { JobQueue } from '../tencent/jobQueue'
import { runImageJob } from './runner'
// ... thin wrapper turning JobLifecycleEvents into safeSend('storyboard-split:progress'|'finished'|'failed')
// ... exports submitSplit, cancelTask, cancelAllActiveTasks, getConfig, setCredentialsFromUI, setDefaultsFromUI, deleteRemoteObjects
// ... preserves all current external behavior
```

### 5.3 Shim files (kept for backwards compat, can be deleted in a follow-up PR)

`storyboardSplit/config.ts`, `cosClient.ts`, `mpsClient.ts` collapse into one-liners that re-export from `tencent/*`. Or delete and update one import site (`storyboardSplit/index.ts`). Since these are internal, prefer deletion.

### 5.4 IPC handlers — unchanged

`src/main/index.ts` IPC handler registrations for `storyboard-split:*` continue to call `submitSplit`, `cancelTask`, etc. The exported names from `storyboardSplit/index.ts` stay the same.

## 6. Test Plan

### 6.1 Behavior-preserving tests for `storyboardSplit`

| Case | Pre-refactor | Post-refactor |
|---|---|---|
| Upload + split a 9-tile image | Works | Must still work |
| Drop 5 images simultaneously | First 4 run concurrently, 5th queued | Must still match |
| Cancel a queued task | Removed from queue | Must still match |
| Cancel an active task mid-upload | Upload not actually aborted (existing bug); task removed from active set | **Now actually aborts** via `cos.cancelUpload(taskId)` — behavior IMPROVES, not regresses |
| Set credentials in UI | Caches invalidated, next call uses new creds | Must still match |
| Network error during MPS poll | Retries until timeout | Must still match |

### 6.2 New tests for shared layer

- `tencent/credentials`: safeStorage migration from electron-store works one-shot; falls back to in-memory if safeStorage unavailable.
- `tencent/cosClient.uploadStream`: streams a 100 MB file with progress callback; abort via `cancelUpload(taskId)` actually stops the upload.
- `tencent/jobQueue`: enqueue >maxConcurrent, observe queue draining; cancel during run terminates AbortSignal.

## 7. Implementation Order

1. Create `src/main/services/tencent/{credentials,cosClient,mpsClient,jobQueue,types}.ts` — copy generic code from current storyboardSplit, add `uploadStream` + `cancelUpload` + safeStorage migration.
2. Create `storyboardSplit/runner.ts` — image-specific bodies extracted from current `mpsClient.ts` and `cosClient.uploadOriginal`.
3. Rewrite `storyboardSplit/index.ts` to use `JobQueue` + `runImageJob`.
4. Delete (or stub-redirect) `storyboardSplit/{config,cosClient,mpsClient}.ts`.
5. Run full storyboardSplit test matrix manually (9 cases above). Fix regressions.
6. Commit refactor as a single PR before any `smartErase` work begins.

## 8. Backwards Compatibility & Rollback

- IPC channels unchanged. Renderer code unchanged. `useStoryboardSplitStore` unchanged.
- `electron-store` credential file is migrated, not deleted. Roll-back instructions: revert this PR + the safeStorage `.bin` file is left orphaned (no harm; old store still works).
- The 5 deleted files in `storyboardSplit/` can be restored by `git revert`.

## 9. Out of Scope

- IPC namespace unification (`media-job:` vs. `storyboard-split:` / `smart-erase:`) — deferred to a future "v2 IPC consolidation" if justified by Phase 2 feature count.
- History store unification (`MediaJobHistoryItem` with `taskType` discriminator) — renderer-side; not part of this main-process refactor.
- Per-feature `JobRunner` package extraction (npm-publishable) — overkill at N=2.
- Customizing `JobQueue` for priority / starvation — current FIFO is sufficient.

---

**Next:** see `2026-04-29-smart-erase-feature-design.md` v1.1 which depends on this refactor.
