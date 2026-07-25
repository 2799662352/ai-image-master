// src/renderer/src/features/video-workbench/workbenchHistory.ts
/**
 * 撤销/重做的纯逻辑:抓意图快照 + 算还原计划。不碰 store 也不碰 IndexedDB。
 *
 * ## 为什么按 revision 抓快照
 *
 * `revision` 的递增条件已经精确等于「编排意图变了」—— 建页/改卡/排序/applyIR 递增,
 * 生成状态回流(applyTaskUpdate / 提交 / 取消)刻意不递增。所以订阅 revision 变化
 * 就自动得到了正确的撤销粒度,不需要在十几个 action 里逐个埋点(埋点必然漏)。
 *
 * ## 还原只覆盖意图,不覆盖运行时
 *
 * 一张卡的 `status` / `taskId` / `videoUrl` / `localPath` / `completionTokens` 是**结果**
 * 而不是意图。如果撤销把它们一起还原,那么「改提示词 → 点生成 → 撤销」会把卡片打回
 * draft,而上游任务还在跑、还在扣费,用户却看不见它了。所以还原只写规格与位置,
 * 运行时字段一律保留当前值 —— 这条线和看板 IR 里 intent/result 的切分是同一条。
 *
 * 唯一例外是**复活**:卡片在快照里存在、现在不存在(被删了),这时只能整块用快照
 * 对象,连 `clientId` 一起。这恰好是对的 —— `applyTaskUpdate` 按 clientId/taskId 认卡,
 * 所以复活一张被误删的进行中卡片,它会自动重新接上仍在广播的那个任务。
 */

import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  WorkbenchApplySkip,
} from '../../../../types/videoWorkbench'
import { isActiveStatus, pickSpec, specEquals } from './cardSpec'
import { WORKBENCH_MAX_CARDS } from './WorkbenchDb'

/** 撤销栈深度上限。超出后丢最老的一步。 */
export const WORKBENCH_HISTORY_LIMIT = 50

/**
 * 连续同目标编辑的合并窗口(毫秒)。空闲超过这个间隔就切新的一步。
 *
 * 窗口量的是**间隔**而不是总时长:连续打字会一直续上,停手才断。这和文本编辑器
 * 的直觉一致 —— 打完一句停一下,再按撤销退掉的是那一句,不是最后一个字。
 */
export const WORKBENCH_COALESCE_MS = 600

/** 上一次入栈的合并标记。key 为 null 表示那一步不可被后续合并。 */
export interface HistoryCursor {
  key: string | null
  at: number
}

/** 记账字段,不是内容 —— 不能参与「改了哪些字段」的判断。 */
const VOLATILE_CARD_KEYS = new Set(['updatedAt', 'rev'])

/**
 * 从变更前后推出合并键 —— 不让 action 自己申报。
 *
 * 申报式(每个 action 传一个键)看着直接,但漏埋无法被类型系统发现,新加的 action
 * 更会忘;而且申报的是「调用方声称改了什么」,这里要的是「实际改了什么」。
 * 反推的代价只是每次变更做 O(卡片数) 次引用比较 —— store 只为真正变了的卡建新
 * 对象,所以引用不等就是变了。
 *
 * 返回 null = 这次变更自成一步,永不与相邻变更合并。批量操作(加卡/删卡/排序/
 * agent 的整板 applyIR)和页操作都落在这里,这正是想要的:它们是离散动作。
 */
export function coalesceKeyFor(prev: WorkbenchIntent, next: WorkbenchIntent): string | null {
  if (prev.activeBoardId !== next.activeBoardId) return null
  // 页数组换了引用 = 建页/删页/改名,离散动作。
  if (prev.boards !== next.boards) return null
  if (prev.cards.length !== next.cards.length) return null

  let changed = -1
  for (let i = 0; i < next.cards.length; i++) {
    if (prev.cards[i] === next.cards[i]) continue
    if (changed !== -1) return null
    changed = i
  }
  if (changed === -1) return null

  const before = prev.cards[changed]
  const after = next.cards[changed]
  // 同一个位置换成了另一张卡 —— 那是重排而不是编辑。
  if (before.id !== after.id) return null

  const fields: string[] = []
  for (const key of new Set<string>([...Object.keys(before), ...Object.keys(after)])) {
    if (VOLATILE_CARD_KEYS.has(key)) continue
    const k = key as keyof VideoWorkbenchCard
    if (before[k] !== after[k]) fields.push(key)
  }
  if (fields.length === 0) return null
  // 字段名进键:打字是 card:X:prompt,换分辨率是 card:X:resolution —— 键不同,
  // 于是下拉框那一下自然与前面那串打字分成两步。
  return `card:${after.id}:${fields.sort().join(',')}`
}

/**
 * 这次变更该并入栈顶已有的那一步,还是另起一步?
 *
 * 撤销的步边界**不能**跟着 revision 走。revision 是 IR 的并发令牌,必须每次内容
 * 变更都递增(否则 agent 能拿过期 IR 悄悄盖掉一次击键);而提示词输入框是逐字符
 * 调 updateCard 的,一条 40 字的提示词会递增 40 次 —— 直接拿它当撤销粒度,一次
 * Ctrl+Z 只退一个字,50 步的栈会被一条提示词吃光。
 *
 * 所以两者解耦:store 照旧逐次递增 revision,历史自己判断哪些相邻变更属于同一次
 * 逻辑编辑。合并键由发起方给(见 store 的 withCoalesceKey),null = 离散动作,
 * 永远自成一步 —— agent 的整板 applyIR、加卡、删卡、页操作都走这条。
 */
export function shouldCoalesce(
  cursor: HistoryCursor | null,
  key: string | null,
  now: number,
): boolean {
  if (!key || !cursor || cursor.key !== key) return false
  return now - cursor.at < WORKBENCH_COALESCE_MS
}

/**
 * 一步快照 = 那一刻的编排意图。
 *
 * 数组是浅拷贝,元素对象与 store 共享 —— store 的每次改动都产出新对象而不原地改,
 * 所以共享是安全的。这一点决定了内存开销:50 步 × 200 张卡只是一万个指针,
 * 而不是五十份几 MB 的 data: URL 素材。
 */
export interface WorkbenchIntent {
  boards: VideoWorkbenchBoard[]
  cards: VideoWorkbenchCard[]
  activeBoardId: string
}

/** planRestore 需要的 store 字段,方便测试直接喂普通对象。 */
export interface WorkbenchHistorySource extends WorkbenchIntent {
  revision: number
  structureRevision: number
}

export interface WorkbenchRestoreResult {
  ok: boolean
  /** 快照与当前意图完全一致 —— 没写任何东西,也没消耗版本号。 */
  noop: boolean
  boards: {
    /** 名字或位置被改回去的页。 */
    restored: string[]
    /** 快照之后新建、现在要删掉的页。 */
    removed: string[]
  }
  cards: {
    /** 规格或位置被改回去的卡。 */
    restored: string[]
    /** 曾被删除、现在被拉回来的卡。 */
    resurrected: string[]
    /** 快照之后新建、现在要删掉的卡。 */
    removed: string[]
  }
  skipped: WorkbenchApplySkip[]
  revision: number
}

export interface RestorePlan {
  result: WorkbenchRestoreResult
  /** 拒绝或 no-op 时缺省。 */
  next?: {
    boards: VideoWorkbenchBoard[]
    cards: VideoWorkbenchCard[]
    activeBoardId: string
    revision: number
    structureRevision: number
  }
  /** 只列真正变了的行 —— 一次撤销不该产生全量写放大。 */
  persist?: {
    cards: VideoWorkbenchCard[]
    removeCardIds: string[]
    boards: VideoWorkbenchBoard[]
    removeBoardIds: string[]
  }
}

/** 抓一份当前意图的快照(浅拷贝数组,元素共享)。 */
export function captureIntent(source: WorkbenchIntent): WorkbenchIntent {
  return {
    boards: [...source.boards],
    cards: [...source.cards],
    activeBoardId: source.activeBoardId,
  }
}

/** 把一步压进栈,超限丢最老的。返回新数组(不改入参)。 */
export function pushHistory(stack: WorkbenchIntent[], entry: WorkbenchIntent): WorkbenchIntent[] {
  const next = [...stack, entry]
  return next.length > WORKBENCH_HISTORY_LIMIT ? next.slice(next.length - WORKBENCH_HISTORY_LIMIT) : next
}

/** 什么都没做的失败结果(栈空、或计划被拒)。 */
export function refusedRestore(revision: number, reason: string): WorkbenchRestoreResult {
  return {
    ok: false,
    noop: false,
    boards: { restored: [], removed: [] },
    cards: { restored: [], resurrected: [], removed: [] },
    skipped: [{ reason }],
    revision,
  }
}

function reject(source: WorkbenchHistorySource, skipped: WorkbenchApplySkip[]): RestorePlan {
  return {
    result: { ...refusedRestore(source.revision, ''), skipped },
  }
}

const byOrder = (a: { order: number }, b: { order: number }): number => a.order - b.order

/**
 * 算出「把工作台还原成 snapshot 的意图」这一步要写什么。纯函数。
 *
 * 与 planApplyIR 共用同一套硬门:在飞的卡不删(停到第一页末尾并报告)、
 * 渲染中的卡规格定格(位置照样还原)、超上限直接拒绝而不是静默淘汰。
 */
export function planRestore(
  source: WorkbenchHistorySource,
  snapshot: WorkbenchIntent,
): RestorePlan {
  const skipped: WorkbenchApplySkip[] = []
  const now = Date.now()

  if (!snapshot || !Array.isArray(snapshot.boards) || snapshot.boards.length === 0) {
    return reject(source, [{ reason: '快照里没有页,拒绝还原(否则会清空工作台)' }])
  }

  const curCardById = new Map(source.cards.map((c) => [c.id, c]))
  const curBoardById = new Map(source.boards.map((b) => [b.id, b]))

  // ---- 页:快照说了算,order 重新压实 ----
  const finalBoards = [...snapshot.boards]
    .sort(byOrder)
    .map((b, i) => (b.order === i ? b : { ...b, order: i }))
  const snapshotBoardIds = new Set(finalBoards.map((b) => b.id))
  const removeBoardIds = source.boards.filter((b) => !snapshotBoardIds.has(b.id)).map((b) => b.id)
  const boardsToPersist = finalBoards.filter((b) => {
    const cur = curBoardById.get(b.id)
    return !cur || cur.name !== b.name || cur.order !== b.order
  })
  const restoredBoards = boardsToPersist.map((b) => b.id)

  // ---- 卡:逐页按快照顺序装回去 ----
  const nextCards: VideoWorkbenchCard[] = []
  const persistCards: VideoWorkbenchCard[] = []
  const restoredCards: string[] = []
  const resurrectedCards: string[] = []
  const snapshotCardIds = new Set<string>()

  /** 位置变了就重写 order/boardId,顺带记账。 */
  const placeExisting = (
    cur: VideoWorkbenchCard,
    boardId: string,
    index: number,
    account: string[] | null,
  ): VideoWorkbenchCard => {
    if (cur.boardId === boardId && cur.order === index) return cur
    const next = { ...cur, boardId, order: index }
    if (account) account.push(cur.id)
    persistCards.push(next)
    return next
  }

  for (const board of finalBoards) {
    const snapCards = snapshot.cards.filter((c) => c.boardId === board.id).sort(byOrder)
    let index = 0
    for (const snap of snapCards) {
      if (snapshotCardIds.has(snap.id)) continue
      snapshotCardIds.add(snap.id)
      const cur = curCardById.get(snap.id)

      if (!cur) {
        // 复活:整块用快照对象(含 clientId/taskId/status),见文件头说明。
        // rev 例外 —— 见下面还原分支的说明,它只能往上走。
        const next: VideoWorkbenchCard = {
          ...snap,
          boardId: board.id,
          order: index,
          updatedAt: now,
          rev: (snap.rev ?? 0) + 1,
        }
        resurrectedCards.push(snap.id)
        persistCards.push(next)
        nextCards.push(next)
        index += 1
        continue
      }

      const spec = pickSpec(snap)
      if (specEquals(cur, spec)) {
        nextCards.push(placeExisting(cur, board.id, index, restoredCards))
        index += 1
        continue
      }
      if (isActiveStatus(cur.status)) {
        // 提交上去的参数已经定格,回滚规格只会让卡片显示的参数与实际产出对不上。
        skipped.push({ cardId: cur.id, reason: '卡片正在生成,规格已定格不可回滚(位置已还原)' })
        nextCards.push(placeExisting(cur, board.id, index, restoredCards))
        index += 1
        continue
      }
      // seed 是规格里唯一可缺省的字段:先摘掉再铺快照规格,快照里没种子才能
      // 真的还原成随机,而不是被当前值顶回来。
      const { seed: _dropped, ...rest } = cur
      const next: VideoWorkbenchCard = {
        ...rest,
        ...spec,
        boardId: board.id,
        order: index,
        updatedAt: now,
        // rev 只能单调递增,**不能**跟着快照回退:否则一个 agent 手里那份「撤销
        // 之前导出的」IR 会看到匹配的 rev 而校验通过,把已经被撤销掉的内容悄悄
        // 写回来 —— 并发令牌的意义正是防这个。
        rev: (cur.rev ?? 0) + 1,
      }
      restoredCards.push(cur.id)
      persistCards.push(next)
      nextCards.push(next)
      index += 1
    }
  }

  // ---- 快照里没有的卡 = 快照之后新建的,要删 ----
  const removeCardIds: string[] = []
  const orphanInFlight: VideoWorkbenchCard[] = []
  for (const cur of source.cards) {
    if (snapshotCardIds.has(cur.id)) continue
    if (isActiveStatus(cur.status)) {
      // 正在跑的任务绝不因为一次撤销消失 —— 上游还在扣费,用户得看得见它。
      skipped.push({ cardId: cur.id, reason: '卡片正在生成,拒绝删除(已保留在页面上)' })
      orphanInFlight.push(cur)
      continue
    }
    removeCardIds.push(cur.id)
  }
  if (orphanInFlight.length > 0) {
    const host = finalBoards[0].id
    let index = nextCards.filter((c) => c.boardId === host).length
    for (const cur of orphanInFlight) {
      nextCards.push(placeExisting(cur, host, index, null))
      index += 1
    }
  }

  if (nextCards.length > WORKBENCH_MAX_CARDS) {
    return reject(source, [
      ...skipped,
      {
        reason:
          `还原后会有 ${nextCards.length} 张卡,超过上限 ${WORKBENCH_MAX_CARDS}。`
          + '先删一些卡再撤销 —— 硬写下去会静默淘汰用户的旧卡。',
      },
    ])
  }

  // 优先回到快照那一刻看的页 —— 撤销要看得见效果,否则「删页 → 撤销」会停在
  // 别的页上,用户以为没生效。快照的页没了(理论上不会)才退回当前页/第一页。
  const activeBoardId = snapshotBoardIds.has(snapshot.activeBoardId)
    ? snapshot.activeBoardId
    : snapshotBoardIds.has(source.activeBoardId)
      ? source.activeBoardId
      : finalBoards[0].id

  // 还原几乎必然动到结构(位置/集合/页),规格回滚也一并算 —— 撤销之后 agent
  // 手里的整份 IR 本来就该作废,而不是「除了这张卡以外还能写」。
  const changed =
    restoredBoards.length > 0
    || removeBoardIds.length > 0
    || restoredCards.length > 0
    || resurrectedCards.length > 0
    || removeCardIds.length > 0
    || activeBoardId !== source.activeBoardId

  const result: WorkbenchRestoreResult = {
    ok: true,
    noop: !changed,
    boards: { restored: restoredBoards, removed: removeBoardIds },
    cards: {
      restored: [...new Set(restoredCards)],
      resurrected: resurrectedCards,
      removed: removeCardIds,
    },
    skipped,
    revision: changed ? source.revision + 1 : source.revision,
  }
  if (!changed) return { result }

  return {
    result,
    next: {
      boards: finalBoards,
      cards: nextCards,
      activeBoardId,
      revision: result.revision,
      structureRevision: source.structureRevision + 1,
    },
    persist: { cards: persistCards, removeCardIds, boards: boardsToPersist, removeBoardIds },
  }
}
