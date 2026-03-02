import { useRef, useCallback, useState, useTransition, type DragEvent } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import { ExampleGallery } from './ExampleGallery'
import { VisionModelSelector } from './VisionModelSelector'

async function compressAndConvert(file: File): Promise<string> {
  const maxSizeMB = 2
  const maxDim = 2048

  const imageCompression = (window as any).imageCompression
  let processed = file

  if (typeof imageCompression === 'function' && file.size > maxSizeMB * 1024 * 1024) {
    try {
      processed = await imageCompression(file, {
        maxSizeMB,
        maxWidthOrHeight: maxDim,
        useWebWorker: true,
        libURL: './cdn/browser-image-compression/browser-image-compression.js',
        fileType: file.type,
      })
    } catch {
      processed = file
    }
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      resolve(result.split(',')[1])
    }
    reader.onerror = reject
    reader.readAsDataURL(processed)
  })
}

const MAX_IMAGES = 8

export function ReferenceImageUpload() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const addReferenceImage = useDirectorStore((s) => s.addReferenceImage)
  const removeReferenceImage = useDirectorStore((s) => s.removeReferenceImage)
  const clearReferenceImages = useDirectorStore((s) => s.clearReferenceImages)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [isProcessing, setIsProcessing] = useState(false)
  const [, startTransition] = useTransition()

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      const imageFiles = Array.from(files)
        .filter((f) => f.type.startsWith('image/'))
        .slice(0, MAX_IMAGES - useDirectorStore.getState().referenceImages.length)
      if (imageFiles.length === 0) return

      setIsProcessing(true)
      try {
        const results = await Promise.all(
          imageFiles.map(async (file) => ({
            data: await compressAndConvert(file),
            mimeType: file.type,
            name: file.name,
          }))
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
            <VisionModelSelector />
            <ExampleGallery />
          </div>
        </div>
        <div
          onClick={() => !isProcessing && fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className={`border-2 border-dashed border-white border-opacity-30 rounded-none p-8 text-center transition-colors ${isProcessing ? 'opacity-60 cursor-wait' : 'cursor-pointer hover:border-purple-400'}`}
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
          <VisionModelSelector />
          <ExampleGallery />
          <div className="flex gap-2">
            {referenceImages.length < MAX_IMAGES && (
              <button
                onClick={() => fileInputRef.current?.click()}
                className="text-xs text-purple-400 hover:text-purple-300 transition-colors"
              >
                <i className="fas fa-plus mr-1" />
                添加
              </button>
            )}
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
      </div>

      <div
        className="grid grid-cols-4 gap-2"
        onDrop={handleDrop}
        onDragOver={handleDragOver}
      >
        {referenceImages.map((img, idx) => (
          <div key={idx} className="relative group aspect-square rounded-none overflow-hidden bg-[#27272A]">
            <img
              src={`data:${img.mimeType};base64,${img.data}`}
              alt={img.name}
              className="w-full h-full object-cover"
            />
            <button
              onClick={() => removeReferenceImage(idx)}
              className="absolute top-1 right-1 w-5 h-5 bg-black/70 rounded-full flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-300"
            >
              <i className="fas fa-times text-xs" />
            </button>
          </div>
        ))}
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
