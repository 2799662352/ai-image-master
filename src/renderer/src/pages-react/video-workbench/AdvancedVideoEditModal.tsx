// 「高级编辑」弹层 —— 在参考视频的某一帧上画标注,拍平成参考图带回卡片。
//
// 移植自 sora-ui 画布工程的 AdvancedVideoEditWorkbench:交互与工具集照搬(矩形 /
// 涂抹 / 箭头 / 文字 / 橡皮 / 定位钉 + 撤销重做),但换了宿主 —— 那边保存要在 tldraw
// 里建节点连边,这里只把「拍平帧 + 备注」交回调用方,由卡片决定怎么落到素材与提示词。
// 配色也换成本工作台的深色主题(原版是产品 mock 的白底,放进来会很突兀)。
//
// 几何计算在 features/video-workbench/advancedVideoEdit.ts,那边是纯函数、有单测。

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import {
  ArrowUpRight,
  Eraser,
  MapPin,
  Pause,
  Pencil,
  Play,
  Redo2,
  Square,
  Trash2,
  Type,
  Undo2,
  Volume2,
  VolumeX,
} from 'lucide-react'
import {
  DEFAULT_FONT_SIZE,
  DEFAULT_TEXT,
  ERASER_RADIUS_PX,
  MIN_LINE_LENGTH,
  STROKE_COLORS,
  STROKE_WIDTH,
  eraseAnnotationsAtPoint,
  flattenAnnotatedFrameToDataUrl,
  formatTimestamp,
  frameAnnotationLabel,
  paintFrameAnnotation,
  readVideoDuration,
  type AnnotationLine,
  type AnnotationToolId,
  type FrameAnnotation,
} from '../../features/video-workbench/advancedVideoEdit'
import { useToastStore } from '../../stores/useToastStore'

/**
 * 已拍平、等着「保存」一起带回卡片的帧。
 *
 * 只带 data: 一种形态,**不在这里管上传**。回填成卡片素材之后,内联素材的转存由
 * `materialTransfer` 统一接管(与粘贴进来的图同一条路):字节走 IPC 的字节通道传
 * COS,回来把 src 换成 https。曾经在这个弹层里单独调一次 COS 上传,那是把「素材
 * 怎么上传」这件事在第二个地方又实现了一遍 —— 而粘贴图有一模一样的毛病,修在
 * 素材层才是一次修两处。
 */
export interface AdvancedEditFrame {
  id: string
  dataUrl: string
  timeSec: number
  /** 实际出图像素。摆在界面上,省得「清不清楚」只能靠感觉争论。 */
  width: number
  height: number
}

interface AdvancedVideoEditModalProps {
  open: boolean
  /** 可播放的视频地址(本地路径已由调用方解析成 blob:)。 */
  videoSrc: string
  onClose: () => void
  /** 「保存」:把拍平帧与备注交回卡片。备注可为空。 */
  onApply: (frames: AdvancedEditFrame[], note: string) => void
}

const TOOLS: Array<{ id: AnnotationToolId; label: string; Icon: typeof Square }> = [
  { id: 'rect', label: '矩形', Icon: Square },
  { id: 'brush', label: '涂抹', Icon: Pencil },
  { id: 'arrow', label: '箭头', Icon: ArrowUpRight },
  { id: 'text', label: '文字', Icon: Type },
  { id: 'pin', label: '定位钉', Icon: MapPin },
  { id: 'eraser', label: '橡皮', Icon: Eraser },
]

function newFrameId(): string {
  return `ave-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
}

export function AdvancedVideoEditModal({ open, videoSrc, onClose, onApply }: AdvancedVideoEditModalProps) {
  const videoRef = useRef<HTMLVideoElement>(null)
  const previewWrapRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const addToast = useToastStore((s) => s.addToast)

  const [playing, setPlaying] = useState(false)
  const [muted, setMuted] = useState(true)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [tool, setTool] = useState<AnnotationToolId | null>(null)
  const [strokeColor, setStrokeColor] = useState<string>(STROKE_COLORS[0])
  const [annotations, setAnnotations] = useState<readonly FrameAnnotation[]>([])
  const [redoStack, setRedoStack] = useState<readonly FrameAnnotation[]>([])
  const [editingTextIndex, setEditingTextIndex] = useState<number | null>(null)
  const [frames, setFrames] = useState<AdvancedEditFrame[]>([])
  const [note, setNote] = useState('')
  // 只盖住拍平那一小段(同步级)。上传不在这里等 —— 见 addCurrentFrame。
  const [busy, setBusy] = useState(false)
  // 源视频的原生尺寸。摆在标题栏是因为它就是出图清晰度的上限:拍平按原生分辨率
  // 走,没有任何一步会再降档,所以「标注图不够清楚」几乎总是源视频不够清楚。
  const [sourceSize, setSourceSize] = useState<{ w: number; h: number } | null>(null)
  const [displaySize, setDisplaySize] = useState({ w: 1, h: 1 })
  const [canvasOffset, setCanvasOffset] = useState({ left: 0, top: 0 })

  // 进行中的草稿放 ref 不放 state:pointermove 每帧都会改它,走 state 等于每帧一次
  // React 提交。它只影响 canvas 像素,不影响任何 DOM 结构。
  const draftRef = useRef<FrameAnnotation | null>(null)
  const rectOriginRef = useRef<{ x: number; y: number } | null>(null)
  const drawingRef = useRef(false)
  const paintRef = useRef<() => void>(() => {})

  // 换视频 / 重新打开 → 整场重置
  useEffect(() => {
    if (!open) return
    setPlaying(false)
    setCurrentTime(0)
    setDuration(0)
    setTool(null)
    setStrokeColor(STROKE_COLORS[0])
    setAnnotations([])
    setRedoStack([])
    setEditingTextIndex(null)
    setFrames([])
    setNote('')
    setBusy(false)
    draftRef.current = null
    rectOriginRef.current = null
    drawingRef.current = false
  }, [open, videoSrc])

  const measureDisplay = useCallback(() => {
    const wrap = previewWrapRef.current
    const video = videoRef.current
    if (!wrap || !video) return
    const rect = wrap.getBoundingClientRect()
    const vw = video.videoWidth || 16
    const vh = video.videoHeight || 9
    const scale = Math.min(rect.width / vw, rect.height / vh)
    const w = Math.max(1, vw * scale)
    const h = Math.max(1, vh * scale)
    setDisplaySize({ w, h })
    setCanvasOffset({ left: (rect.width - w) / 2, top: (rect.height - h) / 2 })

    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const nextW = Math.round(w * dpr)
    const nextH = Math.round(h * dpr)
    // 规范:给 canvas.width/height 赋值(哪怕赋成当前值)都会清空位图。工具栏伸缩时
    // 显示尺寸常常没变,盲目赋值会让已画的痕迹凭空消失。
    const resized = canvas.width !== nextW || canvas.height !== nextH
    if (canvas.width !== nextW) canvas.width = nextW
    if (canvas.height !== nextH) canvas.height = nextH
    canvas.style.width = `${w}px`
    canvas.style.height = `${h}px`
    canvas.style.left = `${(rect.width - w) / 2}px`
    canvas.style.top = `${(rect.height - h) / 2}px`
    // 尺寸没变时 React 不会重渲染,得自己补一笔,否则清空的缓冲会一直空着。
    if (resized) queueMicrotask(() => paintRef.current())
  }, [])

  useLayoutEffect(() => {
    if (!open) return
    measureDisplay()
    const ro = new ResizeObserver(() => measureDisplay())
    if (previewWrapRef.current) ro.observe(previewWrapRef.current)
    window.addEventListener('resize', measureDisplay)
    return () => {
      ro.disconnect()
      window.removeEventListener('resize', measureDisplay)
    }
  }, [open, measureDisplay, videoSrc])

  const paintOverlay = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const dpr = window.devicePixelRatio || 1
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, displaySize.w, displaySize.h)
    annotations.forEach((ann, i) => {
      // 正在编辑的文字由覆盖输入框呈现,canvas 再画一遍就是重影
      if (i === editingTextIndex && ann.kind === 'text') return
      paintFrameAnnotation(ctx, ann)
    })
    if (draftRef.current) paintFrameAnnotation(ctx, draftRef.current)
  }, [annotations, displaySize.w, displaySize.h, editingTextIndex])

  paintRef.current = paintOverlay

  useLayoutEffect(() => {
    paintOverlay()
  }, [paintOverlay])

  // Esc:先退出文字编辑,再关弹层 —— 编辑中直接关会丢掉刚打的字
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      if (editingTextIndex !== null) {
        setEditingTextIndex(null)
        return
      }
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose, editingTextIndex])

  const pauseVideo = useCallback(() => {
    const video = videoRef.current
    if (!video || video.paused) return
    video.pause()
    setPlaying(false)
  }, [])

  const commit = (ann: FrameAnnotation): void => {
    setAnnotations((prev) => [...prev, ann])
    setRedoStack([])
  }

  const localPoint = (e: ReactPointerEvent<HTMLCanvasElement>): { x: number; y: number } => {
    const canvas = canvasRef.current
    if (!canvas) return { x: 0, y: 0 }
    const rect = canvas.getBoundingClientRect()
    return { x: e.clientX - rect.left, y: e.clientY - rect.top }
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!tool) return
    e.preventDefault()
    pauseVideo()
    const p = localPoint(e)

    if (tool === 'eraser') {
      e.currentTarget.setPointerCapture(e.pointerId)
      drawingRef.current = true
      setEditingTextIndex(null)
      setAnnotations((prev) => eraseAnnotationsAtPoint(prev, p, ERASER_RADIUS_PX))
      setRedoStack([])
      return
    }

    if (tool === 'text') {
      setAnnotations((prev) => {
        const next = [...prev, {
          kind: 'text' as const,
          x: p.x,
          y: p.y,
          text: DEFAULT_TEXT,
          color: strokeColor,
          fontSize: DEFAULT_FONT_SIZE,
        }]
        setEditingTextIndex(next.length - 1)
        return next
      })
      setRedoStack([])
      return
    }

    if (tool === 'pin') {
      commit({ kind: 'pin', x: p.x, y: p.y, index: annotations.filter((a) => a.kind === 'pin').length + 1 })
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    drawingRef.current = true
    if (tool === 'rect') {
      rectOriginRef.current = p
      draftRef.current = { kind: 'rect', x: p.x, y: p.y, w: 0, h: 0, color: strokeColor, strokeWidth: STROKE_WIDTH }
    } else if (tool === 'brush') {
      draftRef.current = { kind: 'stroke', points: [p], color: strokeColor, strokeWidth: STROKE_WIDTH + 1 }
    } else {
      draftRef.current = {
        kind: 'line',
        x1: p.x,
        y1: p.y,
        x2: p.x,
        y2: p.y,
        color: strokeColor,
        strokeWidth: STROKE_WIDTH,
        arrowHead: true,
      }
    }
    paintOverlay()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return
    const p = localPoint(e)
    if (tool === 'eraser') {
      setAnnotations((prev) => eraseAnnotationsAtPoint(prev, p, ERASER_RADIUS_PX))
      return
    }
    const draft = draftRef.current
    if (!draft) return
    if (draft.kind === 'rect' && rectOriginRef.current) {
      const o = rectOriginRef.current
      draftRef.current = {
        ...draft,
        x: Math.min(o.x, p.x),
        y: Math.min(o.y, p.y),
        w: Math.abs(p.x - o.x),
        h: Math.abs(p.y - o.y),
      }
    } else if (draft.kind === 'stroke') {
      draftRef.current = { ...draft, points: [...draft.points, p] }
    } else if (draft.kind === 'line') {
      draftRef.current = { ...draft, x2: p.x, y2: p.y }
    }
    paintOverlay()
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLCanvasElement>): void => {
    if (!drawingRef.current) return
    drawingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      // 指针已经被别处释放,忽略
    }
    if (tool === 'eraser') return

    const draft = draftRef.current
    draftRef.current = null
    rectOriginRef.current = null
    if (!draft) return

    // 太小的痕迹多半是误点,丢掉而不是留一个看不见的标注
    if (draft.kind === 'rect') {
      if (draft.w > 4 && draft.h > 4) commit(draft)
      else paintOverlay()
      return
    }
    if (draft.kind === 'stroke') {
      if (draft.points.length > 1) commit(draft)
      else paintOverlay()
      return
    }
    if (draft.kind === 'line') {
      const line: AnnotationLine = draft
      if (Math.hypot(line.x2 - line.x1, line.y2 - line.y1) >= MIN_LINE_LENGTH) commit(line)
      else paintOverlay()
    }
  }

  const undo = (): void => {
    setEditingTextIndex(null)
    setAnnotations((prev) => {
      if (prev.length === 0) return prev
      setRedoStack((r) => [...r, prev[prev.length - 1]])
      return prev.slice(0, -1)
    })
  }

  const redo = (): void => {
    setEditingTextIndex(null)
    setRedoStack((prev) => {
      if (prev.length === 0) return prev
      setAnnotations((a) => [...a, prev[prev.length - 1]])
      return prev.slice(0, -1)
    })
  }

  const clearAll = (): void => {
    setEditingTextIndex(null)
    setAnnotations([])
    setRedoStack([])
    draftRef.current = null
  }

  const togglePlay = (): void => {
    // 选着工具时点画面是要画,不是要播 —— 播放键在标注模式下不接管点击
    if (tool !== null) return
    const video = videoRef.current
    if (!video) return
    if (video.paused) {
      void video.play().then(() => setPlaying(true)).catch(() => {
        addToast({ type: 'error', message: '无法播放该视频' })
      })
    } else {
      video.pause()
      setPlaying(false)
    }
  }

  const onSeek = (value: number): void => {
    const video = videoRef.current
    if (!video || !(duration > 0)) return
    video.pause()
    setPlaying(false)
    video.currentTime = value
    setCurrentTime(value)
    // 标注是**画在某一帧上**的,换帧就不该留着 —— 留着会画在错的画面上还看不出来
    clearAll()
  }

  const addCurrentFrame = async (): Promise<void> => {
    const video = videoRef.current
    if (!video) return
    if (annotations.length === 0) {
      addToast({ type: 'info', message: '先在画面上标注一下,再添加这一帧' })
      return
    }
    setBusy(true)
    try {
      const flat = await flattenAnnotatedFrameToDataUrl({
        video,
        displayWidth: displaySize.w,
        displayHeight: displaySize.h,
        annotations,
        timeSec: currentTime,
      })
      setFrames((prev) => [...prev, { id: newFrameId(), timeSec: currentTime, ...flat }])
      clearAll()
      addToast({
        type: 'success',
        message: `已添加 ${frameAnnotationLabel(currentTime)}(${flat.width}×${flat.height})`,
      })
    } catch (e) {
      addToast({ type: 'error', message: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!open) return null

  const editingText = editingTextIndex !== null ? annotations[editingTextIndex] : undefined
  const timeLabel = `${formatTimestamp(currentTime)} / ${duration > 0 ? formatTimestamp(duration) : '--:--'}`

  // 与同目录其它弹层一致 portal 到 body:卡片上任何 transform/contain 都会把
  // position:fixed 裁进卡片框(见 PortraitPickerModal 的同款注释)。
  return createPortal(
    <div
      className="fixed inset-0 z-[78] bg-black/85 flex items-center justify-center p-4"
      data-testid="vw-advanced-edit"
      onClick={onClose}
    >
      {/*
        高度必须是 `h-`(实高)而不是 `max-h-`。只给最大高度时面板按内容撑高,
        下面预览区的 `flex-1` 就没有多余空间可分,直接退化成它的 min-height ——
        屏幕再大,画面也永远是那么高一条。标注要在画面上圈准位置,给足尺寸不是
        审美问题。
      */}
      <div
        className="w-full max-w-[1500px] h-[92vh] bg-[#111113] border border-[#3F3F46] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-[#27272A]">
          <h3 className="text-white font-bold text-sm">
            <span className="text-[#FCE300]">◈</span> 高级编辑
          </h3>
          <span className="text-white/40 text-xs">在某一帧上标注,拍平成参考图带回卡片</span>
          {sourceSize && (
            <span
              className="text-white/30 text-[11px]"
              title="出图按源视频原生分辨率,不会再降档 —— 这就是标注图能达到的清晰度上限"
            >
              源 {sourceSize.w}×{sourceSize.h}
            </span>
          )}
          <button type="button" aria-label="关闭" className="ml-auto text-white/40 hover:text-white px-1" onClick={onClose}>
            ✕
          </button>
        </div>

        {/* 预览 + 标注覆盖层 */}
        {/* min-h-0:flex 子项默认不肯缩到内容高度以下,矮屏上会把工具栏挤出面板 */}
        <div ref={previewWrapRef} className="relative flex-1 min-h-0 bg-black overflow-hidden">
          <video
            ref={videoRef}
            src={videoSrc}
            className="absolute inset-0 w-full h-full object-contain"
            muted={muted}
            playsInline
            onLoadedMetadata={() => {
              const v = videoRef.current
              if (v) {
                setDuration(readVideoDuration(v))
                if (v.videoWidth > 0) setSourceSize({ w: v.videoWidth, h: v.videoHeight })
              }
              measureDisplay()
            }}
            onTimeUpdate={() => {
              const v = videoRef.current
              if (v) setCurrentTime(v.currentTime)
            }}
            onEnded={() => setPlaying(false)}
          />
          <canvas
            ref={canvasRef}
            data-testid="vw-ave-canvas"
            className="absolute"
            style={{
              left: canvasOffset.left,
              top: canvasOffset.top,
              cursor: tool ? 'crosshair' : 'default',
              pointerEvents: tool ? 'auto' : 'none',
            }}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {editingText?.kind === 'text' && (
            <input
              autoFocus
              data-testid="vw-ave-text-input"
              className="absolute bg-transparent border border-dashed border-cyan-400 outline-none px-1"
              style={{
                left: canvasOffset.left + editingText.x - 4,
                top: canvasOffset.top + editingText.y - 4,
                color: editingText.color,
                fontSize: editingText.fontSize,
                minWidth: 60,
              }}
              value={editingText.text}
              onChange={(e) => {
                const text = e.target.value
                setAnnotations((prev) => prev.map((a, i) => (
                  i === editingTextIndex && a.kind === 'text' ? { ...a, text } : a
                )))
              }}
              onBlur={() => setEditingTextIndex(null)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') setEditingTextIndex(null)
              }}
            />
          )}
        </div>

        {/* 播放控制 */}
        <div className="flex items-center gap-3 px-4 py-2 border-t border-[#27272A]">
          <button
            type="button"
            aria-label={playing ? '暂停' : '播放'}
            disabled={tool !== null}
            className="text-white/70 hover:text-[#FCE300] disabled:opacity-30"
            onClick={togglePlay}
          >
            {playing ? <Pause size={16} /> : <Play size={16} />}
          </button>
          <span className="text-white/40 text-xs tabular-nums">{timeLabel}</span>
          <input
            type="range"
            aria-label="进度"
            className="flex-1 accent-[#FCE300]"
            min={0}
            max={duration > 0 ? duration : 0}
            step={0.05}
            value={currentTime}
            disabled={!(duration > 0)}
            onChange={(e) => onSeek(Number(e.target.value))}
          />
          <button
            type="button"
            aria-label={muted ? '取消静音' : '静音'}
            className="text-white/70 hover:text-[#FCE300]"
            onClick={() => setMuted((m) => !m)}
          >
            {muted ? <VolumeX size={16} /> : <Volume2 size={16} />}
          </button>
        </div>

        {/* 工具栏 */}
        <div className="flex items-center gap-2 px-4 py-2 border-t border-[#27272A] flex-wrap">
          <div className="flex items-center gap-1">
            {STROKE_COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={`颜色 ${c}`}
                aria-pressed={strokeColor === c}
                className={`w-4 h-4 border ${strokeColor === c ? 'border-[#FCE300] scale-110' : 'border-white/20'}`}
                style={{ background: c }}
                onClick={() => setStrokeColor(c)}
              />
            ))}
          </div>
          <span className="w-px h-4 bg-[#3F3F46] mx-1" />
          {TOOLS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              title={label}
              aria-label={label}
              aria-pressed={tool === id}
              className={`px-2 py-1 border ${
                tool === id
                  ? 'border-[#FCE300] text-[#FCE300] bg-[#FCE300]/10'
                  : 'border-[#3F3F46] text-white/60 hover:text-white'
              }`}
              onClick={() => {
                pauseVideo()
                setEditingTextIndex(null)
                setTool((prev) => (prev === id ? null : id))
              }}
            >
              <Icon size={14} />
            </button>
          ))}
          <span className="w-px h-4 bg-[#3F3F46] mx-1" />
          <button
            type="button"
            title="撤销"
            aria-label="撤销"
            disabled={annotations.length === 0}
            className="px-2 py-1 border border-[#3F3F46] text-white/60 hover:text-white disabled:opacity-30"
            onClick={undo}
          >
            <Undo2 size={14} />
          </button>
          <button
            type="button"
            title="重做"
            aria-label="重做"
            disabled={redoStack.length === 0}
            className="px-2 py-1 border border-[#3F3F46] text-white/60 hover:text-white disabled:opacity-30"
            onClick={redo}
          >
            <Redo2 size={14} />
          </button>
          <button
            type="button"
            title="清空标注"
            aria-label="清空标注"
            disabled={annotations.length === 0}
            className="px-2 py-1 border border-[#3F3F46] text-white/60 hover:text-red-400 disabled:opacity-30"
            onClick={clearAll}
          >
            <Trash2 size={14} />
          </button>
          <button
            type="button"
            disabled={busy}
            className="ml-auto text-xs border border-[#FCE300]/60 text-[#FCE300] px-3 py-1.5 hover:bg-[#FCE300]/10 disabled:opacity-40"
            onClick={() => void addCurrentFrame()}
          >
            {busy ? '抽帧中…' : '＋ 添加这一帧'}
          </button>
        </div>

        {/* 已添加的帧 + 备注 + 保存 */}
        <div className="px-4 py-3 border-t border-[#27272A] space-y-2">
          {/* 帧多了自己滚,别一直往下长 —— 面板是定高的,它长一行画面就矮一行 */}
          {frames.length > 0 && (
            <div
              className="flex items-center gap-2 flex-wrap max-h-[104px] overflow-y-auto"
              data-testid="vw-ave-frames"
            >
              {frames.map((f) => (
                <div
                  key={f.id}
                  title={`${frameAnnotationLabel(f.timeSec)} · ${f.width}×${f.height}`}
                  className="relative w-16 h-16 border border-[#3F3F46] group"
                >
                  <img src={f.dataUrl} alt={frameAnnotationLabel(f.timeSec)} className="w-full h-full object-cover" />
                  <span className="absolute inset-x-0 bottom-0 bg-black/70 text-white/70 text-[9px] text-center">
                    {formatTimestamp(f.timeSec)}
                  </span>
                  <button
                    type="button"
                    aria-label={`移除 ${frameAnnotationLabel(f.timeSec)}`}
                    className="absolute -top-1.5 -right-1.5 w-4 h-4 bg-[#18181B] border border-[#3F3F46] text-white/60 text-[10px] leading-none opacity-0 group-hover:opacity-100"
                    onClick={() => setFrames((prev) => prev.filter((x) => x.id !== f.id))}
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-2">
            <input
              value={note}
              placeholder="补充说明(可选):把①处的外套换成红色皮衣"
              className="flex-1 min-w-0 bg-[#18181B] border border-[#3F3F46] text-white/90 text-xs px-2 py-1.5 focus:outline-none focus:border-[#FCE300]"
              onChange={(e) => setNote(e.target.value)}
            />
            <span className="text-white/40 text-xs shrink-0">
              {frames.length > 0 ? `已添加 ${frames.length} 帧` : '先添加至少一帧'}
            </span>
            <button
              type="button"
              className="text-xs bg-[#FCE300] text-black font-bold px-3 py-1.5 disabled:opacity-40 shrink-0"
              disabled={frames.length === 0}
              onClick={() => {
                onApply(frames, note.trim())
                onClose()
              }}
            >
              保存到卡片
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  )
}
