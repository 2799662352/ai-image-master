import { useRef, useCallback, type DragEvent } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
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
      <div>
        <label className="text-sm font-medium text-zinc-300 mb-2 block">
          <i className="fas fa-image mr-2 text-purple-400" />
          参考图片
        </label>
        <div
          onClick={() => fileInputRef.current?.click()}
          onDrop={handleDrop}
          onDragOver={handleDragOver}
          className="border-2 border-dashed border-zinc-600 rounded-lg p-8 text-center cursor-pointer hover:border-purple-400 transition-colors"
        >
          <i className="fas fa-cloud-upload-alt text-3xl text-zinc-500 mb-3" />
          <p className="text-zinc-400 text-sm">点击或拖拽上传参考图片</p>
          <p className="text-zinc-600 text-xs mt-1">最多 {MAX_IMAGES} 张</p>
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
    <div>
      <div className="flex items-center justify-between mb-2">
        <label className="text-sm font-medium text-zinc-300">
          <i className="fas fa-image mr-2 text-purple-400" />
          参考图片 ({referenceImages.length}/{MAX_IMAGES})
        </label>
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
          <div key={idx} className="relative group aspect-square rounded-lg overflow-hidden bg-zinc-800">
            <img
              src={img.data}
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
