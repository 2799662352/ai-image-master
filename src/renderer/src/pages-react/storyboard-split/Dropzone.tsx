import { useState, useRef, useCallback } from 'react'

const ACCEPTED_TYPES = ['image/jpeg', 'image/png', 'image/webp']
const MAX_SIZE = 10 * 1024 * 1024

interface DropzoneProps {
  disabled?: boolean
  onFiles: (files: File[]) => void
  onReject?: (reason: string) => void
}

export function Dropzone({ disabled, onFiles, onReject }: DropzoneProps) {
  const [dragOver, setDragOver] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const validate = useCallback((files: FileList | File[]): File[] => {
    const valid: File[] = []
    let rejectedType = 0
    let rejectedSize = 0
    for (const f of Array.from(files)) {
      if (!ACCEPTED_TYPES.includes(f.type)) { rejectedType++; continue }
      if (f.size > MAX_SIZE) { rejectedSize++; continue }
      valid.push(f)
    }
    if (onReject) {
      if (rejectedType > 0) onReject(`${rejectedType} 個ファイル形式不対応 (JPG/PNG/WebP のみ)`)
      if (rejectedSize > 0) onReject(`${rejectedSize} 個ファイル超過 10MB`)
    }
    return valid
  }, [onReject])

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
      const files: File[] = []
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.kind === 'file') {
          const f = item.getAsFile()
          if (f) files.push(f)
        }
      }
      if (files.length) {
        const valid = validate(files)
        if (valid.length) onFiles(valid)
      }
    },
    [disabled, onFiles, validate]
  )

  return (
    <div
      onDragOver={(e) => { e.preventDefault(); if (!disabled) setDragOver(true) }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onPaste={handlePaste}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`
        d-neon-frame d-clip-corner-br relative p-8 text-center cursor-pointer transition-colors
        ${disabled ? 'opacity-50 cursor-not-allowed' : ''}
        ${dragOver ? 'border-[color:var(--donor-cyan)] bg-[color:var(--donor-cyan)]/5' : ''}
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
      <div className="d-mono text-[color:var(--donor-cyan)] text-3xl mb-2">⊞</div>
      <p className="d-mono text-[color:var(--donor-ink)] text-[13px] tracking-widest uppercase">
        DROP / PASTE / CLICK
      </p>
      <p className="d-mono text-[10px] text-[color:var(--donor-ink-mute)] mt-1 tracking-widest">
        JPG / PNG / WebP · ≤ 10MB
      </p>
    </div>
  )
}
