import { useRef, useState, type DragEvent } from 'react'
import type { BatchRefImage } from '../../stores/useBatchStore'
import { compressImage } from '../../utils/image-compress'
import { useToastStore } from '../../stores/useToastStore'

interface PendingItem {
  id: string
  fileName: string
  originalKB: number
  stage: 'compressing' | 'reading'
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

interface Props {
  images: BatchRefImage[]
  onAdd: (img: BatchRefImage) => void
  onRemove: (id: string) => void
  onClear: () => void
  onPreview?: (url: string) => void
  max?: number
}

const MAX_FILE_MB = 20
const ALLOWED = ['image/jpeg', 'image/png', 'image/webp']

/**
 * BatchRefDrop - 参考图上传(拖拽 / 点击 / 默认 12 张上限)
 * 替代 PunkRefDrop 的米白 sticker + 倾斜缩略图 + 粉红投影。
 */
export default function BatchRefDrop({
  images,
  onAdd,
  onRemove,
  onClear,
  onPreview,
  max = 12,
}: Props) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [dragOver, setDragOver] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState<PendingItem[]>([])
  const addToast = useToastStore((s) => s.addToast)

  const remaining = max - images.length - pending.length

  const updatePending = (id: string, patch: Partial<PendingItem>): void => {
    setPending((list) => list.map((p) => (p.id === id ? { ...p, ...patch } : p)))
  }
  const removePending = (id: string): void => {
    setPending((list) => list.filter((p) => p.id !== id))
  }

  const processOne = async (file: File): Promise<void> => {
    const pendingId = crypto.randomUUID()
    const originalKB = file.size
    setPending((list) => [
      ...list,
      { id: pendingId, fileName: file.name, originalKB, stage: 'compressing' },
    ])

    let processed: File = file
    let compressed = false
    try {
      processed = await compressImage(file)
      compressed = processed.size < file.size
    } catch (e) {
      console.warn('[BatchRefDrop] compress failed, fallback to original:', e)
      addToast({
        message: `压缩失败,使用原图: ${file.name}`,
        type: 'warning',
        duration: 2500,
      })
    }

    updatePending(pendingId, { stage: 'reading' })

    await new Promise<void>((resolve) => {
      const reader = new FileReader()
      reader.onload = () => {
        if (typeof reader.result !== 'string') {
          removePending(pendingId)
          addToast({ message: `读取失败: ${file.name}`, type: 'error' })
          resolve()
          return
        }
        const dataUrl = reader.result
        const img = new Image()
        const finish = (w?: number, h?: number) => {
          onAdd({
            id: crypto.randomUUID(),
            base64: dataUrl,
            fileName: file.name,
            fileSize: processed.size,
            width: w,
            height: h,
          })
          removePending(pendingId)
          if (compressed) {
            const ratio = Math.round((1 - processed.size / originalKB) * 100)
            addToast({
              message: `已压缩 ${file.name}: ${fmtKB(originalKB)} → ${fmtKB(processed.size)} (-${ratio}%)`,
              type: 'success',
              duration: 2200,
            })
          }
          resolve()
        }
        img.onload = () => finish(img.width, img.height)
        img.onerror = () => finish()
        img.src = dataUrl
      }
      reader.onerror = () => {
        removePending(pendingId)
        addToast({ message: `读取失败: ${file.name}`, type: 'error' })
        resolve()
      }
      reader.readAsDataURL(processed)
    })
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
          JPG / PNG / WEBP · ≤ {MAX_FILE_MB}MB · 最多 {max} 张
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
              title={`${p.stage === 'compressing' ? '压缩中' : '读取中'} · ${p.fileName} · ${fmtKB(p.originalKB)}`}
            >
              <div
                className="text-2xl text-cyberpunk-yellow leading-none"
                style={{ animation: 'batch-spin 1.2s linear infinite' }}
                aria-hidden="true"
              >
                ◐
              </div>
              <div className="mt-1 font-mono text-[9px] uppercase tracking-wider text-zinc-300">
                {p.stage === 'compressing' ? 'COMPRESS' : 'READING'}
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
