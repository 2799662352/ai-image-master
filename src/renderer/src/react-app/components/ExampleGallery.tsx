import { useState, useCallback } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

const TOTAL_EXAMPLES = 38
const MAX_IMAGES = 8

const exampleImages = Array.from({ length: TOTAL_EXAMPLES }, (_, i) => {
  const num = String(i + 1).padStart(2, '0')
  return `assets/templates/anime-example-${num}.png`
})

async function imageUrlToBase64(url: string): Promise<{ data: string; mimeType: string }> {
  const response = await fetch(url)
  const blob = await response.blob()
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      resolve({ data: base64, mimeType: blob.type || 'image/png' })
    }
    reader.onerror = reject
    reader.readAsDataURL(blob)
  })
}

export function ExampleGallery() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const addReferenceImage = useDirectorStore((s) => s.addReferenceImage)

  const [showModal, setShowModal] = useState(false)
  const [selectedImages, setSelectedImages] = useState<Set<number>>(new Set())
  const [isLoading, setIsLoading] = useState(false)

  const remainingSlots = MAX_IMAGES - referenceImages.length

  const toggleImage = useCallback(
    (index: number) => {
      setSelectedImages((prev) => {
        const next = new Set(prev)
        if (next.has(index)) {
          next.delete(index)
        } else if (next.size < remainingSlots) {
          next.add(index)
        }
        return next
      })
    },
    [remainingSlots]
  )

  const handleConfirm = useCallback(async () => {
    if (selectedImages.size === 0) return
    setIsLoading(true)
    try {
      const indices = Array.from(selectedImages).sort((a, b) => a - b)
      for (const idx of indices) {
        const url = exampleImages[idx]
        const { data, mimeType } = await imageUrlToBase64(url)
        const num = String(idx + 1).padStart(2, '0')
        addReferenceImage({ data, mimeType, name: `anime-example-${num}.png` })
      }
    } finally {
      setIsLoading(false)
      setSelectedImages(new Set())
      setShowModal(false)
    }
  }, [selectedImages, addReferenceImage])

  const handleOpen = useCallback(() => {
    setSelectedImages(new Set())
    setShowModal(true)
  }, [])

  const handleClose = useCallback(() => {
    setSelectedImages(new Set())
    setShowModal(false)
  }, [])

  return (
    <>
      <button
        onClick={handleOpen}
        disabled={remainingSlots <= 0}
        className="bg-cyan-500 hover:bg-cyan-600 disabled:opacity-40 disabled:cursor-not-allowed text-white px-3 py-1.5 rounded-none text-sm transition-colors"
      >
        <i className="fas fa-images mr-1" />
        示例图库
      </button>

      {showModal && (
        <div
          className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center"
          onClick={handleClose}
        >
          <div
            className="bg-[#27272A] rounded-none p-6 max-w-4xl w-full max-h-[85vh] flex flex-col mx-4"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h2 className="text-white font-semibold text-lg">示例图库</h2>
                {selectedImages.size > 0 && (
                  <span className="text-[#FCE300] text-sm font-medium">
                    已选择 {selectedImages.size} 张
                  </span>
                )}
                <span className="text-white opacity-50 text-xs">
                  (剩余 {remainingSlots} 个位置)
                </span>
              </div>
              <button
                onClick={handleClose}
                className="text-white opacity-50 hover:opacity-100 transition-opacity w-8 h-8 flex items-center justify-center"
              >
                <i className="fas fa-times text-lg" />
              </button>
            </div>

            {/* Grid */}
            <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-6 gap-2 overflow-y-auto flex-1 min-h-0">
              {exampleImages.map((src, idx) => {
                const isSelected = selectedImages.has(idx)
                const canSelect = isSelected || selectedImages.size < remainingSlots
                return (
                  <div
                    key={idx}
                    onClick={() => canSelect && toggleImage(idx)}
                    className={`relative aspect-square rounded-none overflow-hidden cursor-pointer border-2 transition-all ${
                      isSelected
                        ? 'border-[#FCE300]'
                        : canSelect
                          ? 'border-transparent hover:border-white hover:border-opacity-30'
                          : 'border-transparent opacity-40 cursor-not-allowed'
                    }`}
                  >
                    <img
                      src={src}
                      alt={`示例 ${idx + 1}`}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                    {isSelected && (
                      <div className="absolute inset-0 bg-[#FCE300]/20 flex items-center justify-center">
                        <div className="w-6 h-6 bg-[#FCE300] rounded-full flex items-center justify-center">
                          <i className="fas fa-check text-black text-xs" />
                        </div>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {/* Footer */}
            <div className="flex items-center justify-end gap-3 mt-4 pt-4 border-t border-[#3F3F46]">
              <button
                onClick={handleClose}
                className="text-white opacity-50 hover:opacity-100 px-4 py-2 text-sm transition-colors"
              >
                取消
              </button>
              <button
                onClick={handleConfirm}
                disabled={selectedImages.size === 0 || isLoading}
                className="bg-[#FCE300] text-black font-bold rounded-none px-6 py-2 text-sm disabled:opacity-40 disabled:cursor-not-allowed transition-colors hover:brightness-110"
              >
                {isLoading ? (
                  <><i className="fas fa-spinner fa-spin mr-1" />处理中...</>
                ) : (
                  <>确认选择 ({selectedImages.size})</>
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
