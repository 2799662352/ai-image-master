import { useState, useCallback } from 'react'
import { useDirectorStore, type LayoutType } from '../stores/useDirectorStore'

function downloadImage(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

const LAYOUT_GRID: Record<LayoutType, { cols: number; rows: number }> = {
  '2closeup': { cols: 2, rows: 1 },
  '4grid': { cols: 2, rows: 2 },
  '6grid': { cols: 3, rows: 2 },
  '9grid': { cols: 3, rows: 3 },
}

export function ResultsGallery() {
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const currentLayout = useDirectorStore((s) => s.currentLayout)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)

  const successResults = generatedResults.filter((r) => !!r.url)
  if (successResults.length === 0) return null

  const grid = LAYOUT_GRID[currentLayout] || LAYOUT_GRID['6grid']

  const handleDownloadAll = useCallback(() => {
    successResults.forEach((r, i) => {
      setTimeout(() => downloadImage(r.url, `comic-panel-${i + 1}-${Date.now()}.png`), i * 300)
    })
  }, [successResults])

  return (
    <>
      <div className="bg-[#27272A] rounded-none p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-white font-semibold flex items-center">
            <i className="fas fa-images mr-2 text-green-400" />
            生成结果
          </h3>
          <span className="text-xs text-white opacity-50">
            成功 {successResults.length}/{generatedResults.length} 张
          </span>
        </div>

        <div
          className="grid gap-1 bg-black rounded-none overflow-hidden"
          style={{
            gridTemplateColumns: `repeat(${grid.cols}, 1fr)`,
            gridTemplateRows: `repeat(${grid.rows}, 1fr)`,
          }}
        >
          {generatedResults.map((result, idx) => (
            <div key={idx} className="relative group aspect-[3/2] overflow-hidden">
              {result.url ? (
                <>
                  <img
                    src={result.url}
                    alt={`Panel ${idx + 1}`}
                    className="w-full h-full object-cover cursor-pointer"
                    onClick={() => setPreviewIndex(idx)}
                  />
                  <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center">
                    <div className="opacity-0 group-hover:opacity-100 transition-opacity flex gap-2">
                      <button
                        onClick={(e) => { e.stopPropagation(); setPreviewIndex(idx) }}
                        className="w-8 h-8 bg-white/20 hover:bg-white/30 rounded-full flex items-center justify-center text-white"
                      >
                        <i className="fas fa-expand text-xs" />
                      </button>
                      <button
                        onClick={(e) => { e.stopPropagation(); downloadImage(result.url, `comic-panel-${idx + 1}.png`) }}
                        className="w-8 h-8 bg-white/20 hover:bg-white/30 rounded-full flex items-center justify-center text-white"
                      >
                        <i className="fas fa-download text-xs" />
                      </button>
                    </div>
                  </div>
                  <span className="absolute bottom-1 right-1 text-white/40 text-xs font-mono">#{idx + 1}</span>
                </>
              ) : (
                <div className="w-full h-full bg-red-500/10 flex items-center justify-center">
                  <div className="text-center">
                    <i className="fas fa-exclamation-triangle text-red-400 text-lg" />
                    <p className="text-red-300 text-xs mt-1">失败</p>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        <div className="flex justify-center gap-3">
          {successResults.length > 1 && (
            <button
              onClick={handleDownloadAll}
              className="px-4 py-2 bg-[#09090B] border border-[#3F3F46] text-white rounded-none text-sm hover:bg-white hover:bg-opacity-5 transition-colors"
            >
              <i className="fas fa-file-archive mr-2" />
              下载全部 ({successResults.length})
            </button>
          )}
          <button
            onClick={() => {
              const toast = (window as any).toastManagerTS ?? (window as any).toastManager
              toast?.show?.('点击单张图片可预览和下载', 'info')
            }}
            className="px-4 py-2 bg-[#FCE300] text-black font-bold rounded-none text-sm uppercase tracking-tighter hover:scale-105 transition-all"
          >
            <i className="fas fa-redo mr-2" />
            重新生成
          </button>
        </div>
      </div>

      {previewIndex !== null && successResults[previewIndex] && (
        <div
          className="fixed inset-0 bg-black/90 z-[60000] flex items-center justify-center cursor-pointer"
          onClick={() => setPreviewIndex(null)}
        >
          <img
            src={successResults[previewIndex].url}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewIndex(null)}
            className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300 transition-colors"
          >
            <i className="fas fa-times" />
          </button>
          <div className="absolute bottom-6 flex gap-3">
            <button
              onClick={(e) => {
                e.stopPropagation()
                downloadImage(successResults[previewIndex!].url, `comic-panel-${previewIndex! + 1}.png`)
              }}
              className="px-4 py-2 bg-green-500 hover:bg-green-600 text-white rounded-none text-sm transition-colors"
            >
              <i className="fas fa-download mr-2" />
              下载此张
            </button>
            {previewIndex > 0 && (
              <button
                onClick={(e) => { e.stopPropagation(); setPreviewIndex(previewIndex! - 1) }}
                className="px-3 py-2 bg-white/20 hover:bg-white/30 text-white rounded-none text-sm"
              >
                <i className="fas fa-chevron-left" />
              </button>
            )}
            {previewIndex < successResults.length - 1 && (
              <button
                onClick={(e) => { e.stopPropagation(); setPreviewIndex(previewIndex! + 1) }}
                className="px-3 py-2 bg-white/20 hover:bg-white/30 text-white rounded-none text-sm"
              >
                <i className="fas fa-chevron-right" />
              </button>
            )}
          </div>
        </div>
      )}
    </>
  )
}
