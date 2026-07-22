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
import type { SeedanceAssetItem, SeedanceAssetListResult } from '../../../../types/seedance'
import type {
  VideoWorkbenchCard,
  VideoWorkbenchMaterial,
  VideoWorkbenchMode,
} from '../../../../types/videoWorkbench'
import { toRenderableUri } from '../../features/file-explorer/uri'
import { WORKBENCH_MODES, getModeSpec, modeLimit } from '../../features/video-workbench/modes'
import { estimateCostUsd, formatCostUsd } from '../../features/video-workbench/pricing'
import { removeTokenAndReindex, type MediaTokenKind } from '../../features/video-workbench/promptTokens'
import { MaterialStack } from './MaterialStack'
import { useMaterialThumbSrcs, type MaterialThumbEntry } from './MaterialThumb'
import { PortraitPickerModal } from './PortraitPickerModal'
import { RichPromptInput, type PromptMediaRef } from './RichPromptInput'
import { buildModeMedia, canStart, useVideoWorkbenchStore } from '../../features/video-workbench/store'

const CARD_DRAG_MIME = 'application/x-vw-card'

const MODEL_OPTIONS = [
  { value: '2.0', label: 'Seedance 2.0 满血' },
  { value: '2.0-fast', label: 'Seedance 2.0 Fast' },
  { value: '2.0-mini', label: 'Seedance 2.0 Mini(最省)' },
] as const
const RESOLUTION_OPTIONS = ['480p', '720p', '1080p'] as const
const RATIO_OPTIONS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const
/** -1 = 智能时长(模型自动决定,文档 8.1)。 */
const DURATION_OPTIONS = [-1, 4, 5, 6, 8, 10, 12, 15] as const

/** 大文件上限(读成 dataURL 兜底路径时):30MB 图片上游硬限。 */
const MAX_DATAURL_FILE_MB = 30

function getFilePathSafe(file: File): string {
  try {
    const api = (window as unknown as { electronAPI?: { getFilePath?: (f: File) => string } }).electronAPI
    return api?.getFilePath?.(file) ?? ''
  } catch {
    return ''
  }
}

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
 */
async function fileToMaterial(file: File): Promise<VideoWorkbenchMaterial | null> {
  const path = getFilePathSafe(file)
  if (path) return { name: file.name, src: path }
  if (file.size > MAX_DATAURL_FILE_MB * 1024 * 1024) return null
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

/** 播放源优先级:本地 mp4(秒开) > COS 永久 URL > 上游临时地址。 */
function playbackSrc(card: VideoWorkbenchCard): string | null {
  if (card.localPath) return toRenderableUri(card.localPath)
  if (card.remoteUrl) return card.remoteUrl
  if (card.videoUrl) return card.videoUrl
  return null
}

interface WorkbenchCardProps {
  card: VideoWorkbenchCard
  index: number
  onDragStateChange: (dragging: boolean) => void
}

export const WorkbenchCard = memo(function WorkbenchCard({ card, index, onDragStateChange }: WorkbenchCardProps) {
  const updateCard = useVideoWorkbenchStore((s) => s.updateCard)
  const removeCard = useVideoWorkbenchStore((s) => s.removeCard)
  const moveCard = useVideoWorkbenchStore((s) => s.moveCard)
  const addMaterials = useVideoWorkbenchStore((s) => s.addMaterials)
  const removeMaterial = useVideoWorkbenchStore((s) => s.removeMaterial)
  const startCards = useVideoWorkbenchStore((s) => s.startCards)

  const busy = card.status === 'preparing' || card.status === 'queued' || card.status === 'running'

  // 生成耗时 ticker(仅活跃时跑)
  const [elapsed, setElapsed] = useState(0)
  useEffect(() => {
    if (!busy) return
    const startedAt = card.updatedAt
    setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    const timer = setInterval(() => {
      setElapsed(Math.max(0, Math.round((Date.now() - startedAt) / 1000)))
    }, 1000)
    return () => clearInterval(timer)
  }, [busy, card.updatedAt])

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
    } else if (e.dataTransfer.types.includes('Files')) {
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
        const cards = useVideoWorkbenchStore.getState().cards
        const fromIndex = cards.findIndex((c) => c.id === draggedId)
        let target = before ? index : index + 1
        if (fromIndex >= 0 && fromIndex < target) target -= 1
        moveCard(draggedId, target)
      }
      return
    }
    const files = [...(e.dataTransfer.files ?? [])]
    if (files.length === 0 || busy) return
    e.preventDefault()
    void addFiles(files)
  }

  const addFiles = async (files: File[]) => {
    const { images, videos, audios } = classifyFiles(files)
    const toMaterials = async (list: File[]) =>
      (await Promise.all(list.map(fileToMaterial))).filter((m): m is VideoWorkbenchMaterial => m !== null)
    if (images.length && modeLimit(card.mode, 'image') > 0)
      addMaterials(card.id, 'referenceImages', await toMaterials(images))
    if (videos.length && modeLimit(card.mode, 'video') > 0)
      addMaterials(card.id, 'referenceVideos', await toMaterials(videos))
    if (audios.length && modeLimit(card.mode, 'audio') > 0)
      addMaterials(card.id, 'referenceAudios', await toMaterials(audios))
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
      if (list.length >= modeLimit(current.mode, kind)) return null
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

  // 人像库选择器
  const [pickerOpen, setPickerOpen] = useState(false)
  const handlePortraitConfirm = useCallback(
    (assets: SeedanceAssetItem[]) => {
      const grouped: Record<MediaTokenKind, VideoWorkbenchMaterial[]> = { image: [], video: [], audio: [] }
      for (const asset of assets) grouped[assetKind(asset)].push(assetToMaterial(asset))
      const current = useVideoWorkbenchStore.getState().cards.find((c) => c.id === card.id)
      for (const kind of ['image', 'video', 'audio'] as const) {
        if (grouped[kind].length === 0) continue
        const remaining = modeLimit(card.mode, kind) - (current?.[KIND_TO_FIELD[kind]].length ?? 0)
        if (remaining <= 0) continue
        addMaterials(card.id, KIND_TO_FIELD[kind], grouped[kind].slice(0, remaining))
      }
    },
    [card.id, card.mode, addMaterials],
  )

  const modeSpec = getModeSpec(card.mode)
  const src = playbackSrc(card)

  return (
    <div
      ref={cardRef}
      data-testid={`vw-card-${card.id}`}
      className={[
        'vw-card border border-[#3F3F46] bg-[#111113] relative',
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
        if (e.dataTransfer.types.includes('Files') && !busy) {
          dragCounter.current += 1
          setFileOver(true)
        }
      }}
      onDrop={handleDrop}
    >
      {/* 头部:序号 + 拖拽手柄 + 状态徽标 + 删除 */}
      <div className="flex items-center gap-2 px-4 pt-3">
        <span
          className="vw-drag-handle text-white/40 hover:text-[#FCE300] select-none text-sm leading-none px-1"
          title="拖动排序"
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(CARD_DRAG_MIME, card.id)
            e.dataTransfer.effectAllowed = 'move'
            setDragging(true)
            onDragStateChange(true)
          }}
          onDragEnd={() => {
            setDragging(false)
            setDropEdge(null)
            onDragStateChange(false)
          }}
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
        {(modeSpec.maxImages > 0 || modeSpec.maxVideos > 0 || modeSpec.maxAudios > 0) && (
          <div className="space-y-2 border border-dashed border-[#27272A] px-3 py-2">
            <MaterialStackRow card={card} busy={busy} addFiles={addFiles} onRemove={handleRemoveMaterial} />
            <div className="flex items-center gap-3">
              <p className="text-white/25 text-[10px] flex-1">
                {card.mode === 'first_frame'
                  ? '第 1 张图 = 视频首帧(图生视频)'
                  : card.mode === 'first_last_frame'
                    ? '第 1 张图 = 首帧,第 2 张 = 尾帧'
                    : card.mode === 'extend_video'
                      ? '上传要延长的视频(≤3)'
                      : `拖放文件到卡片任意位置即可按类型自动归入(图≤${modeSpec.maxImages} / 视频≤${modeSpec.maxVideos} / 音频≤${modeSpec.maxAudios})`}
              </p>
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
          <select
            aria-label="模型"
            value={card.model}
            disabled={busy}
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => {
              const v = e.target.value
              const model = v === '2.0-fast' || v === '2.0-mini' ? v : '2.0'
              // 1080p 仅 2.0 满血支持(文档 9.2),切 fast/mini 自动降 720p
              updateCard(card.id, {
                model,
                ...(model !== '2.0' && card.resolution === '1080p' ? { resolution: '720p' } : {}),
              })
            }}
          >
            {MODEL_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
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
            {RESOLUTION_OPTIONS.map((r) => (
              <option key={r} value={r} disabled={r === '1080p' && card.model !== '2.0'}>
                {r}{r === '1080p' && card.model !== '2.0' ? '(仅 2.0)' : ''}
              </option>
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
            disabled={busy}
            title="智能时长 = 模型按内容自动决定输出时长"
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => updateCard(card.id, { duration: Number(e.target.value) })}
          >
            {DURATION_OPTIONS.map((d) => (
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

        {card.status === 'succeeded' && src && (
          <div className="space-y-2">
            {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
            <video controls preload="metadata" src={src} className="w-full max-h-[420px] bg-black border border-[#27272A]" />
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-white/40">
              {card.persistence === 'done' && card.localPath ? (
                <span className="truncate max-w-[50%]" title={card.localPath}>已保存: {card.localPath}</span>
              ) : card.persistence === 'failed' ? (
                <span className="text-orange-400">本地保存失败(视频仍可播放/下载)</span>
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
                      buildModeMedia(card).referenceVideos.length > 0,
                      card.completionTokens,
                    )
                    return cost != null ? ` ≈ ${formatCostUsd(cost)}` : ''
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
                  {card.status === 'failed' ? '↻ 重试' : card.status === 'succeeded' ? '↻ 重新生成' : '▶ 生成'}
                </button>
                {!gate.ok && gate.reason !== '提示词为空' && (
                  <span className="text-orange-400 text-[10px]">⚠ {gate.reason}</span>
                )}
              </>
            )
          })()}
          {card.taskId && (
            <span className="text-white/25 text-[10px] truncate" title={card.taskId}>task: {card.taskId}</span>
          )}
        </div>
      </div>

      {/* 人像库选择器(asset:// 回填) */}
      <PortraitPickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} onConfirm={handlePortraitConfirm} />
    </div>
  )
})

function MaterialStackRow({
  card,
  busy,
  addFiles,
  onRemove,
}: {
  card: VideoWorkbenchCard
  busy: boolean
  addFiles: (files: File[]) => Promise<void>
  onRemove: (kind: MediaTokenKind, index: number) => void
}) {
  // MaterialStack 的 onAdd 直接复用整卡 addFiles(自动按 MIME 分流),
  // 这样点「+」和拖放走同一条入库路径。素材上限跟随生成模式。
  const onAdd = (files: File[]) => void addFiles(files)
  const imageLimit = modeLimit(card.mode, 'image')
  const videoLimit = modeLimit(card.mode, 'video')
  const audioLimit = modeLimit(card.mode, 'audio')
  const imageLabel =
    card.mode === 'first_frame' ? '首帧图' : card.mode === 'first_last_frame' ? '首/尾帧' : '参考图'
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-1">
      {imageLimit > 0 && (
        <MaterialStack
          kind="image"
          label={imageLabel}
          accept="image/*"
          materials={card.referenceImages}
          limit={imageLimit}
          disabled={busy}
          onAdd={onAdd}
          onRemove={(i) => onRemove('image', i)}
        />
      )}
      {videoLimit > 0 && (
        <MaterialStack
          kind="video"
          label="视频素材"
          accept="video/*"
          materials={card.referenceVideos}
          limit={videoLimit}
          disabled={busy}
          onAdd={onAdd}
          onRemove={(i) => onRemove('video', i)}
        />
      )}
      {audioLimit > 0 && (
        <MaterialStack
          kind="audio"
          label="音频素材"
          accept="audio/*"
          materials={card.referenceAudios}
          limit={audioLimit}
          disabled={busy}
          onAdd={onAdd}
          onRemove={(i) => onRemove('audio', i)}
        />
      )}
    </div>
  )
}
