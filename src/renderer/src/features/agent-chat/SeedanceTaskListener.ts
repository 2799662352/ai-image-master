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
 *   cancelled       → fail bubble carrying the cancellation reason
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

/** clientId (fallback taskId) → bubble bookkeeping. Module-level so remounts don't duplicate bubbles. */
const tracked = new Map<string, TrackedTask>()

function toFileUrl(filePath: string): string {
  return `file:///${filePath.replace(/\\/g, '/')}`
}

function videoArtifact(update: SeedanceTaskUpdate, uri: string): AttachmentRef {
  // 注意：artifact id 故意用真实上游 taskId（持久身份），而非气泡 key（clientid 兜底）；
  // 别在「一致性清理」时误改成 key。
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
  // 预备卡片（createTask 之前的素材准备阶段）：与上游「排队中」区分开，让
  // 批量并发时每条任务在前置上传/导入期间就有可见且可辨识的进度气泡。
  if (update.phase === 'preparing') return `正在准备素材… (${spec})`
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
  // 历史记录优先存永久 COS URL(remoteUrl):重启 / 链接过期都不丢；
  // 仅当 COS 转存失败时退回本地 file:// 路径。
  if (task.historyRecorded || (!update.remoteUrl && !update.localPath)) return
  task.historyRecorded = true
  const durableUrl = update.remoteUrl ?? (update.localPath ? toFileUrl(update.localPath) : undefined)
  if (!durableUrl) return
  try {
    const history = ServiceRegistry.get<HistoryDataService>(SERVICE_KEYS.HISTORY_DATA)
    if (!history) return
    await history.init()
    const saved = (await history.addToHistory(
      'codex-video',
      update.prompt,
      [durableUrl],
      update.ratio,
      `seedance-${update.model}`,
    )) as { id?: number | string } | null
    const historyId = saved?.id
    if (historyId != null && task.threadId) {
      recordCodexArtifact(task.threadId, {
        // anchor id 同样用真实上游 taskId（持久身份），非气泡 key。
        id: `codex-video-${update.taskId}`,
        createdAt: Date.now(),
        prompt: update.prompt,
        historyId,
        // 本地路径仅作为 COS URL 未解析时的兜底(anchor.paths)。
        ...(update.localPath ? { paths: [update.localPath] } : {}),
        kind: 'video',
      })
    }
  } catch (error) {
    console.error('[SeedanceTaskListener] history persistence failed:', error)
  }
}

export function handleSeedanceTaskUpdate(update: SeedanceTaskUpdate): void {
  // 「生成视频」工作台提交的任务不产生聊天气泡/聊天历史 —— 进度与结果由
  // 工作台页自己的卡片消费（useVideoWorkbenchStore 同样订阅 seedance:task-update）。
  if (update.source === 'workbench') return

  const chat = useAgentChatStore.getState()

  // 气泡身份优先用稳定的 clientId：generate_video 的「预备卡片」与之后真实
  // taskId 的广播带同一个 clientId，于是驱动同一张气泡（不重复建）；缺省回退 taskId。
  const key = update.clientId ?? update.taskId
  let task = tracked.get(key)
  if (!task) {
    const itemId = chat.beginImageGeneration(update.prompt, update.threadId, 'video')
    task = { itemId, threadId: update.threadId, historyRecorded: false }
    tracked.set(key, task)
  }

  switch (update.status) {
    case 'queued':
    case 'running':
      chat.updateGenerationProgress(task.itemId, progressLabel(update), task.threadId)
      return

    case 'failed':
      chat.failImageGeneration(task.itemId, update.error ?? '视频生成失败', task.threadId)
      tracked.delete(key)
      return

    // 聊天气泡的状态机没有「已取消」这一档，用失败态承载，并把原因原样带出
    // —— 那句话里写着这次到底还计不计费（running 阶段无法真取消）。
    case 'cancelled':
      chat.failImageGeneration(task.itemId, update.error ?? '视频生成已取消', task.threadId)
      tracked.delete(key)
      return

    case 'succeeded': {
      // 优先永久 COS URL(remoteUrl,持久且 https) > 本地 mp4 > 上游代理地址
      // (临时,有效期未知)。persistence 完成后 remoteUrl 到达会触发一次
      // 重解析,把气泡从临时地址换成永久地址。
      const uri = update.remoteUrl ?? (update.localPath ? toFileUrl(update.localPath) : update.videoUrl)
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
          tracked.delete(key)
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
          void persistHistory(update, task).finally(() => tracked.delete(key))
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
