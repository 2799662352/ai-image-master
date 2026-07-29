const FILE_TYPE = 'application/x-catimation-file-paths'
const QUOTE_TYPE = 'application/x-catimation-quote'
/**
 * 视频工作台卡片 → 聊天栏。**刻意不复用 {@link FILE_TYPE}**。
 *
 * 那个 MIME 在本仓库里的既定含义是「可以被**移动**的工作区文件」——
 * `FileTreeNode.onDrop` 见到它就调 `moveByDnd` → `fs.move`。而文件树是
 * `AgentChatPanel` 的一部分(全局固定坞),和视频工作台**同屏**;卡片产物躺在
 * `<userData>/agent/uploads` 里,那个目录又在 fs IPC 的 allowedRoots 内。
 * 于是复用会让「把卡片拖过文件树」真的把 mp4 移走,卡片的 localPath 与整份版本
 * 历史一起哑掉 —— 静默的数据丢失。
 *
 * 分开之后,文件树只认自己那个 MIME,天然忽略卡片;聊天栏显式认领这一个。
 */
const WORKBENCH_CARD_TYPE = 'application/x-catimation-workbench-cards'

/**
 * Serialize one or more file paths into the drag DataTransfer.
 *
 * - Internal MIME (`application/x-catimation-file-paths`) carries a JSON
 *   string array; lets `parseFileDrop` recover N paths losslessly.
 * - `text/plain` is a newline-joined fallback so external targets (chat input,
 *   editors, terminal) still see something useful when N>=1.
 */
export function serializeFileDrag(dt: DataTransfer, paths: string[]): void {
  if (paths.length === 0) return
  dt.setData(FILE_TYPE, JSON.stringify(paths))
  dt.setData('text/plain', paths.join('\n'))
}

/**
 * Returns the dragged paths in original order. Always an array (possibly empty)
 * so callers can iterate uniformly without null checks.
 */
export function parseFileDrop(dt: DataTransfer): string[] {
  const raw = dt.getData(FILE_TYPE)
  if (!raw) return []
  try {
    const parsed = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((s) => typeof s === 'string')) {
      return parsed as string[]
    }
  } catch {
    // Older payload format (single path) — graceful fallback
    return [raw]
  }
  return []
}

/**
 * True when a drag carries something our drop targets can actually act on:
 * internal file paths, a quote, or OS files.
 *
 * Exists so drop targets can light up a "you can drop here" affordance without
 * re-hardcoding the MIME literals — this module owns the vocabulary. Deliberately
 * does NOT decide whether a given target accepts the payload (FileTreeNode still
 * refuses rows that have no destination dir); it only answers "is this one of ours".
 */
export function dragCarriesDroppablePayload(dt: DataTransfer): boolean {
  const types = dt.types
  return types.includes(FILE_TYPE) || types.includes(QUOTE_TYPE) || types.includes('Files')
}

/** 一张被拖出来的工作台卡片。`localPath` 缺席表示这张卡还没有产物。 */
export interface WorkbenchCardDragItem {
  cardId: string
  localPath?: string
}

/**
 * 卡片 → 聊天栏。同一次 dragStart 里另写一个裸 id 到页内排序用的 MIME 是调用方的
 * 事;这里只管聊天栏这一路。
 *
 * `text/plain` 兜底让外部目标(编辑器/终端)也能看到点东西。
 */
export function serializeWorkbenchCardDrag(dt: DataTransfer, items: WorkbenchCardDragItem[]): void {
  if (items.length === 0) return
  dt.setData(WORKBENCH_CARD_TYPE, JSON.stringify(items))
  dt.setData('text/plain', items.map((i) => i.localPath ?? i.cardId).join('\n'))
}

/** 总是返回数组(可能为空)。载荷损坏按「没有卡片」处理,不抛。 */
export function parseWorkbenchCardDrop(dt: DataTransfer): WorkbenchCardDragItem[] {
  const raw = dt.getData(WORKBENCH_CARD_TYPE)
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed) && parsed.every((x) => x && typeof (x as WorkbenchCardDragItem).cardId === 'string')) {
      return parsed as WorkbenchCardDragItem[]
    }
    console.warn('[dragHelpers] workbench card payload has unexpected shape — drop ignored')
  } catch {
    console.warn('[dragHelpers] workbench card payload is not valid JSON — drop ignored')
  }
  return []
}

export function serializeQuoteDrag(dt: DataTransfer, quote: string): void {
  dt.setData(QUOTE_TYPE, quote)
}

export function parseQuoteDrop(dt: DataTransfer): string | null {
  return dt.getData(QUOTE_TYPE) || null
}

/**
 * Resolve a `FileList` from an external OS drag-drop into absolute file paths
 * via Electron's `webUtils.getPathForFile` (exposed at electronAPI.getFilePath).
 *
 * Returns [] when:
 *   - The renderer is running on a build without the bridge (Electron < 32 or
 *     a stripped preload), in which case we log a warning so future debugging
 *     isn't a guessing game.
 *   - Every File is synthetic (clipboard paste with no on-disk path → '').
 *
 * Callers should always check `paths.length === 0` and bail rather than
 * dispatching an IPC with no work to do.
 */
export function resolveExternalPaths(files: FileList): string[] {
  const getFilePath = (window as Window & {
    electronAPI?: { getFilePath?: (f: File) => string }
  }).electronAPI?.getFilePath
  if (!getFilePath) {
    console.warn(
      '[file-explorer] electronAPI.getFilePath unavailable — external OS file drop ignored. ' +
        'Renderer may be running on Electron < 32 or a stripped preload.',
    )
    return []
  }
  return Array.from(files)
    .map((f) => getFilePath(f))
    .filter((p): p is string => Boolean(p))
}
