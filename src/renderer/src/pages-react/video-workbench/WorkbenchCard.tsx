// 「生成视频」工作台 —— 单张任务卡片。
//
// 交互移植自 soraui 旧版工作台(VideoGenerator/JimengStyleEditor/TaskCard):
// - 卡片头拖拽手柄排序(原生 HTML5 DnD,自定义 mime 与文件投放区分);
// - 整卡文件拖放上传(dragCounter 计数防抖,按 MIME 分流图/视频/音频);
// - 素材扑克牌堆叠(MaterialStack);
// - 规格参数胶囊排(模型/分辨率/比例/时长/配音);
// - 状态机 UI:draft(生成按钮) → preparing/queued/running(进度条+耗时) →
//   succeeded(内联 <video> 播放) / failed(错误+重试)。

import { memo, useEffect, useRef, useState, type DragEvent } from 'react'
import type { VideoWorkbenchCard, VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { toRenderableUri } from '../../features/file-explorer/uri'
import { MaterialStack } from './MaterialStack'
import {
  MAX_REFERENCE_AUDIOS,
  MAX_REFERENCE_IMAGES,
  MAX_REFERENCE_VIDEOS,
  useVideoWorkbenchStore,
} from '../../features/video-workbench/store'

const CARD_DRAG_MIME = 'application/x-vw-card'

const MODEL_OPTIONS = [
  { value: '2.0', label: 'Seedance 2.0 满血' },
  { value: '2.0-fast', label: 'Seedance 2.0 Fast' },
] as const
const RESOLUTION_OPTIONS = ['480p', '720p', '1080p'] as const
const RATIO_OPTIONS = ['16:9', '9:16', '4:3', '3:4', '1:1', '21:9'] as const
const DURATION_OPTIONS = [4, 5, 6, 8, 10, 12, 15] as const

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
    if (images.length) addMaterials(card.id, 'referenceImages', await toMaterials(images))
    if (videos.length) addMaterials(card.id, 'referenceVideos', await toMaterials(videos))
    if (audios.length) addMaterials(card.id, 'referenceAudios', await toMaterials(audios))
  }

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
          {card.model} · {card.resolution} · {card.ratio} · {card.duration}s{card.generateAudio ? ' · 有声' : ''}
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
        {/* 提示词 */}
        <textarea
          value={card.prompt}
          disabled={busy}
          rows={3}
          placeholder="描述你想要的视频:镜头语言 / 台词 / 风格,可用「图片1 / 视频1 / 音频1」引用下方素材…"
          className="w-full px-3 py-2 bg-[#18181B] border border-[#3F3F46] text-[#FAFAFA] placeholder-[#71717A] text-sm focus:outline-none focus:border-[#FCE300] resize-y disabled:opacity-60"
          onChange={(e) => updateCard(card.id, { prompt: e.target.value })}
        />

        {/* 规格胶囊排 */}
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <select
            aria-label="模型"
            value={card.model}
            disabled={busy}
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => {
              const model = e.target.value === '2.0-fast' ? '2.0-fast' : '2.0'
              // 1080p 仅 2.0 支持,切 fast 自动降 720p
              updateCard(card.id, {
                model,
                ...(model === '2.0-fast' && card.resolution === '1080p' ? { resolution: '720p' } : {}),
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
            className="bg-[#18181B] border border-[#3F3F46] text-white/80 px-2 py-1.5 focus:outline-none focus:border-[#FCE300] disabled:opacity-60"
            onChange={(e) => updateCard(card.id, { duration: Number(e.target.value) })}
          >
            {DURATION_OPTIONS.map((d) => (
              <option key={d} value={d}>{d}s</option>
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
        </div>

        {/* 参考素材:图片扑克牌堆叠 + 视频/音频 */}
        <div className="space-y-2 border border-dashed border-[#27272A] px-3 py-2">
          <MaterialStackRow card={card} busy={busy} addFiles={addFiles} removeMaterial={removeMaterial} />
          <p className="text-white/25 text-[10px]">拖放文件到卡片任意位置即可按类型自动归入(图≤9 / 视频≤3 / 音频≤3)</p>
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
            <div className="flex items-center gap-2 text-[10px] text-white/40">
              {card.persistence === 'done' && card.localPath ? (
                <span className="truncate" title={card.localPath}>已保存: {card.localPath}</span>
              ) : card.persistence === 'failed' ? (
                <span className="text-orange-400">本地保存失败(视频仍可播放/下载)</span>
              ) : (
                <span>正在后台保存…</span>
              )}
            </div>
          </div>
        )}

        {/* 操作行 */}
        <div className="flex items-center gap-2">
          {!busy && (
            <button
              type="button"
              className={`${card.status === 'draft' ? 'vw-generate-btn' : ''} bg-[#FCE300] text-black text-sm font-bold px-4 py-2 hover:opacity-85 active:scale-95 transition-all disabled:opacity-40 disabled:animate-none`}
              disabled={!card.prompt.trim()}
              onClick={() => void startCards([card.id])}
            >
              {card.status === 'failed' ? '↻ 重试' : card.status === 'succeeded' ? '↻ 重新生成' : '▶ 生成'}
            </button>
          )}
          {card.taskId && (
            <span className="text-white/25 text-[10px] truncate" title={card.taskId}>task: {card.taskId}</span>
          )}
        </div>
      </div>
    </div>
  )
})

function MaterialStackRow({
  card,
  busy,
  addFiles,
  removeMaterial,
}: {
  card: VideoWorkbenchCard
  busy: boolean
  addFiles: (files: File[]) => Promise<void>
  removeMaterial: (id: string, kind: 'referenceImages' | 'referenceVideos' | 'referenceAudios', index: number) => void
}) {
  // MaterialStack 的 onAdd 直接复用整卡 addFiles(自动按 MIME 分流),
  // 这样点「+」和拖放走同一条入库路径。
  const onAdd = (files: File[]) => void addFiles(files)
  return (
    <div className="flex flex-wrap gap-x-8 gap-y-1">
      <MaterialStack
        kind="image"
        label="参考图"
        accept="image/*"
        materials={card.referenceImages}
        limit={MAX_REFERENCE_IMAGES}
        disabled={busy}
        onAdd={onAdd}
        onRemove={(i) => removeMaterial(card.id, 'referenceImages', i)}
      />
      <MaterialStack
        kind="video"
        label="视频素材"
        accept="video/*"
        materials={card.referenceVideos}
        limit={MAX_REFERENCE_VIDEOS}
        disabled={busy}
        onAdd={onAdd}
        onRemove={(i) => removeMaterial(card.id, 'referenceVideos', i)}
      />
      <MaterialStack
        kind="audio"
        label="音频素材"
        accept="audio/*"
        materials={card.referenceAudios}
        limit={MAX_REFERENCE_AUDIOS}
        disabled={busy}
        onAdd={onAdd}
        onRemove={(i) => removeMaterial(card.id, 'referenceAudios', i)}
      />
    </div>
  )
}
