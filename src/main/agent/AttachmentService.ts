import { app } from 'electron'
import type { PrismaClient } from '@prisma/client'
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs/promises'
import { createReadStream, createWriteStream } from 'node:fs'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import path from 'node:path'
import type { AgentAttachmentInput } from '../../types/agent'

const MAX_ATTACHMENTS = 20
const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024
const STREAM_CHUNK_SIZE = 64 * 1024

export interface AttachmentErrorEvent {
  name: string
  error: string
}

export interface SavedAttachment {
  id: string
  threadId: string
  originalName: string
  localPath: string
  mime: string
  size: number
  uploadedAt: Date
}

/**
 * Ingest user attachments without blocking the Electron main thread.
 *
 * Design notes (see docs/superpowers/specs/2026-05-11-attachment-streaming-design.md):
 * - Sequential processing (NOT Promise.all) so N×100MB files don't pile into heap
 *   simultaneously and starve the in-process PGlite socket server.
 * - Each file streamed: source → tee(sha256, fs.createWriteStream) so we never hold
 *   the whole file in a Node Buffer. Hash + write happen chunk-by-chunk; the event
 *   loop naturally yields after every 64KB pump, giving Prisma's PGlite wire
 *   protocol time to ack heartbeats.
 * - Per-file try/catch + EventEmitter("attachment-error"): one bad file does not
 *   kill the whole turn. Renderer can show a ⚠ chip and let user remove/retry.
 *   This mirrors the "non-fatal per-thread state" fix Codex's own team is shipping
 *   for openai/codex#13508.
 */
export class AttachmentService extends EventEmitter {
  constructor(private readonly prisma: PrismaClient) {
    super()
  }

  async ingest(threadId: string, attachments: AgentAttachmentInput[]): Promise<SavedAttachment[]> {
    if (attachments.length === 0) return []
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new Error(`Too many attachments: ${attachments.length}`)
    }

    const dir = path.join(app.getPath('userData'), 'agent', 'uploads')
    await fs.mkdir(dir, { recursive: true })

    const results: SavedAttachment[] = []
    for (const attachment of attachments) {
      try {
        const saved = await this.ingestOne(threadId, attachment, dir)
        results.push(saved)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        // Per-attachment isolation: surface the failure but keep going so the
        // rest of the turn (other files, the user's text, the agent call)
        // is not lost.
        console.warn(`[AttachmentService] failed to ingest ${attachment.name}: ${message}`)
        this.emit('attachment-error', { name: attachment.name, error: message } satisfies AttachmentErrorEvent)
      }
      // Explicitly yield the event loop after every file so the same-process
      // PGLiteSocketServer + Codex backend get a chance to drain their queues.
      // Without this, three 80MB files back-to-back are enough to starve the
      // socket heartbeat and surface as "Server has closed the connection".
      await new Promise<void>((resolve) => setImmediate(resolve))
    }
    return results
  }

  private async ingestOne(
    threadId: string,
    attachment: AgentAttachmentInput,
    dir: string,
  ): Promise<SavedAttachment> {
    // 1) Size preflight — fail fast without reading the whole file.
    let declaredSize: number
    if (attachment.path) {
      const stat = await fs.stat(attachment.path)
      if (!stat.isFile()) throw new Error(`Attachment ${attachment.name} is not a file`)
      if (stat.size > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Attachment ${attachment.name} is too large`)
      }
      declaredSize = stat.size
    } else if (attachment.buffer) {
      if (attachment.buffer.byteLength > MAX_ATTACHMENT_BYTES) {
        throw new Error(`Attachment ${attachment.name} is too large`)
      }
      declaredSize = attachment.buffer.byteLength
    } else {
      throw new Error(`Attachment ${attachment.name} is missing file data`)
    }

    // 2) Stream source → temp file while updating the sha256 hasher per chunk.
    //    We can't use stream.pipeline() with a hash sink (digest is terminal,
    //    not a stream), so we route bytes manually: write to disk via pipeline
    //    AND tap each chunk into the hasher via 'data'. The temp file uses a
    //    random suffix so two concurrent ingests of the same content don't
    //    fight over a single in-flight name.
    const ext = path.extname(attachment.name)
    const tmpName = `_tmp_${crypto.randomUUID()}${ext}`
    const tmpPath = path.join(dir, tmpName)

    const source: NodeJS.ReadableStream = attachment.path
      ? createReadStream(attachment.path, { highWaterMark: STREAM_CHUNK_SIZE })
      : Readable.from(splitBuffer(Buffer.from(attachment.buffer!), STREAM_CHUNK_SIZE))

    const hasher = crypto.createHash('sha256')
    source.on('data', (chunk: Buffer) => hasher.update(chunk))

    const writer = createWriteStream(tmpPath)
    try {
      await pipeline(source, writer)
    } catch (err) {
      // Clean up temp file on failure — orphans add up on Windows where
      // unlink-on-error in pipeline() isn't guaranteed.
      await fs.unlink(tmpPath).catch(() => undefined)
      throw err
    }

    const sha = hasher.digest('hex')
    const finalPath = path.join(dir, `${sha}${ext}`)

    // 3) Content-addressed rename. If another concurrent ingest of the same
    //    bytes raced us to `<sha>.ext`, drop our temp copy — the existing
    //    file is identical by construction.
    try {
      await fs.rename(tmpPath, finalPath)
    } catch (renameErr) {
      // EEXIST on Windows when destination already exists. Other ENOENT-class
      // races also fall through here. Delete temp and let the existing file win.
      await fs.unlink(tmpPath).catch(() => undefined)
      // If finalPath also doesn't exist after the rename failed, propagate the
      // original error so the caller knows ingestion truly failed.
      const existsCheck = await fs.stat(finalPath).catch(() => null)
      if (!existsCheck) throw renameErr
    }

    return this.prisma.agentAttachment.create({
      data: {
        threadId,
        originalName: attachment.name,
        localPath: finalPath,
        mime: attachment.mime,
        size: declaredSize,
      },
    })
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

  private isInsideDirectory(filePath: string, dir: string): boolean {
    const relative = path.relative(dir, filePath)
    return relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)
  }
}

function* splitBuffer(buffer: Buffer, chunkSize: number): Generator<Buffer> {
  for (let offset = 0; offset < buffer.byteLength; offset += chunkSize) {
    yield buffer.subarray(offset, Math.min(offset + chunkSize, buffer.byteLength))
  }
}
