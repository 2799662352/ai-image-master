# Smart Subtitle Removal (`智能去字幕`) Feature Design

**Date:** 2026-04-29
**Status:** Approved
**Scope:** Add a new top-level tab next to "宫格拆图", powered by Tencent Cloud MPS `SmartEraseTask`. MVP covers automatic subtitle removal for video files only — no OCR extraction, translation, AI dubbing, or logo removal.

---

## 1. Problem

The Electron app currently has only image-oriented features. We need a video-oriented feature for automatic subtitle removal. Tencent Cloud MPS released a new "智能擦除" template family in 2025-09 (separate from the legacy "智能分析" path) that exposes `SmartEraseTask` — directly invokable through `ProcessMedia` with either a `Definition` (template ID) or `ScheduleId` (workflow ID).

The existing "宫格拆图" feature (`storyboardSplit`) already integrates Tencent Cloud (COS upload + MPS image processing + polling). We can clone its proven architecture for video, swapping `ProcessImage` → `ProcessMedia` and `DescribeImageTaskDetail` → `DescribeTaskDetail`.

## 2. Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Architecture | Clone-sibling (Plan A) | Zero risk to existing `storyboardSplit`; same ergonomics |
| MVP feature scope | 仅 "去字幕（自动擦除）" | Other erase variants (OCR, translation, dubbing, logo, privacy) deferred |
| Default `Definition` | **`303`** = system preset "去字幕-至尊版" | Matches doc scenario "自动擦除（默认参数）"; no user setup required |
| Calling style | Both `Definition` and `ScheduleId`, default Definition | Power users can build custom workflows; default users skip setup |
| Video transport | Local file path → main-process streaming upload | base64 IPC unsuitable for >100 MB videos |
| File path API | `webUtils.getPathForFile(file)` from preload | Electron-recommended way to expose drop-target file paths to renderer |
| COS upload method | `cos.sliceUploadFile` (multipart, resumable) | Built-in for large files; reports progress |
| Concurrency | `MAX_CONCURRENT = 40` | Personal use; well below MPS rate limit (100 req/s) and concurrent transcoding quota (60) |
| Polling cadence | 5s / 10s / 15s exponential | Video tasks are minutes-long; lower than image cadence |
| Task timeout | 60 minutes | Covers long-form videos with safety margin |
| Result UX | Only show processed video | Original video already on user's disk; no need to keep it in app state |
| History poster | COS CI snapshot URL (`ci-process=snapshot`) | Avoids storing base64 thumbnails in localStorage |
| Credential management | Reuse `storyboardSplit/config.ts` | Single source of truth for Tencent Cloud keys across tabs |
| Cancellation semantics | Local-only (queue / upload / polling) | MPS API doesn't expose task cancel; rely on output GC |

## 3. Architecture

### 3.1 Module layout (Clone-sibling pattern)

```
src/
├── types/smartErase.ts                              ← new
├── main/services/
│   ├── storyboardSplit/         (untouched)
│   └── smartErase/                                  ← new
│       ├── config.ts            (re-export storyboardSplit credentials + erase defaults)
│       ├── cosClient.ts         (sliceUploadFile + getVideoSnapshotUrl)
│       ├── mpsClient.ts         (submitProcessMedia + pollMediaUntilFinish)
│       └── index.ts             (queue / runTask / IPC event dispatch)
└── renderer/src/
    ├── pages-react/
    │   ├── StoryboardSplitPage.tsx           (untouched)
    │   ├── SmartErasePage.tsx                ← new
    │   └── smart-erase/                      ← new (sub-components)
    │       ├── EraseUploader.tsx
    │       ├── EraseQueue.tsx
    │       ├── EraseHistoryDrawer.tsx
    │       ├── EraseResultPanel.tsx
    │       └── useEraseEvents.ts
    └── stores/
        ├── useEraseSessionStore.ts           ← new (ephemeral)
        └── useErasePersistStore.ts           ← new (zustand persist)
```

### 3.2 Touchpoints in existing files (5 files modified, no logic changed)

```
src/main/index.ts                          + 6 IPC handler registrations
src/renderer/index.html                    + tab button + #smart-erase-react-root
src/renderer/src/preload/index.ts          + smartErase API + getFilePath()
src/renderer/src/react-app/main.tsx        + mount/unmount entry points
src/renderer/src/services/ServiceBridge.ts + tab routing
```

## 4. Data Flow

```
[Renderer]                                    [Main]                              [Tencent Cloud]
    │                                            │                                       │
    │ 1. Drop file (File object)                 │                                       │
    │    ↓ webUtils.getPathForFile               │                                       │
    │ 2. ipcInvoke('smart-erase:submit', {       │                                       │
    │     filePath, filename, fileSize })        │                                       │
    │ ─────────────────────────────────────────► │                                       │
    │                                            │ 3. enqueue task                       │
    │ ◄──────── 'erase:progress' (queued)        │                                       │
    │                                            │ 4. cos.sliceUploadFile (stream) ────► │  COS
    │ ◄──────── 'erase:progress' (uploading%)    │                                       │
    │                                            │ 5. ProcessMedia(SmartEraseTask) ────► │  MPS
    │                                            │    { Definition: 303 }                │
    │ ◄──────── 'erase:progress' (processing)    │ 6. DescribeTaskDetail loop (5/10/15s) │
    │                                            │ 7. extract output cosKey              │
    │                                            │ 8. getObjectUrl (presigned, 7 days)   │  COS
    │                                            │ 9. getObjectUrl (ci-process=snapshot) │  COS+CI
    │ ◄──────── 'erase:finished'                 │                                       │
    │           { videoUrl, posterUrl, ... }     │                                       │
    │                                            │                                       │
    │ Renderer pushes to history store           │                                       │
    │ (only posterUrl + videoUrl + meta — no     │                                       │
    │  base64, no original video bytes)          │                                       │
```

## 5. Type Contracts

### 5.1 `src/types/smartErase.ts`

```ts
export interface EraseConfig {
  mode: 'definition' | 'scheduleId'
  definitionId: number       // default 303 = 系统预设·去字幕-至尊版
  scheduleId?: number
  autoCleanupRemoteAfterDays: number
  posterExpireSeconds: number
}

export const DEFAULT_ERASE_CONFIG: EraseConfig = {
  mode: 'definition',
  definitionId: 303,
  autoCleanupRemoteAfterDays: 7,
  posterExpireSeconds: 7 * 24 * 3600,
}

export interface EraseSubmitPayload {
  filePath: string           // absolute local path from webUtils.getPathForFile
  filename: string
  fileSize: number
  config?: Partial<EraseConfig>
}

export interface EraseTask {
  id: string
  filename: string
  fileSize: number
  status: 'queued' | 'uploading' | 'submitting' | 'processing' | 'finished' | 'failed' | 'cancelled'
  uploadProgress?: number    // 0-100
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
  videoUrl: string           // COS presigned, 7 days
  videoExpiresAt: number
  posterUrl: string          // COS CI snapshot URL, 7 days
  posterExpiresAt: number
  outputCosKey: string       // for cleanup
  inputCosKey: string        // for cleanup
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
  posterUrl: string
  posterExpiresAt: number
  outputCosKey: string
  inputCosKey: string
}

export interface EraseFailedEvent {
  taskId: string
  errorCode: string          // SCREAMING_SNAKE_CASE
  errorMessage: string
  stage: 'upload' | 'submit' | 'poll' | 'output' | 'unknown'
}
```

## 6. IPC Contract

| Channel | Direction | Purpose |
|---|---|---|
| `smart-erase:submit` | renderer → main | Enqueue task; returns `{ taskId }` |
| `smart-erase:cancel` | renderer → main | Cancel local tracking; aborts upload if in-flight |
| `smart-erase:get-config` | renderer → main | Read current config + credential state |
| `smart-erase:set-credentials` | renderer → main | Save SecretId/SecretKey/Bucket/Region |
| `smart-erase:set-defaults` | renderer → main | Save EraseConfig (mode, definitionId, etc.) |
| `smart-erase:delete-remote` | renderer → main | Best-effort delete COS objects (input + output) |
| `erase:progress` | main → renderer | Per-task status updates |
| `erase:finished` | main → renderer | Single emission per task on success |
| `erase:failed` | main → renderer | Single emission per task on failure |

Preload exposes:

```ts
window.electronAPI.smartEraseSubmit(payload)
window.electronAPI.smartEraseCancel({ taskId })
window.electronAPI.smartEraseGetConfig()
window.electronAPI.smartEraseSetCredentials(c)
window.electronAPI.smartEraseSetDefaults(c)
window.electronAPI.smartEraseDeleteRemote(keys)
window.electronAPI.onSmartEraseEvent(cb)
window.electronAPI.removeSmartEraseListeners()
window.electronAPI.getFilePath(file)   // wraps webUtils.getPathForFile
```

## 7. State Management (Zustand)

### 7.1 `useEraseSessionStore` (ephemeral; resets on app reload)

```ts
interface EraseSessionState {
  activeTasks: Record<string, EraseTask>    // keyed by taskId
  selectedHistoryId: string | null
  setTask(taskId: string, patch: Partial<EraseTask>): void
  setMpsTaskId(taskId: string, mpsTaskId: string): void
  removeTask(taskId: string): void
  clearFinished(): void
  selectHistory(id: string | null): void
}
```

### 7.2 `useErasePersistStore` (zustand persist; localStorage)

```ts
interface ErasePersistState {
  history: EraseHistoryItem[]               // newest first, capped at 200
  defaultConfig: EraseConfig
  drawerOpen: boolean
  pushHistory(item: EraseHistoryItem): void
  removeHistory(id: string): void
  clearHistory(): void
  setDefaultConfig(c: EraseConfig): void
  setDrawerOpen(b: boolean): void
}
```

**No base64 thumbnails persisted.** Posters are 320px wide JPEG URLs from COS CI snapshot (`ci-process=snapshot&time=0.5&format=jpg&width=320`), expiring in 7 days. After expiration, the UI shows a placeholder; we don't auto-regenerate URLs in MVP.

## 8. Error Handling

Stage-specific try/catch in `runTask`. Every error wraps into `EraseFailedEvent` with `errorCode`, `errorMessage`, and `stage`.

| Code | Stage | Trigger | UI |
|---|---|---|---|
| `INVALID_CREDENTIALS` | submit | `AuthFailure.SignatureFailure` etc. | Toast + auto-open settings |
| `BUCKET_NOT_FOUND` | upload | COS 404 | Toast + open settings |
| `FILE_NOT_READABLE` | upload | `fs.createReadStream` error | Toast |
| `FILE_TOO_LARGE` | submit | > 5 GB (configurable) | Toast |
| `UPLOAD_ABORTED` | upload | User cancel | Silent (already on cancel UI) |
| `UPLOAD_FAILED` | upload | Network / COS server error | Toast + retry button on history item |
| `MPS_SUBMIT_FAILED` | submit | `ProcessMedia` returns error | Toast |
| `TEMPLATE_NOT_FOUND` | submit | `InvalidParameterValue.Definition` | Toast + link to ops doc (copy-template instructions) |
| `MPS_TASK_FAILED` | poll | `Status: FAIL` | Toast with `ErrCodeExt` |
| `POLL_TIMEOUT` | poll | > 60 min | Toast; offer "Continue tracking" Phase 2 |
| `OUTPUT_NOT_FOUND` | output | Empty `OutputUrl` | Toast |
| `UNKNOWN_ERROR` | unknown | Anything else | Toast with stack in dev mode |

Local cancellation triggers `UPLOAD_ABORTED` only if upload is in flight. Once `ProcessMedia` is called, the MPS task runs to completion server-side (output is still uploaded; user can find it in COS or trash via the cleanup button).

## 9. Concurrency & Performance

- **`MAX_CONCURRENT = 40`** — covers personal use without splitting upload/inflight queues. MPS rate limit is 100 req/s; default concurrent transcoding quota is 60. We sit comfortably under both.
- **Polling backoff**: 5 s for first 6 polls (≈30 s), then 10 s for next 30 (≈5 min), then 15 s until 60-min timeout.
- **Streaming upload**: `cos.sliceUploadFile` reads via `fs.createReadStream`; main process never holds the entire file in memory.
- **Poster generation**: zero extra Tencent CI cost — `ci-process=snapshot` is computed at GET time, charged per request not per asset.
- **History bound**: 200 items, FIFO eviction. Each item is ~500 bytes JSON; safe for localStorage.

## 10. UX

```
+--------------------------------------------------------------+
| [宫格拆图] [智能去字幕]              ⚙ 设置  📋 历史 (12)  |
+--------------------------------------------------------------+
|                                                               |
|   ┌──────────────────────────────────────────────────────┐    |
|   │   拖入视频文件，或点击选择                            │    |
|   │   支持 .mp4 .mov .mkv（≤ 5 GB）                       │    |
|   └──────────────────────────────────────────────────────┘    |
|                                                               |
|   活跃任务                                                    |
|   ┌──────────────────────────────────────────────────────┐    |
|   │ ▶ episode-01.mp4   processing (3 min elapsed)   [✕] │    |
|   │ ▶ episode-02.mp4   uploading 47%                [✕] │    |
|   │ ▶ episode-03.mp4   queued                       [✕] │    |
|   └──────────────────────────────────────────────────────┘    |
|                                                               |
|   结果预览（点击历史项进入）                                  |
|   ┌──────────────────────────────────────────────────────┐    |
|   │   [video player — 处理后视频]                        │    |
|   │   下载  复制 URL  删除远端文件                        │    |
|   └──────────────────────────────────────────────────────┘    |
+--------------------------------------------------------------+

设置抽屉:
  - 凭证（与宫格拆图共用）
  - 调用方式: ◉ Definition  ○ ScheduleId
  - 模板 ID: [303]  系统预设·去字幕-至尊版
  - 编排 ID: [    ]  (仅 ScheduleId 模式)
  - 远端 7 天后清理: [开]
```

Original video is **not displayed**. User dropped it from disk; they have it locally. The app shows only the processed result.

## 11. Implementation Checklist

**New files (13):**
- `src/types/smartErase.ts`
- `src/main/services/smartErase/{config,cosClient,mpsClient,index}.ts`
- `src/renderer/src/pages-react/SmartErasePage.tsx`
- `src/renderer/src/pages-react/smart-erase/{EraseUploader,EraseQueue,EraseHistoryDrawer,EraseResultPanel,useEraseEvents}.tsx`
- `src/renderer/src/stores/{useEraseSessionStore,useErasePersistStore}.ts`

**Modified files (5):**
- `src/main/index.ts` — register 6 IPC handlers + `setEraseMainWindow(mainWindow)`
- `src/renderer/index.html` — tab button + `<div id="smart-erase-react-root">`
- `src/renderer/src/preload/index.ts` — smartErase API surface + `getFilePath` + event whitelist
- `src/renderer/src/react-app/main.tsx` — `mountSmartEraseReact` / `unmountSmartEraseReact`
- `src/renderer/src/services/ServiceBridge.ts` — tab routing

**Untouched (zero regression):**
- All `storyboardSplit/*`
- `StoryboardSplitPage.tsx` and its sub-components / stores

## 12. Test Matrix

| Case | Expected |
|---|---|
| Drop 1 mp4 | Processed video plays; download + copy URL work |
| Drop 50 mp4 | First 40 run; remaining 10 queued; no task lost |
| Cancel during upload | Task → cancelled; upload aborts |
| Cancel during MPS processing | Task → cancelled locally; server-side runs to completion (output garbage-collected by COS lifecycle) |
| Wrong credentials | `INVALID_CREDENTIALS` toast → settings drawer opens |
| Non-numeric Definition | Settings save validation fails |
| Switch to ScheduleId mode | Definition field hidden; ScheduleId required |
| Switch tabs mid-task | Background processing continues; events still dispatched |
| App restart | History preserved; expired poster URLs render placeholder |

## 13. Operations

**If `Definition: 303` returns `TEMPLATE_NOT_FOUND`:**
1. Log into [腾讯云 MPS 控制台 - 媒体 AI 模板](https://console.cloud.tencent.com/mps/templates/intel)
2. Switch to "智能擦除" tab → find `303 - 去字幕-至尊版` → click "复制模板"
3. The new template gets a custom ID (typically 1xxxxx). Read it from the list.
4. Open app settings → set `Definition` to the new ID.

**Credentials prep:**
- CAM policy: `QcloudMPSFullAccess` + `QcloudCOSFullAccess` on the sub-account.
- COS bucket region must match MPS region (recommended `ap-shanghai` or `ap-guangzhou`).

**Cost reference:** [智能擦除计费说明](https://cloud.tencent.com/document/product/862/36180). Billed per video duration, independent of concurrency.

## 14. Rollback

All changes are additive or isolated. To roll back:
1. Delete the 13 new files.
2. Revert the 5 modified files (each diff is well-scoped — IPC registration, HTML tab, preload exposure, React mount, tab router).

IPC channel namespace `smart-erase:` and `erase:` does not collide with `image-split:` / `split:`. Preload whitelist removal is line-scoped.

## 15. Out of Scope (deferred)

- OCR subtitle extraction
- Subtitle translation / dubbing
- Logo removal (`去 Logo`)
- Privacy protection (face/plate blur)
- Auto-regenerate expired poster URLs (Phase 2)
- Server-side MPS task cancel (API doesn't expose it)
- Multi-region COS support (single region in MVP)
- Bulk history operations (clear all, export, etc.)

---

**Next:** invoke `writing-plans` skill to break this into ordered implementation tasks.
