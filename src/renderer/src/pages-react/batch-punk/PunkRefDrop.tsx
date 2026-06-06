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
 * PunkRefDrop - 参考图上传 (拖拽 / 点击 / 默认 16 张上限)
 */
export default function PunkRefDrop({
  images,
  onAdd,
  onRemove,
  onClear,
  onPreview,
  max = 16,
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
      console.warn('[PunkRefDrop] compress failed, fallback to original:', e)
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
        setError(`最多 ${max} 张, 已满`)
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
    <div
      className="p-sticker p-tilt-r-2"
      style={{
        background: 'var(--punk-cream)',
        padding: '1rem 1.2rem',
        marginBottom: 18,
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 10,
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <label className="p-display p-italic" style={{ fontSize: 18 }}>
          REF // 参考图 (共享)
        </label>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <span
            className="p-mono"
            style={{ fontSize: 11, color: 'var(--punk-pink-deep)', fontWeight: 900 }}
          >
            {images.length}/{max}
          </span>
          {images.length > 0 && (
            <button
              type="button"
              onClick={onClear}
              className="p-btn"
              style={{ fontSize: 10, padding: '0.2rem 0.6rem', borderWidth: 2 }}
            >
              CLR
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
        aria-label={`点击或拖拽上传参考图 (剩余 ${remaining})`}
        style={{
          border: `3px dashed ${dragOver ? 'var(--punk-pink)' : 'var(--punk-black)'}`,
          background: dragOver ? 'var(--punk-pink-soft)' : 'transparent',
          padding: '1.4rem',
          textAlign: 'center',
          cursor: remaining > 0 ? 'pointer' : 'not-allowed',
          opacity: remaining > 0 ? 1 : 0.5,
          transition: 'all 120ms',
        }}
      >
        <div className="p-display" style={{ fontSize: 16, marginBottom: 4 }}>
          {remaining > 0 ? 'DROP // CLICK // PASTE' : '⛔ FULL'}
        </div>
        <div
          className="p-mono"
          style={{ fontSize: 11, color: 'var(--punk-black)', opacity: 0.7 }}
        >
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
        <div
          className="p-mono"
          style={{
            marginTop: 8,
            padding: '0.4rem 0.6rem',
            background: 'var(--punk-red)',
            color: 'var(--punk-cream)',
            fontSize: 11,
            fontWeight: 900,
            border: '2px solid var(--punk-black)',
          }}
        >
          ✗ {error}
        </div>
      )}

      {/* 预览网格 */}
      {(images.length > 0 || pending.length > 0) && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fill, minmax(80px, 1fr))',
            gap: 8,
            marginTop: 10,
          }}
        >
          {pending.map((p) => (
            <div
              key={p.id}
              className="p-pending-card p-tilt-l-2"
              role="status"
              aria-live="polite"
              aria-label={`${p.stage === 'compressing' ? '压缩中' : '读取中'} ${p.fileName}`}
              title={`${p.stage === 'compressing' ? '压缩中' : '读取中'} · ${p.fileName} · ${fmtKB(p.originalKB)}`}
            >
              <div className="p-pending-card-inner">
                <div
                  className="p-display p-spin"
                  style={{ fontSize: 22, color: 'var(--punk-pink-deep)', lineHeight: 1 }}
                  aria-hidden="true"
                >
                  ◐
                </div>
                <div
                  className="p-mono p-pulse"
                  style={{
                    fontSize: 9,
                    fontWeight: 900,
                    marginTop: 4,
                    color: 'var(--punk-black)',
                    letterSpacing: 0.5,
                  }}
                >
                  {p.stage === 'compressing' ? 'COMPRESS' : 'READING'}
                </div>
                <div
                  className="p-mono"
                  style={{
                    fontSize: 8,
                    marginTop: 2,
                    color: 'var(--punk-black)',
                    opacity: 0.85,
                    wordBreak: 'break-all',
                  }}
                >
                  {shortName(p.fileName)}
                </div>
                <div
                  className="p-mono"
                  style={{
                    fontSize: 8,
                    color: 'var(--punk-pink-deep)',
                    fontWeight: 900,
                    marginTop: 1,
                  }}
                >
                  {fmtKB(p.originalKB)}
                </div>
              </div>
            </div>
          ))}
          {images.map((img, idx) => (
            <div
              key={img.id}
              className={idx % 2 === 0 ? 'p-tilt-l-2' : 'p-tilt-r-2'}
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
              style={{
                position: 'relative',
                aspectRatio: '1 / 1',
                border: '3px solid var(--punk-black)',
                background: 'var(--punk-black)',
                boxShadow: '3px 3px 0 var(--punk-pink)',
                cursor: onPreview ? 'zoom-in' : 'default',
              }}
            >
              <img
                src={img.base64}
                alt={img.fileName}
                style={{
                  width: '100%',
                  height: '100%',
                  objectFit: 'cover',
                  display: 'block',
                  pointerEvents: 'none',
                }}
              />
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(img.id)
                }}
                aria-label={`移除 ${img.fileName}`}
                title="移除"
                className="p-mono"
                style={{
                  position: 'absolute',
                  top: -8,
                  right: -8,
                  width: 22,
                  height: 22,
                  background: 'var(--punk-pink)',
                  color: 'var(--punk-black)',
                  border: '2px solid var(--punk-black)',
                  fontWeight: 900,
                  fontSize: 14,
                  cursor: 'pointer',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  zIndex: 2,
                }}
              >
                ×
              </button>
              <span
                className="p-mono"
                style={{
                  position: 'absolute',
                  bottom: 2,
                  left: 2,
                  background: 'rgba(0,0,0,0.85)',
                  color: 'var(--punk-cream)',
                  fontSize: 9,
                  padding: '1px 4px',
                  fontWeight: 900,
                }}
              >
                {String(idx + 1).padStart(2, '0')}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
