import { useMemo } from 'react'
import type { PassCardData } from '../../services/pipeline/types'

const MAX_INLINE_STRING = 2000

function sanitizeRawForDisplay(input: unknown): unknown {
  const visited = new WeakSet<object>()
  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (/^data:image\/[a-zA-Z0-9+.-]+;base64,/.test(value)) return '[base64 image omitted]'
      if (value.length > MAX_INLINE_STRING) return `${value.slice(0, MAX_INLINE_STRING)}... [truncated ${value.length - MAX_INLINE_STRING} chars]`
      return value
    }
    if (!value || typeof value !== 'object') return value
    if (visited.has(value as object)) return '[circular]'
    visited.add(value as object)
    if (Array.isArray(value)) return value.map(walk)
    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) out[k] = walk(v)
    return out
  }
  return walk(input)
}

function collectImageUrls(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const images = (input as any)?.images
  if (!Array.isArray(images)) return []
  return images.map((img: any) => img?.url).filter((url: unknown): url is string => typeof url === 'string' && url.length > 0)
}

interface RawDataModalProps {
  card: PassCardData
  onClose: () => void
}

export function RawDataModal({ card, onClose }: RawDataModalProps) {
  const sanitizedRaw = useMemo(() => sanitizeRawForDisplay(card.raw), [card.raw])
  const previewUrls = useMemo(() => collectImageUrls(card.raw), [card.raw])

  return (
    <div className="fixed inset-0 bg-black/80 z-[60000] flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-[#09090B] border-2 border-[#3F3F46] rounded-none w-full max-w-2xl max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 border-b border-[#3F3F46] flex items-center justify-between">
          <h3 className="text-white font-bold flex items-center">
            <i className="fas fa-database mr-2 text-cyan-400" />
            Pass {card.pass}: {card.label}
          </h3>
          <div className="flex items-center gap-3">
            <span className="text-white opacity-30 text-xs">{(card.elapsed / 1000).toFixed(1)}s</span>
            <button onClick={onClose} className="text-white opacity-50 hover:opacity-100"><i className="fas fa-times text-lg" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-4">
          {previewUrls.length > 0 && (
            <div className="mb-4 grid grid-cols-2 gap-2">
              {previewUrls.map((url, idx) => (
                <img key={`${idx}-${url.slice(0, 32)}`} src={url} alt={`Generated ${idx + 1}`} className="w-full max-h-40 object-contain bg-black/30 border border-[#3F3F46]" />
              ))}
            </div>
          )}
          <pre className="text-white opacity-70 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
            {JSON.stringify(sanitizedRaw, null, 2)}
          </pre>
        </div>
        <div className="px-6 py-3 border-t border-[#3F3F46] flex justify-end gap-2">
          <button
            onClick={async () => { try { await navigator.clipboard.writeText(JSON.stringify(sanitizedRaw, null, 2)); const toast = (window as any).toastManagerTS ?? (window as any).toastManager; toast?.show?.('已复制到剪贴板', 'success') } catch { /* ignore */ } }}
            className="px-4 py-2 bg-[#27272A] border border-[#3F3F46] text-white rounded-none text-sm hover:bg-white hover:bg-opacity-5 transition-colors"
          >
            <i className="fas fa-copy mr-2" />复制
          </button>
          <button onClick={onClose} className="px-4 py-2 bg-[#FCE300] text-black font-bold rounded-none text-sm">关闭</button>
        </div>
      </div>
    </div>
  )
}
