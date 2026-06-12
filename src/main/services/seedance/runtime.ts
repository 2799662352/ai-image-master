// Seedance 运行时接线：TaskManager 单例 + ToolRouter main handler + 设置 IPC。
// 由 index.ts 在 MCP runtime 就绪后调用一次。

import { ipcMain, type BrowserWindow } from 'electron'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ToolRouter } from '../../mcp/ToolRouter'
import type { AttachmentService } from '../../agent/AttachmentService'
import { CHECK_LONG_POLL_MS } from '../../mcp/tools/videoTools'
import { seedanceClient } from './client'
import { getSeedanceApiKey, getSeedanceKeyState, setSeedanceApiKey } from './credentials'
import { SeedanceTaskManager } from './taskManager'
import type { CreateVideoTaskInput, SeedanceContentItem } from './types'

/**
 * 本地素材内联为 data: URL 的单文件上限。上游 data: 字段约 5MB 顶,
 * base64 膨胀 ~4/3,所以原始文件给 4.5MB 余量后仍可能超 — 取 3.5MB 原始
 * 字节(≈4.7MB base64)保证安全。超限直接报错让 codex 换小图。
 */
const MAX_INLINE_FILE_BYTES = Math.floor(3.5 * 1024 * 1024)

/** 无 threadId 的任务(手动 MCP 调用等)落到这个伪线程目录。 */
const FALLBACK_THREAD_ID = 'seedance'

const MIME_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
}

/** 本地路径 → data: URL;data:/http(s) 原样透传。 */
async function resolveMediaUrl(src: string, label: string): Promise<string> {
  const trimmed = src.trim()
  if (/^(data:|https?:)/i.test(trimmed)) return trimmed
  let buf: Buffer
  try {
    buf = await fs.readFile(trimmed)
  } catch {
    throw new Error(`${label}: cannot read local file "${trimmed}" — pass an existing path, data: URL, or https URL.`)
  }
  if (buf.byteLength > MAX_INLINE_FILE_BYTES) {
    throw new Error(
      `${label}: local file is ${(buf.byteLength / 1024 / 1024).toFixed(1)}MB — inline data: URLs are capped at ` +
        `~3.5MB. Compress/downscale the file first, or host it and pass an https URL.`,
    )
  }
  const mime = MIME_BY_EXT[path.extname(trimmed).toLowerCase()] ?? 'application/octet-stream'
  return `data:${mime};base64,${buf.toString('base64')}`
}

async function buildContent(input: CreateVideoTaskInput): Promise<SeedanceContentItem[]> {
  const content: SeedanceContentItem[] = [{ type: 'text', text: input.prompt }]
  if (input.firstFrame) {
    content.push({ type: 'image_url', role: 'first_frame', image_url: { url: await resolveMediaUrl(input.firstFrame, 'firstFrame') } })
  }
  if (input.lastFrame) {
    content.push({ type: 'image_url', role: 'last_frame', image_url: { url: await resolveMediaUrl(input.lastFrame, 'lastFrame') } })
  }
  for (const [i, ref] of (input.referenceImages ?? []).entries()) {
    content.push({ type: 'image_url', role: 'reference_image', image_url: { url: await resolveMediaUrl(ref, `referenceImages[${i}]`) } })
  }
  if (input.referenceVideo) {
    content.push({ type: 'video_url', video_url: { url: await resolveMediaUrl(input.referenceVideo, 'referenceVideo') } })
  }
  if (input.referenceAudio) {
    content.push({ type: 'audio_url', audio_url: { url: await resolveMediaUrl(input.referenceAudio, 'referenceAudio') } })
  }
  return content
}

export interface SeedanceRuntime {
  taskManager: SeedanceTaskManager
  dispose: () => void
}

export function initSeedanceRuntime(opts: {
  router: ToolRouter
  attachments: AttachmentService
  getWindow: () => BrowserWindow | null
}): SeedanceRuntime {
  const { router, attachments, getWindow } = opts

  const taskManager = new SeedanceTaskManager({
    client: seedanceClient,
    getApiKey: getSeedanceApiKey,
    broadcast: (update) => {
      const win = getWindow()
      if (win && !win.isDestroyed()) {
        try {
          win.webContents.send('seedance:task-update', update)
        } catch (e) {
          console.warn('[seedance] broadcast failed:', e)
        }
      }
    },
    persistVideo: async (task) => {
      const buf = await seedanceClient.downloadVideo(task.videoUrl!)
      const name = `seedance-${task.model.replace('.', '_')}-${task.taskId.slice(-8)}.mp4`
      const [saved] = await attachments.ingest(task.threadId ?? FALLBACK_THREAD_ID, [
        {
          name,
          mime: 'video/mp4',
          size: buf.byteLength,
          buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
        },
      ])
      if (!saved) throw new Error('seedance persist: attachment ingest produced no file')
      return saved.localPath
    },
  })

  router.registerMain('generate_video', async (params, threadId) => {
    const input = params as unknown as CreateVideoTaskInput
    const content = await buildContent(input)
    return taskManager.submit({ input, content, threadId })
  })

  router.registerMain('check_video_task', async (params) => {
    const taskId = String((params as { taskId?: unknown }).taskId ?? '')
    const task = await taskManager.waitForChange(taskId, CHECK_LONG_POLL_MS)
    return task ? { found: true, task } : { found: false }
  })

  ipcMain.removeHandler('seedance:get-config')
  ipcMain.handle('seedance:get-config', () => getSeedanceKeyState())
  ipcMain.removeHandler('seedance:set-config')
  ipcMain.handle('seedance:set-config', (_event, args: { apiKey?: unknown }) => {
    setSeedanceApiKey(typeof args?.apiKey === 'string' ? args.apiKey : '')
    return getSeedanceKeyState()
  })

  return {
    taskManager,
    dispose: () => taskManager.dispose(),
  }
}
