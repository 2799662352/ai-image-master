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

import { SeedanceApiError } from './client'
import type { SeedanceClient } from './client'
import type {
  CreateVideoTaskInput,
  SeedanceCancelResult,
  SeedanceCreateTaskBody,
  SeedanceContentItem,
  SeedanceModelAlias,
  SeedanceTaskState,
  SeedanceTaskStatus,
  SeedanceTaskUpdate,
  VideoBillingSource,
} from './types'
import { validateSeedanceRequest } from './types'
import {
  createSeedanceTransport,
  transportFor,
  type VideoTransport,
} from '../videoTransport'

/** content[] 里某类素材的条数 —— 校验按真正会发出去的东西算，而不是入参字段。 */
function countContent(
  content: SeedanceContentItem[],
  type: 'image_url' | 'video_url' | 'audio_url',
): number {
  return content.filter((item) => item.type === type).length
}

/** 上游轮询间隔。文档建议 5~10s。 */
const POLL_INTERVAL_MS = 6_000
/** 连续失败退避的上限：再糟也至少每分钟探一次。 */
const POLL_BACKOFF_CAP_MS = 60_000
/** 单任务轮询上限（30 分钟），防上游悬死导致永久轮询。 */
const POLL_TIMEOUT_MS = 30 * 60_000
/** 终态任务保留时长，之后从 Map 清理。 */
const RETENTION_MS = 30 * 60_000
/**
 * 落盘失败后的后台重试间隔(分钟级)。
 *
 * 上游地址有效期一天(`X-Tos-Expires=86400`),而原来只在几秒内试三次就永久判死 ——
 * 一次几十秒的抖动就足以让本地和 COS 都没副本,只剩这条会过期的地址。
 *
 * 排到 21 分钟为止而不是铺满一天:任务在 `RETENTION_MS`(30 分钟)后会从 Map 里
 * 清掉,更晚的重试会扑空。要覆盖更长窗口得先把任务状态持久化,那是另一件事。
 */
const PERSIST_RETRY_DELAYS_MS = [60_000, 5 * 60_000, 15 * 60_000] as const

export interface SeedanceTaskManagerDeps {
  client: SeedanceClient
  getApiKey: () => string
  /**
   * 万相（Miau）的传输层。缺省时万相模型会回落到 Seedance 那条路 —— 只有还没
   * 接线的调用方（老测试）会走到，见 `transportFor`。
   */
  wan3Transport?: VideoTransport
  /**
   * 平台余额下的 Seedance（经 Miau 网关）。缺省时按平台余额提交会**抛错**而不是
   * 回落 —— 见 `transportFor` 里那条不能回落的分支。
   */
  seedanceGatewayTransport?: VideoTransport
  /**
   * 没有显式意向时，这一次算平台余额还是自填 Key。
   *
   * 注入而不是自己去读:判据是「主进程手上有没有平台影子 token」,读它要碰
   * `auth/gatewayToken`,而本类是纯状态机(单测里不该拉起 electron)。真正的
   * 判据函数是 `seedanceGateway/credentials.ts` 的 `resolveSeedanceGatewayToken`
   * —— 路由与取 token 必须是**同一个**结论,所以那边也用它。
   *
   * 缺省 = 一律自填 Key,与接入网关之前逐字节相同。
   */
  resolveBilling?: (prefer?: VideoBillingSource) => VideoBillingSource
  /**
   * 把上游裸错误翻成人话。缺省 = 原样透出。
   *
   * 注入而不是直接 import：本类是状态机，不该知道有哪些 provider、更不该按
   * provider 挑翻译表。轮询失败这条路原先完全没翻译 —— 而它恰恰是上游错误
   * 最常出现的地方（提交只走一次，轮询要走几十次）。
   */
  translateError?: (raw: string) => string
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
  /** 注入随机源（退避抖动）便于单测精确断言等待时长。 */
  random?: () => number
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
  /**
   * 这一次的钱从哪出。**工作台那条路必须显式带**（值来自渲染层的
   * `useQuotaStore.billingSource`）；MCP 那条路没有渲染层，缺省交给
   * `deps.resolveBilling` 兜底。理由见 `seedanceGateway/credentials.ts`
   * 的「已知缺口」：主进程的 activePool 只是渲染层状态的镜像，可能落后。
   */
  billing?: VideoBillingSource
}

/**
 * 重启接管参数。任务表是纯内存的，应用重启后就空了 —— 但上游任务还在跑。
 * 渲染端（工作台卡片持久化在 IndexedDB）启动时把进行中的 taskId 连同重建
 * 状态所需的元数据送回来，`adopt()` 重新登记并恢复轮询，结果照旧走
 * persistVideo + broadcast 的正常回流路径（含写历史）。
 */
export interface AdoptParams {
  taskId: string
  clientId?: string
  source?: 'workbench'
  threadId?: string
  prompt: string
  model: SeedanceModelAlias
  resolution: string
  ratio: string
  duration: number
  /** 原提交时间，用于 UI 显示真实总耗时；缺省用当前时间。 */
  createdAt?: number
  /**
   * 原提交时的计费模式。**接管必须带**：重启后恢复的轮询要打回同一条上游，
   * 缺了它一条平台任务会被拿 vvdance key 去查，回一句「任务不存在」。
   * 缺省 = 自填 Key（接网关之前建的任务都是这样）。
   */
  billing?: VideoBillingSource
}

export class SeedanceTaskManager {
  private tasks = new Map<string, SeedanceTaskState>()
  private waiters = new Map<string, Array<() => void>>()
  private timers = new Map<string, NodeJS.Timeout>()

  constructor(private deps: SeedanceTaskManagerDeps) {}

  /**
   * 这个模型 + 这种计费模式该走哪条传输层。**本类里唯一与 provider 有关的一行**
   * —— 提交、轮询、取消都经由它，此后代码不再区分 provider（见 videoTransport.ts
   * 的文件头）。
   *
   * `billing` 由调用方给到底、途中不许有默认值：提交时定下的那个值被写进任务
   * 状态，轮询与取消再原样取回来。三处给的必须是同一个值，否则就是「按平台余额
   * 建的任务，拿自填 Key 去查」。
   */
  private transport(
    model: SeedanceModelAlias | undefined,
    billing: VideoBillingSource | undefined,
  ): VideoTransport {
    return transportFor(
      {
        seedance: createSeedanceTransport(this.deps.client, this.deps.getApiKey),
        ...(this.deps.wan3Transport ? { wan3: this.deps.wan3Transport } : {}),
        ...(this.deps.seedanceGatewayTransport
          ? { seedanceGateway: this.deps.seedanceGatewayTransport }
          : {}),
      },
      model,
      { ...(billing ? { billing } : {}) },
    )
  }

  /** 显式意向优先；没有就问兜底；连兜底都没注入就是自填 Key（老行为）。 */
  private billingFor(prefer: VideoBillingSource | undefined): VideoBillingSource {
    return this.deps.resolveBilling ? this.deps.resolveBilling(prefer) : (prefer ?? 'own-key')
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now()
  }

  private random(): number {
    return this.deps.random ? this.deps.random() : Math.random()
  }

  /** 上游裸错误 → 人话。没注入翻译器就原样透出。 */
  private humanError(raw: string): string {
    return this.deps.translateError ? this.deps.translateError(raw) : raw
  }

  /**
   * 查询失败后到下一次重试的等待时长。
   * - 上游给了 Retry-After 就听它的（限流场景，别自作聪明）；
   * - 第一次失败保持基础节奏 —— 单次网络抖动应当快速恢复；
   * - 之后 ×1.5 递增并叠加至多 25% 抖动：工作台是批量场景，几十个任务同时提交
   *   会几乎同步轮询，上游一故障就变成同步重试的惊群，抖动把它们打散。
   */
  private retryDelayMs(consecutiveFailures: number, error: unknown): number {
    const retryAfterMs = error instanceof SeedanceApiError ? error.retryAfterMs : undefined
    if (typeof retryAfterMs === 'number') {
      return Math.min(Math.max(retryAfterMs, POLL_INTERVAL_MS), POLL_BACKOFF_CAP_MS)
    }
    if (consecutiveFailures <= 1) return POLL_INTERVAL_MS
    const backoff = Math.min(POLL_INTERVAL_MS * 1.5 ** (consecutiveFailures - 1), POLL_BACKOFF_CAP_MS)
    return Math.round(backoff * (1 + 0.25 * this.random()))
  }

  async submit(params: SubmitParams): Promise<SeedanceTaskState> {
    const { input, content, threadId } = params
    const model: SeedanceModelAlias = input.model ?? '2.0'
    // 意向只在这里落一次锤,之后整条任务的生命周期都用这个值 —— 用户中途切了
    // 计费来源不该让一条已经在上游跑着的任务换一条路去轮询。
    const billing = this.billingFor(params.billing)
    // 密钥检查交给这条路自己的 transport —— 只配了 Miau 密钥的用户生成万相时,
    // 不该被要求去配一个用不到的火山密钥。
    this.transport(model, billing).requireApiKey()

    const resolution = input.resolution ?? '720p'
    const duration = input.duration ?? 5
    const taskMode = input.taskMode

    // 提交前按模型能力自查。上游对 4k 配 2.5、30 秒配 2.0、edit 不带视频都会 400,
    // 但那时用户已经等过一次网络往返、看到的是一张失败卡片。
    const errors = validateSeedanceRequest(model, {
      duration,
      resolution,
      taskMode,
      images: countContent(content, 'image_url'),
      videos: countContent(content, 'video_url'),
      audios: countContent(content, 'audio_url'),
    })
    if (errors.length > 0) throw new Error(errors.join('；'))

    // edit / extend 由上游强制 adaptive（文档 4.9）—— 与其让它悄悄改写我们传的
    // 比例、再让 UI 显示一个与成片不符的值，不如提交时就写成真实生效的那个。
    const ratio = taskMode ? 'adaptive' : (input.ratio ?? '16:9')

    // 组包归传输层 —— 两家 provider 的请求体毫无共同点,这里只交出已解析的事实。
    const { id } = await this.transport(model, billing).createTask({
      input,
      content,
      model,
      resolution,
      ratio,
      duration,
      ...(taskMode ? { taskMode } : {}),
    })
    const state: SeedanceTaskState = {
      taskId: id,
      clientId: params.clientId,
      ...(params.source ? { source: params.source } : {}),
      billing,
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

  /**
   * 重新接管一个仍在上游跑的任务（应用重启后的对账入口）。已在跟踪则返回
   * undefined 且不做任何事 —— 幂等，绝不起第二个轮询循环。
   */
  adopt(params: AdoptParams): SeedanceTaskState | undefined {
    if (this.tasks.has(params.taskId)) return undefined
    const now = this.now()
    const state: SeedanceTaskState = {
      taskId: params.taskId,
      ...(params.clientId ? { clientId: params.clientId } : {}),
      ...(params.source ? { source: params.source } : {}),
      ...(params.threadId ? { threadId: params.threadId } : {}),
      ...(params.billing ? { billing: params.billing } : {}),
      prompt: params.prompt,
      model: params.model,
      resolution: params.resolution,
      ratio: params.ratio,
      duration: params.duration,
      // 真实状态由首轮轮询（≤6s）纠正；此处只需一个非终态起点。
      status: 'queued',
      createdAt: params.createdAt ?? now,
      updatedAt: now,
      persistence: 'idle',
    }
    this.tasks.set(params.taskId, state)
    void this.pollLoop(params.taskId)
    return { ...state }
  }

  /**
   * 取消任务。计费语义按上游文档分档，如实回报（见 SeedanceCancelResult.billed）:
   * - `queued`：DELETE 生效 → 真取消，不计费；
   * - `running`：上游**不支持**取消 → 只能本地放弃，仍会计费（不发无谓请求）；
   * - 终态：no-op。
   */
  async cancel(taskId: string): Promise<SeedanceCancelResult> {
    const task = this.tasks.get(taskId)
    if (!task) {
      return { ok: false, billed: false, reason: '任务不在跟踪表里（可能早已完成并被清理）' }
    }
    if (task.status === 'cancelled') return { ok: false, billed: false, reason: '任务已取消' }
    if (task.status === 'succeeded') return { ok: false, billed: true, reason: '任务已完成，无可取消' }
    if (task.status === 'failed') return { ok: false, billed: false, reason: '任务已失败，无可取消' }

    let billed = true
    let reason: string | undefined
    // 建任务时用的哪条路，取消就问哪条路 —— 网关那条没有取消接口，拿 vvdance 的
    // deleteTask 去删一个网关任务只会白删，然后把「其实还在计费」报成「已取消」。
    const deleteTask = this.transport(task.model, task.billing).deleteTask
    if (task.status === 'queued' && !deleteTask) {
      // 该 provider 没有验证过的取消接口。发一个没把握的请求、再把它的失败报成
      // 「取消失败」,会让用户以为这笔钱本来能省下来 —— 如实说。
      reason = '该模型不支持取消，已停止等待结果（本次生成仍会计费）'
    } else if (task.status === 'queued' && deleteTask) {
      try {
        await deleteTask(taskId)
        billed = false
      } catch (e) {
        // 取消请求没打通 → 任务可能仍在排队并最终计费。如实上报，不假装省了钱。
        reason = `上游取消失败，本次生成可能仍会计费：${e instanceof Error ? e.message : String(e)}`
      }
    } else {
      reason = '上游不支持取消生成中的任务，已停止等待结果（本次生成仍会计费）'
    }

    this.update(taskId, { status: 'cancelled', ...(reason ? { error: reason } : {}) })
    this.scheduleCleanup(taskId)
    return { ok: true, billed, ...(reason ? { reason } : {}) }
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
    // cancelled 是终态。取消发生时可能已有一次 queryTask / persistVideo 在途，
    // 它们回来后的写入必须丢弃 —— 否则一条迟到的 succeeded 会把被取消的任务
    // 复活，进而触发落盘并写进历史页。
    if (t.status === 'cancelled' && patch.status !== 'cancelled') return
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

  /**
   * 落盘 + **跨分钟级的后台重试**。
   *
   * 为什么不能一次定生死:上游那条地址 `X-Tos-Expires=86400`,有效期整整一天,
   * 而原来只在几秒内试三次就落 `persistence:'failed'` —— 一次几十秒的网络抖动
   * (实测 `ERR_CONNECTION_CLOSED`)就足以让本地和 COS 都没有副本,只剩这条会过期
   * 的地址。用户过几个钟头回来点播放,视频就"没了",而重生成要花钱又要几分钟。
   *
   * 所以失败之后继续在后台试:1 / 5 / 15 / 30 分钟。四次机会摊在 51 分钟里,足够
   * 跨过绝大多数抖动与短时断网,又远在 24 小时窗口之内。定时器 unref,不拖住退出;
   * 卡片已经是 succeeded,重试全程不打扰用户 —— 成了就静默升级成 done。
   */
  private async persistWithRetry(taskId: string, round = 0): Promise<void> {
    const task = this.tasks.get(taskId)
    if (!task) return // 已被清理,没有必要再救
    try {
      const { localPath, remoteUrl } = await this.deps.persistVideo({ ...task })
      this.update(taskId, { persistence: 'done', localPath, remoteUrl })
      return
    } catch (e) {
      const next = PERSIST_RETRY_DELAYS_MS[round]
      console.warn(
        `[seedance] persistVideo failed (round ${round + 1}); `
        + (next ? `retrying in ${next / 60_000}min` : 'giving up, only the expiring upstream URL remains'),
        e,
      )
      // 状态照实标 failed —— 界面要能显示"没保存下来",不能因为后台还在试就假装没事。
      // 试成了会原地升级回 done。
      this.update(taskId, { persistence: 'failed' })
      if (next === undefined) return
      const timer = setTimeout(() => { void this.persistWithRetry(taskId, round + 1) }, next)
      timer.unref?.()
    }
  }

  private async pollLoop(taskId: string): Promise<void> {
    const startedAt = this.now()
    let delayMs = POLL_INTERVAL_MS
    let consecutiveFailures = 0
    let lastFailure: string | undefined

    while (true) {
      await new Promise((r) => {
        const t = setTimeout(r, delayMs)
        ;(t as NodeJS.Timeout).unref?.()
      })
      delayMs = POLL_INTERVAL_MS
      const task = this.tasks.get(taskId)
      if (!task) return // disposed / cleaned up
      if (task.status === 'cancelled') return // 已取消：停止轮询，别再花钱查

      if (this.now() - startedAt > POLL_TIMEOUT_MS) {
        // 带上最后一次失败原因：否则「上游一直 503」和「上游一直在跑」会报出
        // 同一句话，用户和日志都无法区分。
        this.update(taskId, {
          status: 'failed',
          error: lastFailure
            ? `轮询超时（30 分钟未出结果）；最后一次查询失败：${lastFailure}`
            : '轮询超时（30 分钟未出结果）',
        })
        this.scheduleCleanup(taskId)
        return
      }

      let result
      try {
        result = await this.transport(task.model, task.billing).queryTask(taskId)
      } catch (e) {
        // 密钥失效 / 参数非法 / 任务不存在：重试到 30 分钟也不会变好，而且最后只会
        // 报一句与真因无关的「轮询超时」。立刻如实失败。
        if (e instanceof SeedanceApiError && !e.retryable) {
          this.update(taskId, { status: 'failed', error: this.humanError(e.message) })
          this.scheduleCleanup(taskId)
          return
        }
        // 暂时性失败（网络抖动 / 限流 / 5xx）不判死刑，退避后继续。
        consecutiveFailures += 1
        lastFailure = e instanceof Error ? e.message : String(e)
        delayMs = this.retryDelayMs(consecutiveFailures, e)
        console.warn(`[seedance] queryTask failed (${consecutiveFailures}), retry in ${delayMs}ms:`, e)
        continue
      }
      consecutiveFailures = 0
      lastFailure = undefined

      // 上一句 await 期间用户可能点了取消 —— 结果一律作废，不落盘不写历史。
      if (this.tasks.get(taskId)?.status === 'cancelled') return

      if (result.status === 'failed') {
        const err = result.error
        this.update(taskId, {
          status: 'failed',
          error: err
            ? this.humanError(`${err.code ?? 'error'}: ${err.message ?? 'unknown'}`)
            : '生成失败（上游未给出原因）',
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
        // 顺带透传上游回传的实际 seed（可复现）与 completion_tokens（计费口径）。
        this.update(taskId, {
          status: 'succeeded',
          videoUrl,
          persistence: 'running',
          ...(typeof result.seed === 'number' ? { actualSeed: result.seed } : {}),
          ...(typeof result.usage?.completion_tokens === 'number'
            ? { completionTokens: result.usage.completion_tokens }
            : {}),
          // 按秒计费的 provider 走这条（万相）。两者互斥，谁回传谁的。
          ...(typeof result.billedSeconds === 'number' ? { billedSeconds: result.billedSeconds } : {}),
        })
        await this.persistWithRetry(taskId)
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
