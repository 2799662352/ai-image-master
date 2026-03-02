import { useRef, useCallback, type DragEvent } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = reader.result as string
      const base64 = result.split(',')[1]
      resolve(base64)
    }
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

const MAX_IMAGES = 8

export function ReferenceImageUpload() {
  const referenceImages = useDirectorStore((s) => s.referenceImages)
  const addReferenceImage = useDirectorStore((s) => s.addReferenceImage)
  const removeReferenceImage = useDirectorStore((s) => s.removeReferenceImage)
  const clearReferenceImages = useDirectorStore((s) => s.clearReferenceImages)
  const fileInputRef = useRef<HTMLInputElement>(null)

  const processFiles = useCallback(
    async (files: FileList | File[]) => {
      for (const file of Array.from(files)) {
        if (!file.type.startsWith('image/')) continue
        if (referenceImages.length >= MAX_IMAGES) break
        const data = await fileToBase64(file)
        addReferenceImage({ data, mimeType: file.type, name: file.name })
      }
    },
    [referenceImages.length, addReferenceImage]
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
        <h3 className="text-white font-semibold flex items-center mb-3">
          <i className="fas fa-image mr-2 text-purple-400" />
          参考图片
        </h3>
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="border-2 border-dashed border-white border-opacity-30 rounded-none p-8 text-center cursor-pointer hover:border-purple-400 transition-colors"
        >
          <i className="fas fa-cloud-upload-alt text-3xl text-white opacity-30 mb-3" />
          <p className="text-white opacity-50 text-sm">点击或拖拽上传参考图片</p>
          <p className="text-white opacity-30 text-xs mt-1">最多 {MAX_IMAGES} 张</p>
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
