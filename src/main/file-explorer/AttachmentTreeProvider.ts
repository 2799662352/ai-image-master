import { app, BrowserWindow, ipcMain } from 'electron'
import type { PrismaClient } from '@prisma/client'
import type EventEmitter from 'node:events'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { FileNodeIpc } from './fsIpc'

type AttachmentRow = {
  id: string
  originalName: string
  localPath: string
  size: number
  mime: string
  uploadedAt: Date
}

type PrismaLike = Pick<PrismaClient, 'agentAttachment'>

export async function buildAttachmentTreeFromInputs(
  uploadsDir: string,
  rows: AttachmentRow[],
): Promise<(FileNodeIpc & { mime?: string; size?: number })[]> {
  let diskNames: Set<string>
  try {
    const entries = await fs.readdir(uploadsDir)
    diskNames = new Set(entries)
  } catch {
    return []
  }

  const byBasename = new Map<string, AttachmentRow>()
  for (const r of rows) byBasename.set(path.basename(r.localPath), r)

  const result: (FileNodeIpc & { mime?: string; size?: number })[] = []
  for (const filename of diskNames) {
    const row = byBasename.get(filename)
    const full = path.join(uploadsDir, filename)
    if (row) {
      result.push({
        path: full,
        name: row.originalName,
        kind: 'file',
        source: 'attachments',
        childrenLoaded: false,
        mime: row.mime,
        size: row.size,
      })
    } else {
      result.push({
        path: full,
        name: filename,
        kind: 'file',
        source: 'attachments',
        childrenLoaded: false,
      })
    }
  }

  result.sort((a, b) => {
    const ra = byBasename.get(path.basename(a.path))
    const rb = byBasename.get(path.basename(b.path))
    if (ra && rb) return rb.uploadedAt.getTime() - ra.uploadedAt.getTime()
    if (ra && !rb) return -1
    if (!ra && rb) return 1
    return a.name.localeCompare(b.name)
  })
  return result
}

export function registerAttachmentsTreeIpc(prismaGetter: () => PrismaLike | Promise<PrismaLike>): void {
  ipcMain.handle('attachments:list-tree', async () => {
    const uploadsDir = path.join(app.getPath('userData'), 'agent', 'uploads')
    const prisma = await prismaGetter()
    const rows = await prisma.agentAttachment.findMany({ orderBy: { uploadedAt: 'desc' } })
    return buildAttachmentTreeFromInputs(uploadsDir, rows)
  })
}

/**
 * Bridge `AttachmentService` success events to every open BrowserWindow as the
 * `attachments:changed` IPC channel. Mirrors the fs watcher push pattern in
 * `fsIpc.ts` so the renderer's ATTACHMENTS panel never has to poll.
 *
 * Returns a cleanup that removes the listener — used by tests; production
 * lifetime is bound to the AttachmentService instance, which lives for the
 * whole AgentRuntime session.
 *
 * Why this is the correct seam:
 *  - AttachmentService is the only place that performs successful ingests.
 *  - The Prisma row is created inside `ingestOne`, so the event fires AFTER
 *    both disk write + DB row are durable. The renderer's `listTree` pull will
 *    see the new row.
 *  - We broadcast a content-free signal ("something changed, pull again")
 *    rather than the row payload itself. This keeps the contract one-way and
 *    avoids race-y partial-tree updates if multiple ingests interleave.
 */
export function wireAttachmentBroadcast(
  service: EventEmitter,
  windowsGetter: () => BrowserWindow[] = () => BrowserWindow.getAllWindows(),
): () => void {
  const handler = (): void => {
    for (const win of windowsGetter()) {
      if (!win.isDestroyed()) {
        win.webContents.send('attachments:changed')
      }
    }
  }
  service.on('attachment-added', handler)
  return () => {
    service.off('attachment-added', handler)
  }
}
