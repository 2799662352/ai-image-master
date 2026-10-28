// src/renderer/src/features/video-workbench/threadObservation.ts
/**
 * 「自你上次调用以来,别人动过什么」—— 每个对话各自记一份它上次看到的工作台。
 *
 * 为什么要有:几个对话(加上用户)会同时写同一份工作台。agent 的下一次写入是基于它
 * 脑子里的旧图景做的,而光靠「写入时校验版本」只能拦住冲突的那一刻;让它在每次调用
 * 回包里顺带知道「这段时间别人改了哪几张卡」,它才能在冲突发生前就重新看一眼。
 *
 * 设计取舍(都来自对并发写入做法的调研,见 PR 描述):
 * - **只报增量,而且报一次就推进基线**:没变化时回包里没有这个字段(零体积);同一件事
 *   不会在后续每次调用里重复出现 —— 重复的提醒会被当成噪音。
 * - **只报内容,不报进度**:指纹只看规格内容(提示词 / 参数 / 素材名),不看 `rev` 和状态。
 *   `rev` 在素材转存完成这类后台事件里也会涨,状态每秒都在推进,按它们报就是满屏假警报。
 * - **只报碰过的分段**:基线按分段记。同一部剧的几集常由几个对话各填各的,对话 A 不该被
 *   对话 B 在第 2 集里的动作打扰。
 * - **只给数量和 id,不给内容**:提示词全文留给 status;这里体积恒定很小。
 * - **措辞不归因**:字段叫 `changedSinceYourLastCall`,不说是谁改的 —— 用户手改、另一个
 *   对话、后台流程都可能,猜错原因比不说更误导。
 * - 同一对话**并行发出**的几次调用互相分不清谁写的,只有「独自在飞」的那次带增量,
 *   基线在这一批全部结束后才推进。
 *
 * 纯内存,和 threadScope 一样:对话关了 / 应用重启后自然消失,下一次调用重新建基线。
 */

import type { VideoWorkbenchBoard, VideoWorkbenchCard } from '../../../../types/videoWorkbench'

/** 一次回包最多列几个 id;count 始终是真实数量。 */
export const DELTA_MAX_IDS = 8

/** 超过这么久没碰的基线直接丢掉,免得 Map 随对话数无限长。 */
const OBSERVATION_PRUNE_MS = 60 * 60 * 1000

export interface IdList {
  count: number
  ids: string[]
}

export interface WorkbenchDelta {
  added?: IdList
  removed?: IdList
  /** 规格内容变了(提示词 / 参数 / 素材)。状态推进和后台 rev 变化不算。 */
  edited?: IdList
  /** 这些分段里的卡顺序变了(卡的集合没变)。 */
  reordered?: string[]
}

interface BoardObservation {
  /** cardId → 内容指纹 */
  cards: Map<string, string>
  /** 页内顺序(cardId 列表) */
  order: string[]
}

interface Observation {
  projectId: string
  boards: Map<string, BoardObservation>
  touchedAt: number
}

/** 取快照 / 比对只需要 store 的这两个字段。 */
export interface ObservableState {
  boards: ReadonlyArray<Pick<VideoWorkbenchBoard, 'id' | 'projectId'>>
  cards: ReadonlyArray<VideoWorkbenchCard>
}

const observations = new Map<string, Observation>()
const inflight = new Map<string, number>()

export function resetThreadObservationsForTest(): void {
  observations.clear()
  inflight.clear()
}

/** FNV-1a:只用来给「内容有没有变」做指纹,不是安全哈希。 */
function fnv1a(input: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < input.length; i += 1) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(36)
}

const materialKey = (list: ReadonlyArray<{ name: string; src: string }>): string =>
  // 素材可能是几 MB 的 data: URL:指纹只取名字 + 长度,既能发现增删替换,又不必整段哈希。
  list.map((m) => `${m.name}:${m.src.length}`).join(',')

/**
 * 一张卡「内容」的指纹。刻意不含 rev / status / 结果字段 —— 见文件头。
 * 与 specEquals 管同一批字段,但这里要的是可存的短串而不是两两比较。
 */
export function cardContentKey(card: VideoWorkbenchCard): string {
  return fnv1a(
    [
      card.prompt,
      card.model,
      card.resolution,
      card.ratio,
      card.duration,
      card.generateAudio ? 1 : 0,
      card.mode,
      card.seed ?? '',
      card.webSearch ? 1 : 0,
      card.draft ? 1 : 0,
      card.documentOrLink ?? '',
      // 分镜改了(镜头描述 / 时长)就是内容变了;没有分镜的卡与改动前的指纹一致(空串)。
      card.multiShot ? JSON.stringify(card.multiShot) : '',
      materialKey(card.referenceImages),
      materialKey(card.referenceVideos),
      materialKey(card.referenceAudios),
    ].join('\u0001'),
  )
}

function snapshotBoard(state: ObservableState, boardId: string): BoardObservation {
  const cards = new Map<string, string>()
  const order: string[] = []
  const inBoard = state.cards
    .filter((c) => c.boardId === boardId)
    .sort((a, b) => a.order - b.order)
  for (const c of inBoard) {
    cards.set(c.id, cardContentKey(c))
    order.push(c.id)
  }
  return { cards, order }
}

/**
 * 对话开始一次工作台调用。返回「是不是独自在飞」:同一对话还有别的调用没结束(codex 会在
 * 一回合里并行派发)就返回 false —— 那种情况下分不清变化是谁写的,不报增量。
 */
export function beginThreadCall(threadId: string | undefined): boolean {
  if (!threadId) return false
  const n = inflight.get(threadId) ?? 0
  inflight.set(threadId, n + 1)
  return n === 0
}

/** 一次调用结束。返回 true = 这个对话现在没有在飞的调用了(该推进基线)。 */
export function endThreadCall(threadId: string | undefined): boolean {
  if (!threadId) return false
  const n = (inflight.get(threadId) ?? 1) - 1
  if (n <= 0) {
    inflight.delete(threadId)
    return true
  }
  inflight.set(threadId, n)
  return false
}

const cap = (ids: string[]): IdList => ({ count: ids.length, ids: ids.slice(0, DELTA_MAX_IDS) })

/**
 * 这个对话上次看过的那些分段,现在变成什么样了。没有基线 / 基线属于别的剧 / 没变化 → null。
 * 不修改基线 —— 推进基线是 recordObservation 的事,且只在这一批调用全部结束之后。
 */
export function diffObservation(
  threadId: string | undefined,
  projectId: string,
  state: ObservableState,
): WorkbenchDelta | null {
  if (!threadId) return null
  const obs = observations.get(threadId)
  if (!obs || obs.projectId !== projectId) return null

  const added: string[] = []
  const removed: string[] = []
  const edited: string[] = []
  const reordered: string[] = []
  for (const [boardId, was] of obs.boards) {
    // 分段已经不存在了(被删):不报 —— 它的卡对这个对话早已不可见,不算「别人改了我手上的东西」。
    if (!state.boards.some((b) => b.id === boardId && b.projectId === projectId)) continue
    const now = snapshotBoard(state, boardId)
    for (const [id, key] of now.cards) {
      const prev = was.cards.get(id)
      if (prev === undefined) added.push(id)
      else if (prev !== key) edited.push(id)
    }
    for (const id of was.cards.keys()) if (!now.cards.has(id)) removed.push(id)
    // 集合没变、只是顺序变了才算「重排」;有增删时顺序变化是它们的副作用,不再重复报。
    if (
      added.length === 0 && removed.length === 0
      && now.cards.size === was.cards.size
      && now.order.some((id, i) => id !== was.order[i])
    ) {
      reordered.push(boardId)
    }
  }

  const delta: WorkbenchDelta = {
    ...(added.length > 0 ? { added: cap(added) } : {}),
    ...(removed.length > 0 ? { removed: cap(removed) } : {}),
    ...(edited.length > 0 ? { edited: cap(edited) } : {}),
    ...(reordered.length > 0 ? { reordered } : {}),
  }
  return Object.keys(delta).length > 0 ? delta : null
}

/**
 * 记下「现在」作为这个对话的基线:已观察过的分段 + 这次碰到的分段。
 * 换了剧就整份换掉(旧剧的基线对新剧没有意义)。
 */
export function recordObservation(
  threadId: string | undefined,
  projectId: string,
  state: ObservableState,
  touchedBoardIds: Iterable<string>,
  now: number = Date.now(),
): void {
  if (!threadId) return
  for (const [id, o] of observations) {
    if (now - o.touchedAt > OBSERVATION_PRUNE_MS) observations.delete(id)
  }
  const prev = observations.get(threadId)
  const boardIds = new Set<string>(prev && prev.projectId === projectId ? prev.boards.keys() : [])
  for (const id of touchedBoardIds) boardIds.add(id)
  const boards = new Map<string, BoardObservation>()
  for (const boardId of boardIds) {
    if (!state.boards.some((b) => b.id === boardId && b.projectId === projectId)) continue
    boards.set(boardId, snapshotBoard(state, boardId))
  }
  observations.set(threadId, { projectId, boards, touchedAt: now })
}
