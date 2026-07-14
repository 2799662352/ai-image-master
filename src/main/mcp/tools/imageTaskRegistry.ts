// 图片生成异步任务管理器（主进程单例，与 Seedance SeedanceTaskManager 同构）。
//
// 「真正的异步」设计（对齐 video）：
// - 图片渲染只能在渲染进程做（API 客户端 / history / R2 / 文件面板都在那）。
// - 主进程不再用一条 `router.call('generate_image')` 长 IPC 一路 await 到出图
//   （那会占着 IPC 最久 33 分钟、agent 拿不回控制权，实测 209s 静默）。
// - 改为：主进程先 `create()` 登记任务并拿到 taskId → 通过 `router.call` 把任务
//   「踢」给渲染层（渲染层秒回 ack，不阻塞）→ 渲染层后台跑完后用 `image:task-update`
//   广播终态回来 → 主进程 `applyUpdate()` 把状态写进任务表并唤醒长轮询者。
// - `generate_image` / `check_image_task` 只对本任务表做服务端长轮询
//   （`waitForTerminal`），形态与 `check_video_task` 一致。
//
// 关键安全性：渲染层的 `beginImageGeneration → resolveImageGeneration` 是独立链路，
// 图片无论 agent 是否轮询都会出现在用户聊天里——这消除了视频 v1「提交即回 + 轮询」
// 里『codex 提前弃坑 → 结果丢失』的根本风险（见 videoTools.ts 设计史）。

import { randomUUID } from 'node:crypto'
import type { ImageTaskUpdate } from '../../../types/agent'

export type ImageTaskStatus = 'running' | 'succeeded' | 'failed'

/**
 * 'single' = generate_image(一次渲染,result 是渲染层 generate result);
 * 'batch'  = generate_images(一批渲染,result 是 { successes, failures, savedPaths }).
 * check_image_task 据此决定用单图还是批量 banner 回包。
 */
export type ImageTaskKind = 'single' | 'batch'

export interface ImageTaskState {
  taskId: string
  status: ImageTaskStatus
  kind: ImageTaskKind
  prompt: string
  /** 发起请求的 db thread id（并行聊天归位用；渲染层另有同值，主进程仅留作 debug）。 */
  threadId?: string
  createdAt: number
  settledAt?: number
  /**
   * single: 渲染层 generate result { ok, count, model, historyId, paths, persistencePending? }。
   * batch:  { successes: unknown[], failures: {index,error}[], savedPaths: string[] }。
   */
  result?: unknown
  error?: string
}

/** 终态任务保留多久后回收（与视频任务一致：app 重启 / ~30 分钟后丢弃）。 */
const TASK_TTL_AFTER_TERMINAL_MS = 30 * 60_000

/**
 * running 任务的最长存活时间（与 Seedance 的 30 分钟轮询上限对齐）。
 *
 * 终态回报只靠一条无 ack 的 renderer→main `image:task-update` IPC。若渲染进程在
 * 广播前重载/崩溃（图片可能已经渲染并显示给用户了），主进程任务表会永远停在
 * running —— 模型每 ~25s 轮询一次 check_image_task 直到 codex 2000s 工具超时，
 * 用户视角就是「图早出来了 agent 还卡着」。超过上限即判定终态丢失，自动转
 * failed 并给出「先跟用户确认、勿盲目重提交」的指引。
 */
const MAX_RUNNING_MS = 30 * 60_000

/** 终态丢失时的兜底错误文案（banner 会原样带给模型）。 */
export const IMAGE_TASK_TIMEOUT_ERROR =
  'Task timed out after 30 minutes without a terminal report. The image may have ALREADY been rendered and shown in the chat — ask the user to confirm before doing anything else, and do NOT blindly resubmit (that could create a duplicate).'

export class ImageTaskManager {
  private tasks = new Map<string, ImageTaskState>()
  /** 每个 taskId 上等待终态的唤醒回调（长轮询用）。 */
  private waiters = new Map<string, Set<() => void>>()

  /** 登记一个 running 任务，返回新 taskId。 */
  create(prompt: string, kind: ImageTaskKind = 'single', threadId?: string): string {
    this.gc()
    const taskId = randomUUID()
    this.tasks.set(taskId, { taskId, status: 'running', kind, prompt, threadId, createdAt: Date.now() })
    return taskId
  }

  /**
   * 应用来自渲染层的 `image:task-update` 终态广播：回写任务表并唤醒所有 waiter。
   * 未知 / 已终态的 taskId 安全忽略（settle 内部已做幂等保护）。
   */
  applyUpdate(update: ImageTaskUpdate): void {
    if (!update || typeof update.taskId !== 'string') return
    if (update.status === 'failed') {
      this.settle(update.taskId, 'failed', {
        error: typeof update.error === 'string' && update.error.length > 0 ? update.error : 'Image generation failed',
      })
    } else {
      this.settle(update.taskId, 'succeeded', { result: update.result })
    }
  }

  /** 渲染层 ack 失败（根本没跑起来）时由调用方直接判失败。 */
  fail(taskId: string, error: string): void {
    this.settle(taskId, 'failed', { error })
  }

  private settle(
    taskId: string,
    status: Exclude<ImageTaskStatus, 'running'>,
    patch: { result?: unknown; error?: string },
  ): void {
    const task = this.tasks.get(taskId)
    if (!task || task.status !== 'running') return
    task.status = status
    task.settledAt = Date.now()
    if (patch.result !== undefined) task.result = patch.result
    if (patch.error !== undefined) task.error = patch.error
    const waiters = this.waiters.get(taskId)
    if (waiters) {
      this.waiters.delete(taskId)
      for (const wake of waiters) wake()
    }
  }

  get(taskId: string): ImageTaskState | undefined {
    this.expireIfOverdue(this.tasks.get(taskId))
    return this.tasks.get(taskId)
  }

  /** running 超过 MAX_RUNNING_MS ⇒ 终态广播已丢失，就地判失败（幂等，settle 内部有保护）。 */
  private expireIfOverdue(task: ImageTaskState | undefined): void {
    if (!task || task.status !== 'running') return
    if (Date.now() - task.createdAt > MAX_RUNNING_MS) {
      this.settle(task.taskId, 'failed', { error: IMAGE_TASK_TIMEOUT_ERROR })
    }
  }

  /**
   * 服务端长轮询：任务一变终态立即返回；否则最多等 timeoutMs 返回当前快照。
   * taskId 未知返回 undefined（调用方给 unknown banner）。
   */
  async waitForTerminal(taskId: string, timeoutMs: number): Promise<ImageTaskState | undefined> {
    const task = this.tasks.get(taskId)
    if (!task) return undefined
    this.expireIfOverdue(task)
    if (task.status !== 'running') return task

    await new Promise<void>((resolve) => {
      let settled = false
      const wake = (): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.waiters.get(taskId)?.delete(wake)
        resolve()
      }
      const timer = setTimeout(wake, timeoutMs)
      let set = this.waiters.get(taskId)
      if (!set) {
        set = new Set()
        this.waiters.set(taskId, set)
      }
      set.add(wake)
    })

    return this.tasks.get(taskId)
  }

  private gc(): void {
    const now = Date.now()
    for (const [id, task] of this.tasks) {
      if (task.settledAt && now - task.settledAt > TASK_TTL_AFTER_TERMINAL_MS) {
        this.tasks.delete(id)
      }
    }
  }
}

/** 进程级单例（跨 MCP session 复用，与视频 seedance taskManager 一致）。 */
export const imageTaskManager = new ImageTaskManager()
