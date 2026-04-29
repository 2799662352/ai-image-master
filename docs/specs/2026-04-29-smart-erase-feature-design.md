# Smart Subtitle Removal (`智能去字幕`) Feature Design

**Date:** 2026-04-29
**Status:** v1.1 Approved (post-review)
**Depends on:** [`2026-04-29-tencent-cloud-job-runner-refactor.md`](./2026-04-29-tencent-cloud-job-runner-refactor.md) — must merge first.
**Scope:** Add a new top-level tab next to "宫格拆图", powered by Tencent Cloud MPS `SmartEraseTask`. MVP covers automatic subtitle removal for video files only. ScheduleId mode, OCR/translation/dubbing/logo/privacy variants are deferred.

---

## 0. Changelog (v1.0 → v1.1)

After two reviewer passes (adversarial-document + feasibility), the following are corrected from v1.0:

| Δ | Change | Source |
|---|---|---|
| **Architecture** | Built on shared `tencent/*` layer (refactor spec) instead of cloning storyboardSplit modules | adversarial P1 |
| **CSP** | `media-src` must extend to `https:` (one-line patch); video element otherwise refuses COS HTTPS URL | feasibility 2.3 |
| **MPS response shape** | `Definition` mode → `WorkflowTask.SmartEraseTaskResult.Output.Path`; failure detection inside `SmartEraseTaskResult.Status === 'FAIL'` (NOT top-level `resp.Status`) | feasibility 1.4 |
| **Output path** | Explicitly set `OutputDir` and `OutputStorage` in `ProcessMedia` call | feasibility 2.1 |
| **303 verification** | First-run probe, fall back to console copy-template flow if 303 returns `TEMPLATE_NOT_FOUND` | adversarial P2 |
| **Cancel during upload** | Capture `TaskId` from `onTaskReady`; abort via `cos.cancelTask`. `AbortSignal` flag does not reach into the SDK | adversarial A5 / feasibility 3.2 |
| **Concurrency** | Split into `MAX_UPLOAD_CONCURRENT = 3` + `MAX_INFLIGHT = 40` | adversarial D1 |
| **Cost guardrail** | ffprobe at drop time + threshold confirmation dialog if file count >10 OR total duration >60min | adversarial O1 |
| **Credential storage** | Use Electron `safeStorage` (in shared layer); hardcoded electron-store key is obfuscation | adversarial O2 |
| **Side-by-side compare** | Result panel adds toggle to show original `<video src="file://...">` next to processed | adversarial D3 |
| **Poster source** | Switch from COS-CI snapshot URL to local-ffmpeg pre-upload thumbnail (~10 KB base64); avoids CI service requirement and URL expiry | adversarial A1 |
| **Timeout** | Dynamic: `max(60min, sourceDurationMs * 4)` | adversarial A3 / feasibility 3.5 |
| **InputInfo.Type** | Use `COS` (not `URL`); avoid presign-expiry race during long processing | adversarial A4 |
| **ScheduleId mode** | Deferred to Phase 2 (response navigation through `ScheduleTask.ActivityResultSet[]` adds complexity for unknown MVP benefit) | feasibility 4.4 |
| **Per-task config override** | Removed from type. UI exposes only global default | adversarial D2 / feasibility 3.4 |
| **Default config persistence** | Single source of truth = renderer zustand persist. No main-process `set-defaults` IPC | feasibility 3.4 |
| **Cancelled task reaping** | Tracks `mpsTaskId` + `inputCosKey` after local cancel; on natural FINISH, auto-deletes both COS objects | adversarial D4 |
| **History storage** | Cap to 50 items; persist via idb-keyval (or zustand `partialize`) to avoid full-array rewrite on every push. Each item ~2 KB (correction from v1.0's "500 B" claim) | adversarial A6 |
| **Drop input validation** | New error codes `FILE_PATH_UNAVAILABLE` (empty path) and `FILE_NOT_LOCAL` (OneDrive on-demand / network-share probe failure) | adversarial A2 |
| **App-close handling** | `cancelAllActiveSmartEraseTasks()` hooks into `window-all-closed` like storyboardSplit | feasibility 3.3 |
| **Output Path normalization** | Strip leading slash before storing as `outputCosKey` (image runner already does this) | feasibility 3.6 |

---

## 1. Problem

The Electron app currently has only image-oriented features. Tencent Cloud MPS released a new "智能擦除" template family in 2025-09 (separate from the legacy "智能分析" path) that exposes `SmartEraseTask` — invokable through `ProcessMedia` with `Definition` (template ID). After v1.1 refactor, generic Tencent infrastructure lives in `src/main/services/tencent/*`, so this feature plugs in as a thin runner.

## 2. Decision Summary (v1.1)

| Decision | Choice | Rationale |
|---|---|---|
| Architecture | Thin runner on top of `tencent/*` shared layer | Generic plumbing extracted in refactor spec; smartErase is feature-specific bodies only |
| MVP feature scope | Only "去字幕（自动擦除）" | OCR / translation / dubbing / logo / privacy / ScheduleId-mode all deferred |
| API call mode | `Definition` only in MVP | ScheduleId requires `ScheduleTask.ActivityResultSet[]` parsing; defer |
| Default `Definition` | **`303`** = system preset "去字幕-至尊版", **with first-run probe** | Per Tencent doc 119629 §"接入步骤二:API 发起任务"; if 303 returns `TEMPLATE_NOT_FOUND`, surface the copy-template flow as primary path |
| Video transport | Local file path → main-process streaming upload | base64 IPC unsuitable for >100 MB videos |
| File path API | `webUtils.getPathForFile(file)` from preload | Recommended way *given current `contextIsolation: false` posture*; works in preload, returns `""` for synthetic File objects |
| COS upload method | `tencent/cosClient.uploadStream` (`sliceUploadFile` under the hood) | Built into shared layer; reports progress; abort via `cancelTask(taskId)` |
| Concurrency | **`MAX_UPLOAD_CONCURRENT = 3` + `MAX_INFLIGHT = 40`** | Upload is bandwidth-bound (home connection 50–200 Mbps); MPS-side is server-bound (default 60 concurrent transcoding quota). Two queues prevent starving the user's network |
| Polling cadence | 5s × 6 → 10s × 30 → 15s thereafter | Video tasks are minutes-long |
| Task timeout | `max(60min, sourceDurationMs * 4)` | Tencent SmartErase 至尊版 typical 0.3–0.8× source duration; 4× factor + 60-min floor covers long-form content with margin |
| `InputInfo.Type` | `COS` (not `URL`) | Avoids presign expiry mid-processing; couples input to COS which is acceptable since upload always lands there |
| Cost guardrail | ffprobe at drop → if file count >10 OR total duration >60min, show estimated cost confirm dialog | Hard cap on simultaneously-active *new* tasks at 50 unless overridden |
| Result UX | Processed video alone OR side-by-side compare toggle (default off, user opens) | Original is on local disk; just need `<video src={file://...}>` |
| History poster | Local ffmpeg pre-upload thumbnail (320px JPEG, base64) | No CI service dependency; survives URL expiry |
| Credential management | `tencent/credentials.ts` from shared layer (`safeStorage`-backed) | Single source of truth for all features |
| Cancellation semantics | Pre-upload: drop from queue. Mid-upload: `cos.cancelTask(taskId)`. Mid-processing: drop from active set, retain `mpsTaskId` + `inputCosKey` in reaping queue; on natural FINISH, auto-delete both COS objects | Avoid orphan COS storage; user pays for MPS minutes already incurred |
| CSP | Extend `media-src` to include `https:` | Required for `<video>` to load COS HTTPS presigned URL |

## 3. Architecture

### 3.1 Module layout (depends on `tencent/*` from refactor spec)

```
src/
├── types/smartErase.ts                              ← new
├── main/services/
│   ├── tencent/                            (shared, from refactor spec)
│   ├── storyboardSplit/                    (already converted to thin runner)
│   └── smartErase/                                   ← new
│       ├── config.ts            (re-exports tencent/credentials + erase defaults)
│       ├── runner.ts            (video-specific submit + poll + result parsing)
│       ├── posterGen.ts         (NEW: ffmpeg local thumbnail)
│       ├── reaper.ts            (NEW: cancelled-task reaping + auto-cleanup)
│       └── index.ts             (composes JobQueue; IPC handlers)
└── renderer/src/
    ├── pages-react/
    │   ├── SmartErasePage.tsx                ← new
    │   └── smart-erase/                      ← new
    │       ├── EraseUploader.tsx           (drag/drop + ffprobe pre-flight + cost confirm)
    │       ├── EraseQueue.tsx              (3 counters: queued / uploading / processing)
    │       ├── EraseHistoryDrawer.tsx      (50 cap)
    │       ├── EraseResultPanel.tsx        (with compare toggle)
    │       └── useEraseEvents.ts
    └── stores/
        ├── useEraseSessionStore.ts           ← new (ephemeral)
        └── useErasePersistStore.ts           ← new (idb-keyval-backed; defaultConfig + history)
```

### 3.2 Touchpoints in existing files

```
src/main/index.ts                          + 6 IPC handler registrations + setEraseMainWindow + cancelAllActiveSmartEraseTasks() in window-all-closed hook
src/main/index.ts (CSP block, line 232)    Extend media-src to: 'self' data: blob: https:
src/renderer/index.html                    + tab button + #smart-erase-react-root
src/renderer/src/preload/index.ts          + smartErase API + getFilePath() + event whitelist
src/renderer/src/react-app/main.tsx        + mount/unmount entry points
src/renderer/src/services/ServiceBridge.ts + tab routing
package.json                               + ffmpeg-static (or @ffmpeg-installer/ffmpeg) + idb-keyval
```

## 4. Data Flow

```
[Renderer]                                            [Main]                              [Tencent Cloud]
    │                                                    │                                       │
    │ 1. User drops files (FileList)                     │                                       │
    │    a. webUtils.getPathForFile(file) → path         │                                       │
    │       (empty string → FILE_PATH_UNAVAILABLE)       │                                       │
    │    b. fs probe (statSync + first-byte read)        │                                       │
    │       (timeout/error → FILE_NOT_LOCAL)             │                                       │
    │ 2. ipc('smart-erase:probe-batch', { paths })       │                                       │
    │ ─────────────────────────────────────────────────► │                                       │
    │                                                    │ 3. ffprobe each file: {duration, ...} │
    │ ◄──────── { items: [{path, duration, sizeBytes}] } │                                       │
    │ 4. If totalDuration > 60min OR count > 10:         │                                       │
    │    show cost confirm dialog. User confirms or aborts.                                       │
    │ 5. ipc('smart-erase:submit', payload)              │                                       │
    │ ─────────────────────────────────────────────────► │                                       │
    │                                                    │ 6. enqueue + ffmpeg snapshot →posterDataUrl │
    │ ◄──────── 'erase:progress' (queued)                │                                       │
    │                                                    │ 7. uploadStream (gates 3 at a time) ► │  COS
    │ ◄──────── 'erase:progress' (uploading%)            │                                       │
    │                                                    │ 8. ProcessMedia ──────────────────►   │  MPS
    │                                                    │    InputInfo: { Type: 'COS', ... }    │
    │                                                    │    SmartEraseTask: { Definition: 303 }│
    │                                                    │    OutputDir: '/smart-erase/{id}/output/' │
    │                                                    │    OutputStorage: { Type: 'COS', ... }│
    │ ◄──────── 'erase:progress' (processing)            │ 9. DescribeTaskDetail loop (5/10/15s) │
    │                                                    │    Read resp.WorkflowTask.SmartEraseTaskResult │
    │                                                    │    Failure: SmartEraseTaskResult.Status === 'FAIL' │
    │                                                    │    Output: SmartEraseTaskResult.Output.Path     │
    │                                                    │    Strip leading slash                │
    │                                                    │ 10. getPresignedUrl (7 days) ───────► │  COS
    │ ◄──────── 'erase:finished' { videoUrl, posterUrl }  │                                      │
    │                                                    │                                       │
    │ Renderer: posterUrl is the local base64 from step 6.│                                      │
    │ history.push(item) → idb-keyval; cap at 50         │                                       │
```

## 5. Type Contracts

### 5.1 `src/types/smartErase.ts`

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
  // NOTE: no per-task config override; reads from useErasePersistStore.defaultConfig at submit time
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
  errorCode: string               // SCREAMING_SNAKE_CASE; see §8
  errorMessage: string
  stage: 'probe' | 'upload' | 'submit' | 'poll' | 'output' | 'unknown'
}
```

### 5.2 MPS response navigation (BLOCKER fix)

Per `tencentcloud-sdk-nodejs-mps@4.1.218` typedefs (verified):

```ts
// Definition mode — what we use in MVP
interface DescribeTaskDetailResponse {
  TaskType?: 'WorkflowTask'        // for ProcessMedia + SmartEraseTask + Definition
  Status?: 'WAITING' | 'PROCESSING' | 'FINISH'
  WorkflowTask?: {
    SmartEraseTaskResult?: {
      Status?: 'PROCESSING' | 'SUCCESS' | 'FAIL'    // ← failure here, NOT top-level
      ErrCodeExt?: string
      Message?: string
      Output?: {
        Path?: string                                // ← output COS key, with leading "/"
        OutputStorage?: { Type: 'COS', CosOutputStorage: { Bucket, Region } }
      }
    }
  }
}
```

Runner pseudo-code:

```ts
const resp = await client.DescribeTaskDetail({ TaskId: mpsTaskId })

if (resp.Status === 'WAITING' || resp.Status === 'PROCESSING') return 'continue'

const result = resp.WorkflowTask?.SmartEraseTaskResult
if (!result) throw err('OUTPUT_NOT_FOUND', 'No SmartEraseTaskResult in response', 'output')

if (result.Status === 'FAIL') {
  throw err('MPS_TASK_FAILED', `${result.ErrCodeExt}: ${result.Message}`, 'poll')
}

if (result.Status === 'SUCCESS') {
  const path = result.Output?.Path
  if (!path) throw err('OUTPUT_NOT_FOUND', 'SUCCESS but no Output.Path', 'output')
  return { outputCosKey: path.replace(/^\//, '') }    // ← strip leading slash
}
```

## 6. IPC Contract

| Channel | Direction | Purpose |
|---|---|---|
| `smart-erase:probe-batch` | renderer → main | ffprobe each file path; returns `EraseProbeResult[]` for cost confirmation UI |
| `smart-erase:submit` | renderer → main | Enqueue task; returns `{ taskId }` |
| `smart-erase:cancel` | renderer → main | Cancel local tracking; aborts upload via `cos.cancelTask(taskId)` if in-flight |
| `smart-erase:get-config` | renderer → main | Read credential state only (defaults live in renderer persist store) |
| `smart-erase:set-credentials` | renderer → main | Save SecretId/SecretKey/Bucket/Region (delegates to `tencent/credentials`) |
| `smart-erase:delete-remote` | renderer → main | Best-effort delete COS objects (input + output) |
| `erase:progress` | main → renderer | Per-task status updates |
| `erase:finished` | main → renderer | Single emission per task on success |
| `erase:failed` | main → renderer | Single emission per task on failure |

Removed from v1.0: `smart-erase:set-defaults` — defaults are renderer-side via zustand persist.

Preload exposes:

```ts
window.electronAPI.smartEraseProbeBatch(paths: string[])
window.electronAPI.smartEraseSubmit(payload: EraseSubmitPayload)
window.electronAPI.smartEraseCancel({ taskId })
window.electronAPI.smartEraseGetConfig()
window.electronAPI.smartEraseSetCredentials(c)
window.electronAPI.smartEraseDeleteRemote(keys)
window.electronAPI.onSmartEraseEvent(cb)
window.electronAPI.removeSmartEraseListeners()
window.electronAPI.getFilePath(file: File): string   // wraps webUtils.getPathForFile; returns "" for synthetic files
```

## 7. State Management

### 7.1 `useEraseSessionStore` (ephemeral)

```ts
interface EraseSessionState {
  activeTasks: Record<string, EraseTask>
  selectedHistoryId: string | null
  compareMode: boolean                                // §10 side-by-side toggle
  setTask(taskId: string, patch: Partial<EraseTask>): void
  setMpsTaskId(taskId: string, mpsTaskId: string): void
  removeTask(taskId: string): void
  clearFinished(): void
  selectHistory(id: string | null): void
  setCompareMode(b: boolean): void
}
```

### 7.2 `useErasePersistStore` (idb-keyval-backed)

```ts
interface ErasePersistState {
  history: EraseHistoryItem[]                         // newest first, capped at 50
  defaultConfig: EraseConfig                          // single source of truth
  drawerOpen: boolean
  pushHistory(item: EraseHistoryItem): Promise<void>  // append + truncate + persist via idb-keyval (NOT localStorage)
  removeHistory(id: string): Promise<void>
  clearHistory(): Promise<void>
  setDefaultConfig(c: EraseConfig): Promise<void>
  setDrawerOpen(b: boolean): void
}
```

**Why idb-keyval, not zustand `persist` middleware to localStorage:**
- 50 history items × ~2 KB = ~100 KB. localStorage works but `persist` rewrites the entire history array on every push (synchronous). idb-keyval writes asynchronously and the renderer doesn't block.
- Original v1.0 claimed ~500 B per item; corrected estimate per reviewer is ~2 KB (filename + 2 cosKeys + filePath + posterDataUrl 10 KB base64 — actually pushes per-item to ~12 KB). At 50 items × 12 KB = ~600 KB. Within IndexedDB quota; localStorage is borderline.

## 8. Error Handling

| Code | Stage | Trigger | UI |
|---|---|---|---|
| `FILE_PATH_UNAVAILABLE` | probe | `webUtils.getPathForFile` returned `""` | Toast: "文件不在本地磁盘（可能是浏览器拖入或合成 File 对象）" |
| `FILE_NOT_LOCAL` | probe | First-byte read timeout >Ns OR `statSync` fails | Toast: "文件无法读取（OneDrive 占位/网络共享/已断开）。请先复制到本地磁盘" |
| `PROBE_FAILED` | probe | ffprobe exited non-zero or no duration | Toast: "无法读取视频信息（可能不是有效视频文件）" |
| `INVALID_CREDENTIALS` | submit | `AuthFailure.SignatureFailure` etc. | Toast + auto-open settings |
| `BUCKET_NOT_FOUND` | upload | COS 404 | Toast + open settings |
| `FILE_TOO_LARGE` | submit | > 5 GB | Toast |
| `UPLOAD_ABORTED` | upload | User cancel via `cos.cancelTask` | Silent (already on cancel UI) |
| `UPLOAD_FAILED` | upload | Network / COS server error | Toast + retry button |
| `MPS_SUBMIT_FAILED` | submit | `ProcessMedia` returns error | Toast |
| `TEMPLATE_NOT_FOUND` | submit | `InvalidParameterValue.Definition` | Toast + ops link to copy-template flow (§13) |
| `MPS_TASK_FAILED` | poll | `WorkflowTask.SmartEraseTaskResult.Status === 'FAIL'` | Toast with `ErrCodeExt: Message` |
| `POLL_TIMEOUT` | poll | > dynamic timeout | Toast; offer "继续在后台跟踪" (Phase 2) |
| `OUTPUT_NOT_FOUND` | output | Empty `Output.Path` even on SUCCESS | Toast |
| `UNKNOWN_ERROR` | unknown | Anything else | Toast with stack in dev mode |

### 8.1 Cancellation paths

```
User clicks cancel
  ├─ task.status === 'queued-upload' OR 'queued-process'
  │    → drop from queue; emit 'erase:progress' with status='cancelled'
  │
  ├─ task.status === 'uploading'
  │    → cos.cancelTask(taskId) [taskId stored from onTaskReady]
  │    → await abort callback
  │    → drop from active set; emit cancelled
  │
  ├─ task.status === 'submitting'
  │    → wait for in-flight ProcessMedia call to return (un-interruptible);
  │      once it returns mpsTaskId, push to reaping queue
  │      drop from active set; emit cancelled
  │
  ├─ task.status === 'processing'
  │    → push { mpsTaskId, inputCosKey } to reaping queue
  │    → drop from active set; emit cancelled
  │    → reaper polls each entry until SmartEraseTaskResult.Status terminal
  │    → on SUCCESS or FAIL: deleteObjects([inputCosKey, outputCosKey]) best-effort
```

The reaping queue is a `Map<mpsTaskId, { inputCosKey: string }>` and persists across `JobQueue` lifecycle (lives in `smartErase/reaper.ts`). On app close (before the `cancelAllActiveSmartEraseTasks` hook), the reaping queue is **not** persisted — orphans are accepted as a known cost of crashing during a cancelled-but-still-running task.

## 9. Concurrency & Performance

- **Two queues, hand-off in runner:**
  - Upload queue: `MAX_UPLOAD_CONCURRENT = 3`. Beyond 3, tasks sit in `queued-upload`.
  - Process pool: `MAX_INFLIGHT = 40`. Tasks transition from upload → submit when upload completes; if process pool full, sit in `queued-process` (rare, since uploads bottleneck first).
- **Polling cadence:** 5s for first 6 polls (≈30 s), 10s for next 30 (≈5 min), 15s thereafter. At max-load (40 concurrent every 5s) = 8 req/s, well below MPS 100 req/s.
- **ffprobe at drop:** runs in parallel for all dropped files, but capped at 4 concurrent ffprobe processes to avoid spawning 200 spawns at once on a folder drop.
- **Streaming upload:** `tencent/cosClient.uploadStream` reads via `fs.createReadStream`; main process never holds the entire file in memory.
- **Local poster:** ffmpeg `-ss 0.5 -frames:v 1 -vf scale=320:-1 -f mjpeg pipe:1` → base64. ~10 KB per poster. Replaces COS-CI snapshot URL from v1.0.
- **History bound:** 50 items × ~12 KB (mostly poster base64) = ~600 KB IndexedDB.

## 10. UX

```
+--------------------------------------------------------------+
| [宫格拆图] [智能去字幕]              ⚙ 设置  📋 历史 (12)  |
+--------------------------------------------------------------+
|                                                               |
|   ┌──────────────────────────────────────────────────────┐    |
|   │   拖入视频文件，或点击选择                            │    |
|   │   支持 .mp4 .mov .mkv（≤ 5 GB，≤ 60 min 推荐）        │    |
|   └──────────────────────────────────────────────────────┘    |
|                                                               |
|   ── 拖入 12 个文件，总时长 4h 35min（估算 ¥XX.XX） ──        |
|   [取消]      [继续提交]                                       |
|                                                               |
|   队列   3 等待上传  ·  3 上传中  ·  6 处理中                 |
|   ┌──────────────────────────────────────────────────────┐    |
|   │ ▶ episode-01.mp4  4:32  processing (3 min)      [✕] │    |
|   │ ▶ episode-02.mp4  3:18  uploading 47%           [✕] │    |
|   │ ▶ episode-03.mp4  5:01  queued (upload)         [✕] │    |
|   └──────────────────────────────────────────────────────┘    |
|                                                               |
|   结果预览                                                    |
|   ┌──────────────────────────────────────────────────────┐    |
|   │   [video — 处理后]    [□ 对比原视频]                 │    |
|   │   下载  复制 URL  删除远端文件                        │    |
|   └──────────────────────────────────────────────────────┘    |
+--------------------------------------------------------------+

设置抽屉:
  - 凭证（共用; OS 密钥环加密）
  - 模板 ID: [303]  系统预设·去字幕-至尊版
                ⓘ 首次运行将自动验证此 ID 是否可用
  - 远端 7 天后清理: [开]

成本确认对话框（drop-time）:
  当 file count > 10 OR 总时长 > 60min:
  ┌──────────────────────────────────────┐
  │ ⚠ 大量任务确认                        │
  │ 即将处理 N 个视频，总时长 X，估算费用 ¥Y │
  │ MPS 计费按视频时长计算，详见 [文档]     │
  │       [取消]    [我已知晓，继续]       │
  └──────────────────────────────────────┘
```

Side-by-side compare mode: when toggled, result panel renders two `<video>` elements with synchronized `currentTime`. Original from `file://${originalFilePath}`; if file is gone (user moved/deleted it), show "原视频不可用" placeholder. ~30 LOC of React.

## 11. Implementation Checklist

**Prerequisite:** `2026-04-29-tencent-cloud-job-runner-refactor.md` merged.

**New files (15):**
- `src/types/smartErase.ts`
- `src/main/services/smartErase/{config,runner,posterGen,reaper,index}.ts`
- `src/renderer/src/pages-react/SmartErasePage.tsx`
- `src/renderer/src/pages-react/smart-erase/{EraseUploader,EraseQueue,EraseHistoryDrawer,EraseResultPanel,useEraseEvents}.tsx`
- `src/renderer/src/stores/{useEraseSessionStore,useErasePersistStore}.ts`
- `src/renderer/src/utils/idbKeyValStore.ts` (thin idb-keyval wrapper for zustand)

**Modified files (6):**
- `src/main/index.ts` — register 6 IPC handlers + `setEraseMainWindow` + `cancelAllActiveSmartEraseTasks` in `window-all-closed` + extend `media-src` in CSP at line 232
- `src/renderer/index.html` — tab button + `<div id="smart-erase-react-root">`
- `src/renderer/src/preload/index.ts` — smartErase API surface + `getFilePath` + event whitelist
- `src/renderer/src/react-app/main.tsx` — `mountSmartEraseReact` / `unmountSmartEraseReact`
- `src/renderer/src/services/ServiceBridge.ts` — tab routing
- `package.json` — add `ffmpeg-static` (or `@ffmpeg-installer/ffmpeg`) + `idb-keyval`

## 12. Test Matrix

| Case | Expected |
|---|---|
| Drop 1 small mp4 | Probe → no confirm dialog → upload → process → finished video plays in `<video>` element (CSP allows COS https) |
| Drop 50 mp4 (mixed sizes) | Cost confirm dialog appears → user confirms → at most 3 upload concurrently → up to 40 in MPS pool |
| Drop file from OneDrive on-demand placeholder | `FILE_NOT_LOCAL` toast; task NOT enqueued |
| Drop file from `<input type=file>` of synthetic Blob | `FILE_PATH_UNAVAILABLE` toast |
| Cancel during `uploading` | `cos.cancelTask(taskId)` actually aborts; bandwidth freed within ~5s; ghost upload does NOT continue |
| Cancel during `processing` | Local task removed; reaper continues polling silently; on natural FINISH, both COS objects deleted |
| Wrong credentials | `INVALID_CREDENTIALS` → settings drawer auto-opens |
| `Definition: 999999` (nonexistent) | `TEMPLATE_NOT_FOUND` toast + ops link |
| First-run with `Definition: 303` returns `TEMPLATE_NOT_FOUND` | Settings drawer surfaces "未检测到 303 模板，是否一键复制到本账户?" with manual fallback |
| Switch tabs mid-task | Background processing continues; events still dispatched |
| App restart | history preserved (idb-keyval); compareMode resets to false; reaping queue does NOT survive (orphan COS objects accepted) |
| 90-min source video | Timeout = `max(60min, 90*60*4*1000ms)` = 6h; should not pre-timeout |
| `WorkflowTask.SmartEraseTaskResult.Status === 'FAIL'` (forced via wrong template) | `MPS_TASK_FAILED` toast with `ErrCodeExt: Message` |
| `Output.Path` returns `/smart-erase/abc/output.mp4` | `outputCosKey` stored as `smart-erase/abc/output.mp4` (no leading slash) |
| Drop dragged from Chrome browser tab | `webUtils.getPathForFile` returns `""` → `FILE_PATH_UNAVAILABLE` |
| Side-by-side compare with original moved/deleted | `<video>` shows "原视频不可用" placeholder; processed still plays |
| Window closed during upload | `cancelAllActiveSmartEraseTasks` flushes queue; uploads call `cos.cancelTask` |

## 13. Operations

### 13.1 First-run template verification (NEW — was buried in v1.0 §13)

On first `smart-erase:submit`, before calling `ProcessMedia`, the runner does a smoke test:

```ts
// once per app session, gated by a flag in useErasePersistStore
async function verifyDefinition(definitionId: number): Promise<'ok' | 'missing'> {
  try {
    await client.DescribeTranscodeTemplates({
      // Tencent MPS exposes a generic template-list API; if SmartErase has its own, use that
      Type: 'Custom',  // or 'Preset' depending on whether 303 is system-provided
      ContainerType: 'video',
      Limit: 1,
      Offset: 0,
      // (precise API call refined at implementation time — verify against SDK)
    })
    return 'ok'
  } catch (e) {
    if (/not\s*exist|not\s*found/i.test(e.message)) return 'missing'
    throw e
  }
}
```

If `'missing'`, the renderer surfaces a one-click "复制 303 模板到我的账户" button that:
1. Calls a new `smart-erase:copy-template` IPC that hits MPS `CreateAdaptiveDynamicStreamingTemplate`-equivalent for SmartErase (TBD at implementation: confirm exact API name).
2. Returns the new custom ID.
3. Auto-saves it as `defaultConfig.definitionId` in zustand persist.

### 13.2 If automatic template copy is not feasible

Fall back to manual instructions:
1. Log into [腾讯云 MPS 控制台 - 媒体 AI 模板](https://console.cloud.tencent.com/mps/templates/intel)
2. Switch to "智能擦除" tab → find `303 - 去字幕-至尊版` → click "复制模板"
3. The new template gets a custom ID (typically 1xxxxx). Read it from the list.
4. Open app settings → set `Definition` to the new ID.

### 13.3 Credentials prep

- CAM policy: `QcloudMPSFullAccess` + `QcloudCOSFullAccess` on the sub-account.
- COS bucket region must match MPS region (recommended `ap-shanghai` or `ap-guangzhou`).
- App stores via OS keychain (`safeStorage`); falls back to in-memory + warning if unavailable.

### 13.4 Cost reference

[智能擦除计费说明](https://cloud.tencent.com/document/product/862/36180). Billed per source minute, independent of concurrency. Cost estimate dialog at drop time uses a hard-coded rate (configurable in settings later).

## 14. Rollback

All changes are additive or isolated. To roll back:
1. Delete the 15 new files.
2. Revert the 6 modified files.
3. Refactor spec rollback is independent — see its §8.

IPC channel namespace `smart-erase:` and `erase:` does not collide with `image-split:` / `split:`.

## 15. Out of Scope (deferred)

- **ScheduleId mode** (Phase 2 — requires `ScheduleTask.ActivityResultSet[]` walk)
- **OCR subtitle extraction**, translation, dubbing
- **Logo removal** (`去 Logo`), privacy protection (face/plate blur)
- **Auto-regenerate expired video URLs** (current: 7-day presign; expiry shows "URL 已过期" in history)
- **Server-side MPS task cancel** (API doesn't expose it; reaper handles cleanup instead)
- **Multi-region COS support** (single region in MVP)
- **Bulk history operations** (clear all, export, etc.)
- **MediaJobTask discriminator rename** (would unify `EraseHistoryItem` / `SplitHistoryItem` into one shape with a `taskType` field — Phase 3 if feature count justifies it; localStorage migration cost is non-trivial)

## 16. Open Verification Items (must answer before implementation merges)

1. Does `ProcessMedia({ Definition: 303 })` succeed on a fresh sub-account with `QcloudMPSFullAccess`? **Empirical test required.** If no, §13.1 first-run probe becomes mandatory primary path.
2. Exact MPS API name for "list smart erase templates" — `DescribeTranscodeTemplates` is for transcode; SmartErase may expose a different endpoint. Confirm before implementing §13.1.
3. Exact MPS API name for "copy a template" if automatic copy is taken — TBD.
4. ffprobe duration probe time on a 5 GB file: is it fast enough (<1s) to feel instant in the drop flow, or do we need to defer ffprobe to background after enqueueing?
5. Does `<video>` work with a 7-day COS presigned URL containing query-param signature? Some browsers handle range requests poorly with signed URLs — measure on first prototype.
6. `ffmpeg-static` package size impact on installer bundle (~30 MB pre-compressed). If user pushes back, fall back to system-installed ffmpeg via `which ffmpeg` probe at startup.

---

**Next:** invoke `writing-plans` skill to break this into ordered implementation tasks (after refactor spec PR merges).
