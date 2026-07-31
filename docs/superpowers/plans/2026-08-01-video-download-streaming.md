# 视频下载流式化 Implementation Plan（Phase 1）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把上游生成视频的落盘从「整个文件读进内存」改为流式写盘 + 完整性校验 + 原子落位，同时修掉一个正在生效的数据丢失 bug。

**Architecture:** 新增一个专责的 `videoDownload.ts`，把「流式下载到 `.part` → 校验字节数 → 原子 rename」封成一个函数，`client.ts` 只负责调用与重试，`runtime.ts` 改成按路径 ingest 与流式转存。不引入任何新依赖，不使用 Electron 的 `DownloadItem`（放弃理由见设计文档）。

**Tech Stack:** Electron 43.2.0 的 `net.request`、Node `stream/promises` 的 `pipeline`、Vitest。

设计依据：`docs/superpowers/specs/2026-07-31-electron-43-upgrade-and-streaming-downloads-design.md`

## 为什么这件事比「省内存」更紧急

`AttachmentService` 对两种入参有不同的体积上限：

```
export const MAX_PATH_ATTACHMENT_BYTES = 2 * 1024 * 1024 * 1024   // 2GB
const MAX_BUFFER_ATTACHMENT_BYTES = 100 * 1024 * 1024             // 100MB
```

而 `persistVideo` 现在传的是 `buffer`。**任何超过 100MB 的视频，今天就会落盘失败** —— `ingest` 抛 `Attachment ... is too large`，`persistVideo` 失败，任务标记 `persistence: 'failed'`，本地和 COS 都没有副本，只剩上游会过期的地址。这不是理论风险，是一个正在生效的数据丢失路径。

改成传 `path` 后上限抬到 2GB，顺带把内存占用从 O(文件大小)×2 降到 O(1)。

## Global Constraints

- **不引入任何新依赖。**
- **不使用 `DownloadItem` / `createInterruptedDownload`。** 业界五个对标项目无一使用，且存在「退出时删半成品」「缺 `lastModified` 静默从 0 重下」等结构性问题，完整理由见设计文档的「为什么放弃 DownloadItem」一节。
- **不设整体超时，只设空闲超时。** 五个对标项目（VS Code、electron-updater、Signal、Joplin、Logseq）无一对下载设整体超时。整体超时会在慢网下误杀 GB 级文件，且这种失败在测试环境（小文件、快网）永远复现不出来。
- **继续用 `net.request` 而非 `net.fetch`。** 上游视频代理会在 `Content-Disposition` 里塞中文文件名，`net.fetch` 走 undici 的 Headers（要求 Latin1 ByteString）会抛 TypeError，且该异常发生在 Electron 内部回调里 → 变 uncaughtException 被吞掉、Promise 永不 settle。对应 issue `electron/electron#42244`，官方已确认、至今 open、43 未修。
- 每个 Task 结束即提交，提交信息用中文，遵循 `type(scope): 描述` 风格。
- `typecheck:ci` 债务门禁必须 0 新增。

---

## File Structure

| 文件 | 责任 |
| --- | --- |
| `src/main/services/seedance/videoDownload.ts`（**新建**） | 流式下载到 `.part`、空闲超时、Content-Length 校验、原子 rename（含 EBUSY 重试）、孤儿清理。这是本阶段唯一有实质逻辑的文件 |
| `src/main/services/seedance/__tests__/videoDownload.test.ts`（**新建**） | 上述全部行为的单测 |
| `src/main/services/seedance/client.ts` | `downloadVideo` 返回类型从 `Buffer` 改为文件路径；删掉 `downloadViaNetRequest` |
| `src/main/services/seedance/runtime.ts` | `persistVideo` 改为按 path ingest + `relayFileToCos`；启动时清理孤儿 `.part` |
| `src/main/services/seedance/__tests__/client.test.ts` | 跟随 `downloadVideo` 的签名变化 |

---

## Task 1: 流式下载到 `.part`，空闲超时

**Files:**
- Create: `src/main/services/seedance/videoDownload.ts`
- Create: `src/main/services/seedance/__tests__/videoDownload.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `downloadToFile(url: string, destPath: string, opts?: DownloadToFileOptions): Promise<DownloadToFileResult>`，其中
  `DownloadToFileOptions = { idleTimeoutMs?: number; net?: Pick<typeof import('electron').net, 'request'> }`，
  `DownloadToFileResult = { path: string; bytes: number }`。Task 2 会在此基础上加校验与 rename，Task 3 由 `runtime.ts` 消费。

- [ ] **Step 1: 写失败的测试**

创建 `src/main/services/seedance/__tests__/videoDownload.test.ts`：

```ts
// @vitest-environment node
//
// 视频落盘是一条**失败后果不可逆**的路径：落盘失败等于本地和 COS 都没有副本，
// 只剩上游会过期的地址，而且没有第二轮补救。所以这里的每条断言都在守一个
// 具体的丢数据场景，不是形式主义。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { Readable } from 'node:stream'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

/** 造一个行为像 Electron IncomingMessage 的假响应。 */
function fakeResponse(chunks: Buffer[], opts: { status?: number; contentLength?: number } = {}) {
  const readable = Readable.from(chunks) as Readable & {
    statusCode?: number
    headers?: Record<string, string | string[]>
  }
  readable.statusCode = opts.status ?? 200
  readable.headers = opts.contentLength != null ? { 'content-length': String(opts.contentLength) } : {}
  return readable
}

/** 造一个行为像 net.request 返回值的假请求。 */
function fakeNet(response: unknown) {
  const request = new EventEmitter() as EventEmitter & { end: () => void; abort: () => void }
  request.end = () => {
    setImmediate(() => request.emit('response', response))
  }
  request.abort = () => {
    setImmediate(() => request.emit('abort'))
  }
  return { request: () => request, _request: request }
}

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'vd-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
  vi.useRealTimers()
})

describe('downloadToFile — 流式落盘', () => {
  it('把分块响应完整写进 .part，不在内存里聚合', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const body = [Buffer.from('hello '), Buffer.from('world')]
    const net = fakeNet(fakeResponse(body, { contentLength: 11 }))

    const res = await downloadToFile('https://x/v.mp4', dest, { net })

    expect(res.bytes).toBe(11)
    expect(await fs.readFile(res.path, 'utf8')).toBe('hello world')
  })

  it('非 2xx 直接失败，且不留下 .part', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('nope')], { status: 404 }))

    await expect(downloadToFile('https://x/v.mp4', dest, { net })).rejects.toThrow(/404/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  it('传输中途出错时清理 .part —— 半截文件比没有文件更危险', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'out.mp4')
    const broken = new Readable({
      read() {
        this.push(Buffer.from('partial'))
        this.destroy(new Error('socket hang up'))
      },
    }) as Readable & { statusCode?: number; headers?: Record<string, string> }
    broken.statusCode = 200
    broken.headers = {}
    const net = fakeNet(broken)

    await expect(downloadToFile('https://x/v.mp4', dest, { net })).rejects.toThrow(/socket hang up/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })
})
```

- [ ] **Step 2: 跑测试确认它失败**

```powershell
npx vitest run src/main/services/seedance/__tests__/videoDownload.test.ts
```

Expected: FAIL，报 `Cannot find module '../videoDownload'`。

- [ ] **Step 3: 写最小实现**

创建 `src/main/services/seedance/videoDownload.ts`：

```ts
// 上游生成视频的落盘。
//
// 这条路径的失败后果不可逆：落盘失败意味着本地和 COS 都没有副本，只剩上游那条
// 一天后过期的地址，而且没有第二轮补救。所以它比一般的下载多做三件事：写临时
// 文件、校验字节数、原子落位。
//
// 为什么不用 Electron 的 DownloadItem：业界五个对标项目（VS Code、Signal、
// Joplin、Logseq、electron-updater）无一使用，且它会在应用退出时删掉半成品文件、
// 缺 lastModified 时静默从 0 重下。完整理由见
// docs/superpowers/specs/2026-07-31-electron-43-upgrade-and-streaming-downloads-design.md

import { createWriteStream } from 'node:fs'
import fs from 'node:fs/promises'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { net as electronNet } from 'electron'

/**
 * 空闲超时：**60 秒没有收到任何新字节**才判超时。
 *
 * 刻意不设整体超时。对标的五个项目无一对下载设整体超时 —— GB 级文件在慢网下会被
 * 整体超时误杀，而这种失败在测试环境（小文件、快网）永远复现不出来。Joplin 的注释
 * 说得最直白：「60s is per-socket-idle, not total」。
 */
const IDLE_TIMEOUT_MS = 60_000

export interface DownloadToFileOptions {
  idleTimeoutMs?: number
  /** 测试注入点；生产走 Electron 的 net。 */
  net?: { request: (url: string) => unknown }
}

export interface DownloadToFileResult {
  path: string
  bytes: number
}

/**
 * 流式下载到 `<destPath>.part`。成功返回 `.part` 的路径与字节数；失败清理残留。
 *
 * ⚠️ 必须用 net.request 而非 net.fetch：上游视频代理会在响应头里塞 prompt 派生的
 * 中文文件名，net.fetch 走 undici 的 Headers（要求 Latin1 ByteString）会抛
 * TypeError，且该异常发生在 Electron 内部回调里 → 变 uncaughtException 被吞掉，
 * Promise 永不 settle。见 electron/electron#42244（官方已确认，至今 open，43 未修）。
 */
export async function downloadToFile(
  url: string,
  destPath: string,
  options: DownloadToFileOptions = {},
): Promise<DownloadToFileResult> {
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS
  const netImpl = options.net ?? electronNet
  const partPath = `${destPath}.part`

  const request = netImpl.request(url) as {
    on: (event: string, cb: (arg?: unknown) => void) => void
    end: () => void
    abort: () => void
  }

  const response = await new Promise<
    NodeJS.ReadableStream & { statusCode?: number; headers?: unknown }
  >((resolve, reject) => {
    request.on('response', (res) => resolve(res as never))
    request.on('error', (e) => reject(e instanceof Error ? e : new Error(String(e))))
    request.end()
  })

  const status = response.statusCode ?? 0
  if (status < 200 || status >= 300) {
    response.resume?.()
    throw new Error(`video download failed: HTTP ${status}`)
  }

  let received = 0
  let idleTimer: NodeJS.Timeout | undefined
  let timedOut = false

  const armIdle = (): void => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      timedOut = true
      try {
        request.abort()
      } catch {
        /* SDK 内部可能已经清理 */
      }
    }, idleTimeoutMs)
    idleTimer.unref?.()
  }

  // 用 Transform 而不是 response.on('data') 来喂看门狗：挂 'data' 监听会把流切到
  // flowing 模式，和 pipeline 抢数据。
  const watchdog = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      received += chunk.byteLength
      armIdle()
      cb(null, chunk)
    },
  })

  armIdle()
  try {
    await pipeline(response, watchdog, createWriteStream(partPath))
  } catch (e) {
    await fs.unlink(partPath).catch(() => undefined)
    if (timedOut) {
      throw new Error(`video download stalled: no data for ${Math.round(idleTimeoutMs / 1000)}s`)
    }
    throw e instanceof Error ? e : new Error(String(e))
  } finally {
    if (idleTimer) clearTimeout(idleTimer)
  }

  return { path: partPath, bytes: received }
}
```

- [ ] **Step 4: 跑测试确认通过**

```powershell
npx vitest run src/main/services/seedance/__tests__/videoDownload.test.ts
```

Expected: 3 passed。

- [ ] **Step 5: 补空闲超时的测试**

在 `describe('downloadToFile — 流式落盘')` 之后追加：

```ts
describe('downloadToFile — 空闲超时', () => {
  it('长时间无数据才超时；持续缓慢但有数据不超时', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'slow.mp4')

    // 一个「每 30ms 吐一小块、共 5 块」的慢速流。空闲阈值设 100ms：
    // 每块都会重置看门狗，所以全程不该超时。
    let n = 0
    const slow = new Readable({
      read() {
        if (n >= 5) return void this.push(null)
        n += 1
        setTimeout(() => this.push(Buffer.from('x')), 30)
      },
    }) as Readable & { statusCode?: number; headers?: Record<string, string> }
    slow.statusCode = 200
    slow.headers = {}

    const res = await downloadToFile('https://x/v.mp4', dest, {
      net: fakeNet(slow),
      idleTimeoutMs: 100,
    })
    expect(res.bytes).toBe(5)
  })

  it('彻底停流则超时，并清理 .part', async () => {
    const { downloadToFile } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'stall.mp4')

    // 吐一块之后再也不吐，也不 end —— 模拟半开连接。
    const stalled = new Readable({ read() {} }) as Readable & {
      statusCode?: number
      headers?: Record<string, string>
    }
    stalled.statusCode = 200
    stalled.headers = {}
    stalled.push(Buffer.from('start'))

    const net = fakeNet(stalled)
    // abort 时让流以错误结束，模拟 Electron abort 的效果。
    const pending = downloadToFile('https://x/v.mp4', dest, { net, idleTimeoutMs: 50 })
    setTimeout(() => stalled.destroy(new Error('aborted')), 120)

    await expect(pending).rejects.toThrow(/stalled|aborted/)
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })
})
```

- [ ] **Step 6: 跑测试**

```powershell
npx vitest run src/main/services/seedance/__tests__/videoDownload.test.ts
```

Expected: 5 passed。若「慢速流」那条超时了，说明看门狗没有在每个 chunk 上重置，回到 Step 3 检查 `watchdog` 的 `transform` 是否调了 `armIdle()`。

- [ ] **Step 7: 提交**

```powershell
git add src/main/services/seedance/videoDownload.ts src/main/services/seedance/__tests__/videoDownload.test.ts
git commit -m "feat(seedance): 视频下载改流式落盘,超时改为空闲判定"
```

---

## Task 2: Content-Length 校验与原子落位

**Files:**
- Modify: `src/main/services/seedance/videoDownload.ts`
- Modify: `src/main/services/seedance/__tests__/videoDownload.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `downloadToFile`
- Produces: `downloadVideoToDisk(url: string, destPath: string, opts?: DownloadToFileOptions): Promise<string>` —— 下载、校验、rename，返回**最终路径**。Task 3 消费这个函数而不是 `downloadToFile`。

- [ ] **Step 1: 写失败的测试**

追加到测试文件：

```ts
describe('downloadVideoToDisk — 校验与原子落位', () => {
  it('校验通过后才 rename；下载过程中最终路径不存在', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'ok.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('0123456789')], { contentLength: 10 }))

    const finalPath = await downloadVideoToDisk('https://x/v.mp4', dest, { net })

    expect(finalPath).toBe(dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('0123456789')
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  // 这条守的是最阴险的一种坏数据：连接中途断开，落盘的文件大小合法、看起来
  // 「下载好了」，下游任何靠「文件存在」判断就绪的逻辑都会直接吃进去。
  it('字节数与 content-length 不符时判失败并删掉 .part', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'trunc.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('012345')], { contentLength: 100 }))

    await expect(downloadVideoToDisk('https://x/v.mp4', dest, { net })).rejects.toThrow(
      /incomplete|6.*100/i,
    )
    await expect(fs.access(dest)).rejects.toThrow()
    await expect(fs.access(dest + '.part')).rejects.toThrow()
  })

  it('上游不给 content-length 时跳过校验，不因此判失败', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'nolen.mp4')
    const net = fakeNet(fakeResponse([Buffer.from('abc')]))

    expect(await downloadVideoToDisk('https://x/v.mp4', dest, { net })).toBe(dest)
    expect(await fs.readFile(dest, 'utf8')).toBe('abc')
  })

  it('空响应体判失败 —— 0 字节的 mp4 是坏数据不是成功', async () => {
    const { downloadVideoToDisk } = await import('../videoDownload')
    const dest = path.join(tmpDir, 'empty.mp4')
    const net = fakeNet(fakeResponse([]))

    await expect(downloadVideoToDisk('https://x/v.mp4', dest, { net })).rejects.toThrow(/empty/i)
  })
})

describe('renameWithRetry — Windows 上杀软会锁住刚落盘的大文件', () => {
  it('EBUSY 时重试，最终成功', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    const from = path.join(tmpDir, 'a.part')
    const to = path.join(tmpDir, 'a.mp4')
    await fs.writeFile(from, 'data')

    let calls = 0
    const rename = vi.fn(async (f: string, t: string) => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
      await fs.rename(f, t)
    })

    await renameWithRetry(from, to, { rename, delayMs: 0 })

    expect(calls).toBe(3)
    expect(await fs.readFile(to, 'utf8')).toBe('data')
  })

  it('非 EBUSY 错误立刻抛出，不空转', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    const rename = vi.fn(async () => {
      throw Object.assign(new Error('EACCES'), { code: 'EACCES' })
    })

    await expect(
      renameWithRetry('/x/a.part', '/x/a.mp4', { rename, delayMs: 0 }),
    ).rejects.toThrow(/EACCES/)
    expect(rename).toHaveBeenCalledTimes(1)
  })

  // 并发/重试场景下另一次调用可能已经把文件放好了，这时报错是错的。
  it('rename 失败但目标已存在时按成功处理', async () => {
    const { renameWithRetry } = await import('../videoDownload')
    const from = path.join(tmpDir, 'b.part')
    const to = path.join(tmpDir, 'b.mp4')
    await fs.writeFile(to, 'already there')

    const rename = vi.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    })

    await renameWithRetry(from, to, { rename, delayMs: 0 })
    expect(await fs.readFile(to, 'utf8')).toBe('already there')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/main/services/seedance/__tests__/videoDownload.test.ts
```

Expected: 新增的 7 条 FAIL（`downloadVideoToDisk is not a function` / `renameWithRetry is not a function`），Task 1 的 5 条仍 PASS。

- [ ] **Step 3: 实现校验与原子落位**

在 `videoDownload.ts` 末尾追加：

```ts
/**
 * rename 的重试次数与间隔。
 *
 * Windows 上杀毒软件会扫描刚落盘的大文件并短暂锁住句柄，rename 撞 EBUSY 是常态
 * 而非异常 —— 我们落的是 GB 级视频，撞上的概率不低。口径照 electron-updater
 * （60 次 × 500ms，只对 EBUSY 重试）。
 */
const RENAME_ATTEMPTS = 60
const RENAME_DELAY_MS = 500

export interface RenameWithRetryOptions {
  attempts?: number
  delayMs?: number
  rename?: (from: string, to: string) => Promise<void>
}

export async function renameWithRetry(
  from: string,
  to: string,
  options: RenameWithRetryOptions = {},
): Promise<void> {
  const attempts = options.attempts ?? RENAME_ATTEMPTS
  const delayMs = options.delayMs ?? RENAME_DELAY_MS
  const doRename = options.rename ?? ((f, t) => fs.rename(f, t))

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await doRename(from, to)
      return
    } catch (e) {
      // 目标已经在了 —— 可能是另一次调用抢先完成的，这种情况报错是错的。
      const landed = await fs
        .access(to)
        .then(() => true)
        .catch(() => false)
      if (landed) {
        await fs.unlink(from).catch(() => undefined)
        return
      }
      const code = (e as { code?: string })?.code
      if (code !== 'EBUSY' || attempt === attempts) throw e
      await new Promise((resolve) => setTimeout(resolve, delayMs))
    }
  }
}

/**
 * 下载 → 校验 → 原子落位。返回最终路径。
 *
 * 校验只比对 Content-Length，不做 checksum。业界的分界线是「下载物会不会被
 * 执行/安装」：会的全都校验（electron-updater sha512、Signal sha512+Ed25519、
 * VS Code 更新包 sha256），纯内容数据普遍不做。我们下的是视频内容，属于后者；
 * 而且上游未必给 hash，字节数比对不依赖上游配合，成本几乎为零，能抓住绝大多数
 * 截断场景。
 */
export async function downloadVideoToDisk(
  url: string,
  destPath: string,
  options: DownloadToFileOptions = {},
): Promise<string> {
  const { path: partPath, bytes, declaredBytes } = await downloadToFile(url, destPath, options)

  const fail = async (message: string): Promise<never> => {
    await fs.unlink(partPath).catch(() => undefined)
    throw new Error(message)
  }

  if (bytes === 0) await fail('video download produced an empty file')
  if (declaredBytes != null && declaredBytes !== bytes) {
    await fail(`video download incomplete: got ${bytes} bytes, expected ${declaredBytes}`)
  }

  await renameWithRetry(partPath, destPath)
  return destPath
}
```

同时修改 `downloadToFile`，把响应头里的 content-length 带出来。先在文件里加一个响应头取值助手（Electron 的 `IncomingMessage.headers` 的值可能是数组）：

```ts
function headerValue(headers: unknown, name: string): string | undefined {
  const raw = (headers as Record<string, string | string[]> | undefined)?.[name]
  if (Array.isArray(raw)) return raw[0]
  return typeof raw === 'string' ? raw : undefined
}
```

扩展返回类型：

```ts
export interface DownloadToFileResult {
  path: string
  bytes: number
  /** 上游声明的字节数；上游没给就是 undefined。 */
  declaredBytes?: number
}
```

并在 `downloadToFile` 的 return 之前解析它：

```ts
  const declared = Number(headerValue(response.headers, 'content-length'))
  return {
    path: partPath,
    bytes: received,
    ...(Number.isFinite(declared) && declared > 0 ? { declaredBytes: declared } : {}),
  }
```

- [ ] **Step 4: 跑测试**

```powershell
npx vitest run src/main/services/seedance/__tests__/videoDownload.test.ts
```

Expected: 12 passed。

- [ ] **Step 5: 提交**

```powershell
git add src/main/services/seedance/videoDownload.ts src/main/services/seedance/__tests__/videoDownload.test.ts
git commit -m "feat(seedance): 落盘前校验字节数,rename 扛 Windows 的 EBUSY"
```

---

## Task 3: 接进 client 与 persistVideo

这一步才真正兑现收益：内存占用降到 O(1)，以及**修掉超过 100MB 的视频必然落盘失败的 bug**。

**Files:**
- Modify: `src/main/services/seedance/client.ts:33`（接口签名）、`:179-195`（`downloadVideo`）、`:198-225`（删除 `downloadViaNetRequest`）
- Modify: `src/main/services/seedance/runtime.ts:313-335`（`persistVideo`）
- Modify: `src/main/services/seedance/__tests__/client.test.ts`

**Interfaces:**
- Consumes: Task 2 的 `downloadVideoToDisk`
- Produces: `SeedanceClient.downloadVideo(videoUrl: string, destPath: string): Promise<string>`（返回最终文件路径，不再是 Buffer）

- [ ] **Step 1: 改接口与实现**

`client.ts` 的 `SeedanceClient` 接口：

```ts
  /** 下载到 destPath，返回最终文件路径。落盘失败会抛错。 */
  downloadVideo: (videoUrl: string, destPath: string) => Promise<string>
```

`downloadVideo` 实现改为：

```ts
  async downloadVideo(videoUrl, destPath) {
    // 三次尝试、退避 3s / 6s 岔开。岔开是关键：原本两次尝试间隔为零，一次几秒的
    // 抖动会把它们一起吃掉，而这条路径没有第二轮 —— 落盘失败就意味着本地和 COS
    // 都没有副本，只剩会过期的上游地址。
    //
    // 这一层是**编排层**重试：传输层的重试只覆盖建连阶段，一旦响应流开始，传到
    // 800MB 时断线是兜不住的。所以必须在外面整个重来 —— 每次重试都从零开始写
    // .part（createWriteStream 默认 'w' 模式会截断上一次的残留），不会拼出坏文件。
    return retryDownload(() => downloadVideoToDisk(videoUrl, destPath), {
      attempts: 3,
      delayMs: 3_000,
    })
  },
```

删掉整个 `downloadViaNetRequest` 函数（原 `:198-225`）以及不再使用的 `net` 导入（确认 `client.ts` 里没有其他地方用 `net`——`arkRequest` 用的是 `net.fetch`，**所以 `net` 导入要保留**）。

在文件顶部加导入：

```ts
import { downloadVideoToDisk } from './videoDownload'
```

- [ ] **Step 2: 改 `persistVideo`**

`runtime.ts` 的 `persistVideo` 改为：

```ts
    persistVideo: async (task) => {
      const name = `seedance-${task.model.replace('.', '_')}-${task.taskId.slice(-8)}.mp4`
      const tmpDir = path.join(app.getPath('userData'), 'agent', 'downloads')
      await fs.mkdir(tmpDir, { recursive: true })
      const destPath = path.join(tmpDir, `${randomUUID()}-${name}`)

      const filePath = await seedanceClient.downloadVideo(task.videoUrl!, destPath)
      try {
        // 按 path 而非 buffer 交给 ingest：buffer 路径的上限是 100MB
        // (MAX_BUFFER_ATTACHMENT_BYTES)，path 路径是 2GB —— 超过 100MB 的视频
        // 走 buffer 会直接 ingest 失败，本地和 COS 都留不下副本。
        const [saved] = await attachments.ingest(task.threadId ?? FALLBACK_THREAD_ID, [
          { name, mime: 'video/mp4', path: filePath },
        ])
        if (!saved) throw new Error('seedance persist: attachment ingest produced no file')

        // 转存到历史桶（COS）拿永久 https URL —— 聊天气泡 / 历史记录用它做持久
        // 来源，重启后不会因上游代理地址过期或本地文件清理而丢失。上传失败不致命：
        // 本地 mp4 仍在，降级用 file:// 路径。
        let remoteUrl: string | undefined
        try {
          const stat = await fs.stat(filePath)
          remoteUrl = await relayFileToCos(filePath, 'video/mp4', { fileSize: stat.size })
        } catch (e) {
          console.warn('[seedance] video COS upload failed, falling back to local path:', e)
        }
        return { localPath: saved.localPath, remoteUrl }
      } finally {
        // ingest 已经把内容拷进 attachments 目录，这份临时副本不必留。
        await fs.unlink(filePath).catch(() => undefined)
      }
    },
```

确认 `runtime.ts` 顶部已有 `fs`（`node:fs/promises`）、`path`、`randomUUID`、`app` 的导入（`downloadAsset` 已经在用），并把 `relayBufferToCos` 的导入换成 `relayFileToCos`（若 `relayBufferToCos` 在该文件其他地方仍被使用则两个都留）。

- [ ] **Step 3: 改 client 的既有测试**

`__tests__/client.test.ts` 里凡是调用 `seedanceClient.downloadVideo` 的地方补第二个参数。若没有针对它的用例，则本步无改动——用 grep 确认：

```powershell
rg -n "downloadVideo" src/main/services/seedance/__tests__/
```

- [ ] **Step 4: 跑受影响的测试与类型检查**

```powershell
npx vitest run src/main/services/seedance/
npm run typecheck:ci
```

Expected: seedance 目录全绿；typecheck 债务门禁 0 新增。**如果 `taskManager` 的测试因为 `downloadVideo` 签名变化而失败，说明它 mock 了这个方法——按新签名更新 mock，不要改生产代码去迁就 mock。**

- [ ] **Step 5: 提交**

```powershell
git add src/main/services/seedance/client.ts src/main/services/seedance/runtime.ts src/main/services/seedance/__tests__/
git commit -m "fix(seedance): 视频按路径落盘,修超过 100MB 必然丢片的问题"
```

---

## Task 4: 启动时清理孤儿 `.part`

崩溃、断电、进程被杀都会留下 `.part` 残留，不清理会一直占磁盘。VS Code 在启动和取消时都会扫缓存目录删 `.tmp`。

**Files:**
- Modify: `src/main/services/seedance/videoDownload.ts`
- Modify: `src/main/services/seedance/__tests__/videoDownload.test.ts`
- Modify: `src/main/services/seedance/runtime.ts`（在 runtime 初始化处调用一次）

**Interfaces:**
- Consumes: 无
- Produces: `cleanupOrphanParts(dir: string): Promise<number>` —— 返回删除的文件数

- [ ] **Step 1: 写失败的测试**

```ts
describe('cleanupOrphanParts', () => {
  it('删掉残留的 .part，不动别的文件', async () => {
    const { cleanupOrphanParts } = await import('../videoDownload')
    await fs.writeFile(path.join(tmpDir, 'a.mp4.part'), 'x')
    await fs.writeFile(path.join(tmpDir, 'b.mp4.part'), 'y')
    await fs.writeFile(path.join(tmpDir, 'keep.mp4'), 'z')

    expect(await cleanupOrphanParts(tmpDir)).toBe(2)
    expect(await fs.readdir(tmpDir)).toEqual(['keep.mp4'])
  })

  it('目录不存在时安静返回 0，不抛错 —— 清理失败不该拖垮启动', async () => {
    const { cleanupOrphanParts } = await import('../videoDownload')
    expect(await cleanupOrphanParts(path.join(tmpDir, 'nope'))).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

```powershell
npx vitest run src/main/services/seedance/__tests__/videoDownload.test.ts
```

Expected: 新增 2 条 FAIL。

- [ ] **Step 3: 实现**

追加到 `videoDownload.ts`：

```ts
/**
 * 清掉目录里残留的 `.part`。崩溃/断电/进程被杀都会留下它们，不清理会一直占磁盘。
 *
 * 任何失败都吞掉：这是启动路径上的清理动作，它自己出问题不该拖垮应用启动。
 */
export async function cleanupOrphanParts(dir: string): Promise<number> {
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return 0
  }
  let removed = 0
  for (const entry of entries) {
    if (!entry.endsWith('.part')) continue
    try {
      await fs.unlink(path.join(dir, entry))
      removed += 1
    } catch {
      /* 被占用等情况，下次启动再说 */
    }
  }
  return removed
}
```

需要在 `videoDownload.ts` 顶部补 `import path from 'node:path'`。

- [ ] **Step 4: 在 runtime 初始化处调用**

在 `runtime.ts` 里注册 seedance 相关 handler 的初始化流程中（`registerMain('generate_video', ...)` 之前）加：

```ts
  // 清掉上次异常退出留下的半截下载。失败不影响启动。
  void cleanupOrphanParts(path.join(app.getPath('userData'), 'agent', 'downloads')).then(
    (n) => {
      if (n > 0) console.log(`[seedance] 清理了 ${n} 个残留的 .part 文件`)
    },
    () => undefined,
  )
```

- [ ] **Step 5: 跑测试与类型检查**

```powershell
npx vitest run src/main/services/seedance/
npm run typecheck:ci
```

Expected: 全绿，14 条 videoDownload 用例通过。

- [ ] **Step 6: 提交**

```powershell
git add src/main/services/seedance/videoDownload.ts src/main/services/seedance/runtime.ts src/main/services/seedance/__tests__/videoDownload.test.ts
git commit -m "feat(seedance): 启动时清理残留的 .part 下载文件"
```

---

## Task 5: 全量验证与 PR

**Files:** 无代码改动。

- [ ] **Step 1: 全量测试与类型检查**

```powershell
pnpm run test:run
npm run typecheck:ci
```

Expected: 全绿；typecheck 0 新增。已知 flaky：`src/renderer/src/services/pipeline/__tests__/` 下的 DirectorPipeline 用例在机器负载高时会超时，单独重跑通过即可。

- [ ] **Step 2: 构建**

```powershell
pnpm run build:vite
```

Expected: 成功。

- [ ] **Step 3: 真机验证一次真实出片**

这是唯一无法自动化的一步：在应用里跑一次视频生成，确认视频能正常落盘、气泡能播放、历史里能看到。

Expected: 正常出片。同时到 `<userData>/agent/downloads` 看一眼**没有 `.part` 残留**。

- [ ] **Step 4: 开 PR**

正文需包含：改了哪几处、为什么不用 DownloadItem（一句话 + 指向设计文档）、**特别点出「修掉了超过 100MB 视频必然落盘失败」这个正在生效的 bug**、以及 Step 3 的真机验证记录。

---

## 回滚

四个 Task 的改动集中在 `videoDownload.ts`（新文件）、`client.ts`、`runtime.ts` 三处，无数据迁移、无配置变更。回滚即 revert PR。

已落盘的视频不受影响——它们已经通过 `attachments.ingest` 进了 attachments 目录，与本次改动的临时文件机制无关。
