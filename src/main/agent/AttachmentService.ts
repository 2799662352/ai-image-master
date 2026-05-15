import { app } from 'electron'
import type { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { AgentAttachmentInput } from '../../types/agent'

const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024

export class AttachmentService {
  constructor(private readonly prisma: PrismaClient) {}

  async ingest(threadId: string, attachments: AgentAttachmentInput[]) {
    if (attachments.length === 0) return []
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new Error(`Too many attachments: ${attachments.length}`)
    }

    const dir = path.join(app.getPath('userData'), 'agent', 'uploads')
    await fs.mkdir(dir, { recursive: true })

    return Promise.all(
      attachments.map(async (attachment) => {
        const buffer = await this.readAttachmentBuffer(attachment)
        if (buffer.byteLength > MAX_ATTACHMENT_BYTES) {
          throw new Error(`Attachment ${attachment.name} is too large`)
        }

        const sha = crypto.createHash('sha256').update(buffer).digest('hex')
        const ext = path.extname(attachment.name)
        const localPath = path.join(dir, `${sha}${ext}`)

        await fs.writeFile(localPath, buffer)
        return this.prisma.agentAttachment.create({
          data: {
            threadId,
            originalName: attachment.name,
            localPath,
            mime: attachment.mime,
            size: buffer.byteLength,
          },
        })
      }),
    )
  }

  async cleanup(cutoffMs = 7 * 24 * 60 * 60 * 1000): Promise<number> {
    const cutoff = new Date(Date.now() - cutoffMs)
    const uploadsDir = path.join(app.getPath('userData'), 'agent', 'uploads')
    const stale = await this.prisma.agentAttachment.findMany({ where: { uploadedAt: { lt: cutoff } } })
    const candidatePaths = new Set(stale.map((item) => item.localPath))

    for (const item of stale) {
      await this.prisma.agentAttachment.delete({ where: { id: item.id } })
    }

    for (const localPath of candidatePaths) {
      if (!this.isInsideDirectory(localPath, uploadsDir)) continue
      const remainingRefs = await this.prisma.agentAttachment.count({ where: { localPath } })
      if (remainingRefs === 0) {
        await fs.unlink(localPath).catch(() => undefined)
      }
    }

    return stale.length
  }

  private async readAttachmentBuffer(attachment: AgentAttachmentInput): Promise<Buffer> {
    if (attachment.buffer) return Buffer.from(attachment.buffer)
    if (attachment.path) {
      const stat = await fs.stat(attachment.path)
      if (!stat.isFile()) throw new Error(`Attachment ${attachment.name} is not a file`)
      if (stat.size > MAX_ATTACHMENT_BYTES) throw new Error(`Attachment ${attachment.name} is too large`)
      return fs.readFile(attachment.path)
    }
    throw new Error(`Attachment ${attachment.name} is missing file data`)
  }

  private isInsideDirectory(filePath: string, dir: string): boolean {
    const relative = path.relative(dir, filePath)
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
}
