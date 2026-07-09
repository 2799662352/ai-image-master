import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let tmpDir: string

vi.mock('electron', () => ({
  app: {
    getPath: (_kind: string) => tmpDir,
  },
}))

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'attachment-cleanup-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

interface AttachmentRow {
  id: string
  threadId: string
  originalName: string
  localPath: string
  mime: string
  size: number
  uploadedAt: Date
}

interface MessageRow {
  id: string
  items: unknown
}

/**
 * Prisma stub covering exactly what cleanup() touches: agentAttachment
 * findMany/delete/count + agentMessage findMany (the reference scan).
 */
function makePrismaStub(attachments: AttachmentRow[], messages: MessageRow[]) {
  const rows = [...attachments]
  return {
    rows,
    agentAttachment: {
      async findMany({ where }: { where?: { uploadedAt?: { lt: Date } } } = {}) {
        const lt = where?.uploadedAt?.lt
        return lt ? rows.filter((r) => r.uploadedAt < lt) : [...rows]
      },
      async delete({ where }: { where: { id: string } }) {
        const idx = rows.findIndex((r) => r.id === where.id)
        if (idx >= 0) rows.splice(idx, 1)
      },
      async count({ where }: { where: { localPath: string } }) {
        return rows.filter((r) => r.localPath === where.localPath).length
      },
    },
    agentMessage: {
      async findMany(_args?: unknown) {
        return messages.map((m) => ({ items: m.items }))
      },
    },
  }
}

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000)
}

async function writeUpload(name: string): Promise<string> {
  const dir = path.join(tmpDir, 'agent', 'uploads')
  await fs.mkdir(dir, { recursive: true })
  const p = path.join(dir, name)
  await fs.writeFile(p, 'bytes')
  return p
}

/** uri exactly as AgentManager.buildUserTimelineItems persists it. */
function attachmentMessageItems(localPath: string): unknown {
  return [
    {
      type: 'attachment',
      id: 'tl-1',
      startedAt: Date.now(),
      attachments: [
        {
          id: 'att-ref-1',
          kind: 'image',
          name: path.basename(localPath),
          mime: 'image/png',
          size: 5,
          uri: 'local-file:///' + localPath.replace(/\\/g, '/'),
        },
      ],
    },
  ]
}

describe('AttachmentService.cleanup — message-reference-aware sweep', () => {
  it('keeps the file AND the row when a chat message still references the attachment', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const localPath = await writeUpload('aaaa.png')
    const prisma = makePrismaStub(
      [
        {
          id: 'att-1',
          threadId: 't1',
          originalName: 'aaaa.png',
          localPath,
          mime: 'image/png',
          size: 5,
          uploadedAt: daysAgo(30),
        },
      ],
      [{ id: 'msg-1', items: attachmentMessageItems(localPath) }],
    )
    const service = new AttachmentService(prisma as never)

    const deleted = await service.cleanup()

    expect(deleted).toBe(0)
    // Row survives so the ATTACHMENTS panel and future sweeps still see it.
    expect(prisma.rows).toHaveLength(1)
    // File survives so the chat history chip keeps resolving.
    await expect(fs.stat(localPath)).resolves.toBeTruthy()
  })

  it('still deletes stale attachments nothing references', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const localPath = await writeUpload('bbbb.png')
    const prisma = makePrismaStub(
      [
        {
          id: 'att-2',
          threadId: 't1',
          originalName: 'bbbb.png',
          localPath,
          mime: 'image/png',
          size: 5,
          uploadedAt: daysAgo(30),
        },
      ],
      [{ id: 'msg-1', items: [{ type: 'text', id: 'tl-1', startedAt: 1, content: 'unrelated' }] }],
    )
    const service = new AttachmentService(prisma as never)

    const deleted = await service.cleanup()

    expect(deleted).toBe(1)
    expect(prisma.rows).toHaveLength(0)
    await expect(fs.stat(localPath)).rejects.toThrow()
  })

  it('matches references that persist the Windows backslash form of the path', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const localPath = await writeUpload('cccc.png')
    // e.g. reference-mention text lines persist raw OS paths with backslashes.
    const rawTextItems = [
      { type: 'text', id: 'tl-1', startedAt: 1, content: `see attachment at ${localPath}` },
    ]
    const prisma = makePrismaStub(
      [
        {
          id: 'att-3',
          threadId: 't1',
          originalName: 'cccc.png',
          localPath,
          mime: 'image/png',
          size: 5,
          uploadedAt: daysAgo(30),
        },
      ],
      [{ id: 'msg-1', items: rawTextItems }],
    )
    const service = new AttachmentService(prisma as never)

    const deleted = await service.cleanup()

    expect(deleted).toBe(0)
    await expect(fs.stat(localPath)).resolves.toBeTruthy()
  })

  it('leaves fresh attachments alone regardless of references', async () => {
    const { AttachmentService } = await import('../AttachmentService')
    const localPath = await writeUpload('dddd.png')
    const prisma = makePrismaStub(
      [
        {
          id: 'att-4',
          threadId: 't1',
          originalName: 'dddd.png',
          localPath,
          mime: 'image/png',
          size: 5,
          uploadedAt: daysAgo(1),
        },
      ],
      [],
    )
    const service = new AttachmentService(prisma as never)

    const deleted = await service.cleanup()

    expect(deleted).toBe(0)
    expect(prisma.rows).toHaveLength(1)
  })
})
