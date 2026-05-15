import { useRef, useCallback, useState, useTransition, type DragEvent, type MouseEvent } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import { ExampleGallery } from './ExampleGallery'
import { VisionModelSelector } from './VisionModelSelector'
import { compressAndConvert } from '../../utils/image-compress'

const MAX_IMAGES = 12

export function ReferenceImageUpload() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const addReferenceImage = useDirectorStore((s) => s.addReferenceImage)
  const removeReferenceImage = useDirectorStore((s) => s.removeReferenceImage)
  const clearReferenceImages = useDirectorStore((s) => s.clearReferenceImages)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [previewIndex, setPreviewIndex] = useState<number | null>(null)
  const [, startTransition] = useTransition()

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const imageFiles = Array.from(files)
        .filter((f) => f.type.startsWith('image/'))
        .slice(0, MAX_IMAGES - useDirectorStore.getState().referenceImages.length)
      if (imageFiles.length === 0) return

      setIsProcessing(true)
      try {
        const toCompress = imageFiles.filter((f) => f.size > 2 * 1024 * 1024)
        if (toCompress.length > 0) {
          console.log(`🖼️ [Director] 准备参考图片... 需要压缩: ${toCompress.length}/${imageFiles.length}`)
        }
        const results = await Promise.all(
          imageFiles.map(async (file) => {
            const r = await compressAndConvert(file)
            return {
              data: r.base64,
              mimeType: file.type,
              name: file.name,
              fileSize: r.originalSize,
              compressed: r.compressed,
            }
          })
        )
        startTransition(() => {
          for (const img of results) addReferenceImage(img)
        })
      } finally {
        setIsProcessing(false)
      }
    },
    [addReferenceImage, startTransition]
  )

  const handleFileChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) processFiles(e.target.files)
      e.target.value = ''
    },
    [processFiles]
  )

  const handleDrop = useCallback(
    (e: DragEvent<HTMLDivElement>) => {
      e.preventDefault()
      e.stopPropagation()
      if (e.dataTransfer.files.length) processFiles(e.dataTransfer.files)
    },
    [processFiles]
  )

  const handleDragOver = useCallback((e: DragEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.stopPropagation()
  }, [])

  if (referenceImages.length === 0) {
    return (
      <div className="bg-[#27272A] rounded-none p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-semibold flex items-center">
            <i className="fas fa-image mr-2 text-purple-400" />
            参考图片
          </h3>
          <div className="flex items-center gap-2">
            <span className="text-[11px] text-purple-300/90 whitespace-nowrap">
              视觉模型(分析)
            </span>
            <VisionModelSelector />
            <ExampleGallery />
          </div>
        </div>
        <div
          onClick={() => !isProcessing && fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className={`border-2 border-dashed border-white/30 rounded-none p-8 text-center transition-colors ${isProcessing ? 'opacity-60 cursor-wait' : 'cursor-pointer hover:border-purple-400'}`}
        >
          {isProcessing ? (
            <>
              <i className="fas fa-spinner fa-spin text-3xl text-purple-400 mb-3" />
              <p className="text-white opacity-70 text-sm">正在压缩处理图片...</p>
            </>
          ) : (
            <>
              <i className="fas fa-cloud-upload-alt text-3xl text-white opacity-30 mb-3" />
              <p className="text-white opacity-50 text-sm">点击或拖拽上传参考图片</p>
              <p className="text-white opacity-30 text-xs mt-1">最多 {MAX_IMAGES} 张</p>
            </>
          )}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={handleFileChange}
        />
      </div>
    )
  }

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-semibold flex items-center">
          <i className="fas fa-image mr-2 text-purple-400" />
          参考图片 ({referenceImages.length}/{MAX_IMAGES})
        </h3>
        <div className="flex items-center gap-3">
          <span className="text-[11px] text-purple-300/90 whitespace-nowrap">
            视觉模型(分析)
          </span>
          <VisionModelSelector />
          <ExampleGallery />
          {referenceImages.length > 1 && (
            <button
              onClick={clearReferenceImages}
              className="text-xs text-red-400 hover:text-red-300 transition-colors"
            >
              <i className="fas fa-trash mr-1" />
              清空
            </button>
          )}
        </div>
      </div>

      <div
        className="grid grid-cols-4 gap-2"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {referenceImages.map((img, idx) => (
          <div key={idx} className="relative group aspect-square rounded-none overflow-hidden bg-[#09090B] cursor-pointer" onClick={() => setPreviewIndex(idx)}>
            <img
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={img.name}
              className="w-full h-full object-cover"
            />
            {img.fileSize && img.fileSize > 2 * 1024 * 1024 && (
              <div className="absolute top-1 left-1 bg-orange-500/90 text-white text-[10px] px-1.5 py-0.5 rounded flex items-center gap-1 pointer-events-none">
                <i className="fas fa-compress-alt" />
                <span>{(img.fileSize / (1024 * 1024)).toFixed(1)}MB</span>
              </div>
            )}
            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition-all flex items-center justify-center">
              <i className="fas fa-search-plus text-white text-lg opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
            <button
              onClick={(e: MouseEvent) => { e.stopPropagation(); removeReferenceImage(idx) }}
              className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300"
            >
              <i className="fas fa-times text-xs" />
            </button>
          </div>
        ))}
        {referenceImages.length < MAX_IMAGES && (
          <div
            onClick={() => !isProcessing && fileInputRef.current?.click()}
            className="aspect-square border-2 border-dashed border-white/20 rounded-none flex flex-col items-center justify-center cursor-pointer hover:border-[#FCE300]/60 transition-all group"
          >
            <i className="fas fa-plus text-white opacity-30 group-hover:opacity-70 group-hover:text-[#FCE300] text-lg transition-all" />
            <span className="text-white opacity-20 group-hover:opacity-50 text-xs mt-1.5 transition-all">添加</span>
          </div>
        )}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFileChange}
      />

      {previewIndex !== null && referenceImages[previewIndex] && (
        <div
          className="fixed inset-0 bg-black/90 z-[60000] flex items-center justify-center cursor-pointer"
          onClick={() => setPreviewIndex(null)}
        >
          <img
            src={`data:${referenceImages[previewIndex].mimeType};base64,${referenceImages[previewIndex].data}`}
            alt="Preview"
            className="max-w-[90vw] max-h-[90vh] object-contain"
            onClick={(e: MouseEvent) => e.stopPropagation()}
          />
          <button
            onClick={() => setPreviewIndex(null)}
            className="absolute top-4 right-4 text-white text-3xl hover:text-gray-300"
          >
            <i className="fas fa-times" />
          </button>
          {referenceImages.length > 1 && (
            <div className="absolute bottom-6 flex gap-3">
              {previewIndex > 0 && (
                <button onClick={(e: MouseEvent) => { e.stopPropagation(); setPreviewIndex(previewIndex - 1) }} className="px-3 py-2 bg-white/20 hover:bg-white/30 text-white rounded-none text-sm">
                  <i className="fas fa-chevron-left mr-1" /> 上一张
                </button>
              )}
              {previewIndex < referenceImages.length - 1 && (
                <button onClick={(e: MouseEvent) => { e.stopPropagation(); setPreviewIndex(previewIndex + 1) }} className="px-3 py-2 bg-white/20 hover:bg-white/30 text-white rounded-none text-sm">
                  下一张 <i className="fas fa-chevron-right ml-1" />
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
