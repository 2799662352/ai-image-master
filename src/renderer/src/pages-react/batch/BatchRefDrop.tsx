import { useRef, useState, type DragEvent } from 'react'
import type { BatchRefImage } from '../../stores/useBatchStore'
import { uploadRefImageOriginalFirst, type RefUploadStage } from '../../utils/refImageUpload'
import { useToastStore } from '../../stores/useToastStore'

interface PendingItem {
  id: string
  fileName: string
  originalKB: number
  stage: RefUploadStage
}

function fmtKB(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  const kb = bytes / 1024
  if (kb < 1024) return `${kb.toFixed(0)}KB`
  return `${(kb / 1024).toFixed(2)}MB`
}

function shortName(name: string, max = 14): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const ext = dot > 0 ? name.slice(dot) : ''
  const head = name.slice(0, Math.max(1, max - ext.length - 1))
  return `${head}…${ext}`
}

const URL_RE = /^https?:\/\//i

/** 从 URL 取文件名(去查询串);失败兜底 'image'。 */
function basenameFromUrl(u: string): string {
  try {
    const base = new URL(u).pathname.split('/').filter(Boolean).pop()
    return base ? decodeURIComponent(base) : 'image'
  } catch {
    return 'image'
  }
}

/**
 * 用 <img> 探活并取尺寸:既验证链接确实是可加载的图片,又拿到宽高。
 * 不需要 crossOrigin —— 仅展示/取 naturalSize,不读像素。15s 超时兜底。
 */
function probeImageUrl(url: string): Promise<{ ok: boolean; w?: number; h?: number }> {
  return new Promise((resolve) => {
    const img = new Image()
    const timer = setTimeout(() => resolve({ ok: false }), 15_000)
    img.onload = () => {
      clearTimeout(timer)
      resolve({ ok: true, w: img.naturalWidth, h: img.naturalHeight })
    }
    img.onerror = () => {
      clearTimeout(timer)
      resolve({ ok: false })
    }
    img.src = url
  })
}

interface Props {
  images: BatchRefImage[]
  onAdd: (img: BatchRefImage) => void
  onRemove: (id: string) => void
  onClear: () => void
  onPreview?: (url: string) => void
  max?: number
  /**
   * 当前模型是否要求参考图以 base64 inline_data 发送(大香蕉系列)。
   * 为 true 时本地上传跳过 COS,直接保留 base64 —— 避免「上传 COS → 生成时再抓回 base64」
   * 的无意义往返。来源:模型配置 inlineRefImageAsBase64。
   */
  preferBase64?: boolean
}

const MAX_FILE_MB = 20
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp']

/**
 * BatchRefDrop - 参考图上传(拖拽 / 点击 / 默认 16 张上限,对齐 gpt-image 单请求 16 张)
 * 替代 PunkRefDrop 的米白 sticker + 倾斜缩略图 + 粉红投影。
 */
export default function BatchRefDrop({
  images,
  onAdd,
  onRemove,
  onClear,
  onPreview,
  max = 16,
  preferBase64 = false,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingItem[]>([])
  const [urlMode, setUrlMode] = useState(false)
  const [urlInput, setUrlInput] = useState('')
  const [urlBusy, setUrlBusy] = useState(false)
  const addToast = useToastStore((s) => s.addToast)

  const remaining = max - images.length - pending.length

  const updatePending = (id: string, patch: Partial<PendingItem>): void => {
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }
  const removePending = (id: string): void => {
    setPending((list) => list.filter((p) => p.id !== id))
  }

  /**
   * 本地上传:走共用的"原图直传 COS、失败降级压缩"策略(见 utils/refImageUpload)。
   * 这里只负责占位 UI(pending 阶段)与 toast。
   */
  const processOne = async (file: File): Promise<void> => {
    const pendingId = crypto.randomUUID()
    const originalKB = file.size
    setPending((list) => [
      ...list,
      { id: pendingId, fileName: file.name, originalKB, stage: 'reading' },
    ])

    const outcome = await uploadRefImageOriginalFirst(file, {
      metadata: { source: 'batch-ref-upload', fileName: file.name },
      // base64 inline 模型(大香蕉系列):跳过 COS,直接留本地 base64。
      skipCos: preferBase64,
      onStage: (stage) => updatePending(pendingId, { stage }),
    })

    if (!outcome.ok) {
      removePending(pendingId)
      addToast({ message: `读取失败: ${file.name}`, type: 'error' })
      return
    }

    onAdd({
      id: crypto.randomUUID(),
      base64: outcome.src,
      fileName: file.name,
      fileSize: outcome.fileSize,
      width: outcome.width,
      height: outcome.height,
    })
    removePending(pendingId)

    if (outcome.viaCos) {
      addToast({
        message: `已上传原图到云端: ${shortName(file.name)}`,
        type: 'success',
        duration: 2000,
      })
    } else if (outcome.cosSkipped) {
      // 主动跳过 COS:base64 直传,不是失败。
      addToast({
        message: outcome.compressed
          ? `已用本地 base64 直传(${fmtKB(outcome.originalSize)} → ${fmtKB(outcome.fileSize)}): ${shortName(file.name)}`
          : `已用本地 base64 直传(免上传云端): ${shortName(file.name)}`,
        type: 'success',
        duration: 2000,
      })
    } else {
      console.warn('[BatchRefDrop] COS upload failed, fallback to local base64:', outcome.cosError)
      addToast({
        message: outcome.compressed
          ? `云端上传失败,已用本地压缩图(${fmtKB(outcome.originalSize)} → ${fmtKB(outcome.fileSize)}): ${shortName(file.name)}`
          : `云端上传失败,已用本地原图: ${shortName(file.name)}`,
        type: 'warning',
        duration: 2800,
      })
    }
  }

  const handleFiles = async (files: FileList | File[]): Promise<void> => {
    setError(null)
    const arr = Array.from(files)
    const accepted: File[] = []
    for (const file of arr) {
      const used = images.length + pending.length + accepted.length
      if (used >= max) {
        setError(`最多 ${max} 张,已满`)
        addToast({ message: `已达上限 ${max} 张,跳过余下文件`, type: 'warning' })
        break
      }
      if (!ALLOWED.includes(file.type)) {
        setError(`格式不支持: ${file.name} (仅 JPG/PNG/WEBP)`)
        addToast({ message: `格式不支持: ${file.name}`, type: 'error' })
        continue
      }
      if (file.size > MAX_FILE_MB * 1024 * 1024) {
        setError(`太大: ${file.name} > ${MAX_FILE_MB}MB`)
        addToast({ message: `超出 ${MAX_FILE_MB}MB: ${file.name}`, type: 'error' })
        continue
      }
      accepted.push(file)
    }
    // 串行处理,避免一次开 N 个 canvas 资源压缩卡死
    for (const file of accepted) {
      await processOne(file)
    }
  }

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    setDragOver(false)
    if (e.dataTransfer.files.length > 0) handleFiles(e.dataTransfer.files)
  }

  /**
   * 用图片链接(含 COS 历史图 URL)当参考图。
   * 直接把 URL 存进 BatchRefImage.base64 —— 生成时 stripDataUrl 不动它。
   * - multipart 模型(gpt-image-2 / Flux):convertToBlob 走 http 分支抓取(COS 已配 CORS);
   * - Gemini 原生 / images.generations:ApiService 生成前把 URL 预解析成 base64。
   * 两类模型都能用 URL 参考图。支持一次粘贴多条(空格 / 换行 / 逗号分隔)。
   */
  const addUrls = async (raw: string): Promise<void> => {
    setError(null)
    const urls = raw
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean)
    if (urls.length === 0) return

    setUrlBusy(true)
    let added = 0
    try {
      for (const url of urls) {
        if (images.length + pending.length + added >= max) {
          setError(`最多 ${max} 张,已满`)
          addToast({ message: `已达上限 ${max} 张,跳过余下链接`, type: 'warning' })
          break
        }
        if (!URL_RE.test(url)) {
          addToast({ message: `不是有效链接: ${shortName(url, 28)}`, type: 'error' })
          continue
        }
        const probe = await probeImageUrl(url)
        if (!probe.ok) {
          addToast({
            message: `图片无法加载(链接失效 / 跨域 / 非图片): ${shortName(url, 28)}`,
            type: 'error',
            duration: 3500,
          })
          continue
        }
        onAdd({
          id: crypto.randomUUID(),
          base64: url,
          fileName: basenameFromUrl(url),
          fileSize: 0,
          width: probe.w,
          height: probe.h,
        })
        added++
      }
      if (added > 0) {
        setUrlInput('')
        addToast({ message: `已添加 ${added} 张链接参考图`, type: 'success', duration: 2000 })
      }
    } finally {
      setUrlBusy(false)
    }
  }

  return (
    <div className="border-2 border-zinc-700 bg-zinc-900/60 p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <label className="font-mono text-[11px] uppercase tracking-[0.2em] text-cyberpunk-yellow/80">
          // REF 参考图 (共享)
        </label>
        <div className="flex items-center gap-2">
          <span className="font-mono text-[11px] text-zinc-500 tabular-nums">
            {images.length}/{max}
          </span>
          {images.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="px-2 py-0.5 border border-zinc-700 bg-zinc-900 text-zinc-300 font-mono text-[10px] uppercase tracking-wider hover:border-zinc-500"
            >
              清除
            </button>
          )}
        </div>
      </div>

      {/* 拖拽区 */}
      <div
        onClick={() => remaining > 0 && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault()
          if (remaining > 0) setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Enter' || e.key === ' ') && remaining > 0) {
            e.preventDefault()
            inputRef.current?.click()
          }
        }}
        aria-label={`点击或拖拽上传参考图 (剩余 ${remaining})`}
        className={`border-2 border-dashed py-6 text-center transition-colors ${
          remaining > 0
            ? dragOver
              ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/5 cursor-pointer'
              : 'border-zinc-700 bg-zinc-950/40 cursor-pointer hover:border-zinc-500'
            : 'border-zinc-800 bg-zinc-950/20 opacity-50 cursor-not-allowed'
        }`}
      >
        <div className="font-orbitron text-sm uppercase tracking-wider text-zinc-200">
          {remaining > 0 ? '点击或拖拽上传' : '⛔ 已满'}
        </div>
        <div className="mt-1 font-mono text-[11px] text-zinc-500">
          {preferBase64
            ? `JPG / PNG / WEBP · ≤ ${MAX_FILE_MB}MB · 本地 base64 直传,免上传云端`
            : `JPG / PNG / WEBP · ≤ ${MAX_FILE_MB}MB · 原图直传云端,不压缩`}
        </div>
        <input
          ref={inputRef}
          type="file"
          accept={ALLOWED.join(',')}
          multiple
          hidden
          onChange={(e) => {
            if (e.target.files) handleFiles(e.target.files)
            e.target.value = ''
          }}
        />
      </div>

      {/* URL / 历史图 链接入口 */}
      <div className="space-y-1.5">
        <button
          type="button"
          onClick={() => setUrlMode((v) => !v)}
          className="font-mono text-[11px] uppercase tracking-[0.15em] text-zinc-400 hover:text-cyberpunk-yellow transition-colors"
        >
          {urlMode ? '− 收起链接输入' : '+ 用图片链接 / 历史图 URL'}
        </button>
        {urlMode && (
          <div className="flex items-stretch gap-2">
            <textarea
              value={urlInput}
              onChange={(e) => setUrlInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
                  e.preventDefault()
                  void addUrls(urlInput)
                }
              }}
              rows={2}
              placeholder="粘贴 https:// 图片链接,多个用空格 / 换行分隔 (Ctrl+Enter 添加)"
              disabled={urlBusy || remaining <= 0}
              className="flex-1 min-w-0 resize-none bg-zinc-950 border-2 border-zinc-700 px-2.5 py-1.5 font-mono text-[11px] text-zinc-200 placeholder:text-zinc-600 focus:border-cyberpunk-yellow focus:outline-none disabled:opacity-50"
            />
            <button
              type="button"
              onClick={() => void addUrls(urlInput)}
              disabled={urlBusy || remaining <= 0 || !urlInput.trim()}
              className="shrink-0 px-3 border-2 border-cyberpunk-yellow/70 bg-cyberpunk-yellow/10 text-cyberpunk-yellow font-mono text-[11px] uppercase tracking-wider hover:bg-cyberpunk-yellow/20 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {urlBusy ? '…' : '添加'}
            </button>
          </div>
        )}
      </div>

      {error && (
        <div className="px-2.5 py-1.5 bg-red-950/30 border border-red-700/60 text-red-300 font-mono text-[11px]">
          ✗ {error}
        </div>
      )}

      {/* 预览网格 */}
      {(images.length > 0 || pending.length > 0) && (
        <div className="grid gap-2" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))' }}>
          {pending.map((p) => (
            <div
              key={p.id}
              className="aspect-square border-2 border-dashed border-zinc-700 bg-zinc-950/40 flex flex-col items-center justify-center px-1.5 text-center"
              role="status"
              aria-live="polite"
              title={`${p.stage === 'compressing' ? '压缩中' : p.stage === 'uploading' ? '上传云端' : '读取中'} · ${p.fileName} · ${fmtKB(p.originalKB)}`}
            >
              <div
                className="text-2xl text-cyberpunk-yellow leading-none"
                style={{ animation: 'batch-spin 1.2s linear infinite' }}
                aria-hidden="true"
              >
                ◐
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-zinc-300">
                {p.stage === 'compressing' ? 'COMPRESS' : p.stage === 'uploading' ? 'UPLOAD ☁' : 'READING'}
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-zinc-500 break-all">
                {shortName(p.fileName)}
              </div>
              <div className="mt-0.5 font-mono text-[9px] text-cyberpunk-yellow tabular-nums">
                {fmtKB(p.originalKB)}
              </div>
            </div>
          ))}
          {images.map((img, idx) => (
            <div
              key={img.id}
              onClick={() => onPreview?.(img.base64)}
              role={onPreview ? 'button' : undefined}
              tabIndex={onPreview ? 0 : undefined}
              onKeyDown={(e) => {
                if (onPreview && (e.key === 'Enter' || e.key === ' ')) {
                  e.preventDefault()
                  onPreview(img.base64)
                }
              }}
              aria-label={onPreview ? `预览 ${img.fileName}` : img.fileName}
              title={onPreview ? '点击预览' : img.fileName}
              className={`relative aspect-square border-2 border-zinc-700 bg-zinc-950 ${
                onPreview ? 'cursor-zoom-in hover:border-cyberpunk-yellow transition-colors' : ''
              }`}
            >
              <img
                src={img.base64}
                alt={img.fileName}
                className="w-full h-full object-cover block pointer-events-none"
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(img.id)
                }}
                aria-label={`移除 ${img.fileName}`}
                title="移除"
                className="absolute -top-1 -right-1 w-5 h-5 bg-zinc-900 border border-red-700/60 text-red-300 hover:bg-red-900/50 hover:text-red-200 font-bold text-sm leading-none flex items-center justify-center z-10"
              >
                ×
              </button>
              <span className="absolute bottom-1 left-1 px-1 py-px bg-black/80 text-cyberpunk-yellow font-mono text-[9px] font-bold">
                {String(idx + 1).padStart(2, '0')}
              </span>
              {URL_RE.test(img.base64) && (
                <span
                  className="absolute top-1 left-1 px-1 py-px bg-cyberpunk-yellow/90 text-black font-mono text-[8px] font-bold tracking-wider"
                  title="云端 URL 参考图(原图直传,无压缩)"
                >
                  URL
                </span>
              )}
            </div>
          ))}
        </div>
      )}

      <style>{`
        @keyframes batch-spin {
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  )
}
