// Seedance 任务状态机（主进程单例）。
//
// 设计约束（docs/2026-06-12-mcp-stdio-bridge-pitfalls.md 三个坑的吸收）：
// - generate_video 提交即回（坑 1：杜绝长工具调用）；
// - 状态全在本单例，MCP server-per-connection 工厂随便建几个实例都安全（坑 2）;
// - succeeded 即成功；下载/落盘是 bookkeeping（persistence 字段），
//   失败不改写任务成功状态（坑 3）。
//
// waitForChange 给 check_video_task 提供 ≤25s 服务端长轮询：状态一变立即
// 返回，否则超时返回当前快照 —— codex 每次调用都拿到新鲜状态且不会断流。

import { randomUUID } from 'node:crypto'

import type { SeedanceClient } from './client'
import type {
  CreateVideoTaskInput,
  SeedanceCreateTaskBody,
  SeedanceContentItem,
  SeedanceModelAlias,
  SeedanceTaskState,
  SeedanceTaskStatus,
  SeedanceTaskUpdate,
} from './types'
import { SEEDANCE_MODEL_IDS } from './types'

/** 上游轮询间隔。文档建议 5~10s。 */
const POLL_INTERVAL_MS = 6_000
/** 单任务轮询上限（30 分钟），防上游悬死导致永久轮询。 */
const POLL_TIMEOUT_MS = 30 * 60_000
/** 终态任务保留时长，之后从 Map 清理。 */
const RETENTION_MS = 30 * 60_000

export interface SeedanceTaskManagerDeps {
  client: SeedanceClient
  getApiKey: () => string
  /**
   * 下载 + 落盘（线程 uploads 目录）并转存历史桶（COS）。返回本地 mp4 绝对
   * 路径与永久 https URL（COS 上传失败时 remoteUrl 缺省，降级用本地路径）。
   * 抛错只影响 persistence 状态，不影响任务 succeeded。
   */
  persistVideo: (task: SeedanceTaskState) => Promise<{ localPath: string; remoteUrl?: string }>
  /** 每次状态变化推给所有窗口（渲染进程气泡）。 */
  broadcast: (update: SeedanceTaskUpdate) => void
  /** 注入时钟便于单测。 */
  now?: () => number
}

export interface SubmitParams {
  input: CreateVideoTaskInput
  /** 已解析好的 content[]（含参考素材 dataURL），由 main handler 组装。 */
  content: SeedanceContentItem[]
  threadId?: string
  /** generate_video 预备卡片的临时 id；真实任务广播会带上它做气泡对齐。 */
  clientId?: string
  /** 任务来源（'workbench' = 生成视频工作台页；缺省 = 聊天/MCP 链路）。 */
  source?: 'workbench'
}

export class SeedanceTaskManager {
  private tasks = new Map<string, SeedanceTaskState>()
  private waiters = new Map<string, Array<() => void>>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private deps: SeedanceTaskManagerDeps) {}

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  async submit(params: SubmitParams): Promise<SeedanceTaskState> {
    const { input, content, threadId } = params
    const apiKey = this.deps.getApiKey()
    if (!apiKey) throw new Error('SEEDANCE_KEY_MISSING')

    const model: SeedanceModelAlias = input.model ?? '2.0'
    const resolution = input.resolution ?? '720p'
    const ratio = input.ratio ?? '16:9'
    const duration = input.duration ?? 5

    const body: SeedanceCreateTaskBody = {
      model: SEEDANCE_MODEL_IDS[model],
      content,
      ratio,
      resolution,
      duration,
      generate_audio: input.generateAudio ?? true,
    }

    const { id } = await this.deps.client.createTask(body, apiKey)
    const state: SeedanceTaskState = {
      taskId: id,
      clientId: params.clientId,
      ...(params.source ? { source: params.source } : {}),
      threadId,
      prompt: input.prompt,
      model,
      resolution,
      ratio,
      duration,
      status: 'queued',
      createdAt: this.now(),
      updatedAt: this.now(),
      persistence: 'idle',
    }
    this.tasks.set(id, state)
    this.deps.broadcast({ ...state })
    void this.pollLoop(id)
    return { ...state }
  }

  /**
   * 拼装一条「合成广播」——用于真实任务存在之前的预备/失败卡片。taskId 直接复用
   * clientId（渲染端以 clientId 为气泡键，二者一致即可），不进 tasks Map、不轮询。
   */
  private baseUpdate(
    clientId: string,
    input: CreateVideoTaskInput,
    threadId: string | undefined,
    status: SeedanceTaskStatus,
  ): SeedanceTaskUpdate {
    const now = this.now()
    return {
      taskId: clientId,
      clientId,
      threadId,
      prompt: input.prompt,
      model: input.model ?? '2.0',
      resolution: input.resolution ?? '720p',
      ratio: input.ratio ?? '16:9',
      duration: input.duration ?? 5,
      status,
      createdAt: now,
      updatedAt: now,
      persistence: 'idle',
    }
  }

  /**
   * 在重活（buildContent / 素材库导入 / createTask）开始前立刻广播一张
   * 「准备中（queued）」卡片，并返回 clientId 供 submit 透传。这样无论前置上传
   * 多慢、批量并发多少条，用户都能瞬间看到每条任务的进度气泡。
   */
  announcePreparing(params: { input: CreateVideoTaskInput; threadId?: string }): string {
    const clientId = `pending-${randomUUID()}`
    // status 仍用 'queued'（waitForChange/pollLoop 等逻辑不受影响），但带上
    // client-only 'preparing' 相位，渲染端据此显示「正在准备素材…」而非「排队中」，
    // 让前置上传/导入这段慢活有可见、可区分的进度卡片。
    this.deps.broadcast({ ...this.baseUpdate(clientId, params.input, params.threadId, 'queued'), phase: 'preparing' })
    return clientId
  }

  /** 前置阶段（素材解析/导入/createTask）抛错时，把预备卡片落成 failed，避免永远转圈。 */
  announceFailed(params: {
    clientId: string
    input: CreateVideoTaskInput
    threadId?: string
    error: string
  }): void {
    this.deps.broadcast({
      ...this.baseUpdate(params.clientId, params.input, params.threadId, 'failed'),
      error: params.error,
    })
  }

  get(taskId: string): SeedanceTaskState | undefined {
    const t = this.tasks.get(taskId)
    return t ? { ...t } : undefined
  }

  /**
   * 服务端长轮询：状态（status / persistence / localPath / error）任一变化
   * 立即返回新快照；超时返回当前快照；未知任务返回 undefined。
   */
  async waitForChange(taskId: string, timeoutMs: number): Promise<SeedanceTaskState | undefined> {
    const current = this.tasks.get(taskId)
    if (!current) return undefined
    if (current.status === 'failed') return { ...current }
    if (current.status === 'succeeded' && current.persistence !== 'running') {
      return { ...current }
    }

    await new Promise<void>((resolve) => {
      const list = this.waiters.get(taskId) ?? []
      list.push(resolve)
      this.waiters.set(taskId, list)
      setTimeout(resolve, timeoutMs)
    })
    const after = this.tasks.get(taskId)
    return after ? { ...after } : undefined
  }

  /** 测试 / 关停用：停掉所有轮询。 */
  dispose(): void {
    for (const timer of this.timers.values()) clearTimeout(timer)
    this.timers.clear()
    this.tasks.clear()
    this.notifyAll()
  }

  // ---------- internal ----------

  private update(taskId: string, patch: Partial<SeedanceTaskState>): void {
    const t = this.tasks.get(taskId)
    if (!t) return
    Object.assign(t, patch, { updatedAt: this.now() })
    this.deps.broadcast({ ...t })
    const list = this.waiters.get(taskId)
    if (list) {
      this.waiters.delete(taskId)
      for (const resolve of list) resolve()
    }
  }

  private notifyAll(): void {
    for (const list of this.waiters.values()) for (const r of list) r()
    this.waiters.clear()
  }

  private scheduleCleanup(taskId: string): void {
    const timer = setTimeout(() => {
      this.tasks.delete(taskId)
      this.timers.delete(taskId)
    }, RETENTION_MS)
    timer.unref?.()
    this.timers.set(taskId, timer)
  }

  private async pollLoop(taskId: string): Promise<void> {
    const startedAt = this.now()
    while (true) {
      await new Promise((r) => {
        const t = setTimeout(r, POLL_INTERVAL_MS)
        ;(t as NodeJS.Timeout).unref?.()
      })
      const task = this.tasks.get(taskId)
      if (!task) return // disposed / cleaned up

      if (this.now() - startedAt > POLL_TIMEOUT_MS) {
        this.update(taskId, { status: 'failed', error: '轮询超时（30 分钟未出结果）' })
        this.scheduleCleanup(taskId)
        return
      }

      let result
      try {
        result = await this.deps.client.queryTask(taskId, this.deps.getApiKey())
      } catch (e) {
        // 单次查询失败不判死刑（网络抖动），下一轮继续。
        console.warn('[seedance] queryTask failed, will retry:', e)
        continue
      }

      if (result.status === 'failed') {
        const err = result.error
        this.update(taskId, {
          status: 'failed',
          error: err ? `${err.code ?? 'error'}: ${err.message ?? 'unknown'}` : '生成失败（上游未给出原因）',
        })
        this.scheduleCleanup(taskId)
        return
      }

      if (result.status === 'succeeded') {
        const videoUrl = result.content?.video_url
        if (!videoUrl) {
          this.update(taskId, { status: 'failed', error: 'succeeded 但缺少 video_url' })
          this.scheduleCleanup(taskId)
          return
        }
        // 成功即成功 —— 先广播 succeeded，再做落盘 bookkeeping。
        this.update(taskId, { status: 'succeeded', videoUrl, persistence: 'running' })
        try {
          const { localPath, remoteUrl } = await this.deps.persistVideo({ ...this.tasks.get(taskId)! })
          this.update(taskId, { persistence: 'done', localPath, remoteUrl })
        } catch (e) {
          console.warn('[seedance] persistVideo failed (video itself is fine):', e)
          this.update(taskId, { persistence: 'failed' })
        }
        this.scheduleCleanup(taskId)
        return
      }

      // queued / running：仅在状态切换时广播，避免每 6s 刷一次噪音。
      if (result.status !== task.status) {
        this.update(taskId, { status: result.status })
      }
    }
  }
}
