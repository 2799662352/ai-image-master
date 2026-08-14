// 「生成视频」工作台 —— 单张任务卡片。
//
// 交互移植自 soraui 旧版工作台(VideoGenerator/JimengStyleEditor/TaskCard):
// - 卡片头拖拽手柄排序(原生 HTML5 DnD,自定义 mime 与文件投放区分);
// - 整卡文件拖放上传(dragCounter 计数防抖,按 MIME 分流图/视频/音频);
// - 素材区在提示词上方,素材扑克牌堆叠(MaterialStack)+ 人像库入口;
// - 富文本提示词输入(内嵌缩略图 chip + @ 建议,RichPromptInput);
// - 规格参数胶囊排(模式/模型/分辨率/比例/时长/配音/seed/联网);
// - 状态机 UI:draft(生成按钮) → preparing/queued/running(进度条+耗时) →
//   succeeded(内联 <video> 播放) / failed(错误+重试)。

import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import type {
  SeedanceAssetItem,
  SeedanceAssetListResult,
  SeedanceModelAlias,
} from '../../../../types/seedance'
import { capabilitiesFor } from '../../../../types/seedance'
import type {
  VideoWorkbenchCard,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
} from '../../../../types/videoWorkbench'
import { WORKBENCH_MODES, getModeSpec, modeLimit } from '../../features/video-workbench/modes'
import {
  estimateCostCny,
  estimateCostUsd,
  formatCostCny,
  formatCostUsd,
} from '../../features/video-workbench/pricing'
import {
  mediaToken,
  remapTokensForMove,
  removeTokenAndReindex,
  type MediaTokenKind,
} from '../../features/video-workbench/promptTokens'
import { frameAnnotationLabel } from '../../features/video-workbench/advancedVideoEdit'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { useToastStore } from '../../stores/useToastStore'
import {
  externalImageMaterialFromText,
  pasteTargetAcceptsMaterial,
} from '../../features/video-workbench/externalImageUrl'
import { MaterialStack } from './MaterialStack'
import { useMaterialThumbSrcs, type MaterialThumbEntry } from './MaterialThumb'
import { AdvancedVideoEditModal, type AdvancedEditFrame } from './AdvancedVideoEditModal'
import { PortraitPickerModal } from './PortraitPickerModal'
import { ResultVideoPlayer, hasPlaybackSource } from './ResultVideoPlayer'
import { RichPromptInput, type PageMaterialRef, type PromptMediaRef } from './RichPromptInput'
import { VersionSwitcher } from './VersionSwitcher'
import { isActiveStatus } from '../../features/video-workbench/cardSpec'
import { cardHasVideoInput, canStart, useVideoWorkbenchStore } from '../../features/video-workbench/store'
import { parseFileDrop, serializeWorkbenchCardDrag } from '../../features/file-explorer/dragHelpers'
import { materialsFromPaths } from '../../features/video-workbench/pathMaterials'
import { useSeedanceModels } from '../../features/video-workbench/useSeedanceModels'

const CARD_DRAG_MIME = 'application/x-vw-card'
/** 文件栏(FileExplorerPanel)内部拖拽的词表 —— 只有路径,没有 dataTransfer.files。 */
const FILE_PATHS_MIME = 'application/x-catimation-file-paths'

const MODEL_LABELS: Record<SeedanceModelAlias, string> = {
  '2.5': 'Seedance 2.5',
  '2.0': 'Seedance 2.0 满血',
  '2.0-fast': 'Seedance 2.0 Fast',
  '2.0-mini': 'Seedance 2.0 Mini(最省)',
  // 传输层未接完前 region.ts 的 NOT_YET_SELECTABLE 会把它挡在下拉之外;
  // 标签先备着,免得开闸时又要回来补一处。
  wan3: '万相 3.0',
}
/** 站点未报可用档位时的兜底(旧主进程 / IPC 尚未返回)——保守只给 2.0 家族。 */
const FALLBACK_MODELS: readonly SeedanceModelAlias[] = ['2.0', '2.0-fast', '2.0-mini']
const RATIO_OPTIONS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const

/**
 * 分辨率与时长都**按所选模型现算**,不再写死一张 2.0 的表。
 *
 * 2.5 接进来时能力表已经改对了(它没有 1080p / 4k,时长到 30 秒),但这里的常量
 * 数组没跟上,于是界面照旧只肯给到 15 秒、还摆着一个提交必被拒的 1080p。
 *
 * -1 = 智能时长(模型自动决定,文档 8.1);其余按秒连续 —— 上游本来就连续接受,
 * 早先只列偶数与 5 是我们自己漏的,不是上游限制。
 *
 * 「编辑视频」只给智能一个选项:上游 `taskMode="edit"` 的时长固定为 -1,列出来的
 * 每一个秒数都是提交必被拒的(见 cardSpec.lockDurationForMode)。
 */
function durationOptionsFor(model: SeedanceModelAlias, mode: VideoWorkbenchMode): number[] {
  if (mode === 'edit_video') return [-1]
  const { min, max } = capabilitiesFor(model).duration
  const secs: number[] = []
  for (let s = min; s <= max; s += 1) secs.push(s)
  return [-1, ...secs]
}

function getFilePathSafe(file: File): string {
  try {
    const api = (window as unknown as { electronAPI?: { getFilePath?: (f: File) => string } }).electronAPI
    return api?.getFilePath?.(file) ?? ''
  } catch {
    return ''
  }
}

/**
 * 内联(无磁盘路径)素材的体积上限。**只管走内存那条路的**,本地文件不受限 ——
 * 那条从磁盘流式上传,压根没有体积闸门。
 *
 * 取 64MB 而不是聊天栏那条内存路的 100MB(MentionInput 的
 * MAX_BUFFER_ATTACHMENT_BYTES),是因为下游不同:工作台素材要靠
 * `cos:enqueue-upload-bytes` 换成 https,而那条 IPC 自己的闸门就是 64MB。
 * 超过它的素材进来了也永远换不成 https,只会以 base64 跟着卡片一遍遍写进
 * IndexedDB —— 救不回来的东西,别让它进门。
 */
const MAX_INLINE_MATERIAL_BYTES = 64 * 1024 * 1024

function readAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/**
 * File → 素材:优先取真实本地路径(零字节过 IPC,主进程直接读文件/中转 COS);
 * 合成 File(粘贴等)才读 dataURL 兜底。
 *
 * 兜底这条路不设体积上限 —— 体积该由上游裁决,我们猜的数字只会误伤。系统拖拽
 * 和文件选择器给的 File 都带真实路径,走不到这儿;能落到 dataURL 的只有剪贴板
 * 粘贴、网页拖拽这类本来就在内存里的小文件。读失败(超大导致 OOM 等)由
 * FileReader 自己抛,照旧返回 null。
 *
 * `allowInline: false` 关掉兜底(视频用)—— 见 addFiles 里的说明。
 */
async function fileToMaterial(
  file: File,
  allowInline = true,
): Promise<VideoWorkbenchMaterial | null> {
  const path = getFilePathSafe(file)
  if (path) return { name: file.name, src: path }
  if (!allowInline) return null
  if (file.size > MAX_INLINE_MATERIAL_BYTES) return null
  try {
    return { name: file.name, src: await readAsDataUrl(file) }
  } catch {
    return null
  }
}

function classifyFiles(files: File[]): { images: File[]; videos: File[]; audios: File[] } {
  const images: File[] = []
  const videos: File[] = []
  const audios: File[] = []
  for (const f of files) {
    if (f.type.startsWith('image/')) images.push(f)
    else if (f.type.startsWith('video/')) videos.push(f)
    else if (f.type.startsWith('audio/')) audios.push(f)
  }
  return { images, videos, audios }
}

/** 人像库素材项 → 工作台素材(展示名 + asset:// 源 + 预览地址)。 */
function assetToMaterial(asset: SeedanceAssetItem): VideoWorkbenchMaterial {
  return {
    name: asset.name || asset.assetId,
    src: asset.assetUrl || `asset://${asset.assetId}`,
    ...(asset.previewUrl ? { previewUrl: asset.previewUrl } : {}),
  }
}

function assetKind(asset: SeedanceAssetItem): MediaTokenKind {
  const k = String(asset.kind)
  return k === 'video' ? 'video' : k === 'audio' ? 'audio' : 'image'
}

const KIND_TO_FIELD = {
  image: 'referenceImages',
  video: 'referenceVideos',
  audio: 'referenceAudios',
} as const

function statusLabel(card: VideoWorkbenchCard, elapsed: number): string {
  switch (card.status) {
    case 'preparing':
      return '正在准备素材…'
    case 'queued':
      return `排队中 · ${elapsed}s`
    case 'running':
      return `渲染中 · ${elapsed}s(通常 1–3 分钟)`
    default:
      return ''
  }
}


interface WorkbenchCardProps {
  card: VideoWorkbenchCard
  index: number
  onDragStateChange: (dragging: boolean) => void
}

export const WorkbenchCard = memo(function WorkbenchCard({ card, index, onDragStateChange }: WorkbenchCardProps) {
  const updateCard = useVideoWorkbenchStore((s) => s.updateCard)
  const removeCard = useVideoWorkbenchStore((s) => s.removeCard)
const resaveCard = useVideoWorkbenchStore((s) => s.resaveCard)
  const moveCard = useVideoWorkbenchStore((s) => s.moveCard)
  const addMaterials = useVideoWorkbenchStore((s) => s.addMaterials)
  const removeMaterial = useVideoWorkbenchStore((s) => s.removeMaterial)
  const moveMaterial = useVideoWorkbenchStore((s) => s.moveMaterial)
  const startCards = useVideoWorkbenchStore((s) => s.startCards)
  const cancelCards = useVideoWorkbenchStore((s) => s.cancelCards)
  const selected = useVideoWorkbenchStore((s) => s.selectedCardIds.includes(card.id))
  const selectCard = useVideoWorkbenchStore((s) => s.selectCard)

  const busy = card.status === 'preparing' || card.status === 'queued' || card.status === 'running'

  // 可选档位由主进程按站点算(国内 2.5 挂着灰度),渲染端不自己枚举能力表。
  // 拿不到就退回 2.0 家族——少一个选项好过摆一个提交必被拒的选项。
  const availableModels = useSeedanceModels()
  const modelCaps = capabilitiesFor(card.model)
  const durationLocked = card.mode === 'edit_video'
  const durationOptions = useMemo(
    () => durationOptionsFor(card.model, card.mode),
    [card.model, card.mode],
  )

  const [cancelling, setCancelling] = useState(false)
  // running 档的「放弃」要二次确认（不可逆且照样计费）；任务一离开进行中就复位
  const [confirmAbandon, setConfirmAbandon] = useState(false)
  useEffect(() => {
    if (!busy) setConfirmAbandon(false)
  }, [busy])

  // 生成耗时 ticker(仅活跃时跑)。起点必须是 startedAt:每条进度广播都会 bump
  // updatedAt,用它做起点秒表会被广播打回 0(老卡没有 startedAt,退回旧行为)。
  const startedAt = card.startedAt ?? card.updatedAt
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) return
    const tick = (): void => setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    tick()
    const timer = setInterval(tick, 1000)
    return () => clearInterval(timer)
  }, [busy, startedAt])

  // ---- 卡片排序拖拽(手柄触发)与文件投放(整卡)----
  const [dragging, setDragging] = useState(false)
  const [dropEdge, setDropEdge] = useState<'above' | 'below' | null>(null)
  const [fileOver, setFileOver] = useState(false)
  const dragCounter = useRef(0)
  const cardRef = useRef<HTMLDivElement>(null)

  const handleDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes(CARD_DRAG_MIME)) {
      e.preventDefault()
      const rect = cardRef.current?.getBoundingClientRect()
      if (rect) setDropEdge(e.clientY < rect.top + rect.height / 2 ? 'above' : 'below')
    } else if (
      e.dataTransfer.types.includes('Files') ||
      // 文件栏里拖过来的文件只有自定义 MIME(路径),没有 dataTransfer.files ——
      // 不在这里 preventDefault,浏览器压根不会派发 drop,表现为「拖过去没反应」。
      e.dataTransfer.types.includes(FILE_PATHS_MIME)
    ) {
      e.preventDefault()
    }
  }

  const handleDrop = (e: DragEvent) => {
    const draggedId = e.dataTransfer.getData(CARD_DRAG_MIME)
    dragCounter.current = 0
    setFileOver(false)
    if (draggedId) {
      e.preventDefault()
      const rect = cardRef.current?.getBoundingClientRect()
      const before = rect ? e.clientY < rect.top + rect.height / 2 : true
      setDropEdge(null)
      if (draggedId !== card.id) {
        // index / moveCard 都是「本页内」下标:同页卡片按 order 排序后计算来源位。
        const boardCards = useVideoWorkbenchStore
          .getState()
          .cards.filter((c) => c.boardId === card.boardId)
          .sort((a, b) => a.order - b.order)
        const fromIndex = boardCards.findIndex((c) => c.id === draggedId)
        let target = before ? index : index + 1
        if (fromIndex >= 0 && fromIndex < target) target -= 1
        if (fromIndex >= 0) moveCard(draggedId, target)
      }
      return
    }
    const files = [...(e.dataTransfer.files ?? [])]
    if (files.length > 0) {
      if (busy) return
      e.preventDefault()
      void addFiles(files)
      return
    }
    // 文件栏(FileExplorerPanel)拖过来的:只有路径,没有 File。它与工作台同屏
    // (文件栏挂在 AgentChatPanel 上,是全局坞),所以这是个日常动作,此前却整类
    // 被忽略 —— 用户只能先在系统资源管理器里找到同一个文件再拖一次。
    const droppedPaths = parseFileDrop(e.dataTransfer)
    if (droppedPaths.length > 0) {
      if (busy) return
      e.preventDefault()
      addPathMaterials(droppedPaths)
      return
    }
    // 从浏览器直接拖一张图过来:没有 File,只有一条地址(text/uri-list)。
    // 此前这一整类拖放被静默忽略,用户只能先另存到本地再拖进来。
    if (busy) return
    const dropped = externalImageMaterialFromText(
      e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain'),
    )
    if (!dropped) return
    e.preventDefault()
    addExternalImage(dropped)
  }

  /**
   * 一串本地路径入素材(文件栏拖放)。按扩展名归类,各类都尊重当前模式的上限,
   * 与人像库确认那条路同一套「剩余额度」算法。
   */
  const addPathMaterials = (paths: string[]): void => {
    const grouped = materialsFromPaths(paths)
    const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
    for (const kind of ['image', 'video', 'audio'] as const) {
      if (grouped[kind].length === 0) continue
      const remaining = modeLimit(card.mode, kind, card.model) - (current?.[KIND_TO_FIELD[kind]].length ?? 0)
      if (remaining <= 0) continue
      addMaterials(card.id, KIND_TO_FIELD[kind], grouped[kind].slice(0, remaining))
    }
  }

  /** 外链图片入素材(拖放/粘贴共用)。超出该模式的图片上限时不入。 */
  const addExternalImage = (material: VideoWorkbenchMaterial): void => {
    const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
    const limit = modeLimit(card.mode, 'image', card.model)
    if (!current || limit <= 0 || current.referenceImages.length >= limit) return
    if (current.referenceImages.some((m) => m.src === material.src)) return
    addMaterials(card.id, 'referenceImages', [material])
  }

  /** 粘贴一条图片地址即入素材;粘贴文件由浏览器走 files 分支,这里只管文本。 */
  const handlePaste = (e: React.ClipboardEvent): void => {
    if (busy) return
    // 提示词里贴网址是正常写作动作,不能被劫走(事件从输入框冒泡上来)。
    if (!pasteTargetAcceptsMaterial(e.target)) return
    if (e.clipboardData.files.length > 0) return
    const pasted = externalImageMaterialFromText(e.clipboardData.getData('text/plain'))
    if (!pasted) return
    e.preventDefault()
    addExternalImage(pasted)
  }

  const addFiles = async (files: File[]) => {
    const { images, videos, audios } = classifyFiles(files)
    const toMaterials = async (list: File[], allowInline = true) =>
      (await Promise.all(list.map((f) => fileToMaterial(f, allowInline))))
        .filter((m): m is VideoWorkbenchMaterial => m !== null)
    // 体积闸只拦「走内存那条路」的:没有磁盘路径、又超过内联上限。视频不在此列,
    // 它下面有自己那条更明确的提示(无论多大都不收内联)。静默丢掉是最坏的选择 ——
    // 用户只会以为拖拽失灵。
    const tooBig = files.filter(
      (f) =>
        !f.type.startsWith('video/')
        && !getFilePathSafe(f)
        && f.size > MAX_INLINE_MATERIAL_BYTES,
    )
    if (tooBig.length) {
      useToastStore.getState().addToast({
        type: 'warning',
        message: `${tooBig.length > 1 ? `${tooBig.length} 份素材` : `「${tooBig[0].name}」`}没有本地文件且超过 64MB,进来了也无法上传。先保存到本地再拖进来 —— 本地文件走磁盘流式上传,没有体积限制。`,
      })
    }
    // 只进卡片素材区;人像库入库改由生成时兜底(工具栏总闸),上传不再顺带。
    if (images.length && modeLimit(card.mode, 'image', card.model) > 0) {
      addMaterials(card.id, 'referenceImages', await toMaterials(images))
    }
    if (videos.length && modeLimit(card.mode, 'video', card.model) > 0) {
      // 视频不走 dataURL 兜底。分界不在「图片 vs 视频」,在**字节走不走内存**:
      // 有路径的视频由主进程从磁盘流式传 COS,不进渲染堆也不进 IPC,没有体积上限;
      // 没路径就只能整个读进内存再过一次 IPC,而 Electron 的 IPC 对二进制没有零拷贝
      // (所有 IPC 方法都经 v8::ValueSerializer 深拷贝,transfer list 只认 MessagePort),
      // 一条载荷同时存在两份副本。之后它还会以 base64 常驻 IndexedDB、每次提交再过一遍。
      //
      // 图片认这个代价(剪贴板截图没有别的路);视频不认 —— 用户右键存到本地就能换来
      // 流式上传,所以拒收并指路,比默默扛着一坨 base64 诚实。
      const accepted = await toMaterials(videos, false)
      if (accepted.length < videos.length) {
        useToastStore.getState().addToast({
          type: 'warning',
          message: '这个视频没有本地文件(多半是从网页拖来的)。先保存到本地再拖进来 —— 那样会走流式上传,也没有体积限制。',
        })
      }
      if (accepted.length) addMaterials(card.id, 'referenceVideos', accepted)
    }
    if (audios.length && modeLimit(card.mode, 'audio', card.model) > 0) {
      addMaterials(card.id, 'referenceAudios', await toMaterials(audios))
    }
  }

  // ---- 富文本输入的媒体引用(chip 缩略图 / @ 建议数据源)----
  // chip 是 HTML 字符串渲染,跑不了 hook,缩略图地址必须先在这里统一解析:
  // 本地路径经 useMaterialThumbSrcs(IPC → blob:)转可渲染地址(直接塞
  // local-file:// 会裂图,见 MaterialThumb 注释),解析完成前回落 emoji。
  const thumbEntries = useMemo<MaterialThumbEntry[]>(() => {
    const entries: MaterialThumbEntry[] = []
    card.referenceImages.forEach((m) => entries.push({ kind: 'image', material: m }))
    card.referenceVideos.forEach((m) => entries.push({ kind: 'video', material: m }))
    card.referenceAudios.forEach((m) => entries.push({ kind: 'audio', material: m }))
    return entries
  }, [card.referenceImages, card.referenceVideos, card.referenceAudios])
  const thumbSrcs = useMaterialThumbSrcs(thumbEntries)
  const mediaRefs = useMemo<PromptMediaRef[]>(() => {
    const refs: PromptMediaRef[] = []
    const imageCount = card.referenceImages.length
    const videoCount = card.referenceVideos.length
    card.referenceImages.forEach((m, i) =>
      refs.push({ kind: 'image', index1: i + 1, name: m.name, thumbSrc: thumbSrcs[i] }),
    )
    card.referenceVideos.forEach((m, i) =>
      refs.push({ kind: 'video', index1: i + 1, name: m.name, thumbSrc: thumbSrcs[imageCount + i] }),
    )
    card.referenceAudios.forEach((m, i) =>
      refs.push({ kind: 'audio', index1: i + 1, name: m.name, thumbSrc: thumbSrcs[imageCount + videoCount + i] }),
    )
    return refs
  }, [card.referenceImages, card.referenceVideos, card.referenceAudios, thumbSrcs])

  /** @ 建议选中人像库素材:入卡片素材并返回 token 序号(超限返回 null)。 */
  const handlePickAsset = useCallback(
    (asset: SeedanceAssetItem): { kind: MediaTokenKind; index1: number } | null => {
      const kind = assetKind(asset)
      const field = KIND_TO_FIELD[kind]
      const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      if (!current) return null
      const list = current[field]
      if (list.length >= modeLimit(current.mode, kind, current.model)) return null
      // 已在素材里(同 asset:// 源)则直接复用其序号,不重复添加
      const material = assetToMaterial(asset)
      const existing = list.findIndex((m) => m.src === material.src)
      if (existing >= 0) return { kind, index1: existing + 1 }
      addMaterials(card.id, field, [material])
      return { kind, index1: list.length + 1 }
    },
    [card.id, addMaterials],
  )

  /** @ 建议的人像库远程搜索。 */
  const searchAssets = useCallback(async (q: string): Promise<SeedanceAssetItem[]> => {
    const api = (window as unknown as {
      electronAPI?: { seedance?: { listAssets?: (query: object) => Promise<SeedanceAssetListResult> } }
    }).electronAPI?.seedance
    if (!api?.listAssets) return []
    try {
      const result = await api.listAssets({ page: 1, pageSize: 8, kind: 'all', ...(q ? { q } : {}) })
      return result.items ?? []
    } catch {
      return []
    }
  }, [])

  /** 删除素材:同步删掉提示词里的 token 并把同类后续序号 -1(soraui removeMedia)。 */
  const handleRemoveMaterial = useCallback(
    (kind: MediaTokenKind, index: number) => {
      removeMaterial(card.id, KIND_TO_FIELD[kind], index)
      const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      if (!current) return
      const nextPrompt = removeTokenAndReindex(current.prompt, kind, index + 1)
      if (nextPrompt !== current.prompt) updateCard(card.id, { prompt: nextPrompt })
    },
    [card.id, removeMaterial, updateCard],
  )

  /** 素材拖拽换位:同步重映射提示词 token 序号,chip 引用不受顺序调整影响。 */
  const handleReorderMaterial = useCallback(
    (kind: MediaTokenKind, fromIndex: number, toIndex: number) => {
      moveMaterial(card.id, KIND_TO_FIELD[kind], fromIndex, toIndex)
      const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      if (!current) return
      const nextPrompt = remapTokensForMove(current.prompt, kind, fromIndex + 1, toIndex + 1)
      if (nextPrompt !== current.prompt) updateCard(card.id, { prompt: nextPrompt })
    },
    [card.id, moveMaterial, updateCard],
  )

  /** @ 建议「本页素材」分组:页面其他卡片素材(弹层打开时快照,去重排除本卡已有)。 */
  const getPageMaterials = useCallback((): PageMaterialRef[] => {
    const state = useVideoWorkbenchStore.getState()
    const current = state.cards.find((c) => c.id === card.id)
    const own = new Set(
      [
        ...(current?.referenceImages ?? []),
        ...(current?.referenceVideos ?? []),
        ...(current?.referenceAudios ?? []),
      ].map((m) => m.src),
    )
    const seen = new Set<string>()
    const out: PageMaterialRef[] = []
    for (const c of state.cards) {
      // 「本页素材」只收当前页的其他卡片(页与页之间素材隔离)
      if (c.id === card.id || c.boardId !== card.boardId) continue
      const collect = (kind: MediaTokenKind, list: VideoWorkbenchMaterial[]) => {
        for (const m of list) {
          if (own.has(m.src) || seen.has(m.src)) continue
          seen.add(m.src)
          // 只有可直连地址(previewUrl / data: / https)才出缩略图,本地路径回落 emoji
          const direct =
            m.previewUrl ?? (m.src.startsWith('data:') || m.src.startsWith('http') ? m.src : undefined)
          out.push({ kind, material: m, ...(direct ? { thumbSrc: direct } : {}) })
        }
      }
      collect('image', c.referenceImages)
      collect('video', c.referenceVideos)
      collect('audio', c.referenceAudios)
    }
    return out
  }, [card.id])

  /** @ 建议选中其他卡片素材:入本卡素材并返回 token 序号(超限返回 null)。 */
  const handlePickMaterial = useCallback(
    (ref: PageMaterialRef): { kind: MediaTokenKind; index1: number } | null => {
      const field = KIND_TO_FIELD[ref.kind]
      const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      if (!current) return null
      const list = current[field]
      const existing = list.findIndex((m) => m.src === ref.material.src)
      if (existing >= 0) return { kind: ref.kind, index1: existing + 1 }
      if (list.length >= modeLimit(current.mode, ref.kind, current.model)) return null
      addMaterials(card.id, field, [ref.material])
      return { kind: ref.kind, index1: list.length + 1 }
    },
    [card.id, addMaterials],
  )

  // 人像库选择器
  const [pickerOpen, setPickerOpen] = useState(false)
  // 「图片链接」输入行(拖放/粘贴之外的显式入口)
  const [urlInputOpen, setUrlInputOpen] = useState(false)
  const [urlDraft, setUrlDraft] = useState('')
  const handlePortraitConfirm = useCallback(
    (assets: SeedanceAssetItem[]) => {
      const grouped: Record<MediaTokenKind, VideoWorkbenchMaterial[]> = { image: [], video: [], audio: [] }
      for (const asset of assets) grouped[assetKind(asset)].push(assetToMaterial(asset))
      const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      for (const kind of ['image', 'video', 'audio'] as const) {
        if (grouped[kind].length === 0) continue
        const remaining = modeLimit(card.mode, kind, card.model) - (current?.[KIND_TO_FIELD[kind]].length ?? 0)
        if (remaining <= 0) continue
        addMaterials(card.id, KIND_TO_FIELD[kind], grouped[kind].slice(0, remaining))
      }
    },
    [card.id, card.mode, addMaterials],
  )

  // ---- 高级编辑(仅 2.5 的「编辑视频」)----
  // 它解决的是「改哪儿说不清楚」:在参考视频的某一帧上圈一下、标个号,把这张带
  // 标注的图当参考图发出去,比任何措辞都准。入口只在**真能用**时出现:换模型/
  // 换模式/没视频素材时按钮消失,而不是点了才报错。
  const [aveOpen, setAveOpen] = useState(false)
  const editableVideo = card.referenceVideos[0]
  const canAdvancedEdit = card.model === '2.5' && card.mode === 'edit_video' && editableVideo !== undefined
  /**
   * 抽帧源**刻意保留 blob:**,不要跟着播放那几处改成 `toStreamableUri`。
   *
   * 播放类表面(ResultVideoPlayer / MaterialPreviewModal)已经迁到流式协议,省内存
   * 又能拖进度条。这里不能跟：高级编辑要把 `<video>` 画到 canvas 上再 `toDataURL`
   * 取像素,而 canvas 一旦画进**跨源**内容就会被污染,`toDataURL` 直接抛 SecurityError。
   * `blob:` 是同源的,`local-file://` 不是。
   *
   * 真要迁,前置条件是给协议加 `corsEnabled` + 响应带 `Access-Control-Allow-Origin`,
   * 再给 `<video>` 设 `crossOrigin="anonymous"` —— 那是独立一笔,而且会动到刚验证通过
   * 的协议配置,不该顺手做。
   *
   * `fullFidelity` 同样不能去掉:抽帧要原始像素,缩略图那条路出来的是 256px JPEG。
   */
  const aveVideoSrc = useResolvedMediaSrc(
    canAdvancedEdit && aveOpen ? editableVideo.src : '',
    'video',
    { fullFidelity: true },
  )

  /**
   * 高级编辑保存:拍平帧进参考图,并在提示词末尾补上对应的 `【@图片N】` + 备注。
   *
   * 序号按**加入后**的位置算,所以要在 addMaterials 之后重新读一次卡片 —— 中途
   * 可能被模式上限截断,拿加入前的长度去推会指到不存在的素材上。
   */
  const handleAdvancedEditApply = useCallback(
    (frames: AdvancedEditFrame[], note: string) => {
      if (frames.length === 0) return
      const state = useVideoWorkbenchStore.getState()
      const before = state.cards.find((c) => c.id === card.id)?.referenceImages.length ?? 0
      const remaining = modeLimit(card.mode, 'image', card.model) - before
      if (remaining <= 0) {
        useToastStore.getState().addToast({ type: 'error', message: '参考图已达该模式上限,先删几张再添加' })
        return
      }
      const accepted = frames.slice(0, remaining)
      // 就当一张普通参考图加进去:内联字节的转存由 materialTransfer 统一接管
      // (与粘贴图同路),回来会把 src 换成 COS 的 https 地址。
      addMaterials(
        card.id,
        'referenceImages',
        accepted.map((f) => ({ name: `${frameAnnotationLabel(f.timeSec)}.jpg`, src: f.dataUrl })),
      )
      const after = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      if (!after) return
      const tokens = accepted.map((_, i) => mediaToken('image', before + i + 1)).join(' ')
      const nextPrompt = [after.prompt, tokens, note].filter((s) => s && s.trim()).join(' ').trim()
      if (nextPrompt !== after.prompt) updateCard(card.id, { prompt: nextPrompt })
      if (accepted.length < frames.length) {
        useToastStore.getState().addToast({
          type: 'warning',
          message: `参考图上限,只加入了 ${accepted.length}/${frames.length} 帧`,
        })
      }
    },
    [card.id, card.mode, card.model, addMaterials, updateCard],
  )

  const modeSpec = getModeSpec(card.mode)
  const hasResultVideo = hasPlaybackSource(card)
  const versions = card.versions ?? []
  // 预览下标:纯 UI 状态,不持久化。新版本到达时自动跳过去 —— 那正是用户在等的东西。
  const [versionIdx, setVersionIdx] = useState(versions.length > 0 ? versions.length - 1 : 0)
  useEffect(() => {
    setVersionIdx(versions.length > 0 ? versions.length - 1 : 0)
  }, [versions.length])
  // 渲染中显示历史版本;没有版本记录(老数据)时退回卡片自身的结果字段。
  const playbackSource = versions[versionIdx] ?? card

  return (
    <div
      ref={cardRef}
      data-testid={`vw-card-${card.id}`}
      className={[
        'vw-card border bg-[#111113] relative',
        // 选中只换边框色:加投影/填充会遮挡内容,而卡片主体全是可读信息
        selected ? 'border-[#FCE300]' : 'border-[#3F3F46]',
        dragging ? 'vw-dragging' : '',
        dropEdge === 'above' ? 'vw-drop-above' : dropEdge === 'below' ? 'vw-drop-below' : '',
        fileOver ? 'vw-file-over' : '',
      ].join(' ')}
      onDragOver={handleDragOver}
      onDragLeave={(e) => {
        if (e.dataTransfer.types.includes(CARD_DRAG_MIME)) setDropEdge(null)
        if (e.dataTransfer.types.includes('Files')) {
          dragCounter.current -= 1
          if (dragCounter.current <= 0) setFileOver(false)
        }
      }}
      onDragEnter={(e) => {
        // 浏览器拖来的图只有 text/uri-list,没有 Files —— 也要给出可放置反馈,
        // 否则用户看不到卡片接得住它。
        const carriesMedia =
          e.dataTransfer.types.includes('Files') || e.dataTransfer.types.includes('text/uri-list')
        if (carriesMedia && !busy) {
          dragCounter.current += 1
          setFileOver(true)
        }
      }}
      onDrop={handleDrop}
      onPaste={handlePaste}
    >
      {/* 头部:序号 + 拖拽手柄 + 状态徽标 + 删除。
          这一行是**唯一**的选中命中区,也是**整条可拖区** —— 卡片主体密布输入框与
          药丸,整卡点选/整卡可拖都会和它们打架。
          `select-none` 不是装饰:没有它,按住这一行往外拖会变成「选中 #02 这几个字」,
          拖拽压根不启动(用户报的就是这个)。 */}
      <div
        data-testid="vw-card-header"
        // py-3 而不是 pt-3:这一行既是选中命中区又是拖拽抓手,原来只有上内边距,
        // 实际可点高度只有文字那么高(约 18px),要「瞄准」才点得中。加下内边距把
        // 它撑到约 40px —— 仍然只占卡片顶部一条,不侵占主体的输入框与药丸。
        // cursor-grab 让「这里能拖」不必靠猜。
        className={[
          'flex items-center gap-2 px-4 py-3 select-none cursor-grab active:cursor-grabbing',
          // 悬停给一点底色:命中区看不见时,用户不知道该往哪儿按
          'hover:bg-white/[0.04] transition-colors',
          selected ? 'bg-[#FCE300]/[0.07]' : '',
        ].join(' ')}
        title="拖动:页内排序 / 拖进聊天栏交给模型(还没出片就递这张卡的规格说明);单击选中(Ctrl 加选 · Shift 选区间)"
        draggable
        onDragStart={(e) => {
          // 从行内按钮(删除等)起手不该变成拖卡
          if ((e.target as HTMLElement).closest('button')) {
            e.preventDefault()
            return
          }
          // 页内排序只认被拖那一张,即便当时选中了好几张 —— 换位语义不变。
          e.dataTransfer.setData(CARD_DRAG_MIME, card.id)

          // 拖未选中的卡 → 先把选区换成它(FileTreeNode 同款):这样「拖出去的」
          // 恒等于「选中的」,而选中态本身会随每次工作台工具调用带给 agent。
          const before = useVideoWorkbenchStore.getState()
          if (!before.selectedCardIds.includes(card.id)) before.selectCard(card.id)
          // 同步选区之后再读一次,别把「换选区前」的快照和「换之后」的混着用
          const { cards, selectedCardIds } = useVideoWorkbenchStore.getState()
          const dragged = selectedCardIds
            .map((id) => cards.find((c) => c.id === id))
            .filter((c): c is VideoWorkbenchCard => Boolean(c))
          // 专用 MIME,**不是**文件树那个 x-catimation-file-paths:后者的含义是
          // 「可以被移动的工作区文件」,而文件栏与工作台同屏,复用会让卡片被拖过
          // 文件树时真的 fs.move 掉 mp4(详见 dragHelpers 里 WORKBENCH_CARD_TYPE 的注释)。
          //
          // 三级地址全带上(localPath → remoteUrl → videoUrl),和播放器的降级顺序
          // 一致:只带 localPath 会把「本地被 7 天清理扫掉、云端还在」的卡误报成
          // 「还没有生成结果」。还没有产物的卡则带上规格摘要,聊天栏据此合成一份
          // 说明递给模型 —— 素材只记名字,data: URL 不进载荷。
          serializeWorkbenchCardDrag(
            e.dataTransfer,
            dragged.map((c) => ({
              cardId: c.id,
              ...(c.localPath ? { localPath: c.localPath } : {}),
              ...(c.remoteUrl ? { remoteUrl: c.remoteUrl } : {}),
              ...(c.videoUrl ? { videoUrl: c.videoUrl } : {}),
              status: c.status,
              ...(c.error ? { error: c.error } : {}),
              spec: {
                prompt: c.prompt,
                model: c.model,
                resolution: c.resolution,
                ratio: c.ratio,
                duration: c.duration,
                generateAudio: c.generateAudio,
                mode: c.mode,
                ...(c.seed !== undefined ? { seed: c.seed } : {}),
                webSearch: c.webSearch,
                referenceBrief: {
                  images: c.referenceImages.map((m) => m.name),
                  videos: c.referenceVideos.map((m) => m.name),
                  audios: c.referenceAudios.map((m) => m.name),
                },
              },
            })),
          )

          // 'move' 会让聊天栏那侧拿不到 copy 效果 —— 双目标必须 copyMove。
          e.dataTransfer.effectAllowed = 'copyMove'
          setDragging(true)
          onDragStateChange(true)
        }}
        onDragEnd={() => {
          setDragging(false)
          setDropEdge(null)
          onDragStateChange(false)
        }}
        onClick={(e) => {
          // 行内那几个控件(删除等)各自 stopPropagation 不现实,统一按标签放行
          if ((e.target as HTMLElement).closest('button')) return
          selectCard(card.id, e.shiftKey ? 'range' : e.ctrlKey || e.metaKey ? 'toggle' : 'replace')
        }}
      >
        {/* 纯视觉抓手 —— 可拖的是整条头部行,这个只是告诉用户「这里能拖」 */}
        <span
          className="vw-drag-handle text-white/40 text-sm leading-none px-1"
          aria-hidden="true"
        >
          ⣿
        </span>
        <span className="text-[#FCE300] text-xs font-bold tracking-widest">#{String(index + 1).padStart(2, '0')}</span>
        <span
          className={[
            'text-[10px] uppercase tracking-wider px-1.5 py-0.5',
            card.status === 'succeeded'
              ? 'bg-green-600 text-white'
              : card.status === 'failed'
                ? 'bg-red-600 text-white'
                : busy
                  ? 'bg-[#FCE300] text-black'
                  : 'bg-[#27272A] text-white/60',
          ].join(' ')}
        >
          {card.status === 'draft'
            ? '草稿'
            : card.status === 'preparing'
              ? '准备中'
              : card.status === 'queued'
                ? '排队中'
                : card.status === 'running'
                  ? '渲染中'
                  : card.status === 'succeeded'
                    ? '已完成'
                    : card.status === 'cancelled'
                      ? '已取消'
                      : '失败'}
        </span>
        <span className="text-white/30 text-[10px] ml-auto">
          {modeSpec.label} · {card.model} · {card.resolution} · {card.ratio} ·{' '}
          {card.duration === -1 ? '智能时长' : `${card.duration}s`}
          {card.generateAudio ? ' · 有声' : ''}
          {card.seed !== undefined ? ` · seed ${card.seed}` : ''}
          {card.webSearch ? ' · 联网' : ''}
        </span>
        <button
          type="button"
          aria-label="删除卡片"
          className="text-white/40 hover:text-red-400 text-sm px-1"
          onClick={() => removeCard(card.id)}
        >
          ✕
        </button>
      </div>

      <div className="p-4 space-y-3">
        {/* 参考素材(soraui 布局:素材区在提示词上方) */}
        {(modeLimit(card.mode, 'image', card.model) > 0 ||
          modeLimit(card.mode, 'video', card.model) > 0 ||
          modeLimit(card.mode, 'audio', card.model) > 0) && (
          <div className="space-y-2 border border-dashed border-[#27272A] px-3 py-2">
            <MaterialStackRow
              card={card}
              busy={busy}
              addFiles={addFiles}
              onRemove={handleRemoveMaterial}
              onReorder={handleReorderMaterial}
              thumbSrcs={thumbSrcs}
            />
            <div className="flex items-center gap-3">
              <p className="text-white/25 text-[10px] flex-1">
                {card.mode === 'first_frame'
                  ? '第 1 张图 = 视频首帧(图生视频)'
                  : card.mode === 'first_last_frame'
                    ? '第 1 张图 = 首帧,第 2 张 = 尾帧'
                    : card.mode === 'extend_video'
                      ? `上传要延长的视频(≤${modeLimit(card.mode, 'video', card.model)})`
                      : `拖放文件到卡片任意位置即可按类型自动归入(图≤${modeLimit(card.mode, 'image', card.model)} / 视频≤${modeLimit(card.mode, 'video', card.model)} / 音频≤${modeLimit(card.mode, 'audio', card.model)})`}
              </p>
              {!busy && (
                <button
                  type="button"
                  className="text-[10px] border border-[#3F3F46] text-white/60 px-2 py-1 hover:border-[#FCE300] hover:text-[#FCE300] shrink-0"
                  onClick={() => setUrlInputOpen((v) => !v)}
                >
                  ◎ 图片链接
                </button>
              )}
              {!busy && (
                <button
                  type="button"
                  className="text-[10px] border border-[#3F3F46] text-white/60 px-2 py-1 hover:border-[#FCE300] hover:text-[#FCE300] shrink-0"
                  onClick={() => setPickerOpen(true)}
                >
                  ◈ 人像库
                </button>
              )}
            </div>
            {urlInputOpen && !busy && (
              // 拖放与粘贴是给熟手的手势,这里是给「我手上就有一条地址」的人的入口。
              <input
                autoFocus
                type="url"
                aria-label="图片链接"
                value={urlDraft}
                placeholder="粘贴图片地址后回车(支持没有扩展名的图床地址)"
                className="w-full bg-[#18181B] border border-[#3F3F46] text-white/80 text-[11px] px-2 py-1.5 focus:outline-none focus:border-[#FCE300]"
                onChange={(e) => setUrlDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') { setUrlInputOpen(false); setUrlDraft(''); return }
                  if (e.key !== 'Enter') return
                  const material = externalImageMaterialFromText(urlDraft)
                  if (!material) return
                  addExternalImage(material)
                  setUrlDraft('')
                  setUrlInputOpen(false)
                }}
              />
            )}
          </div>
        )}

        {/* 提示词(富文本:素材 token 渲染为缩略图 chip,@ 呼出建议) */}
        <RichPromptInput
          value={card.prompt}
          disabled={busy}
          placeholder="描述你想要的视频:镜头语言 / 台词 / 风格;输入 @ 引用素材(图片1 / 视频1 / 音频1)…"
          mediaRefs={mediaRefs}
          onChange={(v) => updateCard(card.id, { prompt: v })}
          onPickAsset={handlePickAsset}
          searchAssets={searchAssets}
          getPageMaterials={getPageMaterials}
          onPickMaterial={handlePickMaterial}
        />

        {/* 规格胶囊排 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="生成模式"
            value={card.mode}
            disabled={busy}
            title={modeSpec.description}
            className="bg-[#18181B] border border-[#3F3F46] text-[#FCE300] px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => updateCard(card.id, { mode: e.target.value as VideoWorkbenchMode })}
          >
            {WORKBENCH_MODES.map((m) => (
              <option key={m.value} value={m.value} title={m.description}>{m.label}</option>
            ))}
          </select>
          {canAdvancedEdit && (
            <button
              type="button"
              data-testid="vw-advanced-edit-open"
              disabled={busy}
              title="在参考视频的某一帧上标注(圈选/箭头/文字/定位钉),拍平成参考图带回本卡"
              className="border border-[#FCE300]/60 text-[#FCE300] px-2 py-1.5 hover:bg-[#FCE300]/10 disabled:opacity-40"
              onClick={() => setAveOpen(true)}
            >
              ✎ 高级编辑
            </button>
          )}
          <select
            aria-label="模型"
            value={card.model}
            disabled={busy}
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => {
              const model = e.target.value as SeedanceModelAlias
              const caps = capabilitiesFor(model)
              // 换档可能让当前分辨率/时长越界(1080p 只有 2.0 满血有;2.5 上限 30s
              // 而 2.0 家族 15s)。就地收敛到新模型的合法值,别把越界值留到提交时
              // 才被上游或 validateSeedanceRequest 拒。
              const resolution = caps.resolutions.includes(card.resolution)
                ? undefined
                : ('720p' as const)
              const duration =
                card.duration !== -1 &&
                (card.duration < caps.duration.min || card.duration > caps.duration.max)
                  ? Math.min(caps.duration.max, Math.max(caps.duration.min, card.duration))
                  : undefined
              updateCard(card.id, {
                model,
                ...(resolution ? { resolution } : {}),
                ...(duration !== undefined ? { duration } : {}),
              })
            }}
          >
            {availableModels.map((m) => (
              <option key={m} value={m}>{MODEL_LABELS[m]}</option>
            ))}
          </select>
          <select
            aria-label="分辨率"
            value={card.resolution}
            disabled={busy}
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) =>
              updateCard(card.id, { resolution: e.target.value as '480p' | '720p' | '1080p' })
            }
          >
            {modelCaps.resolutions.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            aria-label="画面比例"
            value={card.ratio}
            disabled={busy}
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => updateCard(card.id, { ratio: e.target.value as typeof RATIO_OPTIONS[number] })}
          >
            {RATIO_OPTIONS.map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
          <select
            aria-label="时长"
            value={card.duration}
            disabled={busy || durationLocked}
            title={durationLocked
              ? '编辑视频固定为智能时长 —— 上游不接受固定秒数,输出长度跟随被编辑的视频'
              : '智能时长 = 模型按内容自动决定输出时长'}
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => updateCard(card.id, { duration: Number(e.target.value) })}
          >
            {durationOptions.map((d) => (
              <option key={d} value={d}>{d === -1 ? '✨ 智能' : `${d}s`}</option>
            ))}
          </select>
          <label className="flex items-center gap-1.5 text-white/70 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={card.generateAudio}
              disabled={busy}
              className="accent-[#FCE300]"
              onChange={(e) => updateCard(card.id, { generateAudio: e.target.checked })}
            />
            配音/音效
          </label>
          {/* seed:留空=随机(soraui 🎲 pill 的 InputNumber) */}
          <label className="flex items-center gap-1 text-white/70 select-none" title="随机种子:留空=随机,固定后同参数可复现">
            <span>🎲</span>
            <input
              type="number"
              min={0}
              max={4294967295}
              step={1}
              value={card.seed ?? ''}
              disabled={busy}
              placeholder="随机"
              aria-label="随机种子"
              className="w-24 bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60 [appearance:textfield]"
              onChange={(e) => {
                const raw = e.target.value.trim()
                updateCard(card.id, { seed: raw === '' ? null : Number(raw) })
              }}
            />
          </label>
          {/* 联网搜索(soraui 🌐 Switch → 上游 tools: web_search) */}
          <label className="flex items-center gap-1.5 text-white/70 cursor-pointer select-none" title="联网搜索增强:生成时允许上游检索网络信息">
            <input
              type="checkbox"
              checked={card.webSearch}
              disabled={busy}
              className="accent-[#FCE300]"
              onChange={(e) => updateCard(card.id, { webSearch: e.target.checked })}
            />
            🌐 联网
          </label>
        </div>

        {/* 状态区 */}
        {busy && (
          <div className="space-y-1.5">
            <div className="vw-progress-track"><div className="vw-progress-bar" /></div>
            <p className="text-white/60 text-xs">{statusLabel(card, elapsed)}</p>
          </div>
        )}

        {card.status === 'failed' && (
          <p className="text-red-400 text-xs break-all border border-red-500/40 px-2 py-1.5">{card.error ?? '生成失败'}</p>
        )}

        {/* 取消的原因值得原样显示 —— 它会说明这次到底计不计费 */}
        {card.status === 'cancelled' && (
          <p className="text-orange-300 text-xs break-all border border-orange-400/40 px-2 py-1.5">
            {card.error ?? '已取消'}
          </p>
        )}

        {/* 有历史版本时,渲染中也要保持结果区可见 —— 「重新生成不该隐藏之前的视频」。 */}
        {(hasResultVideo || versions.length > 0) && (
          <div className="space-y-2">
            {/* 本地字节经 IPC 转 blob: 播放(local-file:// 直塞 <video> 会空白,
                见 ResultVideoPlayer 注释);失败自动降级远程源/错误兜底 */}
            <ResultVideoPlayer source={playbackSource} />
            {isActiveStatus(card.status) && versions.length > 0 && (
              <p className="text-[10px] text-white/40">新版本生成中,当前显示历史版本</p>
            )}
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/40">
              <VersionSwitcher versions={versions} index={versionIdx} onChange={setVersionIdx} />
              {card.persistence === 'done' && card.localPath ? (
                <span className="truncate max-w-[50%]" title={card.localPath}>已保存: {card.localPath}</span>
              ) : card.persistence === 'failed' ? (
                <span className="flex items-center gap-1.5 text-orange-400">
                  {/* 不能写「视频仍可播放/下载」—— 本地和 COS 都没副本时只剩上游那条会
                      过期的地址，等用户回来点播放它多半已经不通，那句话就成了假话。 */}
                  <span title="上游地址通常一天后过期；后台已在 1/5/15 分钟各重试过一次">
                    未保存到本地(仅剩上游临时地址)
                  </span>
                  {(card.taskId || card.videoUrl) && (
                    // 免费的补救。有任务号就一定值得点:主进程会拿它向上游重查出一条
                    // 新签发的地址，不受那条旧地址 24 小时过期的限制。
                    <button
                      type="button"
                      title="按任务号重新取一次视频并保存，不重新生成、不花钱"
                      className="border border-orange-400/50 px-1.5 py-0.5 text-[10px] hover:border-[#FCE300] hover:text-[#FCE300] transition-colors"
                      onClick={() => { void resaveCard(card.id) }}
                    >
                      ↻ 重新保存
                    </button>
                  )}
                </span>
              ) : (
                <span>正在后台保存…</span>
              )}
              {/* 上游回传的实际 seed:点击回填,可复现同画面(文档 3.1) */}
              {card.actualSeed !== undefined && (
                <button
                  type="button"
                  className="text-white/40 hover:text-[#FCE300] underline decoration-dotted underline-offset-2"
                  title="上游实际使用的种子;点击回填到 seed 输入框,同参数重跑可复现"
                  onClick={() => updateCard(card.id, { seed: card.actualSeed })}
                >
                  🎲 seed {card.actualSeed}
                </button>
              )}
              {/* usage.completion_tokens + 按官方价目估算(文档 9) */}
              {card.completionTokens !== undefined && (
                <span title="上游 usage.completion_tokens(计费口径)">
                  {Math.round(card.completionTokens / 1000)}k tokens
                  {(() => {
                    const cost = estimateCostUsd(
                      card.model,
                      card.resolution,
                      cardHasVideoInput(card),
                      card.completionTokens,
                    )
                    return cost != null ? ` ≈ ${formatCostUsd(cost)}` : ''
                  })()}
                </span>
              )}
              {/* 按秒计费(万相):口径是上游回传的**实际出片秒数**,不是用户选的
                  时长 —— 智能时长下两者不是一回事。 */}
              {card.billedSeconds !== undefined && (
                <span title="上游回传的实际出片秒数(按秒计费口径)">
                  {card.billedSeconds}s
                  {(() => {
                    const cost = estimateCostCny(card.model, card.resolution, card.billedSeconds)
                    return cost != null ? ` ≈ ${formatCostCny(cost)}` : ''
                  })()}
                </span>
              )}
            </div>
          </div>
        )}

        {/* 操作行(启动约束与 store.canStart 同源:空提示词/音频单独作参考/1080p 档位) */}
        <div className="flex items-center gap-2">
          {!busy && (() => {
            const gate = canStart(card)
            return (
              <>
                <button
                  type="button"
                  className={`${card.status === 'draft' ? 'vw-generate-btn' : ''} bg-[#FCE300] text-black text-sm font-bold px-4 py-2 hover:opacity-85 active:scale-95 transition-all disabled:opacity-40 disabled:animate-none`}
                  disabled={!gate.ok}
                  title={gate.ok ? undefined : gate.reason}
                  onClick={() => void startCards([card.id])}
                >
                  {card.status === 'failed'
                    ? '↻ 重试'
                    : card.status === 'succeeded' || card.status === 'cancelled'
                      ? '↻ 重新生成'
                      : '▶ 生成'}
                </button>
                {!gate.ok && gate.reason !== '提示词为空' && (
                  <span className="text-orange-400 text-[10px]">⚠ {gate.reason}</span>
                )}
              </>
            )
          })()}
          {/* 取消。计费口径按上游分档如实写在按钮上:排队中能真取消(不计费),
              生成中上游不支持取消 —— 视频照样出、照样扣钱,这里只是停止等待,
              所以那一档要二次确认,别让人以为点一下就省了钱。 */}
          {busy && (() => {
            const running = card.status === 'running'
            return (
              <button
                type="button"
                className="border border-white/20 text-white/70 text-sm px-3 py-2 hover:border-red-400 hover:text-red-300 transition-colors disabled:opacity-40"
                disabled={cancelling}
                title={
                  running
                    ? '上游不支持取消生成中的任务:视频仍会生成并计费,这里只是停止等待结果'
                    : '排队阶段可以真取消,不会产生费用'
                }
                onClick={() => {
                  if (running && !confirmAbandon) {
                    setConfirmAbandon(true)
                    return
                  }
                  setCancelling(true)
                  void cancelCards([card.id]).finally(() => setCancelling(false))
                }}
              >
                {cancelling
                  ? '处理中…'
                  : running
                    ? confirmAbandon
                      ? '确认放弃?(仍计费)'
                      : '⏹ 放弃结果'
                    : '⏹ 取消'}
              </button>
            )
          })()}
          {card.taskId && (
            <span className="text-white/25 text-[10px] truncate" title={card.taskId}>task: {card.taskId}</span>
          )}
        </div>
      </div>

      {/* 人像库选择器(asset:// 回填) */}
      <PortraitPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onConfirm={handlePortraitConfirm} />
      {/* 地址解析完才挂:<video src=""> 会立刻报一个没有意义的加载错误 */}
      {aveOpen && aveVideoSrc && (
        <AdvancedVideoEditModal
          open
          videoSrc={aveVideoSrc}
          onClose={() => setAveOpen(false)}
          onApply={handleAdvancedEditApply}
        />
      )}
    </div>
  )
})

function MaterialStackRow({
  card,
  busy,
  addFiles,
  onRemove,
  onReorder,
  thumbSrcs,
}: {
  card: VideoWorkbenchCard
  busy: boolean
  addFiles: (files: File[]) => Promise<void>
  onRemove: (kind: MediaTokenKind, index: number) => void
  onReorder: (kind: MediaTokenKind, fromIndex: number, toIndex: number) => void
  /** 卡片层已解析的缩略图地址,顺序为 图片→视频→音频(见 thumbEntries)。 */
  thumbSrcs: Array<string | undefined>
}) {
  // MaterialStack 的 onAdd 直接复用整卡 addFiles(自动按 MIME 分流),
  // 这样点「+」和拖放走同一条入库路径。素材上限跟随生成模式。
  const onAdd = (files: File[]) => void addFiles(files)
  const imageLimit = modeLimit(card.mode, 'image', card.model)
  const videoLimit = modeLimit(card.mode, 'video', card.model)
  const audioLimit = modeLimit(card.mode, 'audio', card.model)
  const imageLabel =
    card.mode === 'first_frame' ? '首帧图' : card.mode === 'first_last_frame' ? '首/尾帧' : '参考图'
  // thumbSrcs 是三类素材首尾相接的一条数组,按各自长度切回来。
  const imageCount = card.referenceImages.length
  const videoCount = card.referenceVideos.length
  const imageThumbs = thumbSrcs.slice(0, imageCount)
  const videoThumbs = thumbSrcs.slice(imageCount, imageCount + videoCount)
  const audioThumbs = thumbSrcs.slice(imageCount + videoCount)
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-1">
      {imageLimit > 0 && (
        <MaterialStack
          kind="image"
          label={imageLabel}
          accept="image/*"
          materials={card.referenceImages}
          thumbSrcs={imageThumbs}
          limit={imageLimit}
          disabled={busy}
          onAdd={onAdd}
          onRemove={(i) => onRemove('image', i)}
          onReorder={(f, t) => onReorder('image', f, t)}
        />
      )}
      {videoLimit > 0 && (
        <MaterialStack
          kind="video"
          label="视频素材"
          accept="video/*"
          materials={card.referenceVideos}
          thumbSrcs={videoThumbs}
          limit={videoLimit}
          disabled={busy}
          onAdd={onAdd}
          onRemove={(i) => onRemove('video', i)}
          onReorder={(f, t) => onReorder('video', f, t)}
        />
      )}
      {audioLimit > 0 && (
        <MaterialStack
          kind="audio"
          label="音频素材"
          accept="audio/*"
          materials={card.referenceAudios}
          thumbSrcs={audioThumbs}
          limit={audioLimit}
          disabled={busy}
          onAdd={onAdd}
          onRemove={(i) => onRemove('audio', i)}
          onReorder={(f, t) => onReorder('audio', f, t)}
        />
      )}
    </div>
  )
}
