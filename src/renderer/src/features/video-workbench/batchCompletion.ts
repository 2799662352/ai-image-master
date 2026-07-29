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
 */

import type { VideoWorkbenchCard } from '../../../../types/videoWorkbench'
import { isActiveStatus } from './cardSpec'
import { useVideoWorkbenchStore } from './store'

/** 摘要里最多列几张卡 —— 上下文体积纪律，其余只进计数。 */
const MAX_LISTED = 12

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
}

let batches: PendingBatch[] = []
let deliver: ((notice: WorkbenchBatchNotice) => void) | null = null

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
  batches.push({ threadId, cardIds: [...cardIds] })
  // 立刻结算一次：提交可能同步失败（preload 桥缺失、gate 拦下），
  // 那种情况下 zustand 不会再有变更事件来触发 watcher。
  settle()
}

/** 把已经跑完的批次投递出去。每个批次只投一次。 */
function settle(): void {
  if (batches.length === 0) return
  const cards = useVideoWorkbenchStore.getState().cards
  const byId = new Map(cards.map((c) => [c.id, c]))
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
  batches = remaining
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
  const unsubscribe = useVideoWorkbenchStore.subscribe(() => settle())
  return () => {
    unsubscribe()
    deliver = null
  }
}

/** 测试用：清空登记的批次与投递通道。 */
export function __resetWorkbenchBatches(): void {
  batches = []
  deliver = null
}
