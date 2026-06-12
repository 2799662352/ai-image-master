/**
 * Bridges main-process Seedance video tasks into chat bubbles.
 *
 * The `generate_video` / `check_video_task` MCP tools run ENTIRELY in the main
 * process (ToolRouter main handlers) — the renderer never sees the tool call.
 * Instead the SeedanceTaskManager broadcasts every state transition over the
 * `seedance:task-update` IPC channel, and this listener drives the SAME
 * artifact-bubble state machine the codex `generate_image` tool uses:
 *
 *   created/queued  → begin bubble ("排队中…")
 *   running         → progress line ("生成中 · 23s")
 *   succeeded       → resolve with the video artifact; save banner narrates
 *                     the decoupled persistence (pending → saved/failed)
 *   failed          → fail bubble with the upstream error
 *
 * Persistence parity with generate_image: once the mp4 is on disk we record a
 * history entry (type `codex-video`) and a codex-artifact anchor so the bubble
 * survives reload / thread switch.
 */

import { ServiceRegistry, SERVICE_KEYS } from '../../services/ServiceBridge'
import type { HistoryDataService } from '../history'
import { useAgentChatStore } from './store'
import { recordCodexArtifact } from './codexArtifactPersistence'
import type { AttachmentRef } from '../../../../types/agent-timeline'
import type { SeedanceTaskUpdate } from '../../../../types/seedance'

type SeedanceElectronApi = {
  seedance?: {
    onTaskUpdate: (callback: (update: SeedanceTaskUpdate) => void) => () => void
  }
}

interface TrackedTask {
  itemId: string
  threadId?: string
  /** Bubble already settled with artifacts (don't re-resolve on every poll). */
  resolvedUri?: string
  /** History record + anchor written (exactly once per task). */
  historyRecorded: boolean
}

/** taskId → bubble bookkeeping. Module-level so remounts don't duplicate bubbles. */
const tracked = new Map<string, TrackedTask>()

function toFileUrl(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

function videoArtifact(update: SeedanceTaskUpdate, uri: string): AttachmentRef {
  return {
    id: `seedance-${update.taskId}`,
    kind: 'video',
    name: `seedance-${update.model.replace('.', '_')}-${update.taskId.slice(-8)}.mp4`,
    mime: 'video/mp4',
    size: 0,
    uri,
  }
}

function progressLabel(update: SeedanceTaskUpdate): string {
  const elapsed = Math.max(0, Math.round((Date.now() - update.createdAt) / 1000))
  const spec = `Seedance ${update.model} · ${update.duration}s ${update.resolution}`
  if (update.status === 'queued') return `正在生成视频 · 排队中 (${spec})`
  return `正在生成视频 · ${elapsed}s (${spec})`
}

function dirOf(filePath: string): string | undefined {
  const cut = Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/'))
  return cut > 0 ? filePath.slice(0, cut) : undefined
}

/**
 * History record + reload anchor, exactly once per succeeded task. Best-effort:
 * the video is already on screen and on disk, bookkeeping failures only degrade
 * the history page / reload behaviour.
 */
async function persistHistory(update: SeedanceTaskUpdate, task: TrackedTask): Promise<void> {
  if (task.historyRecorded || !update.localPath) return
  task.historyRecorded = true
  try {
    const history = ServiceRegistry.get<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
    if (!history) return
    await history.init()
    const saved = (await history.addToHistory(
      'codex-video',
      update.prompt,
      [toFileUrl(update.localPath)],
      update.ratio,
      `seedance-${update.model}`,
    )) as { id?: number | string } | null
    const historyId = saved?.id
    if (historyId != null && task.threadId) {
      recordCodexArtifact(task.threadId, {
        id: `codex-video-${update.taskId}`,
        createdAt: Date.now(),
        prompt: update.prompt,
        historyId,
        paths: [update.localPath],
        kind: 'video',
      })
    }
  } catch (error) {
    console.error('[SeedanceTaskListener] history persistence failed:', error)
  }
}

export function handleSeedanceTaskUpdate(update: SeedanceTaskUpdate): void {
  const chat = useAgentChatStore.getState()

  let task = tracked.get(update.taskId)
  if (!task) {
    const itemId = chat.beginImageGeneration(update.prompt, update.threadId, 'video')
    task = { itemId, threadId: update.threadId, historyRecorded: false }
    tracked.set(update.taskId, task)
  }

  switch (update.status) {
    case 'queued':
    case 'running':
      chat.updateGenerationProgress(task.itemId, progressLabel(update), task.threadId)
      return

    case 'failed':
      chat.failImageGeneration(task.itemId, update.error ?? '视频生成失败', task.threadId)
      tracked.delete(update.taskId)
      return

    case 'succeeded': {
      // Prefer the durable local mp4; fall back to the upstream proxy URL so
      // the user can already play the video while persistence runs.
      const uri = update.localPath ? toFileUrl(update.localPath) : update.videoUrl
      if (uri && uri !== task.resolvedUri) {
        task.resolvedUri = uri
        chat.resolveImageGeneration(task.itemId, [videoArtifact(update, uri)], task.threadId)
      }

      switch (update.persistence) {
        case 'idle':
        case 'running':
          chat.annotateImageGeneration(task.itemId, { status: 'pending' }, task.threadId)
          return
        case 'failed':
          chat.annotateImageGeneration(task.itemId, { status: 'failed' }, task.threadId)
          tracked.delete(update.taskId)
          return
        case 'done': {
          const localPath = update.localPath
          chat.annotateImageGeneration(
            task.itemId,
            localPath
              ? { status: 'saved', dir: dirOf(localPath), paths: [localPath] }
              : { status: 'saved' },
            task.threadId,
          )
          void persistHistory(update, task).finally(() => tracked.delete(update.taskId))
          return
        }
        default: {
          const _exhaustive: never = update.persistence
          return _exhaustive
        }
      }
    }

    default: {
      const _exhaustive: never = update.status
      return _exhaustive
    }
  }
}

/**
 * Subscribe to `seedance:task-update`. Mounted alongside the AgentToolExecutor
 * (AppLayout / agent-chat mount). Returns the unsubscribe function; no-op in
 * environments without the preload bridge (tests / plain browser).
 */
export function mountSeedanceTaskListener(): () => void {
  const api = (window as Window & { electronAPI?: SeedanceElectronApi }).electronAPI?.seedance
  if (!api?.onTaskUpdate) return () => {}
  return api.onTaskUpdate(handleSeedanceTaskUpdate)
}
