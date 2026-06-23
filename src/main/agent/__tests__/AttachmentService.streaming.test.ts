import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import crypto from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (_kind: string) => tmpDir,
  },
}))

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-stream-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makePrismaStub() {
  const created: Array<{
    threadId: string
    originalName: string
    localPath: string
    mime: string
    size: number
  }> = []
  let nextId = 1
  return {
    created,
    agentAttachment: {
      async create({
        data,
      }: {
        data: {
          threadId: string
          originalName: string
          localPath: string
          mime: string
          size: number
        }
      }) {
        created.push(data)
        return { id: `att_${nextId++}`, uploadedAt: new Date(), ...data }
      },
    },
  }
}

/**
 * Reference: whole-buffer SHA256 of the bytes we wrote to disk. The streaming
 * implementation must produce the SAME hex.
 */
async function referenceSha256(filePath: string): Promise<string> {
  const buf = await fs.readFile(filePath)
  return crypto.createHash('sha256').update(buf).digest('hex')
}

describe('AttachmentService (streaming ingest)', () => {
  it('hashes a path-based attachment via stream and matches whole-buffer hash', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const srcPath = path.join(tmpDir, 'big.bin')
    const bytes = crypto.randomBytes(4 * 1024 * 1024 + 17) // 4MB + a tail to test partial chunks
    await fs.writeFile(srcPath, bytes)
    const expectedHash = await referenceSha256(srcPath)

    const out = await service.ingest('thread-A', [
      { name: 'big.bin', mime: 'application/octet-stream', size: bytes.byteLength, path: srcPath },
    ])

    expect(out).toHaveLength(1)
    expect(out[0].size).toBe(bytes.byteLength)
    expect(out[0].localPath.endsWith(`${expectedHash}.bin`)).toBe(true)

    // The on-disk file should have identical bytes (content-addressed storage).
    const actual = await fs.readFile(out[0].localPath)
    expect(actual.equals(bytes)).toBe(true)
  })

  it('hashes a buffer-based attachment via stream and matches whole-buffer hash', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const bytes = crypto.randomBytes(200 * 1024)
    const expectedHash = crypto.createHash('sha256').update(bytes).digest('hex')

    const out = await service.ingest('thread-B', [
      { name: 'inline.png', mime: 'image/png', size: bytes.byteLength, buffer: bytes.buffer },
    ])

    expect(out).toHaveLength(1)
    expect(out[0].localPath.endsWith(`${expectedHash}.png`)).toBe(true)
    const written = await fs.readFile(out[0].localPath)
    expect(written.equals(bytes)).toBe(true)
  })

  it('isolates per-attachment errors — one missing file does not break the rest', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const errors: Array<{ name: string; error: string }> = []
    service.on('attachment-error', (e: { name: string; error: string }) => errors.push(e))

    const okPath1 = path.join(tmpDir, 'a.txt')
    const okPath2 = path.join(tmpDir, 'b.txt')
    await fs.writeFile(okPath1, 'hello')
    await fs.writeFile(okPath2, 'world')

    const out = await service.ingest('thread-C', [
      { name: 'a.txt', mime: 'text/plain', size: 5, path: okPath1 },
      { name: 'missing.txt', mime: 'text/plain', size: 0, path: path.join(tmpDir, 'does-not-exist.txt') },
      { name: 'b.txt', mime: 'text/plain', size: 5, path: okPath2 },
    ])

    expect(out).toHaveLength(2)
    expect(out.map((r) => r.originalName)).toEqual(['a.txt', 'b.txt'])
    expect(errors).toHaveLength(1)
    expect(errors[0].name).toBe('missing.txt')
  })

  it('processes attachments sequentially (not Promise.all)', async () => {
    // We assert serial order by tracking the order in which the *prisma create*
    // calls happen. With Promise.all this would interleave; with a serial loop
    // the order matches the input array.
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const paths: string[] = []
    for (let i = 0; i < 5; i++) {
      const p = path.join(tmpDir, `f${i}.bin`)
      // Different sizes ensure different hash. Keep small so the test is fast.
      await fs.writeFile(p, crypto.randomBytes(10 * 1024 * (i + 1)))
      paths.push(p)
    }

    const inputs = paths.map((p, i) => ({
      name: `f${i}.bin`,
      mime: 'application/octet-stream',
      size: 10 * 1024 * (i + 1),
      path: p,
    }))

    await service.ingest('thread-D', inputs)

    expect(prisma.created.map((c) => c.originalName)).toEqual([
      'f0.bin', 'f1.bin', 'f2.bin', 'f3.bin', 'f4.bin',
    ])
  })

  it('accepts a path-based attachment well over the old 100MB cap (e.g. 200MB) — streamed off disk', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    // Mock stat → 200MB so we don't allocate a 200MB file; the actual on-disk
    // file is tiny, and the stream copies whatever bytes really exist. The point
    // is the size PREFLIGHT no longer rejects a 200MB path-based attachment.
    const big = path.join(tmpDir, 'big-video.mp4')
    await fs.writeFile(big, 'fake-mp4-bytes')
    const statSpy = vi.spyOn(fs, 'stat').mockResolvedValueOnce({
      isFile: () => true,
      size: 200 * 1024 * 1024,
    } as never)

    const errors: Array<{ name: string; error: string }> = []
    service.on('attachment-error', (e: { name: string; error: string }) => errors.push(e))

    const out = await service.ingest('thread-E', [
      { name: 'big-video.mp4', mime: 'video/mp4', size: 200 * 1024 * 1024, path: big },
    ])

    expect(errors).toHaveLength(0)
    expect(out).toHaveLength(1)
    expect(out[0].originalName).toBe('big-video.mp4')
    statSpy.mockRestore()
  })

  it('rejects a path-based attachment over the 2GB streaming cap before any disk write', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const huge = path.join(tmpDir, 'huge.mp4')
    await fs.writeFile(huge, 'x')
    const statSpy = vi.spyOn(fs, 'stat').mockResolvedValueOnce({
      isFile: () => true,
      size: 3 * 1024 * 1024 * 1024, // 3GB > 2GB cap
    } as never)

    const errors: Array<{ name: string; error: string }> = []
    service.on('attachment-error', (e: { name: string; error: string }) => errors.push(e))

    const out = await service.ingest('thread-E2', [
      { name: 'huge.mp4', mime: 'video/mp4', size: 3 * 1024 * 1024 * 1024, path: huge },
    ])

    expect(out).toHaveLength(0)
    expect(errors[0].name).toBe('huge.mp4')
    expect(errors[0].error).toMatch(/too large/i)
    statSpy.mockRestore()
  })

  it('rejects a buffer-based attachment over the 100MB in-memory cap', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const errors: Array<{ name: string; error: string }> = []
    service.on('attachment-error', (e: { name: string; error: string }) => errors.push(e))

    // Fake ArrayBuffer-like: preflight only reads byteLength and throws before
    // touching the bytes, so we avoid allocating 100MB in the test.
    const fakeBuffer = { byteLength: 200 * 1024 * 1024 } as ArrayBuffer

    const out = await service.ingest('thread-E3', [
      { name: 'pasted.png', mime: 'image/png', size: 200 * 1024 * 1024, buffer: fakeBuffer },
    ])

    expect(out).toHaveLength(0)
    expect(errors[0].name).toBe('pasted.png')
    expect(errors[0].error).toMatch(/too large/i)
  })

  it('emits attachment-added after each successful ingest so the file panel can refresh', async () => {
    // Regression: ATTACHMENTS panel stayed stale after Codex chat ingested a
    // new file because the service had no success-signal. We now emit
    // 'attachment-added' once per saved row, mirroring 'attachment-error' on
    // the failure side. AttachmentTreeProvider's broadcast wires this through
    // to the renderer as `attachments:changed` IPC.
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const added: Array<{ saved: { originalName: string; localPath: string } }> = []
    service.on('attachment-added', (e: { saved: { originalName: string; localPath: string } }) => added.push(e))

    const aPath = path.join(tmpDir, 'a.txt')
    const bPath = path.join(tmpDir, 'b.txt')
    await fs.writeFile(aPath, 'AAA')
    await fs.writeFile(bPath, 'BBB')

    const out = await service.ingest('thread-G', [
      { name: 'a.txt', mime: 'text/plain', size: 3, path: aPath },
      { name: 'b.txt', mime: 'text/plain', size: 3, path: bPath },
    ])

    expect(out).toHaveLength(2)
    expect(added).toHaveLength(2)
    expect(added.map((e) => e.saved.originalName)).toEqual(['a.txt', 'b.txt'])
    // The emitted localPath must match what ingest() returned — otherwise the
    // renderer can't correlate IPC events with rendered rows.
    expect(added[0].saved.localPath).toBe(out[0].localPath)
  })

  it('does NOT emit attachment-added when ingest fails (size cap, missing file, etc.)', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    const added: unknown[] = []
    const errors: unknown[] = []
    service.on('attachment-added', (e) => added.push(e))
    service.on('attachment-error', (e) => errors.push(e))

    await service.ingest('thread-H', [
      { name: 'missing.txt', mime: 'text/plain', size: 0, path: path.join(tmpDir, 'does-not-exist.txt') },
    ])

    expect(added).toHaveLength(0)
    expect(errors).toHaveLength(1)
  })

  it('keeps the event loop responsive while ingesting multiple large files', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const prisma = makePrismaStub()
    const service = new AttachmentService(prisma as never)

    // 3 files, ~6MB each. We measure max event-loop lag during ingestion by
    // scheduling a setTimeout(0) heartbeat and recording the gap. With the
    // OLD impl (sync fs.readFile + sync hash + Promise.all) this would
    // routinely exceed 200ms on a developer laptop; with the streaming impl
    // we expect well under 100ms.
    const paths: string[] = []
    for (let i = 0; i < 3; i++) {
      const p = path.join(tmpDir, `chunky-${i}.bin`)
      await fs.writeFile(p, crypto.randomBytes(6 * 1024 * 1024))
      paths.push(p)
    }
    const inputs = paths.map((p, i) => ({
      name: `chunky-${i}.bin`,
      mime: 'application/octet-stream',
      size: 6 * 1024 * 1024,
      path: p,
    }))

    let maxGap = 0
    let prev = performance.now()
    let stop = false
    const heartbeat = (): void => {
      const now = performance.now()
      const gap = now - prev
      if (gap > maxGap) maxGap = gap
      prev = now
      if (!stop) setTimeout(heartbeat, 0)
    }
    setTimeout(heartbeat, 0)

    await service.ingest('thread-F', inputs)
    stop = true

    // Generous bound to avoid CI flake; the old impl easily hit >500ms on these
    // sizes. If a regression reintroduces sync hashing this fails loudly.
    expect(maxGap).toBeLessThan(300)
  })
})
