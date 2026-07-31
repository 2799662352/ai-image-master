# 图片抓取流式化 Implementation Plan（Phase 1.5）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `cos:enqueue-upload-from-url` 的 http(s) 分支从「整张图读进内存」改为流式落盘，并据此重新评估那道为防 buffer 堆积而设的并发闸门。

**Architecture:** 把 Phase 1 已经写好的「流式落 `.part` → 校验 → 原子 rename」抽成通用助手，图片路径复用它；COS 转存从 `uploadBufferToBucket` 换成已存在的 `uploadStreamToBucket`。中间那份 Buffer 彻底消失。

**Tech Stack:** Node `stream/promises`、全局 `fetch`（undici）、COS `sliceUploadFile`、Vitest。

设计依据：`docs/superpowers/specs/2026-07-31-electron-43-upgrade-and-streaming-downloads-design.md` 的「Phase 1.5」一节。

## 为什么做这件事

`src/main/index.ts:1874` 记着一次 P0 事故：

```
// P0 闪退修复: 先占并发槽位再 fetch/解码。修复前 N 个入队各自先
// 分配 30MB+ Buffer 再排队, N 份 30MB+ buffer 同时驻留主进程堆 → OOM。
```

当时的修法是加并发闸门 `MAX_CONCURRENT_UPLOADS_MAIN = 4`。那是止血不是根治——峰值内存仍是 `4 × 30MB × 2`（chunks 数组与 concat 出的新 Buffer 同时存在）约 240MB，而且代价是把上传串行到 4 路，批量出图的吞吐被它卡住。

流式之后峰值是 `4 × 64KB ≈ 256KB`，差三个数量级。**真正的收益兑现点是 Task 4 —— 回头放宽那道闸门。** 不做 Task 4 的话，这次改造只省了内存、没换来速度。

## Global Constraints

- **只改 `cos:enqueue-upload-from-url` 的 http(s) 分支。** `data:` 分支与 `cos:enqueue-upload-bytes`（`index.ts:2001`）手里本来就是 Buffer，流式没有意义，保持原样；`saveGeneratedImageLocally` 因此必须保留。
- **`fetchImageBytes` 的错误分类一条都不能丢**：403/404 立刻放弃、408/429/5xx 才重试、空响应体单独判失败。这是全仓库做得最细的一处。
- **必须用 `pipeline` 而非裸 `pipe` 或手动 `.on('data')` + `.write()`。** 后者不处理背压，队列会无限涨，那时流式比全量 buffer 更糟。
- 不引入新依赖。
- `typecheck:ci` 债务门禁 0 新增。
- 每个 Task 结束即提交，中文提交信息，`type(scope): 描述`。

## 分支基线

本阶段依赖 Phase 1 的 `videoDownload.ts`，**从 `feat/video-download-streaming` 分出**（PR #176）。#176 合入 main 后本分支 rebase 到 main 即可。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/main/utils/atomicFile.ts`（**新建**） | 从 `videoDownload.ts` 抽出的通用件：`renameWithRetry`、`cleanupOrphanParts`。两条下载路径共用 |
| `src/main/utils/__tests__/atomicFile.test.ts`（**新建**） | 上述的单测（从 `videoDownload.test.ts` 迁移相关用例） |
| `src/main/services/seedance/videoDownload.ts` | 改为从 `atomicFile` 导入并 re-export，行为不变 |
| `src/main/utils/fetchImageBytes.ts` | 新增流式变体 `fetchImageToFile`，保留原 `fetchImageBytes` 不动 |
| `src/main/utils/__tests__/fetchImageBytes.test.ts` | 新增流式变体的用例 |
| `src/main/index.ts` | `cos:enqueue-upload-from-url` 的 http(s) 分支改走流式；重新评估并发闸门 |

---

## Task 1: 抽出通用的原子落盘助手

纯重构，不改行为。目的是让图片路径能复用 Phase 1 已经写好且测试覆盖过的 rename 重试与孤儿清理，而不是复制一份。

**Files:**
- Create: `src/main/utils/atomicFile.ts`
- Create: `src/main/utils/__tests__/atomicFile.test.ts`
- Modify: `src/main/services/seedance/videoDownload.ts`
- Modify: `src/main/services/seedance/__tests__/videoDownload.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `renameWithRetry(from: string, to: string, options?: RenameWithRetryOptions): Promise<void>`、`cleanupOrphanParts(dir: string): Promise<number>`、`PART_SUFFIX = '.part'`

- [ ] **Step 1: 建新文件并搬运**

创建 `src/main/utils/atomicFile.ts`，把 `videoDownload.ts` 里的 `RENAME_ATTEMPTS`、`RENAME_DELAY_MS`、`RenameWithRetryOptions`、`renameWithRetry`、`cleanupOrphanParts` **原样搬过来**（含全部注释），文件头加：

```ts
// 「写临时文件 → 校验 → 原子落位」这套动作的通用件。
//
// 抽出来是因为视频落盘和图片落盘要用同一套语义:同样要扛 Windows 的 EBUSY、
// 同样要处理「rename 失败但目标已存在」、同样要在启动时清理崩溃残留。复制两份
// 的话,某天只修好其中一份的概率接近 1。

/** 下载中的临时文件后缀。两条路径必须一致,否则孤儿清理会漏。 */
export const PART_SUFFIX = '.part'
```

- [ ] **Step 2: `videoDownload.ts` 改为引用**

删掉搬走的那几段，改为：

```ts
import { PART_SUFFIX, renameWithRetry } from '../../utils/atomicFile'

// 视频侧的既有导入方还在用这两个名字,原样透出,避免无谓的调用点改动。
export { renameWithRetry, cleanupOrphanParts } from '../../utils/atomicFile'
```

并把 `downloadToFile` 里拼 `.part` 的地方改用 `PART_SUFFIX`：

```ts
  const partPath = `${destPath}${PART_SUFFIX}`
```

`cleanupOrphanParts` 的 `.endsWith('.part')` 同样改用 `PART_SUFFIX`。

- [ ] **Step 3: 迁移测试**

把 `videoDownload.test.ts` 里的 `describe('renameWithRetry …')` 与 `describe('cleanupOrphanParts')` 两块**整体搬到** `src/main/utils/__tests__/atomicFile.test.ts`，import 改为 `'../atomicFile'`，并带上文件头的 `// @vitest-environment node` 与 tmpDir 的 `beforeEach` / `afterEach`。

`videoDownload.test.ts` 保留其余用例。

- [ ] **Step 4: 验证行为未变**

```powershell
npx vitest run src/main/utils/__tests__/atomicFile.test.ts src/main/services/seedance/__tests__/videoDownload.test.ts
npm run typecheck:ci
```

Expected: 两个文件加起来仍是 17 条，全绿；typecheck 0 新增。**数量必须对得上——少一条就说明搬漏了。**

- [ ] **Step 5: 提交**

```powershell
git add src/main/utils/atomicFile.ts src/main/utils/__tests__/atomicFile.test.ts src/main/services/seedance/
git commit -m "refactor: 抽出通用的原子落盘助手,供视频与图片两条路径共用"
```

---

## Task 2: `fetchImageToFile` 流式变体

**Files:**
- Modify: `src/main/utils/fetchImageBytes.ts`
- Modify: `src/main/utils/__tests__/fetchImageBytes.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `renameWithRetry`、`PART_SUFFIX`
- Produces:
  ```ts
  export type FetchImageToFileResult =
    | { ok: true; path: string; bytes: number; contentType?: string }
    | { ok: false; error: string }

  export function fetchImageToFile(
    url: string,
    destPath: string,
    options?: FetchImageBytesOptions,
  ): Promise<FetchImageToFileResult>
  ```

- [ ] **Step 1: 写失败的测试**

追加到 `src/main/utils/__tests__/fetchImageBytes.test.ts`。先在文件顶部补需要的 import：

```ts
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
```

并造一个带流式 body 的假响应：

```ts
/** 造一个 body 为 web ReadableStream 的假响应,形状对齐 undici 的 Response。 */
function streamResponse(
  chunks: string[],
  opts: { status?: number; contentType?: string } = {},
): Response {
  const status = opts.status ?? 200
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? opts.contentType ?? null : null) },
    body: Readable.toWeb(Readable.from(chunks.map((c) => Buffer.from(c)))),
  } as unknown as Response
}
```

用例：

```ts
describe('fetchImageToFile — 流式落盘', () => {
  let tmpDir: string

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fi-test-'))
  })

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true })
  })

  it('流式写入并原子落位,带回 content-type', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'a.png')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse(['abc', 'de'], { contentType: 'image/webp' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, { fetchImpl, delayMs: 0 })

    expect(res).toMatchObject({ ok: true, path: dest, bytes: 5, contentType: 'image/webp' })
    expect(await fs.readFile(dest, 'utf8')).toBe('abcde')
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  // 错误分类必须与 fetchImageBytes 完全一致 —— 这是全仓库做得最细的一处,
  // 流式化不该把它冲淡。
  it('403 立刻放弃,不重试', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([], { status: 403 }))

    const res = await fetchImageToFile('https://cdn/a.png', path.join(tmpDir, 'b.png'), {
      fetchImpl,
      delayMs: 0,
    })

    expect(res).toEqual({ ok: false, error: 'fetch 403' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('503 重试,第二次成功', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'c.png')
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(streamResponse([], { status: 503 }))
      .mockResolvedValueOnce(streamResponse(['ok'], { contentType: 'image/png' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, { fetchImpl, delayMs: 0 })

    expect(res.ok).toBe(true)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('空响应体判失败,且不留下文件', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'd.png')
    const fetchImpl = vi.fn().mockResolvedValue(streamResponse([], { contentType: 'image/png' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, {
      fetchImpl,
      delayMs: 0,
      attempts: 1,
    })

    expect(res.ok).toBe(false)
    await expect(fs.access(dest)).rejects.toThrow()
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  it('传输中途出错时清理 .part,并按重试策略再来一次', async () => {
    const { fetchImageToFile } = await import('../fetchImageBytes')
    const dest = path.join(tmpDir, 'e.png')
    const brokenBody = Readable.toWeb(
      new Readable({
        read() {
          this.push(Buffer.from('half'))
          this.destroy(new Error('socket hang up'))
        },
      }),
    )
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'image/png' },
        body: brokenBody,
      } as unknown as Response)
      .mockResolvedValueOnce(streamResponse(['whole'], { contentType: 'image/png' }))

    const res = await fetchImageToFile('https://cdn/a.png', dest, { fetchImpl, delayMs: 0 })

    expect(res.ok).toBe(true)
    expect(await fs.readFile(dest, 'utf8')).toBe('whole')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/main/utils/__tests__/fetchImageBytes.test.ts
```

Expected: 新增 5 条 FAIL（`fetchImageToFile is not a function`），原有 7 条仍 PASS。

- [ ] **Step 3: 实现**

在 `fetchImageBytes.ts` 顶部补导入：

```ts
import { createWriteStream } from 'node:fs'
import fsp from 'node:fs/promises'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { PART_SUFFIX, renameWithRetry } from './atomicFile'
```

在文件末尾追加：

```ts
export type FetchImageToFileResult =
  | { ok: true; path: string; bytes: number; contentType?: string }
  | { ok: false; error: string }

/**
 * `fetchImageBytes` 的流式版本:边收边写盘,内存占用与图片大小无关。
 *
 * 为什么需要它:index.ts:1874 记着一次 P0 闪退 ——「N 份 30MB+ buffer 同时驻留
 * 主进程堆 → OOM」。当时靠并发闸门止血,这里是根治。
 *
 * 重试与错误分类**完全沿用** fetchImageBytes 的口径(403/404 立刻放弃、
 * 408/429/5xx 才重试、空响应体判失败),只把「攒 Buffer」换成「写文件」。
 * 判据在响应头阶段就完成,与 body 如何消费解耦,所以两者不会漂移。
 */
export async function fetchImageToFile(
  url: string,
  destPath: string,
  options: FetchImageBytesOptions = {},
): Promise<FetchImageToFileResult> {
  const { attempts = 3, timeoutMs = 30_000, delayMs = 1_000, fetchImpl = fetch } = options
  const partPath = `${destPath}${PART_SUFFIX}`
  let lastError = 'fetch failed'

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) await sleep(delayMs * 2 ** (attempt - 1))

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetchImpl(url, { signal: controller.signal })
      if (!response.ok) {
        lastError = `fetch ${response.status}`
        // 确定性失败:立刻交还结果,别让调用方白等两轮退避。
        if (!isRetryableStatus(response.status)) return { ok: false, error: lastError }
        continue
      }
      if (!response.body) {
        lastError = 'response has no body'
        continue
      }

      let received = 0
      const counter = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          received += chunk.byteLength
          cb(null, chunk)
        },
      })
      try {
        await pipeline(Readable.fromWeb(response.body as never), counter, createWriteStream(partPath))
      } catch (e) {
        await fsp.unlink(partPath).catch(() => undefined)
        lastError = e instanceof Error ? e.message : String(e)
        continue
      }

      if (received === 0) {
        await fsp.unlink(partPath).catch(() => undefined)
        lastError = 'empty body after fetch'
        continue
      }

      await renameWithRetry(partPath, destPath)
      const contentType = response.headers.get('content-type') ?? undefined
      return { ok: true, path: destPath, bytes: received, ...(contentType ? { contentType } : {}) }
    } catch (error) {
      await fsp.unlink(partPath).catch(() => undefined)
      lastError = error instanceof Error ? error.message : String(error)
    } finally {
      clearTimeout(timer)
    }
  }

  return { ok: false, error: lastError }
}
```

同时把 `Transform` 加进 `node:stream` 的导入。

- [ ] **Step 4: 跑测试**

```powershell
npx vitest run src/main/utils/__tests__/fetchImageBytes.test.ts
```

Expected: 12 passed（原 7 + 新 5）。

- [ ] **Step 5: 提交**

```powershell
git add src/main/utils/fetchImageBytes.ts src/main/utils/__tests__/fetchImageBytes.test.ts
git commit -m "feat(utils): fetchImageBytes 增加流式落盘变体,错误分类沿用原口径"
```

---

## Task 3: 接进 `cos:enqueue-upload-from-url`

**Files:**
- Modify: `src/main/index.ts:1873-1943`（http(s) 分支）

**Interfaces:**
- Consumes: Task 2 的 `fetchImageToFile`、既有的 `uploadStreamToBucket`
- Produces: 行为不变的 IPC 契约（`broadcastUploadResult` 的字段一个不改）

### 一个必须正面处理的行为回退

现在 `saveGeneratedImageLocally` 落盘失败是**非致命**的：catch 掉、返回 `undefined`、继续用内存里的 buffer 传 COS。用户最终仍能拿到 COS 地址，只是少了本地副本。

改成流式后没有内存副本，磁盘写不进去就等于什么都没有——**从「降级」变成「彻底失败」**。这是静默回退，必须处理。

处理方式：**只在错误明确是磁盘类时回落到原来的 buffer 路径**（`EACCES` / `ENOSPC` / `EROFS` / `EMFILE` / `ENAMETOOLONG`）。网络类失败不回落——`fetchImageToFile` 内部已经重试过，再走一遍 buffer 路径只是白费一轮。

- [ ] **Step 1: 先抽出路径生成（下一步要用）**

`saveGeneratedImageLocally` 里拼文件名的三行要被两处复用，抽成一个函数放在它上面：

```ts
/** 生成本地副本的落盘路径。流式与 buffer 两条路径共用,保证命名规则不漂移。 */
function generatedImagePath(requestId: string, mimeType: string): string {
  const safeId = requestId.replace(/[^a-zA-Z0-9_-]+/g, '-').slice(0, 64)
  const filename = `${Date.now()}-${safeId}-${randomBytes(4).toString('hex')}.${mimeTypeToExtension(mimeType)}`
  return path.join(imagesDir, filename)
}
```

`saveGeneratedImageLocally` 改为调用它：

```ts
    const filePath = generatedImagePath(requestId, mimeType)
    await fs.promises.writeFile(filePath, body)
    return filePath
```

- [ ] **Step 2: 改写 http(s) 分支**

把 `index.ts:1877-1932` 的 `try` 块改为：

```ts
        let localPath: string | undefined
        let mimeType: string
        let uploadedUrl: string
        let key: string

        if (sourceUrl.startsWith('data:')) {
          // data: 手里本来就是字节,流式没有意义,保持原路径。
          const m = /^data:([^;,]+);base64,(.+)$/i.exec(sourceUrl)
          if (!m) {
            broadcastUploadResult({ requestId, success: false, error: 'invalid data: URL' })
            return
          }
          mimeType = m[1] || hintMime || 'image/png'
          const body = Buffer.from(m[2], 'base64')
          if (body.byteLength === 0) {
            broadcastUploadResult({ requestId, success: false, error: 'empty body after decode' })
            return
          }
          localPath = await saveGeneratedImageLocally(requestId, body, mimeType)
          key = generateImageHistoryKey(mimeType)
          uploadedUrl = await uploadBufferToBucket({
            bucket: IMAGE_HISTORY_BUCKET,
            region: IMAGE_HISTORY_REGION,
            key,
            body,
            contentType: mimeType,
          })
        } else {
          // 先按 hint 猜扩展名定路径 —— 流式必须先有目标路径。真实 content-type
          // 在响应头到达后才知道,若与猜测不符,下面用 rename 纠正。
          mimeType = hintMime && hintMime.startsWith('image/') ? hintMime : mimeFromUrl(sourceUrl)
          const guessPath = generatedImagePath(requestId, mimeType)

          const fetched = await fetchImageToFile(sourceUrl, guessPath)
          if (!fetched.ok) {
            broadcastUploadResult({ requestId, success: false, error: fetched.error })
            return
          }

          // 响应头给了更准的类型就纠正文件名,否则历史里会出现 .png 装着 webp。
          const actual = fetched.contentType?.split(';')[0]?.trim()
          localPath = fetched.path
          if (actual && actual.startsWith('image/') && actual !== mimeType) {
            mimeType = actual
            const corrected = generatedImagePath(requestId, mimeType)
            await renameWithRetry(fetched.path, corrected)
            localPath = corrected
          }

          key = generateImageHistoryKey(mimeType)
          uploadedUrl = await uploadStreamToBucket({
            bucket: IMAGE_HISTORY_BUCKET,
            region: IMAGE_HISTORY_REGION,
            key,
            filePath: localPath,
            contentType: mimeType,
          })
        }

        void metadata
        broadcastUploadResult({ requestId, success: true, url: uploadedUrl, key, localPath })
```

- [ ] **Step 3: 加磁盘失败回落**

在上面 `else` 分支的 `fetchImageToFile` 调用外面包一层：

```ts
          const DISK_ERRORS = new Set(['EACCES', 'ENOSPC', 'EROFS', 'EMFILE', 'ENAMETOOLONG'])
          let fetched: Awaited<ReturnType<typeof fetchImageToFile>>
          try {
            fetched = await fetchImageToFile(sourceUrl, guessPath)
          } catch (e) {
            // 只有磁盘写不进去才回落 buffer 路径 —— 保住「本地落盘失败不影响
            // 上传」这条既有语义。网络类失败不回落:fetchImageToFile 内部已经
            // 重试过,再走一遍只是白费一轮。
            const code = (e as { code?: string })?.code
            if (!code || !DISK_ERRORS.has(code)) throw e
            console.warn('[cos-upload] 流式落盘失败,回落 buffer 路径:', code)
            const buffered = await fetchImageBytes(sourceUrl)
            if (!buffered.ok) {
              broadcastUploadResult({ requestId, success: false, error: buffered.error })
              return
            }
            mimeType = hintMime || buffered.contentType || mimeFromUrl(sourceUrl)
            key = generateImageHistoryKey(mimeType)
            uploadedUrl = await uploadBufferToBucket({
              bucket: IMAGE_HISTORY_BUCKET,
              region: IMAGE_HISTORY_REGION,
              key,
              body: buffered.body,
              contentType: mimeType,
            })
            broadcastUploadResult({ requestId, success: true, url: uploadedUrl, key })
            return
          }
```

- [ ] **Step 4: 补导入**

`index.ts:39` 那行 `import { fetchImageBytes } from './utils/fetchImageBytes'` 改为：

```ts
import { fetchImageBytes, fetchImageToFile } from './utils/fetchImageBytes'
import { renameWithRetry } from './utils/atomicFile'
```

**`uploadStreamToBucket` 目前没有被 `index.ts` 导入**（已确认），需要加到既有的 `./services/tencent/cosClient` 导入里。

- [ ] **Step 5: 验证**

```powershell
npm run typecheck:ci
pnpm run build:vite
npx vitest run src/main/utils/
```

Expected: typecheck 0 新增；构建通过；utils 测试全绿。

- [ ] **Step 6: 提交**

```powershell
git add src/main/index.ts
git commit -m "perf(cos): 图片抓取改流式落盘,COS 转存走分片上传"
```

---

## Task 4: 重新评估并发闸门

**这一步才是收益兑现。** 前三个 Task 只是把内存降下来；不动闸门的话，批量出图的吞吐仍被卡在 4 路。

**Files:**
- Modify: `src/main/index.ts:1704`（`MAX_CONCURRENT_UPLOADS_MAIN`）

- [ ] **Step 1: 确认闸门现在还挡着什么**

```powershell
rg -n "acquireUploadSlot" src/main/index.ts
```

逐个调用点核对：改造后哪些路径仍会持有大 Buffer？预期结果是——`cos:enqueue-upload-bytes`（IPC 传来的 ArrayBuffer，天然在内存里，有 64MB 闸门）和 `data:` 分支仍需要限流；http(s) 分支不再需要。

- [ ] **Step 2: 抬高上限并写明依据**

```ts
/**
 * 上传并发上限。
 *
 * 这个闸门原本是为了防「N 份 30MB+ buffer 同时驻留主进程堆 → OOM」而设的
 * (2026-07 的 P0 闪退)。http(s) 抓图改流式之后,那条路径的峰值内存与图片大小
 * 无关(约 64KB 的流缓冲),根因消失。
 *
 * 仍然保留闸门,是因为另外两条路径手里仍是完整 Buffer:`cos:enqueue-upload-bytes`
 * (IPC 传来的 ArrayBuffer,另有 64MB 闸门)与 `data:` 分支。按最坏情况估:
 * 12 × 64MB = 768MB 仍然过大,所以没有直接放开,而是抬到 12 —— 对批量出图
 * (主要走 http(s) 流式路径)是 3 倍吞吐,对 buffer 路径仍留有余量。
 *
 * ⚠️ 再往上调之前必须先实测 COS sliceUploadFile 在默认分片配置下的实际驻留量,
 * 那部分没有量过,不能纯推理。
 */
const MAX_CONCURRENT_UPLOADS_MAIN = 12
```

- [ ] **Step 3: 真机验证批量出图**

跑一次批量出图（≥8 张），观察：任务管理器里主进程内存峰值、以及出图总耗时是否有改善。

Expected: 内存峰值明显低于改造前；吞吐有可观察的提升。**把实测数字记进 PR** —— 没有数字的话，这个 Task 等于没有验收标准。

- [ ] **Step 4: 提交**

```powershell
git add src/main/index.ts
git commit -m "perf(cos): 流式化后上传并发上限从 4 抬到 12"
```

---

## Task 5: 全量验证与 PR

- [ ] **Step 1: 全量测试与类型检查**

```powershell
pnpm run test:run
npm run typecheck:ci
```

Expected: 全绿；0 新增。已知 flaky：`src/renderer/src/services/pipeline/__tests__/` 下的 DirectorPipeline 用例在负载高时超时，单独重跑通过即可。

- [ ] **Step 2: 开 PR**

正文需包含：为什么做（引用那段 P0 注释）、改了哪三处、**明确说明磁盘失败回落的设计**（这是唯一的行为变化）、Task 4 的实测数字、以及仍保留闸门的理由。

---

## 风险

| 风险 | 缓解 |
| --- | --- |
| 磁盘写失败从「降级」变「彻底失败」 | Task 3 Step 3 的磁盘错误回落 |
| content-type 与猜测的扩展名不符，历史里出现 `.png` 装着 webp | 响应头到达后用 rename 纠正文件名 |
| 全局 `fetch`（undici）遇到含中文的响应头抛 TypeError | 目前图片路径没报过此问题（视频那条是 `net.fetch` + `Content-Disposition`）。若出现，按视频的做法改用 `net.request`。**不预先改** —— 没有证据的改动只会扩大验证面 |
| 并发闸门抬太高导致 buffer 路径 OOM | 只抬到 12 而非放开；注释写明再调之前必须先实测 COS 分片驻留量 |
