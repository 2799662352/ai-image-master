import { useRef, useState } from 'react'
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea'

interface BulkAddPanelProps {
  onBulkAdd: (text: string) => void
}

export function BulkAddPanel({ onBulkAdd }: BulkAddPanelProps) {
  // Tracked internally so useAutosizeTextarea can grow with content, then
  // cleared on commit. The parent only cares about the committed value, so
  // we don't lift this state up.
  const [draft, setDraft] = useState('')
  const taRef = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(taRef, draft, { minRows: 4, maxRows: 20 })

  return (
    <details className="text-sm">
      <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">批量导入（每行一个提示词）</summary>
      <textarea
        ref={taRef}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={4}
        placeholder="粘贴多行提示词..."
        className="w-full mt-2 px-3 py-2 bg-zinc-800 border border-zinc-700 text-white text-sm resize-none focus:outline-none focus:border-cyberpunk-yellow transition-[height] duration-100"
        onBlur={(e) => {
          if (e.target.value.trim()) {
            onBulkAdd(e.target.value)
            setDraft('')
          }
        }}
      />
    </details>
  )
}
