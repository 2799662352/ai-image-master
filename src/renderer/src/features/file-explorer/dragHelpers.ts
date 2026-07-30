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

/**
 * 工作台卡片单独一个判据,**刻意不并进 {@link dragCarriesDroppablePayload}**。
 *
 * 那个函数是「我们家的通用载荷」,谁都能拿去点亮自己;卡片却只有聊天栏接得住 ——
 * 文件树对卡片 MIME 是故意不响应的(响应就会 fs.move 掉 mp4)。混进去等于给所有
 * 现在和将来的投放目标发一张「这里能放卡片」的假许可,而拖到文件树上松手会毫无
 * 反应。所以让接得住的那一方显式认领,与 MentionInput.onDrop 的做法一致。
 */
export function dragCarriesWorkbenchCards(dt: DataTransfer): boolean {
  return dt.types.includes(WORKBENCH_CARD_TYPE)
}

/**
 * 一张被拖出来的工作台卡片。
 *
 * **`localPath` 缺席不等于没出片。** 本地 mp4 会被 7 天清理扫掉(AttachmentService
 * .cleanup 判断「仍被引用」时只扫聊天记录,工作台卡片对它隐形),`remoteUrl` 才是
 * 耐久源;播放器本来就按 localPath → remoteUrl → videoUrl 逐级降级。所以这三级必须
 * 带齐,否则聊天栏会把「本地已清理、云端还在」的卡误报成「还没有生成结果」——
 * 播放器还放得出来,拖进聊天栏却说没产物。
 */
export interface WorkbenchCardDragItem {
  cardId: string
  /** 本地 mp4 绝对路径(最快,可能已被清理)。 */
  localPath?: string
  /** COS 永久 https URL(跨设备/清理后仍可播)。 */
  remoteUrl?: string
  /** 上游临时结果地址(有效期未知,最后兜底)。 */
  videoUrl?: string
  /** 卡片状态机当前值 —— 还没有产物时,说明里据此写清「为什么还没有」。 */
  status?: string
  /** 终态失败时上游/本地的错误原文。 */
  error?: string
  /** 意图快照。还没有产物时,聊天栏据此合成一份规格说明递给模型。 */
  spec?: WorkbenchCardDragSpec
}

/**
 * 卡片规格摘要。字段与 `VideoWorkbenchSpec` 一一对应,但**素材只记名字不记字节** ——
 * 与 `VideoWorkbenchVersionSpec.referenceBrief` 同一条纪律:referenceImages 里可能是
 * data: URL,原样塞进 dataTransfer 会让一次拖拽拖着几十 MB base64 走,还会照原样落进
 * 附件。类型用裸 string 而不是 workbench 的联合类型,是为了不让这个 MIME 词汇表模块
 * 反过来依赖视频工作台。
 */
export interface WorkbenchCardDragSpec {
  prompt: string
  model: string
  resolution: string
  ratio: string
  /** 秒;-1 = 智能时长(模型自动决定)。 */
  duration: number
  generateAudio: boolean
  mode: string
  /** undefined = 随机。 */
  seed?: number
  webSearch: boolean
  referenceBrief: { images: string[]; videos: string[]; audios: string[] }
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
  // 兜底按播放器同款降级取「最能指向这张卡产物的那个地址」,只有真没产物才退回 id。
  dt.setData(
    'text/plain',
    items.map((i) => i.localPath ?? i.remoteUrl ?? i.videoUrl ?? i.cardId).join('\n'),
  )
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
