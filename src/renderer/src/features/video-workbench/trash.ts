// 视频工作台「回收站」的纯逻辑:条目形状、水合分流、撤销/整板写里的「删除改入回收站」。
//
// 存储方案:**不新开 object store、不升库版本**,而是在原来的 project / board 记录上打
// `deletedAt` 标。卡片记录不动 —— 它们靠 boardId 指回被标记的分段,水合时据此分流。
// 这样旧版本的库直接可读,升级也不会有「升级事务失败 → 整个工作台打不开」这一类风险。
// (代价:降级回没有回收站的旧版本时,被标记的记录会重新当成活数据露出来。可接受:
//  数据一个没丢,用户最多看到「删掉的又回来了」。)
//
// 内存里 `projects` / `boards` / `cards` 只放活着的;被删的整块挂在 `trash` 里,
// 所以 agent 的 status / IR / 剧栏 / 统计这些读 projects/boards/cards 的地方一概不用改。

import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchProject,
} from '../../../../types/videoWorkbench'

export type TrashKind = 'project' | 'board'

export interface WorkbenchTrashEntry {
  /** 剧 / 分段自己的 id。同一个 id 同一时刻最多一条。 */
  id: string
  kind: TrashKind
  deletedAt: number
  /** kind === 'project':被删的剧(已去掉库里的删除标记)。 */
  project?: VideoWorkbenchProject
  /** 剧:随它一起进来的分段;分段:只有它自己。已去掉删除标记。 */
  boards: VideoWorkbenchBoard[]
  /** 这些分段名下的卡片。 */
  cards: VideoWorkbenchCard[]
  /** kind === 'board':它原来所在的剧(恢复时放回去)。 */
  projectId?: string
}

export function trashEntryName(entry: WorkbenchTrashEntry): string {
  return entry.project?.name ?? entry.boards[0]?.name ?? ''
}

export function stripProjectMark(p: VideoWorkbenchProject): VideoWorkbenchProject {
  const { deletedAt: _drop, ...rest } = p
  return rest
}

export function stripBoardMark(b: VideoWorkbenchBoard): VideoWorkbenchBoard {
  const { deletedAt: _drop, deletedWithProject: _with, ...rest } = b
  return rest
}

export function markProject(p: VideoWorkbenchProject, at: number): VideoWorkbenchProject {
  return { ...p, deletedAt: at }
}

export function markBoard(b: VideoWorkbenchBoard, at: number, withProject: boolean): VideoWorkbenchBoard {
  return { ...b, deletedAt: at, ...(withProject ? { deletedWithProject: true as const } : {}) }
}

/**
 * 水合:库里读出来的原始记录 → 活数据 + 回收站。
 *
 * 分流规则(顺序有讲究):
 * - 剧有 deletedAt → 在回收站;它名下的分段整体跟着走;
 * - 分段有 deletedAt、或所属剧在回收站 → 在回收站;
 * - 卡片只看 boardId 是否落在回收站的分段里。**必须在「孤儿卡迁入第一页」的归一化
 *   之前分流**,否则回收站里的卡会被当成孤儿卡塞回活着的第一页。
 */
export function partitionTrash(
  projects: readonly VideoWorkbenchProject[],
  boards: readonly VideoWorkbenchBoard[],
  cards: readonly VideoWorkbenchCard[],
): {
  projects: VideoWorkbenchProject[]
  boards: VideoWorkbenchBoard[]
  cards: VideoWorkbenchCard[]
  trash: WorkbenchTrashEntry[]
} {
  const trashedProjects = projects.filter((p) => p.deletedAt !== undefined)
  const trashedProjectIds = new Set(trashedProjects.map((p) => p.id))
  const liveProjects = projects.filter((p) => p.deletedAt === undefined)

  const isTrashedBoard = (b: VideoWorkbenchBoard): boolean =>
    b.deletedAt !== undefined || trashedProjectIds.has(b.projectId)
  const liveBoards = boards.filter((b) => !isTrashedBoard(b))
  const trashedBoards = boards.filter(isTrashedBoard)
  const trashedBoardIds = new Set(trashedBoards.map((b) => b.id))

  const liveCards: VideoWorkbenchCard[] = []
  const trashedCardsByBoard = new Map<string, VideoWorkbenchCard[]>()
  for (const c of cards) {
    if (c.boardId && trashedBoardIds.has(c.boardId)) {
      const list = trashedCardsByBoard.get(c.boardId) ?? []
      list.push(c)
      trashedCardsByBoard.set(c.boardId, list)
    } else {
      liveCards.push(c)
    }
  }
  const cardsOf = (bs: readonly VideoWorkbenchBoard[]): VideoWorkbenchCard[] =>
    bs.flatMap((b) => trashedCardsByBoard.get(b.id) ?? [])

  const entries: WorkbenchTrashEntry[] = []
  const claimed = new Set<string>()
  for (const p of trashedProjects) {
    // 随剧一起删的段(deletedWithProject,或老记录没有 deletedAt 的)归剧;
    // 之前单独删掉的段(有 deletedAt、不带 deletedWithProject)仍是它自己的条目。
    const own = trashedBoards.filter(
      (b) => b.projectId === p.id && (b.deletedWithProject === true || b.deletedAt === undefined),
    )
    own.forEach((b) => claimed.add(b.id))
    entries.push({
      id: p.id,
      kind: 'project',
      deletedAt: p.deletedAt!,
      project: stripProjectMark(p),
      boards: own.map(stripBoardMark).sort((a, b) => a.order - b.order),
      cards: cardsOf(own),
    })
  }
  for (const b of trashedBoards) {
    if (claimed.has(b.id)) continue
    entries.push({
      id: b.id,
      kind: 'board',
      deletedAt: b.deletedAt ?? 0,
      boards: [stripBoardMark(b)],
      cards: cardsOf([b]),
      projectId: b.projectId,
    })
  }
  entries.sort((a, b) => b.deletedAt - a.deletedAt)
  return { projects: liveProjects, boards: liveBoards, cards: liveCards, trash: entries }
}

/** 没有任何内容的分段(无卡、无摘要)—— 进回收站没有意义,直接物理删除。 */
function isTrivialBoard(board: VideoWorkbenchBoard, cardCount: number): boolean {
  return cardCount === 0 && !board.summary?.trim()
}

/** 自动起名「未命名剧 N」、没有摘要、名下全是空分段的剧。 */
function isTrivialProject(
  project: VideoWorkbenchProject,
  ownBoards: readonly VideoWorkbenchBoard[],
  cardCountByBoard: ReadonlyMap<string, number>,
): boolean {
  return (
    /^未命名剧 \d+$/.test(project.name)
    && !project.summary?.trim()
    && ownBoards.every((b) => isTrivialBoard(b, cardCountByBoard.get(b.id) ?? 0))
  )
}

export interface RemovalPersist {
  cards: VideoWorkbenchCard[]
  removeCardIds: string[]
  boards: VideoWorkbenchBoard[]
  removeBoardIds: string[]
  projects?: VideoWorkbenchProject[]
  removeProjectIds?: string[]
}

export interface SoftenedRemovals<P extends RemovalPersist> {
  /** 新进回收站的条目(新的在前)。 */
  entries: WorkbenchTrashEntry[]
  /** 把「物理删除」换成「打删除标记」之后的落盘增量。 */
  persist: P
}

/**
 * 撤销 / 重做 / agent 整板写会**删掉**分段、剧和卡片 —— 这里把其中有内容的改入回收站,
 * 而不是物理删除:
 * - 重做「删除」不该把用户删掉的东西永久抹掉;
 * - agent 手写 IR 删页同理,删错了还有回收站可救。
 * 没有任何内容的空段 / 空剧(撤销「新建」时最常见)仍然直接删,不往回收站里塞噪音。
 *
 * 只处理 persist 里列出来的删除;卡片只有「属于被删分段」的才进条目 —— 其余被删的卡
 * (比如被撤销掉的新建卡)和以前一样物理删除。
 */
export function softenRemovals<P extends RemovalPersist>(
  prev: {
    projects: readonly VideoWorkbenchProject[]
    boards: readonly VideoWorkbenchBoard[]
    cards: readonly VideoWorkbenchCard[]
  },
  persist: P,
  now = Date.now(),
): SoftenedRemovals<P> {
  const removeProjectIds = new Set(persist.removeProjectIds ?? [])
  const removeBoardIds = new Set(persist.removeBoardIds)
  const removeCardIds = new Set(persist.removeCardIds)
  if (removeProjectIds.size === 0 && removeBoardIds.size === 0) return { entries: [], persist }

  const cardCountByBoard = new Map<string, number>()
  const removedCardsByBoard = new Map<string, VideoWorkbenchCard[]>()
  for (const c of prev.cards) {
    if (!c.boardId || !removeCardIds.has(c.id)) continue
    cardCountByBoard.set(c.boardId, (cardCountByBoard.get(c.boardId) ?? 0) + 1)
    const list = removedCardsByBoard.get(c.boardId) ?? []
    list.push(c)
    removedCardsByBoard.set(c.boardId, list)
  }

  const entries: WorkbenchTrashEntry[] = []
  const markedProjects: VideoWorkbenchProject[] = []
  const markedBoards: VideoWorkbenchBoard[] = []
  const softBoardIds = new Set<string>()
  const softCardIds = new Set<string>()
  const softProjectIds = new Set<string>()

  for (const project of prev.projects) {
    if (!removeProjectIds.has(project.id)) continue
    const own = prev.boards.filter((b) => b.projectId === project.id && removeBoardIds.has(b.id))
    if (isTrivialProject(project, own, cardCountByBoard)) continue
    const cards = own.flatMap((b) => removedCardsByBoard.get(b.id) ?? [])
    entries.push({
      id: project.id,
      kind: 'project',
      deletedAt: now,
      project,
      boards: own,
      cards,
    })
    softProjectIds.add(project.id)
    markedProjects.push(markProject(project, now))
    for (const b of own) {
      softBoardIds.add(b.id)
      markedBoards.push(markBoard(b, now, true))
    }
    cards.forEach((c) => softCardIds.add(c.id))
  }

  for (const board of prev.boards) {
    if (!removeBoardIds.has(board.id) || softBoardIds.has(board.id)) continue
    // 所属剧也被删却没进回收站(空剧)→ 它的段一并物理删除
    if (removeProjectIds.has(board.projectId)) continue
    const cards = removedCardsByBoard.get(board.id) ?? []
    if (isTrivialBoard(board, cards.length)) continue
    entries.push({
      id: board.id,
      kind: 'board',
      deletedAt: now,
      boards: [board],
      cards,
      projectId: board.projectId,
    })
    softBoardIds.add(board.id)
    markedBoards.push(markBoard(board, now, false))
    cards.forEach((c) => softCardIds.add(c.id))
  }

  if (entries.length === 0) return { entries: [], persist }

  return {
    entries: entries.sort((a, b) => b.deletedAt - a.deletedAt),
    persist: {
      ...persist,
      projects: [...(persist.projects ?? []), ...markedProjects],
      boards: [...persist.boards, ...markedBoards],
      // 进回收站的卡改成「写一次最新内容」而不是删除:防抖队列里 500ms 前的旧内容
      // 会被调用方掐掉,回收站里躺的不能是旧版本。
      cards: [...persist.cards, ...entries.flatMap((e) => e.cards)],
      removeProjectIds: (persist.removeProjectIds ?? []).filter((id) => !softProjectIds.has(id)),
      removeBoardIds: persist.removeBoardIds.filter((id) => !softBoardIds.has(id)),
      removeCardIds: persist.removeCardIds.filter((id) => !softCardIds.has(id)),
    },
  }
}

/**
 * 还原 / 整板写之后,id 已经重新出现在活数据里的回收站条目要摘掉
 * (撤销「删除」等于把它们救回来了,不能同时又在回收站里)。
 */
export function pruneTrash(
  trash: readonly WorkbenchTrashEntry[],
  liveProjectIds: ReadonlySet<string>,
  liveBoardIds: ReadonlySet<string>,
): WorkbenchTrashEntry[] {
  return trash.filter((e) =>
    e.kind === 'project' ? !liveProjectIds.has(e.id) : !liveBoardIds.has(e.id),
  )
}
