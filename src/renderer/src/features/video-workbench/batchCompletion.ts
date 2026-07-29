/**
 * 「批次完成」感知 —— 工作台把一批卡片跑完后主动推给 agent，替代让模型轮询。
 *
 * 为什么不轮询：`video_workbench_start` 一返回 agent 的 turn 就结束了（刻意的，
 * 见 store.startCards 里那段注释）。若让模型循环调 `video_workbench_status`，
 * 每次等待都变成一次工具调用，而工具调用在飞的时候模型不推理、用户排队的
 * turn/steer 也进不来 —— 又回到「启动后卡住，没法说话」。所以改成推送：这里盯着
 * 卡片状态，批次全部落终态时投一条摘要给 agent 侧。
 *
 * 分层：本模块只依赖工作台 store（卡片状态的单一真相源），投递方式由调用方注入
 * （agent-chat 在 mount 时接线）。工作台不反向 import agent-chat。
 *
 * 登记表**跨重启存活**（落 localStorage，见 AGENT_BATCH_STORAGE_KEY）：一次推送
 * 是对模型许下的承诺（「不要轮询，跑完会推给你」），进程重启不能把它吞掉。
 */

import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { isActiveStatus } from './cardSpec'
import { useVideoWorkbenchStore } from './store'

/** 摘要里最多列几张卡 —— 上下文体积纪律，其余只进计数。 */
const MAX_LISTED = 12

/**
 * 登记表的落盘位置。**必须跨重启存活**：渲染要几分钟，用户中途重启是常事，
 * 而 `video_workbench_start` 的横幅明说了「不要轮询，跑完会推给你」—— 那是一句
 * 承诺。重启把登记吞掉的话，重启接管（reconcileInFlight）照样能把卡片跑到终态，
 * 但推送永不触发，agent 会永远静默等待，用户还得自己去捅它。
 *
 * 用 localStorage 而不是往卡片上加字段：批次归属是会话级的投递意图，不是卡片
 * 规格的一部分，塞进卡片就得连带回答「要不要进 IR / 算不算 specEquals」。
 * 与 ACTIVE_BOARD_KEY 同款（都是工作台的会话级小状态）。
 */
export const AGENT_BATCH_STORAGE_KEY = 'catimation.workbench.agentBatches'

/**
 * 恢复时的保质期。过了这么久还没结算的批次直接丢：那时候再报「批次渲染完成」
 * 已经是噪音，而且这也顺手给登记表封了顶 —— 万一有批次因为某张卡永远不落终态
 * 而卡住，它不会在 localStorage 里长住。
 */
const BATCH_TTL_MS = 24 * 60 * 60 * 1000

export interface WorkbenchBatchNotice {
  /** 发起这一批的线程；缺省时由 agent-chat 落到当前活跃线程。 */
  threadId?: string
  total: number
  succeeded: number
  failed: number
  cancelled: number
  /** 可直接注入模型的中文摘要。 */
  text: string
}

interface PendingBatch {
  threadId?: string
  cardIds: string[]
  /** 登记时刻,用于恢复时按 BATCH_TTL_MS 丢弃过期批次。 */
  createdAt: number
}

let batches: PendingBatch[] = []
let deliver: ((notice: WorkbenchBatchNotice) => void) | null = null

/** 落盘那份才是真相,内存只是缓存 —— 于是重复挂载不会把同一批记两遍。 */
function persistBatches(): void {
  try {
    if (batches.length === 0) globalThis.localStorage?.removeItem(AGENT_BATCH_STORAGE_KEY)
    else globalThis.localStorage?.setItem(AGENT_BATCH_STORAGE_KEY, JSON.stringify(batches))
  } catch {
    // localStorage 不可用时仅内存生效(与 store 的 writeActiveBoard 同款)
  }
}

function loadBatches(): PendingBatch[] {
  let raw: string | null = null
  try {
    raw = globalThis.localStorage?.getItem(AGENT_BATCH_STORAGE_KEY) ?? null
  } catch {
    return []
  }
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    const now = Date.now()
    return parsed.filter((b): b is PendingBatch => {
      if (!b || typeof b !== 'object') return false
      const batch = b as Partial<PendingBatch>
      if (!Array.isArray(batch.cardIds) || !batch.cardIds.every((x) => typeof x === 'string')) return false
      if (typeof batch.createdAt !== 'number') return false
      return now - batch.createdAt < BATCH_TTL_MS
    })
  } catch {
    // 只有我们自己写这个键,解不开说明写坏了 —— 按「没有待推批次」处理,别拖垮挂载
    console.warn('[VideoWorkbench] 批次登记表读取失败,已忽略')
    return []
  }
}

/** 卡片已经不在飞：终态（succeeded/failed/cancelled）或已被删除。 */
function isSettled(card: VideoWorkbenchCard | undefined): boolean {
  if (!card) return true
  return !isActiveStatus(card.status) && card.status !== 'draft'
}

function summarize(cards: VideoWorkbenchCard[]): string {
  const succeeded = cards.filter((c) => c.status === 'succeeded')
  const failed = cards.filter((c) => c.status === 'failed')
  const cancelled = cards.filter((c) => c.status === 'cancelled')

  const head = [
    `${succeeded.length} 张成功`,
    ...(failed.length > 0 ? [`${failed.length} 张失败`] : []),
    ...(cancelled.length > 0 ? [`${cancelled.length} 张已取消`] : []),
  ].join('、')

  const lines: string[] = []
  // 失败/取消优先列全（可执行信息：错误原因决定要不要改参数重试）；
  // 成功的补在后面，带落盘路径。
  for (const card of [...failed, ...cancelled, ...succeeded]) {
    if (lines.length >= MAX_LISTED) break
    if (card.status === 'succeeded') {
      const where = card.remoteUrl ?? card.localPath
      lines.push(`- ✅ ${card.id}${where ? ` → ${where}` : ''}`)
    } else {
      const label = card.status === 'failed' ? '❌' : '⛔'
      lines.push(`- ${label} ${card.id}：${card.error ?? '无错误信息'}`)
    }
  }
  const omitted = cards.length - lines.length
  if (omitted > 0) lines.push(`- …另有 ${omitted} 张，用 video_workbench_status 查看`)

  return [
    `[视频工作台] 批次渲染完成：${head}（共 ${cards.length} 张）。`,
    ...lines,
    '成品已在工作台页面播放，并已存本地 + COS。不要重复提交；'
      + '要向用户汇报就直接用这里的信息，需要更多细节再调 video_workbench_status。',
  ].join('\n')
}

/**
 * 登记一批「由 agent 启动」的卡片。批次内全部落终态时推送一次，随后自动注销。
 * 用户在页面上手点启动的卡片不登记 —— 他自己看得见结果，不必打扰模型。
 */
export function registerAgentBatch(cardIds: string[], threadId?: string): void {
  if (cardIds.length === 0) return
  batches.push({ threadId, cardIds: [...cardIds], createdAt: Date.now() })
  persistBatches()
  // 立刻结算一次：提交可能同步失败（preload 桥缺失、gate 拦下），
  // 那种情况下 zustand 不会再有变更事件来触发 watcher。
  settle()
}

/** 把已经跑完的批次投递出去。每个批次只投一次。 */
function settle(): void {
  if (batches.length === 0) return
  const state = useVideoWorkbenchStore.getState()
  // 水合之前 store 里一张卡都没有,而「查不到的卡」算已结算(为的是整批被删时
  // 静默丢弃)。两条一叠,重启恢复的批次会在读库前被判成「跑完了且无可汇报」而
  // 丢掉 —— 正是这个函数要救的那条路径。所以先等卡片读回来。
  if (!state.hydrated) return
  const byId = new Map(state.cards.map((c) => [c.id, c]))
  const remaining: PendingBatch[] = []

  for (const batch of batches) {
    const tracked = batch.cardIds.map((id) => byId.get(id))
    if (!tracked.every(isSettled)) {
      remaining.push(batch)
      continue
    }
    const present = tracked.filter((c): c is VideoWorkbenchCard => c !== undefined)
    // 整批都被删了：没有可汇报的内容，静默丢弃。
    if (present.length === 0) continue
    deliver?.({
      ...(batch.threadId ? { threadId: batch.threadId } : {}),
      total: present.length,
      succeeded: present.filter((c) => c.status === 'succeeded').length,
      failed: present.filter((c) => c.status === 'failed').length,
      cancelled: present.filter((c) => c.status === 'cancelled').length,
      text: summarize(present),
    })
  }
  if (remaining.length === batches.length) return
  // 只在真有批次出清时落盘:store 每秒都有进度广播,不能每次都写 localStorage。
  batches = remaining
  persistBatches()
}

/**
 * 接线投递通道并开始盯卡片状态。订阅整个 store 而不是逐个改写终态的地方
 * （applyTaskUpdate / submit 的 then+catch / writeCancelled / cancelCards…），
 * 一个钩子覆盖所有落终态的路径，不会漏。
 */
export function mountWorkbenchBatchWatcher(
  onBatchDone: (notice: WorkbenchBatchNotice) => void,
): () => void {
  deliver = onBatchDone
  // 恢复上一个进程留下的未履行承诺。直接整份替换而不是 merge:本进程登记的批次
  // 同样已经落盘,读回来就是全集 —— 于是重复挂载也不会把批次记两遍。
  batches = loadBatches()
  const unsubscribe = useVideoWorkbenchStore.subscribe(() => settle())
  // 挂载时卡片可能已经水合完(挂载顺序不保证在读库之前),先结算一次;
  // 没水合的话这一次是空转,水合落地时订阅会再叫一遍。
  settle()
  return () => {
    unsubscribe()
    deliver = null
  }
}

/** 测试用：清空登记的批次（含落盘那份）与投递通道。 */
export function __resetWorkbenchBatches(): void {
  batches = []
  deliver = null
  try {
    globalThis.localStorage?.removeItem(AGENT_BATCH_STORAGE_KEY)
  } catch {
    // 同上
  }
}
