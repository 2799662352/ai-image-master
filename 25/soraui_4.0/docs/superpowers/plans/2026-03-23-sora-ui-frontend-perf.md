# Sora UI 前端性能优化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the progressive performance degradation in sora-ui after 1-2 hours of use by eliminating localStorage serialization storms, unnecessary re-renders, and memory leaks.

**Architecture:** Debounced write-back for localStorage persistence; thumbnails offloaded to Tencent Cloud COS with imageMogr2; Zustand selectors to prevent cascade re-renders; SSE change detection to skip no-op state updates.

**Tech Stack:** React 18, TypeScript, Zustand 5, Vite 5, Tencent Cloud COS (S3-compatible), SSE (EventSource)

**Spec:** `docs/superpowers/specs/2026-03-23-sora-ui-frontend-perf-design.md`

---

## File Structure

| Action | File | Responsibility |
|--------|------|---------------|
| Modify | `src/utils/taskTokenManager.ts` | Add `scheduleSave()` debounced write, strip `thumbnailBase64` on write |
| Modify | `src/types/taskToken.ts` | Add `thumbnailUrl` field, update `extractToken()` to stop copying `thumbnailBase64` |
| Modify | `src/App.tsx` | Remove hot-path `updateTask()` calls, add change detection in SSE handler, fix duplicate Ctrl+S, wire `scheduleSave()` |
| Modify | `src/hooks/useSSE.ts` | Zustand selector fix |
| Modify | `src/components/TaskCard.tsx` | Use `thumbnailUrl` priority over `thumbnailBase64` |
| Modify | `src/components/VideoHistory.tsx` | Remove `useMemoryLifecycle`, fix `observedIdsRef`/`loadedImagesRef` cleanup |
| Create | `sora-ui-backend/src/routes/cosThumbnail.ts` | Lightweight COS thumbnail upload endpoint |
| Modify | `sora-ui-backend/src/app.ts` | Register new route |

---

## Task 1: `taskTokenManager` — 写入防抖 (P0-1)

**Files:**
- Modify: `src/utils/taskTokenManager.ts`

- [ ] **Step 1: Add `scheduleSave()` with 1s debounce to `TaskTokenManager`**

In `src/utils/taskTokenManager.ts`, add a debounce timer and `scheduleSave` method:

```typescript
private _saveTimer: ReturnType<typeof setTimeout> | null = null;
private _pendingTokens: TaskToken[] | null = null;

scheduleSave(tokens: TaskToken[]): void {
  this._pendingTokens = tokens;
  if (this._saveTimer) {
    clearTimeout(this._saveTimer);
  }
  this._saveTimer = setTimeout(() => {
    if (this._pendingTokens) {
      this._writeToStorage(this._pendingTokens);
      this._pendingTokens = null;
    }
    this._saveTimer = null;
  }, 1000);
}

flushSave(): void {
  if (this._saveTimer) {
    clearTimeout(this._saveTimer);
    this._saveTimer = null;
  }
  if (this._pendingTokens) {
    this._writeToStorage(this._pendingTokens);
    this._pendingTokens = null;
  }
}

private _writeToStorage(tokens: TaskToken[]): void {
  try {
    const stripped = tokens.map(t => {
      const { thumbnailBase64, ...rest } = t;
      return rest;
    });
    window.localStorage[STORAGE_KEY] = JSON.stringify(stripped);
    this.logger.info('Flushed', stripped.length, 'tokens to localStorage');
  } catch (error: any) {
    this.logger.error('Failed to flush tokens:', error.message);
  }
}
```

- [ ] **Step 2: Update `saveTasks()` to also strip `thumbnailBase64`**

In the existing `saveTasks()` method, replace line 107:
```typescript
// Before:
window.localStorage[STORAGE_KEY] = JSON.stringify(tokens);

// After:
this._writeToStorage(tokens);
```

- [ ] **Step 3: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add src/utils/taskTokenManager.ts
git commit -m "perf: add debounced localStorage write-back to taskTokenManager"
```

---

## Task 2: `extractToken` — 停止复制 `thumbnailBase64`，新增 `thumbnailUrl` (P0-2a)

**Files:**
- Modify: `src/types/taskToken.ts`

- [ ] **Step 1: Add `thumbnailUrl` field to `TaskToken` interface**

In `src/types/taskToken.ts`, add after line 78 (`thumbnailBase64`):
```typescript
  /** 缩略图 COS URL（替代 thumbnailBase64，永久有效） */
  thumbnailUrl?: string;
```

- [ ] **Step 2: Update `extractToken()` to pass `thumbnailUrl` and stop copying `thumbnailBase64`**

In `extractToken()`, change line 135:
```typescript
// Before:
thumbnailBase64: task.thumbnailBase64,

// After:
thumbnailUrl: task.thumbnailUrl,
```

- [ ] **Step 3: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`
Expected: May show warnings about `thumbnailBase64` references — these will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/types/taskToken.ts
git commit -m "perf: add thumbnailUrl field, stop persisting thumbnailBase64 in token"
```

---

## Task 3: 后端 COS 缩略图上传路由 (P0-2b)

**Files:**
- Create: `sora-ui-backend/src/routes/cosThumbnail.ts`
- Modify: `sora-ui-backend/src/app.ts`

- [ ] **Step 1: Create COS thumbnail upload route**

Create `sora-ui-backend/src/routes/cosThumbnail.ts`:

```typescript
import express, { Request, Response } from 'express';
import { authMiddleware } from '../middleware/auth';
import { parseBase64, uploadAsset, buildThumbnailUrl } from '../services/assetStorageService';

const router = express.Router();
router.use(authMiddleware);

router.post('/thumbnail', async (req: Request, res: Response) => {
  try {
    const userId = (req as any).user?.id;
    if (!userId) return res.status(401).json({ success: false, message: '未授权' });

    const { taskId, base64Data } = req.body;
    if (!taskId || !base64Data) {
      return res.status(400).json({ success: false, message: '缺少 taskId 或 base64Data' });
    }

    const { buffer, mime } = parseBase64(base64Data);
    const result = await uploadAsset(buffer, mime, userId);

    res.json({
      success: true,
      data: {
        url: result.url,
        thumbnailUrl: buildThumbnailUrl(result.url, 200, 200),
        cosKey: result.cosKey,
      },
    });
  } catch (error: any) {
    console.error('[CosThumbnail] 上传失败:', error.message);
    res.status(500).json({ success: false, message: error.message });
  }
});

export default router;
```

- [ ] **Step 2: Register route in app.ts**

In `sora-ui-backend/src/app.ts`, find where routes are registered and add:
```typescript
import cosThumbnailRoutes from './routes/cosThumbnail';
// ... in the route registration section:
app.use('/api/cos', cosThumbnailRoutes);
```

- [ ] **Step 3: Verify backend builds**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui-backend && npm run build`
Expected: No TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add sora-ui-backend/src/routes/cosThumbnail.ts sora-ui-backend/src/app.ts
git commit -m "feat: add COS thumbnail upload endpoint with imageMogr2"
```

---

## Task 4: 前端 Remix 缩略图改为 COS 上传 (P0-2c)

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Replace Canvas thumbnail with COS upload in Remix handler**

In `src/App.tsx`, find the Remix thumbnail generation block (around line 2108-2140). Replace the Canvas-based code with COS upload:

```typescript
// 🔥 如果有参考图，上传到 COS 获取 thumbnailUrl
if (referenceImage) {
  try {
    const { token: authToken } = useAuthStore.getState();
    if (authToken) {
      const response = await backendAPI.post('/api/cos/thumbnail', {
        taskId: remixGeneration.id,
        base64Data: referenceImage,
      }, authToken);
      if (response.success && response.data?.thumbnailUrl) {
        (remixGeneration as any).thumbnailUrl = response.data.thumbnailUrl;
        setThumbnail(remixGeneration.id, response.data.thumbnailUrl);
        console.log('[App] 🎨 Remix 缩略图已上传到 COS');
      }
    }
  } catch (thumbnailError) {
    console.error('[App] 🎨 Remix 缩略图上传失败（不阻塞）:', thumbnailError);
  }
}
```

Note: Need to check if `backendAPI.post` exists or use `axios` directly. Check the existing API pattern in `src/api/backend-api.ts`.

- [ ] **Step 2: Remove old Canvas thumbnail code**

Delete the old `new Image()` → `canvas.drawImage()` → `canvas.toDataURL()` block and the `(remixGeneration as any).thumbnailBase64 = thumbnail` assignment.

- [ ] **Step 3: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/App.tsx
git commit -m "perf: upload Remix thumbnails to COS instead of inline base64"
```

---

## Task 5: TaskCard 使用 `thumbnailUrl` (P0-2d)

**Files:**
- Modify: `src/components/TaskCard.tsx`

- [ ] **Step 1: Update thumbnail resolution logic**

In `src/components/TaskCard.tsx` line 127, change:

```typescript
// Before:
const refThumbnail = item.thumbnailBase64 || getThumbnail(item.id) || item.referenceImageThumbnail;

// After:
const refThumbnail = item.thumbnailUrl || getThumbnail(item.id) || item.referenceImageThumbnail;
```

- [ ] **Step 2: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/components/TaskCard.tsx
git commit -m "perf: prefer thumbnailUrl over thumbnailBase64 in TaskCard"
```

---

## Task 6: SSE 变化检测 + 移除热路径 `updateTask` (P0-1 + P0-4)

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Add change detection in SSE `onTaskUpdate` handler**

In `src/App.tsx`, in the `setTaskTokens(prev => { ... })` updater inside `onTaskUpdate` (around line 306), after finding the matching task at `index`, add a change detection guard before creating the new array:

```typescript
const oldToken = prev[index];
const hasChange =
  oldToken.status !== mappedStatus ||
  oldToken.progress !== (progress || oldToken.progress) ||
  oldToken.video_url !== (videoUrl || oldToken.video_url) ||
  oldToken.image_url !== (imageUrl || oldToken.image_url) ||
  oldToken.error !== (error || oldToken.error);

if (!hasChange) {
  return prev;
}
```

Insert this check right after line 345 (`const oldStatus = prev[index].status;`) and before line 349 (`const newTokens = [...prev];`).

- [ ] **Step 2: Remove `taskTokenManager.updateTask()` for generating status**

In `src/App.tsx` line 414-420, remove or comment out the generating-status write:

```typescript
// Before (line 414-420):
} else {
  // 🔥 生成中状态也同步到 localStorage（保持状态一致）
  taskTokenManager.updateTask(newTokens[index].id, {
    status: mappedStatus,
    progress: progress || newTokens[index].progress,
  }).catch(console.error);
}

// After:
} else {
  // 🔥 perf: generating 状态不再立即写 localStorage，由 scheduleSave 延迟批量写入
  taskTokenManager.scheduleSave(newTokens);
}
```

- [ ] **Step 3: Wire `scheduleSave` for completed/error/cancelled paths too**

After line 390 (`taskTokenManager.updateTask(...)` for completed status), add:
```typescript
taskTokenManager.scheduleSave(newTokens);
```

Keep the existing `updateTask()` call for completed/error/cancelled as the immediate persist path — but also schedule a full save so the array stays in sync.

- [ ] **Step 4: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 5: Commit**

```bash
git add src/App.tsx
git commit -m "perf: add SSE change detection, debounce generating-status localStorage writes"
```

---

## Task 7: Zustand selector 修复 (P0-3)

**Files:**
- Modify: `src/hooks/useSSE.ts`
- Modify: `src/App.tsx`

- [ ] **Step 1: Fix `useSSE.ts` — use selector for token**

In `src/hooks/useSSE.ts` line 40, change:

```typescript
// Before:
const { token } = useAuthStore();

// After:
const token = useAuthStore(state => state.token);
```

- [ ] **Step 2: Fix `ImpersonationBanner` — use `useShallow`**

In `src/App.tsx`, add import:
```typescript
import { useShallow } from 'zustand/react/shallow';
```

In `ImpersonationBanner` component (line 183), change:

```typescript
// Before:
const { isImpersonating, user, stopImpersonation } = useAuthStore();

// After:
const { isImpersonating, user, stopImpersonation } = useAuthStore(
  useShallow(state => ({
    isImpersonating: state.isImpersonating,
    user: state.user,
    stopImpersonation: state.stopImpersonation,
  }))
);
```

- [ ] **Step 3: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 4: Commit**

```bash
git add src/hooks/useSSE.ts src/App.tsx
git commit -m "perf: add Zustand selectors to prevent unnecessary re-renders"
```

---

## Task 8: P1 资源泄漏修复

**Files:**
- Modify: `src/App.tsx`
- Modify: `src/components/VideoHistory.tsx`

- [ ] **Step 1: Fix `processedEventsRef` — change to Map with TTL**

In `src/App.tsx` line 224, change:
```typescript
// Before:
const processedEventsRef = useRef<Set<string>>(new Set());

// After:
const processedEventsRef = useRef<Map<string, number>>(new Map());
```

Update all usages:
- `.has(eventKey)` stays the same (Map has `.has()`)
- `.add(eventKey)` → `.set(eventKey, Date.now())`
- Replace the cleanup block (lines 921-924) with:
```typescript
if (processedEventsRef.current.size > 100) {
  const now = Date.now();
  const fiveMinutesAgo = now - 5 * 60 * 1000;
  for (const [key, timestamp] of processedEventsRef.current) {
    if (timestamp < fiveMinutesAgo) {
      processedEventsRef.current.delete(key);
    }
  }
}
```

- [ ] **Step 2: Fix `recoveredTasksRef` — clear when no generating tasks**

In `src/App.tsx`, in the 60-second URL check interval (around line 844), add at the start of `checkMissingUrls`:
```typescript
const generatingTokens = taskTokensRef.current.filter(t => t.status === 'generating');
if (generatingTokens.length === 0) {
  recoveredTasksRef.current.clear();
  return;
}
```

- [ ] **Step 3: Remove duplicate Ctrl+S handler**

Delete `src/App.tsx` lines 1254-1266 (the second `useEffect` with `handleSaveAll` keydown listener). Keep the first one at lines 565-581.

- [ ] **Step 4: Remove `useMemoryLifecycle` from VideoHistory**

In `src/components/VideoHistory.tsx`:
- Remove the import at line 15: `import { useMemoryLifecycle } from '../hooks/useMemoryLifecycle';`
- Remove the hook call at lines 295-299: `useMemoryLifecycle({ ... });`

- [ ] **Step 5: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 6: Commit**

```bash
git add src/App.tsx src/components/VideoHistory.tsx
git commit -m "fix: clean up resource leaks — bounded event dedup, clear stale refs, remove dead code"
```

---

## Task 9: P1 定时器 Page Visibility 优化

**Files:**
- Modify: `src/App.tsx`

- [ ] **Step 1: Wrap 60s URL checker and 5min autosave with visibility guard**

In `src/App.tsx`, for the 60-second `setInterval` (line 895) and the 5-minute `setInterval` (line 1273), add at the start of each callback:
```typescript
if (document.hidden) return;
```

- [ ] **Step 2: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/App.tsx
git commit -m "perf: skip timers when page is hidden (Page Visibility API)"
```

---

## Task 10: 首次部署迁移 — strip 现有 thumbnailBase64

**Files:**
- Modify: `src/utils/taskTokenManager.ts`

- [ ] **Step 1: Add migration logic in `recoverTasks()`**

In `taskTokenManager.ts` `recoverTasks()` method, after parsing tokens (line 122), add:

```typescript
const hasThumbnails = tokens.some(t => t.thumbnailBase64);
if (hasThumbnails) {
  this.logger.info('Migrating thumbnailBase64 to memory cache...');
  const { setThumbnail } = await import('./thumbnailCache');
  tokens.forEach(t => {
    if (t.thumbnailBase64) {
      setThumbnail(t.id, t.thumbnailBase64);
    }
  });
  this._writeToStorage(tokens);
  this.logger.info('Migration complete — thumbnailBase64 stripped from localStorage');
}
```

Note: `_writeToStorage` already strips `thumbnailBase64`.

- [ ] **Step 2: Verify build passes**

Run: `cd d:\tecx\text\25\soraui_4.0\sora-ui && npm run build`

- [ ] **Step 3: Commit**

```bash
git add src/utils/taskTokenManager.ts
git commit -m "feat: one-time migration strips thumbnailBase64 from localStorage on first load"
```

---

## Verification Checklist

After all tasks are complete:

- [ ] Open DevTools → Application → Local Storage → check `taskRecovery` size (should be < 500KB for 500 tasks)
- [ ] Open DevTools → Performance → record 5 minutes of SSE activity → check Long Tasks (>50ms) count
- [ ] Open DevTools → Memory → take heap snapshot at T=0 and T=2h → compare growth
- [ ] Verify thumbnails display correctly for Remix tasks (from COS URL)
- [ ] Verify thumbnails show placeholder for non-Remix tasks (expected behavior)
- [ ] Verify Ctrl+S only triggers one save handler
- [ ] Verify page background tab doesn't run URL checker or autosave
