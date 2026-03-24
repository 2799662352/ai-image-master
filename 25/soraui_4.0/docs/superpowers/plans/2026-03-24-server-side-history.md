# Server-Side History Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace localStorage-based history persistence with server API as the single source of truth, eliminating ~800 lines of local storage sync code.

**Architecture:** "展示源替换" — swap the data source from `taskTokenManager.recoverTasks()` (localStorage) to `backendAPI.listVideoTasks()` (API), remove all localStorage write paths, keep existing React state + SSE flow intact. UI components remain unchanged since `displayHistory = taskTokens` (line 601 of App.tsx) is a direct alias.

**Tech Stack:** React 18, TypeScript, Zustand 5, Vite 5, Axios, SSE (EventSource), Prisma (backend)

**Spec:** `docs/brainstorms/2026-03-24-server-side-history-brainstorm.md`

**Backend dependency:** Tasks 5 (delete) and Task 1 (favorite) require `sora-ui-backend` to implement the corresponding endpoints. Run `git submodule update --init sora-ui-backend` and add the routes before end-to-end testing. Frontend stubs are safe to commit first — they degrade gracefully (console error only).

---

## File Structure

### Files to Create

| File | Responsibility |
|------|---------------|
| `sora-ui/src/utils/videoTaskAdapter.ts` | Convert `VideoTask` (API) ↔ `TaskToken` (UI) — single place for field mapping |

### Files to Modify

| File | Lines Affected | Change |
|------|---------------|--------|
| `sora-ui/src/api/backend-api.ts` | Add after line 414 | Add `deleteVideoTask`, `toggleFavorite`, expand `listVideoTasks` options |
| `sora-ui/src/App.tsx:111-177` | Replace `loadHistory()` | Load from API instead of `taskTokenManager.recoverTasks()` |
| `sora-ui/src/App.tsx:269-446` | Modify SSE handler | Remove `taskTokenManager.scheduleSave()` / `updateTask()` calls |
| `sora-ui/src/App.tsx:456-510` | Remove | `syncBackendHistory` listener (no longer needed) |
| `sora-ui/src/App.tsx:512-562` | Simplify mount effect | Remove `cleanupStaleGeneratingTasks` (server is source of truth) |
| `sora-ui/src/App.tsx:630-683` | Remove | `autoSyncOnLogin` (no longer needed) |
| `sora-ui/src/App.tsx:1090-1124` | Rewrite `handleDeleteTask` | Call API instead of localStorage ops |
| `sora-ui/src/App.tsx:1314-1382` | Remove | `beforeunload` localStorage writes |
| `sora-ui/src/App.tsx:58,64-75` | Clean imports | Remove dead imports |

### Files to Modify (cleanup)

| File | Change |
|------|--------|
| `sora-ui/src/types/taskToken.ts` | Remove `thumbnailBase64` field (no longer needed without localStorage) |

### Files to Delete (Phase 4)

| File | Reason |
|------|--------|
| `sora-ui/src/utils/taskTokenManager.ts` | Entire localStorage recovery mechanism |
| `sora-ui/src/utils/storageManager.ts` | localStorage/Electron per-day storage |
| `sora-ui/src/utils/backendHistorySync.ts` | Bidirectional sync logic |
| `sora-ui/src/services/business/history.service.ts` | IndexedDB + RxJS layer |
| `sora-ui/src/utils/storage/*` (indexedDBStorage) | IndexedDB operations, if `history.service.ts` was the only consumer |

---

## Task 1: Add Backend API Functions

**Files:**
- Modify: `sora-ui/src/api/backend-api.ts` (add after line 414)

- [ ] **Step 1: Add `deleteVideoTask` function**

Add after the `listVideoTasks` function (after line 414):

```typescript
export const deleteVideoTask = async (
  token: string,
  videoId: string
): Promise<void> => {
  const response = await axios.delete<BackendResponse>(
    `${BACKEND_BASE_URL}/api/video/tasks/${videoId}`,
    {
      headers: { 'Authorization': `Bearer ${token}` },
    }
  );

  if (!response.data.success) {
    throw new Error(response.data.message || '删除任务失败');
  }
};
```

- [ ] **Step 2: Add `toggleVideoTaskFavorite` function**

```typescript
export const toggleVideoTaskFavorite = async (
  token: string,
  videoId: string,
  isFavorite: boolean
): Promise<void> => {
  const response = await axios.patch<BackendResponse>(
    `${BACKEND_BASE_URL}/api/video/tasks/${videoId}/favorite`,
    { isFavorite },
    {
      headers: { 'Authorization': `Bearer ${token}` },
    }
  );

  if (!response.data.success) {
    throw new Error(response.data.message || '更新收藏状态失败');
  }
};
```

- [ ] **Step 3: Expand `listVideoTasks` options type**

At line 380, expand the options interface to support future filter params:

```typescript
export const listVideoTasks = async (
  token: string,
  options: {
    page?: number;
    pageSize?: number;
    status?: string;
    orderBy?: string;
    order?: 'asc' | 'desc';
    model?: string;
    search?: string;
  } = {}
): Promise<{
  tasks: VideoTask[];
  total: number;
  page: number;
  pageSize: number;
}> => {
  const params = new URLSearchParams();
  if (options.page) params.append('page', options.page.toString());
  if (options.pageSize) params.append('pageSize', options.pageSize.toString());
  if (options.status) params.append('status', options.status);
  if (options.orderBy) params.append('orderBy', options.orderBy);
  if (options.order) params.append('order', options.order);
  if (options.model) params.append('model', options.model);
  if (options.search) params.append('search', options.search);
  // ... rest unchanged
```

- [ ] **Step 4: Add to default export**

At line ~1538 add the two new functions:

```typescript
  deleteVideoTask,
  toggleVideoTaskFavorite,
```

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit --pretty 2>&1 | head -20`
Expected: No new errors (backend endpoints don't exist yet, but types are correct)

- [ ] **Step 6: Commit**

```bash
git add sora-ui/src/api/backend-api.ts
git commit -m "feat(api): add deleteVideoTask and toggleVideoTaskFavorite endpoints"
```

---

## Task 2: Create VideoTask → TaskToken Adapter

**Files:**
- Create: `sora-ui/src/utils/videoTaskAdapter.ts`

- [ ] **Step 1: Create adapter file**

```typescript
import type { TaskToken } from '../types/taskToken';
import type { VideoTask } from '../api/backend-api';

export function videoTaskToToken(task: VideoTask): TaskToken {
  const createdAt = typeof task.createdAt === 'string'
    ? task.createdAt
    : new Date(task.createdAt).toISOString();

  const date = new Date(createdAt);
  const dateFolder = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;

  const statusMap: Record<string, TaskToken['status']> = {
    'QUEUED': 'pending',
    'PROCESSING': 'generating',
    'COMPLETED': 'completed',
    'FAILED': 'error',
    'CANCELLED': 'cancelled',
  };

  return {
    id: task.videoId,
    prompt: task.prompt || '',
    prompt_preview: (task.prompt || '').substring(0, 50),
    status: statusMap[task.status] || 'error',
    created_at: createdAt,
    model: task.model || 'unknown',
    dateFolder,
    progress: task.progress,
    video_url: task.videoUrl || task.video_url,
    image_url: task.imageUrl || task.image_url,
    media_type: task.imageUrl ? 'image' : 'video',
    apiConfigId: task.apiConfigId,
    duration: task.duration,
    backendVideoId: task.videoId,
    externalTaskId: task.externalTaskId,
    source: 'simple',
    isFavorite: (task as any).isFavorite,
    error: task.error || task.errorMessage,
    referenceImageUrl: (task.metadata as any)?.referenceImageUrl,
    referenceImageUrls: (task.metadata as any)?.referenceImageUrls,
    thumbnailUrl: (task.metadata as any)?.thumbnailUrl,
  };
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit --pretty 2>&1 | head -20`

- [ ] **Step 3: Commit**

```bash
git add sora-ui/src/utils/videoTaskAdapter.ts
git commit -m "feat: add videoTaskToToken adapter for API→UI data conversion"
```

---

## Task 3: Replace Startup Data Loading

**Files:**
- Modify: `sora-ui/src/App.tsx:111-177` (replace `loadHistory` function)
- Modify: `sora-ui/src/App.tsx:512-562` (simplify mount effect)

- [ ] **Step 1: Add import for adapter**

At top of App.tsx (near line 75), add:

```typescript
import { videoTaskToToken } from './utils/videoTaskAdapter';
```

- [ ] **Step 2: Replace `loadHistory()` function (lines 111-177)**

Replace the entire `loadHistory` function. Key design: two parallel API calls — one for in-flight tasks (PROCESSING/QUEUED), one for recent history — merged into a single list. This matches brainstorm 场景 2 "刷新页面" dual-query strategy.

```typescript
const loadHistory = async (): Promise<TaskToken[]> => {
  performance.mark('token-load-start');
  
  try {
    const { token: authToken } = useAuthStore.getState();
    
    if (!authToken) {
      console.log('[App] ⚠️ 未登录，跳过历史加载');
      return [];
    }

    console.log('[App] 🔄 从服务端加载历史记录...');
    
    // Dual query: in-flight tasks + recent history (parallel)
    const [inFlightResult, historyResult] = await Promise.all([
      backendAPI.listVideoTasks(authToken, {
        status: 'PROCESSING',
        pageSize: 50,
        orderBy: 'createdAt',
        order: 'desc',
      }).catch(() => ({ tasks: [] as any[], total: 0, page: 1, pageSize: 50 })),
      backendAPI.listVideoTasks(authToken, {
        pageSize: 100,
        orderBy: 'createdAt',
        order: 'desc',
      }),
    ]);
    
    // Merge: in-flight first, then history (dedup by videoId)
    const seenIds = new Set<string>();
    const allTasks = [...inFlightResult.tasks, ...historyResult.tasks];
    const tokens = allTasks
      .map(videoTaskToToken)
      .filter(t => {
        if (seenIds.has(t.id)) return false;
        seenIds.add(t.id);
        return true;
      });
    
    performance.mark('token-load-end');
    performance.measure('token-load', 'token-load-start', 'token-load-end');
    const measure = performance.getEntriesByName('token-load')[0];
    if (measure) {
      console.log('[Performance] ⚡ API 加载时间:', measure.duration.toFixed(2), 'ms,', tokens.length, '条');
    }
    performance.clearMarks('token-load-start');
    performance.clearMarks('token-load-end');
    performance.clearMeasures('token-load');
    
    return tokens;
  } catch (error) {
    console.error('[App] ❌ 历史加载失败:', error);
    return [];
  }
};
```

- [ ] **Step 3: Simplify mount effect (lines 512-562)**

Replace the mount `useEffect` body. Remove `cleanupStaleGeneratingTasks` logic (server is SSOT), keep `startTransition`:

```typescript
  useEffect(() => {
    const load = async () => {
      PerformanceMonitor.start('loadTokens');
      const tokens = await loadHistory();
      PerformanceMonitor.end('loadTokens');
      
      console.log('[App] Token 已加载:', tokens.length, '条');
      
      startTransition(() => {
        setTaskTokens(tokens);
      });
    };
    
    load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
```

- [ ] **Step 4: Verify app still starts**

Run: `cd sora-ui && npm run dev`
Open browser, check console for `[App] 🔄 从服务端加载历史记录...` log.

- [ ] **Step 5: Commit**

```bash
git add sora-ui/src/App.tsx sora-ui/src/utils/videoTaskAdapter.ts
git commit -m "feat: load history from server API instead of localStorage"
```

---

## Task 4: Remove localStorage Writes from SSE Handler

**Files:**
- Modify: `sora-ui/src/App.tsx:269-446` (SSE `onTaskUpdate` handler)

- [ ] **Step 1: Remove `saveTaskToHistory` call (around line 397-405)**

In the SSE handler, find the block that calls `saveTaskToHistory(taskToSave).catch(console.error)` and `taskTokenManager.updateTask(...)`. Remove both calls. Keep only the `setTaskTokens` state update and notification logic.

Specifically, in the completion block (around lines 397-412), remove:

```typescript
// DELETE these lines:
saveTaskToHistory(taskToSave).catch(console.error);
taskTokenManager.updateTask(newTokens[index].id, {
  status: mappedStatus,
  video_url: videoUrl || newTokens[index].video_url,
  image_url: imageUrl || newTokens[index].image_url,
  error: error || newTokens[index].error,
}).catch(console.error);
```

- [ ] **Step 2: Remove `taskTokenManager.scheduleSave` call (around line 437)**

Find and remove:

```typescript
// DELETE this line:
taskTokenManager.scheduleSave(newTokens);
```

The `setTaskTokens` updater return (`return newTokens`) stays — that's the memory-only update we keep.

- [ ] **Step 3: Verify SSE still updates UI**

Run dev server, trigger a video generation, verify progress updates appear in the UI without console errors about `taskTokenManager`.

- [ ] **Step 4: Commit**

```bash
git add sora-ui/src/App.tsx
git commit -m "refactor: remove localStorage writes from SSE handler"
```

---

## Task 5: Rewrite Delete Operation

**Files:**
- Modify: `sora-ui/src/App.tsx:1090-1124` (`handleDeleteTask`)

- [ ] **Step 1: Replace `handleDeleteTask` implementation**

Replace lines 1090-1124 with:

```typescript
  const handleDeleteTask = useCallback(async (taskId: string) => {
    console.log('[App] 🗑️ 删除任务:', taskId);
    
    const taskToDelete = taskTokens.find(t => t.id === taskId);
    const videoId = taskToDelete?.backendVideoId || taskToDelete?.id || taskId;
    
    // Optimistic UI: remove from list immediately
    setTaskTokens(prev => prev.filter(token => token.id !== taskId));
    
    // Call backend delete API
    try {
      const { token: authToken } = useAuthStore.getState();
      if (authToken) {
        await backendAPI.deleteVideoTask(authToken, videoId);
        console.log('[App] ✅ 任务已从服务端删除:', videoId);
      }
    } catch (error) {
      console.error('[App] ❌ 服务端删除失败，但本地已移除:', error);
    }
  }, [taskTokens]);
```

- [ ] **Step 2: Verify delete works in UI**

Open history, delete a task, verify it disappears. Refresh page, verify it stays deleted (loaded from API, not localStorage).

- [ ] **Step 3: Commit**

```bash
git add sora-ui/src/App.tsx
git commit -m "refactor: delete tasks via server API instead of localStorage"
```

---

## Task 6: Remove Backend Sync & beforeunload Code

**Files:**
- Modify: `sora-ui/src/App.tsx`

- [ ] **Step 1: Remove `syncBackendHistory` listener (lines 456-510)**

Delete the entire `useEffect` block that listens for `backendTaskCompleted` custom events and calls `syncBackendHistory`. No longer needed — server is the source of truth.

- [ ] **Step 2: Remove `autoSyncOnLogin` effect (lines 630-683)**

Delete the entire `useEffect` block that calls `autoSyncOnLogin`. No longer needed — `loadHistory()` already fetches from API.

- [ ] **Step 3: Remove `beforeunload` localStorage writes (lines 1314-1382)**

Delete the entire `useEffect` block with `handleBeforeUnload`. No localStorage to flush on exit.

- [ ] **Step 4: Verify no runtime errors**

Run: `cd sora-ui && npm run dev`
Navigate through the app, verify no console errors about missing functions.

- [ ] **Step 5: Commit**

```bash
git add sora-ui/src/App.tsx
git commit -m "refactor: remove backend sync, autoSyncOnLogin, and beforeunload localStorage writes"
```

---

## Task 7: Clean Dead Imports in App.tsx

**Files:**
- Modify: `sora-ui/src/App.tsx:58,64-75`

- [ ] **Step 1: Remove `backendHistorySync` import (line 58)**

Delete:
```typescript
import { autoSyncOnLogin, addDeletedTaskId, syncBackendHistory, cleanupStaleGeneratingTasks } from './utils/backendHistorySync';
```

- [ ] **Step 2: Remove `storageManager` imports (lines 64-74)**

Delete:
```typescript
import { 
  getAllHistoryFlat, 
  saveTaskToHistory, 
  deleteTask as deleteTaskFromStorage,
  deleteDateFolder,
  clearFailedTasks as clearFailedTasksFromStorage,
  getTodayDateFolder,
  getTaskById,
  recoverTasksWithDetails,
  normalizeUrl,
} from './utils/storageManager';
```

- [ ] **Step 3: Remove `taskTokenManager` import (line 75)**

Delete:
```typescript
import { TaskTokenManager, taskTokenManager } from './utils/taskTokenManager';
```

- [ ] **Step 4: Replace `handleDeleteDateFolder` (~lines 1126-1148)**

This handler deletes all tasks in a date folder. Replace with API-based approach:

```typescript
  const handleDeleteDateFolder = useCallback(async (dateFolder: string) => {
    console.log('[App] 🗑️ 删除日期文件夹:', dateFolder);
    const { token: authToken } = useAuthStore.getState();
    
    // Find all tasks in this date folder
    const tasksToDelete = taskTokens.filter(t => t.dateFolder === dateFolder);
    
    // Optimistic: remove from UI
    setTaskTokens(prev => prev.filter(t => t.dateFolder !== dateFolder));
    
    // Delete each from backend
    if (authToken) {
      for (const task of tasksToDelete) {
        const videoId = task.backendVideoId || task.id;
        backendAPI.deleteVideoTask(authToken, videoId).catch(console.error);
      }
    }
  }, [taskTokens]);
```

- [ ] **Step 5: Replace `handleClearFailedTasks` (~lines 1150-1169)**

```typescript
  const handleClearFailedTasks = useCallback(async () => {
    console.log('[App] 🧹 清除失败任务');
    const { token: authToken } = useAuthStore.getState();
    
    const failedTasks = taskTokens.filter(t => t.status === 'error' || t.status === 'failed');
    
    // Optimistic: remove from UI
    setTaskTokens(prev => prev.filter(t => t.status !== 'error' && t.status !== 'failed'));
    
    // Delete each from backend
    if (authToken) {
      for (const task of failedTasks) {
        const videoId = task.backendVideoId || task.id;
        backendAPI.deleteVideoTask(authToken, videoId).catch(console.error);
      }
    }
  }, [taskTokens]);
```

- [ ] **Step 6: Remove all remaining dead references**

Search and remove every remaining call to:
- `taskTokenManager.*` — delete all call sites
- `saveTaskToHistory` — delete all call sites
- `deleteTaskFromStorage` — already replaced by API calls above
- `getAllHistoryFlat` — delete all call sites (no longer needed for migration)
- `addDeletedTaskId` — delete all call sites (backend handles deletion)
- `taskRecoveryService` — delete all call sites
- `getTaskById` — replace with no-op or remove (data comes from API)
- `recoverTasksWithDetails` — delete all call sites
- `normalizeUrl` from storageManager — if still needed, inline or import from a utility
- `markDirty` / `dirtyTracker` — delete if only used for localStorage persistence

- [ ] **Step 5: Verify TypeScript compiles**

Run: `cd sora-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Expected: No errors related to removed imports.

- [ ] **Step 6: Commit**

```bash
git add sora-ui/src/App.tsx
git commit -m "refactor: remove all localStorage-related imports from App.tsx"
```

---

## Task 8: Add SSE Reconnect Refresh

**Files:**
- Modify: `sora-ui/src/hooks/useSSE.ts` (or `sora-ui/src/App.tsx` SSE setup)

- [ ] **Step 1: Add refetch on SSE reconnect**

In the SSE `onConnected` callback (useSSE.ts or wherever EventSource `open` is handled), add a refetch of in-flight tasks to reconcile state after disconnect. Find the `onConnected` handler and add:

```typescript
const onConnected = () => {
  console.log('[SSE] ✅ Connected');
  // On reconnect, refresh in-flight task states from server
  const { token: authToken } = useAuthStore.getState();
  if (authToken) {
    backendAPI.listVideoTasks(authToken, { status: 'PROCESSING', pageSize: 50 })
      .then(({ tasks }) => {
        const tokens = tasks.map(videoTaskToToken);
        // Merge: update existing generating tasks with server state
        setTaskTokens(prev => {
          const serverIds = new Set(tokens.map(t => t.id));
          const kept = prev.filter(t => t.status !== 'generating' || serverIds.has(t.id));
          const newFromServer = tokens.filter(t => !prev.some(p => p.id === t.id));
          return [...newFromServer, ...kept];
        });
      })
      .catch(console.error);
  }
};
```

This ensures that if a task completed while SSE was disconnected, the UI reflects the correct state on reconnect.

- [ ] **Step 2: Commit**

```bash
git add sora-ui/src/hooks/useSSE.ts sora-ui/src/App.tsx
git commit -m "feat: refetch in-flight tasks on SSE reconnect for state reconciliation"
```

---

## Task 9: Clean TaskToken Type & Delete Dead Files

**Files:**
- Modify: `sora-ui/src/types/taskToken.ts`
- Delete: `sora-ui/src/utils/taskTokenManager.ts`
- Delete: `sora-ui/src/utils/storageManager.ts`
- Delete: `sora-ui/src/utils/backendHistorySync.ts`
- Delete: `sora-ui/src/services/business/history.service.ts`
- Delete: `sora-ui/src/utils/storage/*` (indexedDBStorage, if only used by history.service)

- [ ] **Step 1: Remove `thumbnailBase64` from TaskToken type**

In `sora-ui/src/types/taskToken.ts`, line 78, remove:

```typescript
// DELETE this field:
thumbnailBase64?: string;
```

Also remove the `thumbnailBase64` line from `extractToken()` function if still present.

- [ ] **Step 2: Search for ALL remaining imports of dead files**

Run:
```bash
cd sora-ui && rg -n "taskTokenManager|storageManager|backendHistorySync|history\.service|indexedDBStorage|indexedDB" src/ --type ts --type tsx
```

Fix **every** remaining import before proceeding. Each one must either be:
- Deleted (if the call site was already removed in Tasks 3-7)
- Replaced with API call or no-op

- [ ] **Step 3: Delete files**

```bash
rm sora-ui/src/utils/taskTokenManager.ts
rm sora-ui/src/utils/storageManager.ts
rm sora-ui/src/utils/backendHistorySync.ts
rm sora-ui/src/services/business/history.service.ts
```

Also check `sora-ui/src/utils/storage/` for `indexedDBStorage` or similar files. If they exist and are only imported by `history.service.ts`, delete them too:

```bash
rg -l "indexedDBStorage" sora-ui/src/ --type ts --type tsx
# If only history.service.ts imports it, delete the indexedDB files
```

- [ ] **Step 4: Search for localStorage key writes to clean up**

```bash
rg -n "taskRecovery|sora-history-|sora-deleted-task-ids|thumbnailBase64" sora-ui/src/ --type ts --type tsx
```

Remove any remaining references. These localStorage keys should no longer be read or written anywhere.

- [ ] **Step 5: Verify build succeeds**

Run: `cd sora-ui && npx tsc --noEmit --pretty 2>&1 | head -30`
Then: `cd sora-ui && npm run build 2>&1 | tail -20`
Expected: Both pass with no import errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: delete deprecated localStorage history files + clean TaskToken type

Removed files:
- taskTokenManager.ts (localStorage recovery)
- storageManager.ts (per-day localStorage/Electron storage)
- backendHistorySync.ts (bidirectional sync logic)
- history.service.ts (IndexedDB + RxJS layer)
- indexedDBStorage (if applicable)

Cleaned TaskToken: removed thumbnailBase64 field.

~800 lines of local persistence code eliminated.
Server API is now the single source of truth."
```

---

## Task 10: Smoke Test Full Flow

- [ ] **Step 1: Start dev server**

```bash
cd sora-ui && npm run dev
```

- [ ] **Step 2: Verify history loads from API**

Open browser DevTools Network tab. Navigate to the app. Verify:
- `GET /api/video/tasks` is called on startup
- History items appear in the UI
- Console shows `[App] 🔄 从服务端加载历史记录...`
- No `localStorage.getItem('taskRecovery')` calls in Application tab

- [ ] **Step 3: Verify SSE updates work**

Trigger a new video generation. Verify:
- Task appears with `generating` status
- Progress updates in real-time
- Completes and shows video/image
- No console errors about `taskTokenManager`

- [ ] **Step 4: Verify delete works**

Delete a task from history. Verify:
- Task disappears from UI immediately
- `DELETE /api/video/tasks/:id` called in Network tab
- Refresh page → task stays deleted

- [ ] **Step 5: Verify page refresh recovery**

Refresh the page during a generating task. Verify:
- Generating tasks reappear (loaded from API with status=PROCESSING)
- SSE reconnects and resumes updates

- [ ] **Step 6: Verify localStorage is clean**

In DevTools → Application → Local Storage, verify:
- No `taskRecovery` key
- No `sora-history-*` keys
- No `sora-deleted-task-ids` key
- Only `zustand-persist` and minimal UI preferences remain
