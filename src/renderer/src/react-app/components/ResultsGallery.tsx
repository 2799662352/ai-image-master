import { useState, useCallback, useEffect } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

function downloadImage(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
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
  const [currentIndex, setCurrentIndex] = useState(0)
  const [gridOpen, setGridOpen] = useState(false)
  const [focusedIndex, setFocusedIndex] = useState(0)

  const successResults = generatedResults.filter((r) => !!r.url)

  // 新一轮生成结果到来时重置状态
  useEffect(() => {
    setCurrentIndex(0)
    setGridOpen(false)
    setFocusedIndex(0)
  }, [generatedResults])

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

  const openGrid = useCallback(
    (idx: number) => {
      setFocusedIndex(idx)
      setGridOpen(true)
    },
    []
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

  if (successResults.length === 0) return null

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
            <span className="text-xs text-white opacity-50">
              {successResults.length}/{generatedResults.length} 张
            </span>
            <button
              onClick={() => openGrid(safeIndex)}
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
          </div>
        </div>

        {/* 主图区 */}
        <div
          className="relative group rounded-none overflow-hidden bg-[#27272A] cursor-pointer"
          onClick={() => openGrid(safeIndex)}
        >
          <img
            src={current.url}
            alt={`Result ${safeIndex + 1}`}
            className="w-full object-contain max-h-[380px]"
          />

          {/* 放大镜 hover */}
          <div className="absolute inset-0 bg-black/0 group-hover:bg-black/20 transition-all flex items-center justify-center pointer-events-none">
            <div className="w-12 h-12 bg-black/50 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity">
              <i className="fas fa-th text-white text-lg" />
            </div>
          </div>

          {/* 序号角标 */}
          <div className="absolute top-2 left-2 px-2 py-0.5 bg-black/60 text-white text-xs pointer-events-none select-none">
            {safeIndex + 1} / {successResults.length}
          </div>

          {/* 翻页箭头 */}
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

          {/* 下载当前图 */}
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

        {/* 缩略图网格（替代横向滚动条） */}
        {successResults.length > 1 && (
          <div className={`grid ${getThumbnailCols(successResults.length)} gap-1`}>
            {successResults.map((result, idx) => (
              <button
                key={idx}
                onClick={() => { setCurrentIndex(idx); openGrid(idx) }}
                className={`relative aspect-video rounded-none overflow-hidden border-2 transition-all cursor-pointer ${
                  idx === safeIndex
                    ? 'border-blue-400'
                    : 'border-transparent opacity-50 hover:opacity-90 hover:border-white/20'
                }`}
              >
                <img src={result.url} alt={`Thumb ${idx + 1}`} className="w-full h-full object-cover" />
                <span className="absolute bottom-0 left-0 right-0 text-center text-[10px] text-white bg-black/60 py-0.5 select-none">
                  {idx + 1}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>

      {/* ── 全屏网格 lightbox ── */}
      {gridOpen && (
        <div
          className="fixed inset-0 bg-black z-[60000] flex flex-col"
          onClick={() => setGridOpen(false)}
        >
          {/* 顶部关闭按钮 */}
          <button
            onClick={() => setGridOpen(false)}
            className="absolute top-3 right-3 z-10 w-9 h-9 bg-white/10 hover:bg-white/20 rounded-full flex items-center justify-center text-white transition-colors cursor-pointer"
          >
            <i className="fas fa-times text-lg" />
          </button>

          {/* 图片网格 */}
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
                onClick={() => setFocusedIndex(idx)}
              >
                <img
                  src={result.url}
                  alt={`Panel ${idx + 1}`}
                  className="w-full h-full object-cover"
                  draggable={false}
                />

                {/* 当前聚焦高亮 */}
                {idx === focusedIndex && (
                  <div className="absolute inset-0 pointer-events-none" style={{ background: 'rgba(252,227,0,0.08)' }} />
                )}

                {/* Hover 操作层 */}
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

          {/* 底部信息栏 */}
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
