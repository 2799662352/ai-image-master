# 宫格拆图残留问题修复计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 2 轮 code review 后残留的 6 个问题，消除 SDK 实例浪费、IPC 死锁、类型缺失等缺陷。

**Architecture:** COS/MPS client 改为 cache-and-invalidate 单例；`cancelAllActiveTasks` 补齐 reject；preload 类型引用共享 types；Zustand persist 加 migrate 占位。

**Tech Stack:** Electron 41, React 19, Zustand 5, cos-nodejs-sdk-v5, tencentcloud-sdk-nodejs-mps, electron-store 8

---

## 文件结构

| 文件 | 操作 | 职责变更 |
|------|------|----------|
| `src/main/services/storyboardSplit/cosClient.ts` | Modify | COS 实例缓存 + invalidate |
| `src/main/services/storyboardSplit/mpsClient.ts` | Modify | MPS client 缓存 + invalidate |
| `src/main/services/storyboardSplit/config.ts` | Modify | `setCredentials` 时触发 invalidate |
| `src/main/services/storyboardSplit/index.ts` | Modify | `cancelAllActiveTasks` reject 队列 Promise |
| `src/preload/index.ts` | Modify | 拆图 API 类型从 `any` 改为强类型 |
| `src/renderer/src/stores/useSplitPersistStore.ts` | Modify | 加 `migrate` 占位函数 |
| `src/renderer/src/pages-react/StoryboardSplitPage.tsx` | Modify | `createThumbnail` 加超时/reject |

---

### Task 1: COS 实例缓存 + credential invalidation

**Files:**
- Modify: `src/main/services/storyboardSplit/cosClient.ts`
- Modify: `src/main/services/storyboardSplit/config.ts`

**问题：** 每次调用 `uploadOriginal` 和 `getPresignedUrl` 都 `new COS()`。官方文档示例是创建一次实例后多次调用。同一个任务内至少创建 2 个实例（上传 + 签名），轮询期间每次也重建 MPS client。

**修复思路：** 缓存 COS 实例，凭证变更时 invalidate。

- [ ] **Step 1: 在 config.ts 加 invalidation 钩子**

```typescript
// src/main/services/storyboardSplit/config.ts
// 在文件顶部添加
type InvalidateCallback = () => void
const invalidateCallbacks: InvalidateCallback[] = []

export function onCredentialsInvalidated(cb: InvalidateCallback): void {
  invalidateCallbacks.push(cb)
}

// 修改 setCredentials 函数，末尾加 invalidation 通知
export function setCredentials(creds: Partial<Credentials>): void {
  const store = getCredentialStore()
  if (creds.secretId !== undefined) store.set('secretId', creds.secretId)
  if (creds.secretKey !== undefined) store.set('secretKey', creds.secretKey)
  if (creds.bucket !== undefined) store.set('bucket', creds.bucket)
  if (creds.region !== undefined) store.set('region', creds.region)
  invalidateCallbacks.forEach((cb) => cb())
}
```

- [ ] **Step 2: 改造 cosClient.ts 为缓存单例**

```typescript
// src/main/services/storyboardSplit/cosClient.ts
import { getCredentials, onCredentialsInvalidated } from './config'

let COS: any = null
let cosInstance: any = null

onCredentialsInvalidated(() => { cosInstance = null })

function getCosInstance() {
  if (!cosInstance) {
    const creds = getCredentials()
    if (!COS) COS = require('cos-nodejs-sdk-v5')
    cosInstance = new COS({
      SecretId: creds.secretId,
      SecretKey: creds.secretKey,
      Protocol: 'https:',
      Timeout: 120000,
    })
  }
  return cosInstance
}

// getBucketAndRegion, uploadOriginal, getPresignedUrl 保持不变
```

- [ ] **Step 3: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功，无报错

- [ ] **Step 4: Commit**

```bash
git add src/main/services/storyboardSplit/cosClient.ts src/main/services/storyboardSplit/config.ts
git commit -m "perf(split): cache COS instance, invalidate on credential change"
```

---

### Task 2: MPS client 缓存

**Files:**
- Modify: `src/main/services/storyboardSplit/mpsClient.ts`

**问题：** `getMpsClient()` 每次都 `new Client()`，轮询 60 次 = 60 个 client 实例。

- [ ] **Step 1: 改造 mpsClient.ts 为缓存单例**

```typescript
// src/main/services/storyboardSplit/mpsClient.ts
import { getCredentials, onCredentialsInvalidated } from './config'
import type { SplitConfig, SplitResult } from '../../../types/storyboardSplit'
import { getPresignedUrl } from './cosClient'

let MpsClientClass: any = null
let mpsInstance: any = null

onCredentialsInvalidated(() => { mpsInstance = null })

function getMpsClient() {
  if (!mpsInstance) {
    const creds = getCredentials()
    if (!MpsClientClass) {
      const sdk = require('tencentcloud-sdk-nodejs-mps')
      MpsClientClass = sdk.mps.v20190612.Client
    }
    mpsInstance = new MpsClientClass({
      credential: {
        secretId: creds.secretId,
        secretKey: creds.secretKey,
      },
      region: creds.region,
      profile: {
        signMethod: 'TC3-HMAC-SHA256',
        httpProfile: { reqMethod: 'POST', reqTimeout: 30 },
      },
    })
  }
  return mpsInstance
}

// submitProcessImage, pollUntilFinish 保持不变
```

- [ ] **Step 2: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/main/services/storyboardSplit/mpsClient.ts
git commit -m "perf(split): cache MPS client instance, invalidate on credential change"
```

---

### Task 3: cancelAllActiveTasks 补齐 reject

**Files:**
- Modify: `src/main/services/storyboardSplit/index.ts`

**问题：** `cancelAllActiveTasks()` 用 `queue.length = 0` 直接清空队列，但没有 reject 队列里的 Promise。这些 Promise 对应 `submitSplit` 里的 `await new Promise<void>()`，永远不会 settle，导致 `ipcMain.handle` 回调挂起，IPC 死锁。

- [ ] **Step 1: 修改 cancelAllActiveTasks**

```typescript
// src/main/services/storyboardSplit/index.ts
export function cancelAllActiveTasks() {
  for (const [, task] of activeTasks) {
    task.abortSignal.aborted = true
  }
  activeTasks.clear()
  while (queue.length > 0) {
    const item = queue.shift()!
    item.reject(new Error('All tasks cancelled'))
  }
}
```

- [ ] **Step 2: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/main/services/storyboardSplit/index.ts
git commit -m "fix(split): reject queued promises in cancelAllActiveTasks to prevent IPC deadlock"
```

---

### Task 4: Preload 拆图 API 强类型

**Files:**
- Modify: `src/preload/index.ts`

**问题：** 拆图相关的 5 个方法和 2 个事件监听全用 `any`，丢失了 `src/types/storyboardSplit.ts` 定义的类型安全。

- [ ] **Step 1: 导入类型并替换 any**

在 `src/preload/index.ts` 文件顶部的 import 区域添加：

```typescript
import type {
  SplitSubmitPayload,
  SplitConfig,
  SplitProgressEvent,
  SplitFinishedEvent,
  SplitFailedEvent,
  CredentialState,
} from '../types/storyboardSplit'
```

修改 `ElectronAPI` 接口中的拆图部分：

```typescript
  // 宫格拆图
  storyboardSplitSubmit: (payload: SplitSubmitPayload) => Promise<{ success: boolean; error?: string; errorCode?: string }>
  storyboardSplitCancel: (taskId: string) => Promise<{ success: boolean }>
  storyboardSplitGetConfig: () => Promise<{
    success: boolean
    defaults: SplitConfig
    credentials: CredentialState
  }>
  storyboardSplitSetCredentials: (creds: { secretId: string; secretKey: string; bucket: string; region: string }) => Promise<{ success: boolean }>
  storyboardSplitSetDefaults: (config: SplitConfig) => Promise<{ success: boolean }>
  onStoryboardSplitEvent: (callback: (channel: string, data: SplitProgressEvent | SplitFinishedEvent | SplitFailedEvent) => void) => void
  removeStoryboardSplitListeners: () => void
```

- [ ] **Step 2: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功。如果 preload 构建用的 tsconfig 不包含 `src/types`，可能需要用 `import type` 带相对路径。

- [ ] **Step 3: Commit**

```bash
git add src/preload/index.ts
git commit -m "refactor(split): replace any types with shared interfaces in preload API"
```

---

### Task 5: Zustand persist 加 migrate 占位

**Files:**
- Modify: `src/renderer/src/stores/useSplitPersistStore.ts`

**问题：** `version: 1` 已设置但没有 `migrate` 函数。当将来 v2 需要修改 schema 时，如果忘加 migrate，所有老数据会被 Zustand 丢弃。现在加一个空 migrate 作为扩展点。

- [ ] **Step 1: 添加 migrate 函数**

在 `persist` 配置的第二个参数中，`version: 1` 后添加：

```typescript
    {
      name: 'storyboard-split-storage',
      version: 1,
      migrate: (persisted: any, version: number) => {
        // v0 → v1: 初始版本，无需迁移
        return persisted
      },
      partialize: (state) => ({
        history: state.history.slice(0, MAX_HISTORY),
        defaultConfig: state.defaultConfig,
      }),
    }
```

- [ ] **Step 2: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/stores/useSplitPersistStore.ts
git commit -m "chore(split): add placeholder migrate function for Zustand persist"
```

---

### Task 6: createThumbnail 防挂起

**Files:**
- Modify: `src/renderer/src/pages-react/StoryboardSplitPage.tsx`

**问题：** `createThumbnail` 用 `new Promise((resolve) => { ... })` 但 `img.onload` 里的 `canvas` 操作如果抛异常（例如 canvas 安全限制），Promise 就永远不 resolve。加一个 try-catch 兜底。

- [ ] **Step 1: 加强 createThumbnail**

```typescript
async function createThumbnail(dataUrl: string): Promise<string> {
  if (!dataUrl) return ''
  return new Promise((resolve) => {
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        const MAX = 200
        let w = img.width, h = img.height
        if (w > h) { h = Math.round((h / w) * MAX); w = MAX }
        else { w = Math.round((w / h) * MAX); h = MAX }
        canvas.width = w
        canvas.height = h
        canvas.getContext('2d')!.drawImage(img, 0, 0, w, h)
        resolve(canvas.toDataURL('image/jpeg', 0.7))
      } catch {
        resolve('')
      }
    }
    img.onerror = () => resolve('')
    img.src = dataUrl
  })
}
```

- [ ] **Step 2: 验证构建**

Run: `npm run build:vite`
Expected: 构建成功

- [ ] **Step 3: Commit**

```bash
git add src/renderer/src/pages-react/StoryboardSplitPage.tsx
git commit -m "fix(split): guard createThumbnail against canvas errors"
```

---

## 执行顺序

Task 1 → Task 2 （有依赖：都用 config.ts 的 invalidation 钩子）
Task 3、Task 4、Task 5、Task 6 互相独立，可并行。

总计 6 个 task，预计 15-20 分钟完成。
