import { useState, useRef, useCallback } from 'react'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 10 * 1024 * 1024

interface DropzoneProps {
  disabled?: boolean
  onFiles: (files: File[]) => void
}

export function Dropzone({ disabled, onFiles }: DropzoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const validate = useCallback((files: FileList | File[]): File[] => {
    const valid: File[] = []
    for (const f of Array.from(files)) {
      if (!ACCEPTED_TYPES.includes(f.type)) continue
      if (f.size > MAX_SIZE) continue
      valid.push(f)
    }
    return valid
  }, [])

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setDragOver(false)
      if (disabled) return
      const valid = validate(e.dataTransfer.files)
      if (valid.length) onFiles(valid)
    },
    [disabled, onFiles, validate]
  )

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (disabled) return
      const items = e.clipboardData.items
      const files: File[] = []
      for (const item of Array.from(items)) {
        if (item.kind === 'file' && ACCEPTED_TYPES.includes(item.type)) {
          const f = item.getAsFile()
          if (f && f.size <= MAX_SIZE) files.push(f)
        }
      }
      if (files.length) onFiles(files)
    },
    [disabled, onFiles]
  )

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`
        relative border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors
        ${disabled ? 'opacity-50 cursor-not-allowed border-zinc-700' : ''}
        ${dragOver ? 'border-cyberpunk-yellow bg-cyberpunk-yellow/5' : 'border-zinc-600 hover:border-zinc-500'}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept=".jpg,.jpeg,.png,.webp"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) {
            const valid = validate(e.target.files)
            if (valid.length) onFiles(valid)
          }
          e.target.value = ''
        }}
      />
      <div className="text-3xl mb-2">🧩</div>
      <p className="text-white font-medium">拖拽、粘贴或点击选择宫格图片</p>
      <p className="text-xs text-zinc-500 mt-1">支持 JPG / PNG / WebP，单张 ≤ 10MB</p>
    </div>
  )
}
