import { useState, useCallback, useEffect, useRef } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import { useDirectorGeneration } from '../hooks/useDirectorGeneration'
import { useDisplaySrc } from '../../hooks/useDisplaySrc'

/**
 * 单格图 —— 把 `<img>` 抽出来,只为让 useDisplaySrc 能在 .map() 里安全调用。
 * 钩子不能直接在 .map 回调里写,每张 cell 单独持有它那张的 blob: URL 生命周期。
 * src 是 dataURL 时换成 blob: 让浏览器后台解码; http/blob 透传。
 */
function GalleryImage({
  src,
  alt,
  className,
  draggable,
}: {
  src: string
  alt: string
  className: string
  draggable?: boolean
}) {
  const imgSrc = useDisplaySrc(src)
  return (
    <img
      src={imgSrc}
      alt={alt}
      loading="lazy"
      decoding="async"
      className={className}
      draggable={draggable}
    />
  )
}

const REGEN_COUNT_OPTIONS = [1, 2, 3, 4, 5, 6, 8, 10]

function downloadImage(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

function openImageViewer(urls: string[], index: number) {
  const viewer = (window as any).imageViewerTS
  if (viewer?.open) {
    viewer.open(urls, index)
  }
}

function getGridCols(count: number): string {
  if (count <= 1) return 'grid-cols-1'
  if (count <= 4) return 'grid-cols-2'
  if (count <= 9) return 'grid-cols-3'
  if (count <= 16) return 'grid-cols-4'
  return 'grid-cols-5'
}

function getThumbnailCols(count: number): string {
  if (count <= 2) return 'grid-cols-2'
  if (count <= 6) return 'grid-cols-3'
  return 'grid-cols-4'
}

export function ResultsGallery() {
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const regenerateCount = useDirectorStore((s) => s.regenerateCount)
  const progressPercentage = useDirectorStore((s) => s.progressPercentage)
  const currentProgress = useDirectorStore((s) => s.currentProgress)
  const setRegenerateCount = useDirectorStore((s) => s.setRegenerateCount)
  const pushProgress = useDirectorStore((s) => s.pushProgress)
  const { canRegenerate, isGenerating, regenerateImages } = useDirectorGeneration()
  const [currentIndex, setCurrentIndex] = useState(0)
  const [gridOpen, setGridOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)
  const [regenDropdownOpen, setRegenDropdownOpen] = useState(false)

  const handleRegenerate = useCallback(async () => {
    setRegenDropdownOpen(false)
    const toast = (window as any).toastManagerTS ?? (window as any).toastManager
    toast?.show?.(`正在重新生图（目标 ${regenerateCount} 张）...`, 'info')
    try {
      const result = await regenerateImages(regenerateCount, (progress) => {
        pushProgress(progress as any)
      })
      const images = Array.isArray((result as any)?.images) ? (result as any).images : []
      const successCount = images.filter((img: any) => Boolean(img?.url)).length
      const failed = images.filter((img: any) => !img?.url)

      if (successCount > 0) {
        const failCount = Math.max(0, images.length - successCount)
        toast?.show?.(
          `重新生图完成：成功 ${successCount} 张${failCount > 0 ? `，失败 ${failCount} 张` : ''}`,
          failCount > 0 ? 'info' : 'success'
        )
      } else {
        const firstError = String(failed[0]?.error || '生图请求失败，请检查网络或更换绘图模型后重试')
        toast?.show?.(`重新生图失败：${firstError}`, 'error')
      }
    } catch (err) {
      console.error('[ResultsGallery] 重新生图失败:', err)
      const toast = (window as any).toastManagerTS ?? (window as any).toastManager
      toast?.show?.(
        `重新生图失败：${err instanceof Error ? err.message : String(err)}`,
        'error'
      )
    }
  }, [regenerateCount, regenerateImages, pushProgress])

  const successResults = generatedResults.filter((r) => !!r.url)
  const failedResults = generatedResults.filter((r) => !r.url)
  const allUrls = successResults.map((r) => r.url)
  const prevCountRef = useRef(successResults.length)
  const progressLabel = currentProgress?.label || '正在生成中...'
  const safeProgress = Math.max(3, Math.min(progressPercentage || 0, 99))

  useEffect(() => {
    const prevCount = prevCountRef.current
    prevCountRef.current = successResults.length
    if (successResults.length > prevCount && prevCount > 0) {
      setCurrentIndex(prevCount)
    } else if (prevCount === 0) {
      setCurrentIndex(0)
    }
    setGridOpen(false)
    setFocusedIndex(0)
  }, [successResults.length])

  const navigate = useCallback(
    (direction: 1 | -1) => {
      if (successResults.length === 0) return
      setCurrentIndex((prev) => {
        let next = prev + direction
        if (next < 0) next = successResults.length - 1
        if (next >= successResults.length) next = 0
        return next
      })
    },
    [successResults.length]
  )

  useEffect(() => {
    if (!gridOpen) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setGridOpen(false)
      if (e.key === 'ArrowLeft') setFocusedIndex((p) => Math.max(0, p - 1))
      if (e.key === 'ArrowRight') setFocusedIndex((p) => Math.min(successResults.length - 1, p + 1))
    }
    document.addEventListener('keydown', handler)
    return () => document.removeEventListener('keydown', handler)
  }, [gridOpen, successResults.length])

  if (generatedResults.length === 0 && isGenerating) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center">
            <i className="fas fa-images mr-2 text-green-400" />
            生成结果
          </h3>
          <span className="text-xs text-[#FCE300] font-semibold flex items-center gap-1.5">
            <i className="fas fa-spinner fa-spin" />
            生成中
          </span>
        </div>

        <div className="bg-[#27272A] rounded-none p-6 flex items-center justify-center border border-[#3F3F46]" style={{ minHeight: '220px' }}>
          <div className="text-center text-white opacity-55">
            <i className="fas fa-image text-4xl mb-3 opacity-35" />
            <p className="text-sm">生成的图片将在这里显示</p>
          </div>
        </div>

        <div className="space-y-2">
          <div className="h-1.5 bg-white/10 overflow-hidden">
            <div className="h-full bg-[#FCE300] transition-all duration-300" style={{ width: `${safeProgress}%` }} />
          </div>
          <div className="text-xs text-white/70 text-center">{progressLabel}</div>
        </div>
      </div>
    )
  }

  if (successResults.length === 0) {
    if (generatedResults.length === 0) return null
    const firstError = String(failedResults[0]?.error || '生图请求失败，请稍后重试')
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center">
            <i className="fas fa-images mr-2 text-red-400" />
            生成结果
          </h3>
          <div className="flex items-center gap-2">
            {isGenerating && (
              <span className="text-xs text-[#FCE300] font-semibold flex items-center gap-1.5">
                <i className="fas fa-spinner fa-spin" />
                生成中
              </span>
            )}
            <span className="text-xs text-white opacity-50">
              成功 0 / {generatedResults.length} 张
            </span>
          </div>
        </div>

        {isGenerating && (
          <div className="space-y-2">
            <div className="h-1.5 bg-white/10 overflow-hidden">
              <div className="h-full bg-[#FCE300] transition-all duration-300" style={{ width: `${safeProgress}%` }} />
            </div>
            <div className="text-[11px] text-white/65">{progressLabel}</div>
          </div>
        )}

        <div className="border border-red-500/40 bg-red-500/10 px-4 py-3">
          <div className="text-sm text-red-300 font-semibold mb-1 flex items-center gap-2">
            <i className="fas fa-exclamation-triangle" />
            生图失败
          </div>
          <p className="text-xs text-white/75 leading-relaxed">
            {firstError}
          </p>
          <p className="text-xs text-white/55 mt-2">
            建议：先切换顶部“绘图模型(出图)”后，再点击“重新生图”。
          </p>
        </div>

        <div className="flex items-center justify-end">
          {canRegenerate && (
            <div className="relative">
              <div className="flex items-center">
                <button
                  onClick={handleRegenerate}
                  disabled={isGenerating}
                  className="text-xs text-black bg-[#FCE300] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1 flex items-center gap-1.5 cursor-pointer transition-all font-semibold"
                >
                  <i className={`fas ${isGenerating ? 'fa-spinner fa-spin' : 'fa-redo'}`} />
                  {isGenerating ? '生成中...' : `重新生图 ×${regenerateCount}`}
                </button>
                <button
                  onClick={() => setRegenDropdownOpen(!regenDropdownOpen)}
                  disabled={isGenerating}
                  className="text-xs text-black bg-[#FCE300] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed px-1.5 py-1 border-l border-black/20 cursor-pointer transition-all"
                >
                  <i className="fas fa-caret-down" />
                </button>
              </div>
              {regenDropdownOpen && (
                <div className="absolute right-0 bottom-full mb-1 bg-[#27272A] border border-[#3F3F46] shadow-xl z-[70000] min-w-[120px] max-h-56 overflow-y-auto">
                  <div className="px-3 py-1.5 text-[10px] text-white opacity-40 border-b border-[#3F3F46]">
                    生成数量
                  </div>
                  {REGEN_COUNT_OPTIONS.map((n) => (
                    <button
                      key={n}
                      onClick={() => { setRegenerateCount(n); setRegenDropdownOpen(false) }}
                      className={`w-full text-left px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                        n === regenerateCount
                          ? 'text-[#FCE300] bg-white/5'
                          : 'text-white hover:bg-white/10'
                      }`}
                    >
                      {n} 张
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  const safeIndex = Math.min(currentIndex, successResults.length - 1)
  const current = successResults[safeIndex]

  return (
    <>
      <div className="space-y-3">
        {/* 标题栏 */}
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center">
            <i className="fas fa-images mr-2 text-green-400" />
            生成结果
          </h3>
          <div className="flex items-center gap-3">
            {isGenerating && (
              <span className="text-xs text-[#FCE300] font-semibold flex items-center gap-1.5">
                <i className="fas fa-spinner fa-spin" />
                生成中
              </span>
            )}
            <span className="text-xs text-white opacity-50">
              {successResults.length}/{generatedResults.length} 张
            </span>
            <button
              onClick={() => { setFocusedIndex(safeIndex); setGridOpen(true) }}
              className="text-xs text-white opacity-40 hover:opacity-100 transition-opacity flex items-center gap-1.5 cursor-pointer"
            >
              <i className="fas fa-th" />
              全屏网格
            </button>
            {successResults.length > 1 && (
              <button
                onClick={() => {
                  successResults.forEach((r, i) => {
                    setTimeout(() => downloadImage(r.url, `comic-panel-${i + 1}.png`), i * 120)
                  })
                }}
                className="text-xs text-white opacity-40 hover:opacity-100 transition-opacity flex items-center gap-1.5 cursor-pointer"
              >
                <i className="fas fa-download" />
                全部下载
              </button>
            )}
            {canRegenerate && (
              <div className="relative">
                <div className="flex items-center">
                  <button
                    onClick={handleRegenerate}
                    disabled={isGenerating}
                    className="text-xs text-black bg-[#FCE300] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed px-3 py-1 flex items-center gap-1.5 cursor-pointer transition-all font-semibold"
                  >
                    <i className={`fas ${isGenerating ? 'fa-spinner fa-spin' : 'fa-redo'}`} />
                    {isGenerating ? '生成中...' : `重新生图 ×${regenerateCount}`}
                  </button>
                  <button
                    onClick={() => setRegenDropdownOpen(!regenDropdownOpen)}
                    disabled={isGenerating}
                    className="text-xs text-black bg-[#FCE300] hover:brightness-110 disabled:opacity-40 disabled:cursor-not-allowed px-1.5 py-1 border-l border-black/20 cursor-pointer transition-all"
                  >
                    <i className="fas fa-caret-down" />
                  </button>
                </div>
                {regenDropdownOpen && (
                  <div className="absolute right-0 bottom-full mb-1 bg-[#27272A] border border-[#3F3F46] shadow-xl z-[70000] min-w-[120px] max-h-56 overflow-y-auto">
                    <div className="px-3 py-1.5 text-[10px] text-white opacity-40 border-b border-[#3F3F46]">
                      生成数量
                    </div>
                    {REGEN_COUNT_OPTIONS.map((n) => (
                      <button
                        key={n}
                        onClick={() => { setRegenerateCount(n); setRegenDropdownOpen(false) }}
                        className={`w-full text-left px-3 py-1.5 text-xs cursor-pointer transition-colors ${
                          n === regenerateCount
                            ? 'text-[#FCE300] bg-white/5'
                            : 'text-white hover:bg-white/10'
                        }`}
                      >
                        {n} 张
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {isGenerating && (
          <div className="space-y-2">
            <div className="h-1.5 bg-white/10 overflow-hidden">
              <div className="h-full bg-[#FCE300] transition-all duration-300" style={{ width: `${safeProgress}%` }} />
            </div>
            <div className="text-[11px] text-white/65">{progressLabel}</div>
          </div>
        )}

        {/* 主图区 — 点击用全局 ImageViewer 打开 */}
        <div
          className="relative group rounded-none overflow-hidden bg-[#27272A] cursor-pointer"
          onClick={() => openImageViewer(allUrls, safeIndex)}
        >
          <GalleryImage
            src={current.url}
            alt={`Result ${safeIndex + 1}`}
            className="w-full object-contain max-h-[380px]"
          />

          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 bg-black/50 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <i className="fas fa-search-plus text-white text-lg" />
            </div>
          </div>

          <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/60 text-white text-xs pointer-events-none select-none">
            {safeIndex + 1} / {successResults.length}
          </div>

          {successResults.length > 1 && (
            <>
              <button
                onClick={(e) => { e.stopPropagation(); navigate(-1) }}
                className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white hover:bg-black/80 cursor-pointer"
              >
                <i className="fas fa-chevron-left text-sm" />
              </button>
              <button
                onClick={(e) => { e.stopPropagation(); navigate(1) }}
                className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white hover:bg-black/80 cursor-pointer"
              >
                <i className="fas fa-chevron-right text-sm" />
              </button>
            </>
          )}

          <button
            onClick={(e) => {
              e.stopPropagation()
              downloadImage(current.url, `comic-panel-${safeIndex + 1}.png`)
            }}
            className="absolute bottom-2 right-2 px-3 py-1.5 bg-black/60 text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 flex items-center gap-1.5 cursor-pointer"
          >
            <i className="fas fa-download" />
            下载
          </button>
        </div>

        {/* Prompt 预览 */}
        {current.prompt && (
          <div className="flex items-start gap-2 bg-[#09090B] border border-[#3F3F46] px-3 py-2">
            <i className="fas fa-quote-left text-white opacity-20 text-xs mt-0.5 flex-shrink-0" />
            <p className="text-white opacity-50 text-xs font-mono line-clamp-2 flex-1">
              {String(current.prompt)}
            </p>
          </div>
        )}

        {/* 缩略图网格 — 点击用全局 ImageViewer 打开 */}
        {successResults.length > 1 && (
          <div className={`grid ${getThumbnailCols(successResults.length)} gap-1`}>
            {successResults.map((result, idx) => (
              <button
                key={idx}
                onClick={() => {
                  setCurrentIndex(idx)
                  openImageViewer(allUrls, idx)
                }}
                className={`relative aspect-video rounded-none overflow-hidden border-2 transition-all cursor-pointer ${
                  idx === safeIndex
                    ? 'border-blue-400'
                    : 'border-transparent opacity-50 hover:opacity-90 hover:border-white/20'
                }`}
              >
                <GalleryImage src={result.url} alt={`Thumb ${idx + 1}`} className="w-full h-full object-cover" />
                <span className="absolute bottom-0 left-0 right-0 text-center text-[10px] text-white bg-black/60 py-0.5 select-none">
                  {idx + 1}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 全屏网格 lightbox（额外入口） ── */}
      {gridOpen && (
        <div
          className="fixed inset-0 bg-black z-[60000] flex flex-col"
          onClick={() => setGridOpen(false)}
        >
          <button
            onClick={() => setGridOpen(false)}
            className="absolute top-3 right-3 z-10 w-9 h-9 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors cursor-pointer"
          >
            <i className="fas fa-times text-lg" />
          </button>

          <div
            className={`flex-1 grid ${getGridCols(successResults.length)} gap-[1px]`}
            style={{ background: 'rgba(255,255,255,0.06)' }}
            onClick={(e) => e.stopPropagation()}
          >
            {successResults.map((result, idx) => (
              <div
                key={idx}
                className={`relative overflow-hidden cursor-pointer group ${
                  idx === focusedIndex ? 'ring-2 ring-inset ring-[#FCE300]' : ''
                }`}
                onClick={() => {
                  setGridOpen(false)
                  openImageViewer(allUrls, idx)
                }}
              >
                <GalleryImage
                  src={result.url}
                  alt={`Panel ${idx + 1}`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />

                {idx === focusedIndex && (
                  <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(252,227,0,0.08)' }} />
                )}

                <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-end justify-between p-2 opacity-0 group-hover:opacity-100">
                  <span className="text-white text-xs bg-black/60 px-1.5 py-0.5">
                    {idx + 1}
                  </span>
                  <button
                    onClick={(e) => {
                      e.stopPropagation()
                      downloadImage(result.url, `comic-panel-${idx + 1}.png`)
                    }}
                    className="w-7 h-7 bg-black/60 hover:bg-[#FCE300] hover:text-black text-white rounded-full flex items-center justify-center transition-colors cursor-pointer"
                  >
                    <i className="fas fa-download text-xs" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div
            className="bg-black/80 border-t border-white/10 px-6 py-2.5 flex items-center gap-4"
            onClick={(e) => e.stopPropagation()}
          >
            <span className="text-white/40 text-xs select-none">
              {focusedIndex + 1} / {successResults.length}
            </span>
            {successResults[focusedIndex]?.prompt && (
              <p className="flex-1 text-white/40 text-xs font-mono truncate">
                {String(successResults[focusedIndex].prompt)}
              </p>
            )}
            <div className="flex items-center gap-2 flex-shrink-0">
              <button
                onClick={() => {
                  successResults.forEach((r, i) => {
                    setTimeout(() => downloadImage(r.url, `comic-panel-${i + 1}.png`), i * 120)
                  })
                }}
                className="px-3 py-1.5 border border-white/20 text-white text-xs flex items-center gap-1.5 hover:bg-white/10 transition-colors cursor-pointer"
              >
                <i className="fas fa-download" />
                全部下载
              </button>
              <button
                onClick={() => {
                  const target = successResults[focusedIndex]
                  if (target) downloadImage(target.url, `comic-panel-${focusedIndex + 1}.png`)
                }}
                className="px-4 py-1.5 bg-[#FCE300] text-black text-xs font-bold flex items-center gap-1.5 hover:brightness-110 transition-all cursor-pointer"
              >
                <i className="fas fa-download" />
                下载当前
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
