import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'
import { useImageLoadRetry } from '../../hooks/useImageLoadRetry'

interface ImageLightboxProps {
  /** 当前预览集合(有序)。左右切换在这个集合里循环移动。 */
  urls: string[]
  /** 打开时的初始索引。 */
  startIndex: number
  onClose: () => void
  /**
   * 可选的动作按钮插槽,渲染在图片左下角(右下角是内置的 下载/打开 URL)。
   * 回调收到「当前正在展示的图」的 URL —— index 由组件内部维护,父组件
   * 不知道用户切到了哪张,所以必须以回调形式取 URL。
   * Batch 页用它挂 多角度/打光/全景/导演台/加为参考图(原缩略图悬停工具栏)。
   */
  renderActions?: (currentUrl: string) => ReactNode
}

async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
  } catch {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

/**
 * ImageLightbox — 共享图片放大预览,支持左右切换(键盘 ←/→、屏幕两侧箭头、
 * 点击图片下一张)。Generate / Batch 的结果区与参考图都复用这一个组件,
 * 不用切出去再点缩略图。
 *
 * 自包含:内部持有当前 index,父组件只负责传 urls + startIndex + onClose。
 * 大 dataURL 走 useDisplaySrc 换 blob: URL,避免主线程同步解码卡顿。
 */
export function ImageLightbox({ urls, startIndex, onClose, renderActions }: ImageLightboxProps) {
  const [index, setIndex] = useState(startIndex)

  // 父组件可能在已打开状态下换一张缩略图(传新的 startIndex),同步过去。
  useEffect(() => {
    setIndex(startIndex)
  }, [startIndex, urls])

  const total = urls.length
  const clampedIndex = Math.min(Math.max(index, 0), Math.max(0, total - 1))
  const hasMultiple = total > 1

  const goPrev = useCallback(() => {
    setIndex((i) => (i <= 0 ? total - 1 : i - 1))
  }, [total])
  const goNext = useCallback(() => {
    setIndex((i) => (i >= total - 1 ? 0 : i + 1))
  }, [total])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case 'Escape':
          onClose()
          break
        case 'ArrowLeft':
          if (hasMultiple) goPrev()
          break
        case 'ArrowRight':
          if (hasMultiple) goNext()
          break
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, goPrev, goNext, hasMultiple])

  const currentUrl = urls[clampedIndex]
  const imgSrc = useDisplaySrc(currentUrl)
  const {
    reloadKey: imgReloadKey,
    onError: onImgError,
    failed: imgFailed,
  } = useImageLoadRetry(imgSrc)

  if (total === 0 || !currentUrl) return null

  return createPortal(
    <div
      onClick={onClose}
      className="fixed inset-0 z-[70000] flex items-center justify-center bg-black/92 backdrop-blur p-6"
    >
      {/* 顶部:计数 + 关闭 */}
      <div className="absolute left-4 right-4 top-4 flex items-center justify-between text-sm text-zinc-300 font-mono">
        <span className="px-2 py-1 bg-black/60 tabular-nums">
          {clampedIndex + 1} / {total}
        </span>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onClose()
          }}
          aria-label="关闭预览"
          className="w-9 h-9 flex items-center justify-center bg-zinc-900 border-2 border-zinc-700 text-white hover:bg-red-900/50 hover:border-red-700/60 text-lg font-bold transition-colors"
        >
          ×
        </button>
      </div>

      <div
        onClick={(e) => e.stopPropagation()}
        className="relative max-w-[92vw] max-h-[82vh] border-2 border-zinc-700 bg-zinc-950 shadow-2xl"
      >
        {imgFailed ? (
          <div className="flex h-[50vh] w-[60vw] max-w-[92vw] items-center justify-center text-sm text-zinc-500">
            图片加载失败
          </div>
        ) : (
          <img
            key={imgReloadKey}
            src={imgSrc}
            alt={`preview ${clampedIndex + 1}`}
            onError={onImgError}
            onClick={() => hasMultiple && goNext()}
            className={`block max-w-[92vw] max-h-[82vh] object-contain ${hasMultiple ? 'cursor-pointer' : ''}`}
          />
        )}
        {renderActions && (
          <div
            onClick={(e) => e.stopPropagation()}
            className="absolute bottom-2 left-2 flex flex-wrap items-center gap-1 max-w-[60%] px-2 py-1 bg-zinc-900/90 border border-zinc-600 rounded-lg"
          >
            {renderActions(currentUrl)}
          </div>
        )}
        <div className="absolute bottom-2 right-2 flex gap-2">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              void downloadImage(currentUrl, `preview-${Date.now()}.png`)
            }}
            aria-label="下载图片"
            className="px-3 py-1.5 bg-cyberpunk-yellow text-cyberpunk-black border-2 border-cyberpunk-yellow font-mono text-xs font-bold uppercase tracking-wider hover:bg-cyberpunk-accent transition-colors"
          >
            ↓ 下载
          </button>
          {!currentUrl.startsWith('data:') && (
            <a
              href={currentUrl}
              target="_blank"
              rel="noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="px-3 py-1.5 bg-zinc-900 text-zinc-200 border-2 border-zinc-700 font-mono text-xs font-bold uppercase tracking-wider hover:border-cyberpunk-yellow hover:text-cyberpunk-yellow transition-colors no-underline"
            >
              打开 URL
            </a>
          )}
        </div>
      </div>

      {/* 左右切换箭头 */}
      {hasMultiple && (
        <>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              goPrev()
            }}
            aria-label="上一张"
            className="absolute left-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center bg-zinc-900/80 border-2 border-zinc-700 text-zinc-200 hover:text-cyberpunk-yellow hover:border-cyberpunk-yellow text-3xl font-bold transition-colors"
          >
            ‹
          </button>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              goNext()
            }}
            aria-label="下一张"
            className="absolute right-4 top-1/2 -translate-y-1/2 w-12 h-12 flex items-center justify-center bg-zinc-900/80 border-2 border-zinc-700 text-zinc-200 hover:text-cyberpunk-yellow hover:border-cyberpunk-yellow text-3xl font-bold transition-colors"
          >
            ›
          </button>
        </>
      )}
    </div>,
    document.body,
  )
}
