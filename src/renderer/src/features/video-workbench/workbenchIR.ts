// src/renderer/src/features/video-workbench/workbenchIR.ts
/**
 * 看板 JSON IR 的导出与 apply 计划 —— 全部是纯函数,不碰 store 也不碰 IndexedDB。
 *
 * store 的 applyIR action 只做两件事:调 planApplyIR 拿计划,把计划里的
 * next/persist 落下去。所有判断逻辑(冲突、id 校验、渲染中定格、merge/replace
 * 语义、order 压实)都在这里,因此可以用普通对象当输入直接测。
 *
 * ## 素材体积:wbref:// 占位
 *
 * 卡片素材的 src 可能是几 MB 的 data: URL。导出时原样吐出去会把 agent 的上下文
 * 瞬间打爆(Codex #5544/#6426 的教训),所以 data: URL 一律换成
 * `wbref://<cardId>/<kind>/<index>` 占位 —— 语义是「当前在这个槽位上的那份素材」。
 * apply 时按占位反查原始字节。
 *
 * 附带的好处是这个占位可以被搬:agent 把 A 卡的 wbref 抄到 B 卡上,就等于把那张
 * 内嵌图复用过去,不需要重新上传,也不需要 agent 见到字节。
 *
 * 短 src(本地路径 / https / asset://)原样导出 —— 它们既可读又可写,agent 能直接
 * 编辑,没必要藏。
 */

import type {
  VideoWorkbenchBoard,
  VideoWorkbenchCard,
  VideoWorkbenchCardInput,
  VideoWorkbenchMaterial,
  VideoWorkbenchSpec,
  WorkbenchApplyOptions,
  WorkbenchApplyResult,
  WorkbenchApplySkip,
  WorkbenchIR,
  WorkbenchIRBoard,
  WorkbenchIRCard,
  WorkbenchIRMaterial,
} from '../../../../types/videoWorkbench'
import { WORKBENCH_IR_VERSION } from '../../../../types/videoWorkbench'
import {
  MATERIAL_KINDS,
  type MaterialKind,
  createId,
  isActiveStatus,
  normalizeSpec,
  specEquals,
} from './cardSpec'
/** IR 导出/apply 只需要 store 的这几个字段,方便测试直接喂普通对象。 */
export interface WorkbenchIRSource {
  cards: VideoWorkbenchCard[]
  boards: VideoWorkbenchBoard[]
  activeBoardId: string
  /** 「有任何编排改动」计数器,驱动撤销栈入栈。 */
  revision: number
  /** 结构版本(卡片集合/位置/页),IR 的整份并发令牌。 */
  structureRevision: number
}

const WBREF_PREFIX = 'wbref://'

/** 内嵌素材占位:`wbref://<cardId>/<kind>/<index>`。 */
function makeWbref(cardId: string, kind: MaterialKind, index: number): string {
  return `${WBREF_PREFIX}${cardId}/${kind}/${index}`
}

interface ParsedWbref {
  cardId: string
  kind: MaterialKind
  index: number
}

function parseWbref(src: string): ParsedWbref | null {
  if (!src.startsWith(WBREF_PREFIX)) return null
  const parts = src.slice(WBREF_PREFIX.length).split('/')
  if (parts.length !== 3) return null
  const [cardId, kind, rawIndex] = parts
  if (!cardId || !MATERIAL_KINDS.includes(kind as MaterialKind)) return null
  const index = Number(rawIndex)
  if (!Number.isInteger(index) || index < 0) return null
  return { cardId, kind: kind as MaterialKind, index }
}

/** 导出单条素材:data: URL 换占位,其余原样。 */
function exportMaterial(
  material: VideoWorkbenchMaterial,
  cardId: string,
  kind: MaterialKind,
  index: number,
): WorkbenchIRMaterial {
  return {
    name: material.name,
    src: material.src.startsWith('data:') ? makeWbref(cardId, kind, index) : material.src,
  }
}

function exportCard(card: VideoWorkbenchCard): WorkbenchIRCard {
  return {
    id: card.id,
    rev: card.rev ?? 0,
    prompt: card.prompt,
    model: card.model,
    resolution: card.resolution,
    ratio: card.ratio,
    duration: card.duration,
    generateAudio: card.generateAudio,
    mode: card.mode,
    ...(card.seed !== undefined ? { seed: card.seed } : {}),
    webSearch: card.webSearch,
    referenceImages: card.referenceImages.map((m, i) => exportMaterial(m, card.id, 'referenceImages', i)),
    referenceVideos: card.referenceVideos.map((m, i) => exportMaterial(m, card.id, 'referenceVideos', i)),
    referenceAudios: card.referenceAudios.map((m, i) => exportMaterial(m, card.id, 'referenceAudios', i)),
    result: {
      status: card.status,
      ...(card.taskId ? { taskId: card.taskId } : {}),
      ...(card.error ? { error: card.error } : {}),
      ...(card.localPath ? { localPath: card.localPath } : {}),
      ...(card.remoteUrl ? { remoteUrl: card.remoteUrl } : {}),
      // 版本是结果不是意图:只作只读注解导出,planApplyIR 整块忽略 result,
      // 所以不会被回灌 —— 无需在 apply 侧写任何防御。
      ...(card.versions && card.versions.length > 0
        ? {
            versions: card.versions.map((v) => ({
              seq: v.seq,
              ...(v.localPath ? { localPath: v.localPath } : {}),
              ...(v.remoteUrl ? { remoteUrl: v.remoteUrl } : {}),
              prompt: v.spec.prompt,
            })),
          }
        : {}),
    },
  }
}

/**
 * 导出整个工作台。页与卡都按 order 升序,数组顺序即最终顺序 —— IR 里没有
 * order 字段,重排就是重排数组。
 */
export function exportWorkbenchIR(source: WorkbenchIRSource): WorkbenchIR {
  const boards = [...source.boards].sort((a, b) => a.order - b.order)
  const irBoards: WorkbenchIRBoard[] = boards.map((board) => ({
    id: board.id,
    name: board.name,
    cards: source.cards
      .filter((c) => c.boardId === board.id)
      .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      .map(exportCard),
  }))
  return {
    irVersion: WORKBENCH_IR_VERSION,
    structureRevision: source.structureRevision,
    activeBoardId: source.activeBoardId,
    boards: irBoards,
  }
}

// ---------------------------------------------------------------------------
// apply
// ---------------------------------------------------------------------------

export interface ApplyPlan {
  result: WorkbenchApplyResult
  /** 只有 result.ok 为 true 才有:要写进 store 的下一份状态。 */
  next?: {
    boards: VideoWorkbenchBoard[]
    cards: VideoWorkbenchCard[]
    activeBoardId: string
    revision: number
    structureRevision: number
  }
  /** 只有 result.ok 为 true 才有:要落 IndexedDB 的增量。 */
  persist?: {
    cards: VideoWorkbenchCard[]
    removeCardIds: string[]
    boards: VideoWorkbenchBoard[]
    removeBoardIds: string[]
  }
}

/**
 * 列出「卡片现值」与「agent 带回的规格」对不上的字段，喂到跳过理由里。
 *
 * **只报差异，不做归因。** 没有导出时的基线快照，就分不清某个字段是用户改的还是 agent
 * 要改的 —— 硬猜会把「用户把时长改成 30 秒」说成「你要改时长」，比不说更误导。所以这里
 * 只把线索摆出来（哪几个字段、现值是什么），判断留给能读懂提示词内容的 agent。
 *
 * 长文本只报「变了」不贴全文：提示词动辄几百字，两份都塞进 reason 会把回包撑爆，而
 * `current.prompt` 里本来就有现值。
 */
function describeSpecDrift(cur: VideoWorkbenchSpec, next: VideoWorkbenchSpec): string {
  const parts: string[] = []
  if (cur.prompt !== next.prompt) parts.push('prompt(内容不同,现值见 current.prompt)')
  if (cur.model !== next.model) parts.push(`model(现 ${cur.model} / 你写 ${next.model})`)
  if (cur.resolution !== next.resolution) {
    parts.push(`resolution(现 ${cur.resolution} / 你写 ${next.resolution})`)
  }
  if (cur.ratio !== next.ratio) parts.push(`ratio(现 ${cur.ratio} / 你写 ${next.ratio})`)
  if (cur.duration !== next.duration) {
    parts.push(`duration(现 ${cur.duration}s / 你写 ${next.duration}s)`)
  }
  if (cur.generateAudio !== next.generateAudio) {
    parts.push(`generateAudio(现 ${cur.generateAudio} / 你写 ${next.generateAudio})`)
  }
  if (cur.mode !== next.mode) parts.push(`mode(现 ${cur.mode} / 你写 ${next.mode})`)
  if (cur.seed !== next.seed) parts.push(`seed(现 ${cur.seed ?? '随机'} / 你写 ${next.seed ?? '随机'})`)
  if (cur.webSearch !== next.webSearch) {
    parts.push(`webSearch(现 ${cur.webSearch} / 你写 ${next.webSearch})`)
  }
  for (const [key, label] of [
    ['referenceImages', '参考图'],
    ['referenceVideos', '参考视频'],
    ['referenceAudios', '参考音频'],
  ] as const) {
    const a = cur[key]?.length ?? 0
    const b = next[key]?.length ?? 0
    if (a !== b) parts.push(`${label}(现 ${a} 份 / 你写 ${b} 份)`)
  }
  return parts.join('、')
}

function reject(
  source: WorkbenchIRSource,
  skipped: WorkbenchApplySkip[],
  conflict?: { expected: number; actual: number },
): ApplyPlan {
  return {
    result: {
      ok: false,
      ...(conflict ? { conflict } : {}),
      boards: { created: [], renamed: [], removed: [] },
      cards: { created: [], updated: [], moved: [], removed: [] },
      skipped,
      structureRevision: source.structureRevision,
    },
  }
}

/**
 * 把 IR 素材还原成可提交的 Material:wbref:// 占位反查原始素材(通常是
 * data: URL 字节),查不到就丢掉并记一条 skip —— 静默留一个死链更糟。
 */
function resolveMaterials(
  list: WorkbenchIRMaterial[] | undefined,
  cardById: Map<string, VideoWorkbenchCard>,
  skipped: WorkbenchApplySkip[],
  ownerCardId: string | undefined,
): Array<string | VideoWorkbenchMaterial> {
  const out: Array<string | VideoWorkbenchMaterial> = []
  for (const item of list ?? []) {
    if (!item || typeof item.src !== 'string' || item.src.length === 0) continue
    const ref = parseWbref(item.src)
    if (!ref) {
      out.push({ name: item.name || item.src, src: item.src })
      continue
    }
    const original = cardById.get(ref.cardId)?.[ref.kind]?.[ref.index]
    if (!original) {
      skipped.push({
        ...(ownerCardId ? { cardId: ownerCardId } : {}),
        reason: `素材占位无法解析,已丢弃: ${item.src}`,
      })
      continue
    }
    out.push(original)
  }
  return out
}

function irCardToInput(
  card: WorkbenchIRCard,
  cardById: Map<string, VideoWorkbenchCard>,
  skipped: WorkbenchApplySkip[],
): VideoWorkbenchCardInput {
  return {
    prompt: card.prompt,
    model: card.model,
    resolution: card.resolution,
    ratio: card.ratio,
    duration: card.duration,
    generateAudio: card.generateAudio,
    mode: card.mode,
    // IR 是声明式的:没写 seed 就是「随机」,而不是「沿用旧值」。
    seed: card.seed ?? null,
    webSearch: card.webSearch,
    referenceImages: resolveMaterials(card.referenceImages, cardById, skipped, card.id),
    referenceVideos: resolveMaterials(card.referenceVideos, cardById, skipped, card.id),
    referenceAudios: resolveMaterials(card.referenceAudios, cardById, skipped, card.id),
  }
}

/** IR 里被认领的一张卡:目标页 + 页内位置 + 新规格。 */
interface CardClaim {
  boardId: string
  index: number
  spec: VideoWorkbenchSpec
}

interface BoardSlot {
  board: VideoWorkbenchBoard
  created: boolean
  renamed: boolean
  /** 该页在 IR 里列出的卡,按顺序。`rev` = IR 带回的按卡并发令牌。 */
  claims: Array<{ cardId?: string; spec: VideoWorkbenchSpec; rev?: number }>
}

/**
 * 计算 apply 的完整计划。纯函数:不改 source,不产生副作用。
 *
 * 判定顺序刻意如此 —— 格式 → 版本冲突 → 内容,让 agent 先看到最根本的问题,
 * 而不是在一堆 skip 里翻找「其实是你的 IR 版本不对」。
 */
export function planApplyIR(
  source: WorkbenchIRSource,
  ir: WorkbenchIR,
  opts: WorkbenchApplyOptions = {},
): ApplyPlan {
  const mode = opts.mode ?? 'merge'
  const skipped: WorkbenchApplySkip[] = []
  const now = Date.now()

  if (!ir || typeof ir !== 'object') {
    return reject(source, [{ reason: 'IR 不是对象' }])
  }
  if (ir.irVersion !== WORKBENCH_IR_VERSION) {
    return reject(source, [
      { reason: `不认识的 irVersion: ${String(ir.irVersion)}(当前 ${WORKBENCH_IR_VERSION});请重新 export` },
    ])
  }
  if (!Array.isArray(ir.boards) || ir.boards.length === 0) {
    return reject(source, [{ reason: 'boards 为空:工作台至少要有一页' }])
  }
  if (!opts.force && ir.structureRevision !== source.structureRevision) {
    return reject(source, [
      {
        reason:
          '卡片集合或位置在你导出之后变过(新增/删除/排序/页操作)。IR 用数组下标表达位置,'
          + '这时候写下去会错位。请重新 export、把改动重做一遍再 apply。',
      },
    ], { expected: ir.structureRevision, actual: source.structureRevision })
  }

  const boardById = new Map(source.boards.map((b) => [b.id, b]))
  const cardById = new Map(source.cards.map((c) => [c.id, c]))

  // ---- 第一遍:解析页,并认领卡片 id ----
  const slots: BoardSlot[] = []
  const claimedBoardIds = new Set<string>()
  const claims = new Map<string, CardClaim>()

  for (const irBoard of ir.boards) {
    const name = (irBoard?.name ?? '').trim()
    if (!name) {
      skipped.push({ ...(irBoard?.id ? { boardId: irBoard.id } : {}), reason: '页名为空,已跳过该页' })
      continue
    }
    let board: VideoWorkbenchBoard
    let created = false
    let renamed = false
    if (irBoard.id) {
      const cur = boardById.get(irBoard.id)
      if (!cur) {
        skipped.push({ boardId: irBoard.id, reason: `页不存在: ${irBoard.id}(想新建就别给 id)` })
        continue
      }
      if (claimedBoardIds.has(cur.id)) {
        skipped.push({ boardId: cur.id, reason: `IR 里同一个页 id 出现多次: ${cur.id}` })
        continue
      }
      claimedBoardIds.add(cur.id)
      renamed = cur.name !== name
      board = renamed ? { ...cur, name } : cur
    } else {
      board = { id: createId(), name, order: 0, createdAt: now }
      created = true
    }

    const slot: BoardSlot = { board, created, renamed, claims: [] }
    for (const irCard of Array.isArray(irBoard.cards) ? irBoard.cards : []) {
      if (!irCard || typeof irCard !== 'object') continue
      const spec = normalizeSpec(irCardToInput(irCard, cardById, skipped))
      if (!irCard.id) {
        slot.claims.push({ spec })
        continue
      }
      if (!cardById.has(irCard.id)) {
        skipped.push({ cardId: irCard.id, reason: `卡片不存在: ${irCard.id}(想新建就别给 id)` })
        continue
      }
      if (claims.has(irCard.id)) {
        skipped.push({ cardId: irCard.id, reason: `IR 里同一张卡出现多次: ${irCard.id}` })
        continue
      }
      claims.set(irCard.id, { boardId: board.id, index: slot.claims.length, spec })
      slot.claims.push({
        cardId: irCard.id,
        spec,
        ...(typeof irCard.rev === 'number' ? { rev: irCard.rev } : {}),
      })
    }
    slots.push(slot)
  }

  if (slots.length === 0) {
    return reject(source, [...skipped, { reason: 'IR 里没有一页可用,拒绝执行(否则会清空工作台)' }])
  }

  // ---- 页的最终顺序 ----
  // merge:IR 列出的页按 IR 顺序在前,未列出的页保持相对顺序跟在后面。
  // replace:未列出的页连带删除。
  const slotByBoardId = new Map(slots.map((s) => [s.board.id, s]))
  const untouchedBoards = source.boards
    .filter((b) => !claimedBoardIds.has(b.id))
    .sort((a, b) => a.order - b.order)
  const orderedBoards = mode === 'replace'
    ? slots.map((s) => s.board)
    : [...slots.map((s) => s.board), ...untouchedBoards]
  const finalBoards = orderedBoards.map((b, i) => (b.order === i ? b : { ...b, order: i }))
  const removedBoardIds = mode === 'replace' ? untouchedBoards.map((b) => b.id) : []

  // ---- 第二遍:逐页装卡 ----
  const nextCards: VideoWorkbenchCard[] = []
  const persistCards: VideoWorkbenchCard[] = []
  const createdCards: string[] = []
  const updatedCards: string[] = []
  const movedCards: string[] = []

  /** 位置变了就要重写 order/boardId,顺带记账。 */
  const placeExisting = (cur: VideoWorkbenchCard, boardId: string, index: number): VideoWorkbenchCard => {
    if (cur.boardId === boardId && cur.order === index) return cur
    movedCards.push(cur.id)
    const next = { ...cur, boardId, order: index }
    persistCards.push(next)
    return next
  }

  for (const board of finalBoards) {
    const slot = slotByBoardId.get(board.id)
    let index = 0

    if (slot) {
      for (const claim of slot.claims) {
        if (!claim.cardId) {
          const next: VideoWorkbenchCard = {
            id: createId(),
            boardId: board.id,
            order: index,
            status: 'draft',
            createdAt: now,
            updatedAt: now,
            rev: 0,
            ...claim.spec,
          }
          createdCards.push(next.id)
          persistCards.push(next)
          nextCards.push(next)
          index += 1
          continue
        }
        const cur = cardById.get(claim.cardId)!
        const specChanged = !specEquals(cur, claim.spec)
        if (specChanged && isActiveStatus(cur.status)) {
          // 提交上去的参数已经定格,改了也不会影响正在渲染的这一轮 —— 静默改掉
          // 反而会让卡片显示的规格和实际产出的视频对不上。位置照样能动。
          skipped.push({
            cardId: cur.id,
            reason: '卡片正在生成,规格已定格不可改(位置改动已生效)',
          })
          nextCards.push(placeExisting(cur, board.id, index))
          index += 1
          continue
        }
        if (!specChanged) {
          nextCards.push(placeExisting(cur, board.id, index))
          index += 1
          continue
        }
        // 按卡并发校验:只有这张卡被改过才跳过这张,其余卡照写。整份拒绝留给
        // 结构变动 —— 用户在一张卡里打字不该让 agent 对另外四十九张的回写作废。
        if (!opts.force && claim.rev !== undefined && (cur.rev ?? 0) !== claim.rev) {
          const drifted = describeSpecDrift(cur, claim.spec)
          skipped.push({
            cardId: cur.id,
            reason:
              `这张卡在你导出之后被用户改过(当前 rev=${cur.rev ?? 0},你带回的是 ${claim.rev});`
              + '规格改动已跳过,位置改动已生效。'
              + (drifted ? `对不上的字段:${drifted}。` : '规格字段本身一致,差的只是版本号。')
              + '注意这里只说「哪几个对不上」,分不清是你改的还是用户改的——那要你自己对照'
              + '`current` 判断:时长/模型这类变了就按新值重写你那份再发一次;提示词被整个'
              + '换过就先问用户,别把人家刚写的覆盖掉。'
              + '确认要覆盖时,把 `current.rev` 抄进这张卡的 `rev` 重发即可(不必重新 export 整板)。',
            // 带上现场值,省掉「为了看用户改了什么再 export 一次」那趟往返。
            current: {
              prompt: cur.prompt,
              model: cur.model,
              resolution: cur.resolution,
              ratio: cur.ratio,
              duration: cur.duration,
              rev: cur.rev ?? 0,
            },
          })
          nextCards.push(placeExisting(cur, board.id, index))
          index += 1
          continue
        }
        // seed 是规格里唯一可缺省的字段:先摘掉再铺新规格,IR 没写 seed 才能
        // 真的清成随机,而不是被 cur 的旧值顶回来。
        const { seed: _dropped, ...rest } = cur
        const next: VideoWorkbenchCard = {
          ...rest,
          ...claim.spec,
          boardId: board.id,
          order: index,
          updatedAt: now,
          // 规格变了就 bump —— 让任何还攥着旧 rev 的 IR 后续撞上这一张。
          rev: (cur.rev ?? 0) + 1,
        }
        updatedCards.push(cur.id)
        if (cur.boardId !== board.id || cur.order !== index) movedCards.push(cur.id)
        persistCards.push(next)
        nextCards.push(next)
        index += 1
      }
    }

    // 该页里 IR 没提到的卡:merge 保留(跟在列出的卡后面,保持相对顺序);
    // replace 下这些卡要被删,除外情况在下面统一处理。
    const keepLeftovers = mode === 'merge' || !slot
    if (keepLeftovers) {
      const leftovers = source.cards
        .filter((c) => c.boardId === board.id && !claims.has(c.id))
        .sort((a, b) => a.order - b.order || a.createdAt - b.createdAt)
      for (const cur of leftovers) {
        nextCards.push(placeExisting(cur, board.id, index))
        index += 1
      }
    }
  }

  // ---- 被丢下的卡 ----
  const keptIds = new Set(nextCards.map((c) => c.id))
  const removedCardIds: string[] = []
  const orphanInFlight: VideoWorkbenchCard[] = []
  for (const cur of source.cards) {
    if (keptIds.has(cur.id)) continue
    if (isActiveStatus(cur.status)) {
      // 正在跑的任务绝不因为一次 apply 消失 —— 上游还在扣费,用户得看得见它。
      skipped.push({ cardId: cur.id, reason: '卡片正在生成,拒绝删除(已保留在页面上)' })
      orphanInFlight.push(cur)
      continue
    }
    // 走到这里只有两种情况:IR 没列这张卡(replace 模式)、或它的页被删了。
    // 两者都是删。
    removedCardIds.push(cur.id)
  }
  // 在飞的孤儿卡归到第一页末尾(它原来的页可能已经被删掉了)。
  if (orphanInFlight.length > 0) {
    const host = finalBoards[0].id
    let index = nextCards.filter((c) => c.boardId === host).length
    for (const cur of orphanInFlight) {
      nextCards.push(placeExisting(cur, host, index))
      index += 1
    }
  }

  // ---- activeBoardId ----
  const finalBoardIds = new Set(finalBoards.map((b) => b.id))
  const activeBoardId =
    ir.activeBoardId && finalBoardIds.has(ir.activeBoardId)
      ? ir.activeBoardId
      : finalBoardIds.has(source.activeBoardId)
        ? source.activeBoardId
        : finalBoards[0].id

  const createdBoards = slots.filter((s) => s.created).map((s) => s.board.id)
  const renamedBoards = slots.filter((s) => s.renamed).map((s) => s.board.id)
  const boardsToPersist = finalBoards.filter((b) => {
    const prev = boardById.get(b.id)
    return !prev || prev.name !== b.name || prev.order !== b.order
  })

  // 结构变动 = 卡片集合/位置/页本身变了 —— 只有这些会让 IR 里「数组下标即位置」
  // 的表达失效,所以只有这些 bump 整份令牌。改一张卡的规格不算。
  //
  // 改页名严格说不影响位置计划,但仍算结构变动:页操作很稀少(用户不会像敲提示词
  // 那样一边改页名一边让 agent 干活),这点悲观换来「不会静默把用户刚改的页名
  // 覆盖回去」,划得来。
  const structureChanged =
    createdBoards.length > 0
    || renamedBoards.length > 0
    || removedBoardIds.length > 0
    || boardsToPersist.length > 0
    || createdCards.length > 0
    || movedCards.length > 0
    || removedCardIds.length > 0

  // 什么都没变就不 bump 版本号 —— 重复 apply 同一份 IR 不该让 agent 手里的
  // 令牌失效。
  const changed = structureChanged || updatedCards.length > 0 || activeBoardId !== source.activeBoardId
  const revision = changed ? source.revision + 1 : source.revision
  const structureRevision = structureChanged
    ? source.structureRevision + 1
    : source.structureRevision

  return {
    result: {
      ok: true,
      boards: { created: createdBoards, renamed: renamedBoards, removed: removedBoardIds },
      cards: {
        created: createdCards,
        updated: updatedCards,
        moved: [...new Set(movedCards)],
        removed: removedCardIds,
      },
      skipped,
      structureRevision,
    },
    next: { boards: finalBoards, cards: nextCards, activeBoardId, revision, structureRevision },
    persist: {
      cards: persistCards,
      removeCardIds: removedCardIds,
      boards: boardsToPersist,
      removeBoardIds: removedBoardIds,
    },
  }
}
