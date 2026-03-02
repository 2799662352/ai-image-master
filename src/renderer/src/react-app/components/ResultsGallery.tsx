import { useState, useCallback } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

function downloadImage(url: string, filename: string) {
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
}

export function ResultsGallery() {
  const generatedResults = useDirectorStore((s) => s.generatedResults)
  const [currentIndex, setCurrentIndex] = useState(0)

  const successResults = generatedResults.filter((r) => !!r.url)

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

  if (successResults.length === 0) return null

  const safeIndex = Math.min(currentIndex, successResults.length - 1)
  const current = successResults[safeIndex]

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-white font-semibold flex items-center">
          <i className="fas fa-images mr-2 text-green-400" />
          生成结果
        </h3>
        <span className="text-xs text-white opacity-50">
          成功 {successResults.length}/{generatedResults.length} 张
        </span>
      </div>

      <div className="relative group rounded-none overflow-hidden bg-[#27272A]">
        <img
          src={current.url}
          alt={`Result ${safeIndex + 1}`}
          className="w-full object-contain max-h-[400px]"
        />

        {successResults.length > 1 && (
          <>
            <button
              onClick={() => navigate(-1)}
              className="absolute left-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white hover:bg-black/80"
            >
              <i className="fas fa-chevron-left text-sm" />
            </button>
            <button
              onClick={() => navigate(1)}
              className="absolute right-2 top-1/2 -translate-y-1/2 w-8 h-8 bg-black/60 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-white hover:bg-black/80"
            >
              <i className="fas fa-chevron-right text-sm" />
            </button>
          </>
        )}

        <button
          onClick={() => downloadImage(current.url, `comic-panel-${safeIndex + 1}.png`)}
          className="absolute bottom-2 right-2 px-3 py-1.5 bg-black/60 rounded-none text-xs text-white opacity-0 group-hover:opacity-100 transition-opacity hover:bg-black/80 flex items-center gap-1.5"
        >
          <i className="fas fa-download" />
          下载
        </button>
      </div>

      {successResults.length > 1 && (
        <div className="flex gap-1.5 overflow-x-auto pb-1">
          {successResults.map((result, idx) => (
            <button
              key={idx}
              onClick={() => setCurrentIndex(idx)}
              className={`flex-shrink-0 w-14 h-14 rounded-none overflow-hidden border-2 transition-all ${
                idx === safeIndex ? 'border-blue-400' : 'border-transparent opacity-60 hover:opacity-100'
              }`}
            >
              <img src={result.url} alt={`Thumb ${idx + 1}`} className="w-full h-full object-cover" />
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
