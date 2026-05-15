# Attachment ingestion: streaming + path-only + DB process isolation

- Status: draft → in implementation
- Owner: catimation agent team
- Bug ref: 拖入 2 个长文档 → `agent:send-message` 报 `PrismaClientKnownRequestError: ... Server has closed the connection`
- Related prior art:
  - OpenAI Codex #13508 — 大附件冻结 Codex Desktop（同症状）
  - OpenAI Codex #15270 — Windows 3.6 MB JPEG 卡死（说明问题在 I/O 阻塞模型，非文件大小）
  - OpenAI Codex PR #21108 — 官方修复：保持 "path-based attachment contract"，bytes 走流式 staging
  - PGlite 官方多 worker 模式文档（`@electric-sql/pglite/worker`）
  - Electron `utilityProcess` + `webUtils.getPathForFile` 文档

## Goal

让"拖入 N 个大文件（≤100MB/单，≤250MB/总）"不再卡死主进程、不再让 PGlite socket 被饿死、不再让 Prisma 报 `Server has closed the connection`。

## Root cause

`AttachmentService.ingest()` 当前对每个附件干 3 件同步阻塞活：

1. `fs.readFile(path)` → 整个文件灌进 Node Buffer，heap 暴涨
2. `crypto.createHash('sha256').update(buffer).digest('hex')` → 同步 NAPI 全量哈希，event loop 全停
3. `Promise.all(attachments.map(...))` → 并行做 1+2，N 个大文件同时挤 heap

PGlite 作为 `PGLiteSocketServer` 跑在**主进程同线程**（`db.ts: startEmbeddedPGlite`）。主进程 event loop 卡几百 ms 后，Prisma wire 心跳超时 → `connection lost` → `Server has closed the connection`。

**DB 不是真的挂了，是被饿死的。**

Renderer 端两条附件路径不对称：

| 入口 | 行为 | 风险 |
|---|---|---|
| File Explorer `onDrop` | 只传 `path` ✅ | OK |
| 点 `+ Add references or files` `onFileChange` | `file.arrayBuffer()` 全量读 + IPC structuredClone ❌ | OOM |

## Non-goals

- 不做服务端 staging upload（Codex PR #21108 那套 SFTP）—— 我们是 in-process，没必要
- 不引入新的附件契约 —— 路径模型已经对，保持
- 不改 100MB 单文件 / 250MB 总量上限
- 不改 DB schema

## Design

### Phase A — 主进程流式 ingest（必做，单独可解决报错）

#### A.1 `AttachmentService.ingest()` 改成流式 + 串行

```ts
async ingest(threadId, attachments) {
  if (!attachments.length) return []
  if (attachments.length > MAX_ATTACHMENTS) throw ...

  const dir = path.join(app.getPath('userData'), 'agent', 'uploads')
  await fs.mkdir(dir, { recursive: true })

  const results = []
  for (const attachment of attachments) {
    try {
      results.push(await this.ingestOne(threadId, attachment, dir))
      // yield event loop so PGlite socket + Codex backend get air
      await new Promise((r) => setImmediate(r))
    } catch (err) {
      // Per-attachment error isolation: skip this file, don't kill the turn
      this.emit('attachment-error', { name: attachment.name, error: err.message })
    }
  }
  return results
}

private async ingestOne(threadId, attachment, dir) {
  // 1. Size preflight via stat (avoid reading entire file first)
  if (attachment.path) {
    const stat = await fs.stat(attachment.path)
    if (!stat.isFile()) throw new Error(...)
    if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error('too large')
  } else if (attachment.buffer) {
    if (attachment.buffer.byteLength > MAX_ATTACHMENT_BYTES) throw new Error('too large')
  }

  // 2. Stream source → sha256 + temp file in one pipeline
  const source = attachment.path
    ? fs.createReadStream(attachment.path, { highWaterMark: 64 * 1024 })
    : Readable.from(Buffer.from(attachment.buffer))
  const hasher = crypto.createHash('sha256')
  const tmpPath = path.join(dir, `_tmp_${crypto.randomUUID()}${ext}`)
  const writer = fs.createWriteStream(tmpPath)

  source.on('data', (chunk) => hasher.update(chunk))
  await pipeline(source, writer)

  // 3. Rename to <sha>.ext (content-addressed); if exists, just delete tmp
  const sha = hasher.digest('hex')
  const finalPath = path.join(dir, `${sha}${ext}`)
  try { await fs.rename(tmpPath, finalPath) }
  catch { await fs.unlink(tmpPath).catch(() => {}) }

  // 4. DB metadata only (unchanged)
  return this.prisma.agentAttachment.create({ data: {...} })
}
```

要点：
- **64KB chunk**：哈希和 write 都流式 yield，主进程 event loop 每 chunk 后能喂 PGlite socket
- **per-file try/catch + emit('attachment-error')**：单文件失败 → 跳过、上报 renderer 显示 chip，不杀整个 turn
- **`await setImmediate()` 每文件后**：显式 yield，给 PGlite socket / Codex backend 喘气
- **串行**：N 个大文件不再并发挤 heap（用户体感几乎没差，因为同样是磁盘 I/O bound）
- **content-addressed rename**：保持 `<sha>.ext` 去重语义不变

#### A.2 Renderer 端附件错误显示

`store.ts` 加 `attachmentErrors: Record<string, string>`，订阅 `agent-event` 中的 `attachment-error`。`MentionInput` 在 ref chip 上叠红色 ⚠ + tooltip 显示原因 + "移除"按钮。

#### A.3 Feature flag

环境变量 `CATIMATION_ATTACHMENT_STREAM_INGEST` 控制（默认 `1`，可热修关掉走老路径）。

### Phase B — Renderer "path-only"（picker 也不读 buffer）

#### B.1 Preload 暴露 `webUtils.getPathForFile`

```ts
// src/preload/index.ts
import { contextBridge, webUtils } from 'electron'

contextBridge.exposeInMainWorld('electronAPI', {
  // ...existing...
  webUtils: {
    getPathForFile: (file: File): string => {
      try { return webUtils.getPathForFile(file) }
      catch { return '' }
    },
  },
})
```

#### B.2 `MentionInput.onFileChange` 改用 path

```ts
async function onFileChange(event) {
  const files = Array.from(event.target.files ?? [])
  for (const file of files.slice(0, remainingSlots)) {
    // Preflight by file.size (no arrayBuffer)
    if (file.size > MAX_ATTACHMENT_BYTES) { skipped++; continue }

    const filePath = window.electronAPI?.webUtils?.getPathForFile(file)
    if (filePath) {
      // Native picker — file is on disk, send path only
      addAttachment({ name: file.name, mime: file.type, size: file.size, path: filePath })
    } else {
      // Fallback (e.g. clipboard blob without path) — buffer route, but warn user
      const buffer = await file.arrayBuffer()
      addAttachment({ name: file.name, mime: file.type, size: file.size, buffer })
    }
  }
}
```

renderer 从此**只在罕见 fallback 情况下持有 buffer**。

### Phase C — PGlite 搬到 `utilityProcess`（防御深度）

#### C.1 新文件 `src/main/agent/pgliteWorker.ts`

```ts
// Runs in Electron utilityProcess. Owns PGlite + PGLiteSocketServer.
import { PGlite } from '@electric-sql/pglite'
import { PGLiteSocketServer } from '@electric-sql/pglite-socket'

process.parentPort.once('message', async ({ data }) => {
  const { dataDir, port } = data as { dataDir: string; port: number }
  const db = await PGlite.create(dataDir)
  const server = new PGLiteSocketServer({ db, host: '127.0.0.1', port })
  await server.start()
  process.parentPort.postMessage({ type: 'ready', port })

  process.parentPort.on('message', async ({ data: msg }) => {
    if (msg?.type === 'shutdown') {
      await server.stop()
      await db.close()
      process.exit(0)
    }
  })
})
```

#### C.2 `src/main/agent/db.ts` 用 `utilityProcess.fork`

```ts
import { utilityProcess } from 'electron'

let pgliteChild: ReturnType<typeof utilityProcess.fork> | null = null

export async function startEmbeddedPGlite(): Promise<string> {
  if (pgliteChild) return 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'

  const dataDir = path.join(app.getPath('userData'), 'pgdata')
  const workerPath = app.isPackaged
    ? path.join(process.resourcesPath, 'app.asar', 'dist', 'main', 'pgliteWorker.js')
    : path.join(__dirname, 'pgliteWorker.js')

  pgliteChild = utilityProcess.fork(workerPath, [], {
    serviceName: 'CatimationPGliteWorker',
    stdio: 'inherit',
  })

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('PGlite worker startup timeout')), 30_000)
    pgliteChild!.once('message', (msg) => {
      clearTimeout(timeout)
      if (msg?.type === 'ready') resolve()
      else reject(new Error('Unexpected PGlite worker msg'))
    })
    pgliteChild!.postMessage({ dataDir, port: 5433 })
  })

  return 'postgresql://postgres:postgres@127.0.0.1:5433/postgres'
}

export async function shutdownDatabase(): Promise<void> {
  await prisma?.$disconnect()
  if (pgliteChild) {
    pgliteChild.postMessage({ type: 'shutdown' })
    await new Promise<void>((r) => { pgliteChild!.once('exit', () => r()) })
    pgliteChild = null
  }
  prisma = null
}
```

#### C.3 `electron-builder.yml` 把 `dist/main/pgliteWorker.js` 也打包（已在 `dist/main` 全量纳入，无需额外配置）

要点：
- **`@electron/utilityProcess` 是官方推荐**：`docs/tutorial/process-model.md` 明确说 "should prefer the UtilityProcess API over Node.js child_process.fork"
- **MessagePort 双向通信**：`process.parentPort.postMessage` + `child.on('message')`
- **优雅退出**：`app.on('before-quit')` → `shutdownDatabase()` → worker `pg.close()` 落盘后 exit

## Verification

### A1. 单测（vitest）

`src/main/agent/__tests__/AttachmentService.streaming.test.ts`:

```ts
it('hashes file via stream (matches whole-buffer hash)', async () => {
  const tmp = await writeRandomFile(50 * 1024 * 1024) // 50MB
  const result = await service.ingest(threadId, [{ name: 'big.bin', mime: '...', size: 50*1024*1024, path: tmp }])
  expect(result[0].localPath).toMatch(/\/[a-f0-9]{64}\.bin$/)
  // hash matches reference
})

it('isolates per-attachment errors', async () => {
  const errors: string[] = []
  service.on('attachment-error', (e) => errors.push(e.name))
  const out = await service.ingest(threadId, [
    { name: 'ok.txt', path: validPath },
    { name: 'missing.txt', path: '/does/not/exist' },
    { name: 'ok2.txt', path: validPath2 },
  ])
  expect(out).toHaveLength(2)
  expect(errors).toEqual(['missing.txt'])
})

it('keeps event loop responsive during ingest', async () => {
  const lag = monitorEventLoopDelay()
  lag.enable()
  await service.ingest(threadId, [bigFile, bigFile, bigFile])
  lag.disable()
  // p99 lag < 50ms (vs >2s in the old impl)
  expect(lag.max).toBeLessThan(50 * 1e6) // ns
})
```

### A2. 集成

`src/main/agent/__tests__/AgentManager.attachments.integration.test.ts`：拖 2 个 80MB 文档 → 整轮 sendMessage 不抛 Prisma error，DB 里 2 行 AgentAttachment。

### A3. 手测

1. 启 dev (`npm run dev`)
2. 用 File Explorer 拖入 `long_text_*.md` x2
3. 看 console — 没 `Server has closed`，agent 正常响应
4. 用 + 号 picker 选 2 个大 markdown — 同样不爆
5. 故意拖一个不存在的路径（通过 dev tools 改 store）— 应当 chip 显示 ⚠ 并允许移除，agent 继续

## Rollback

- Phase A：`CATIMATION_ATTACHMENT_STREAM_INGEST=0` 环境变量回到老路径
- Phase B：`MentionInput.onFileChange` 检测 `webUtils.getPathForFile` 不存在自动回退 buffer
- Phase C：删 `pgliteChild` 那段、回到 `new PGlite(dataDir)` 同进程方式

## Implementation order

1. **Phase A**（半小时）→ 单独发版，足以解决 user-reported crash
2. **Phase B**（10 分钟）→ 顺手把 picker 优化掉
3. **Phase C**（1-2 小时）→ 防御深度
