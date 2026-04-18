interface BulkAddPanelProps {
  onBulkAdd: (text: string) => void
}

export function BulkAddPanel({ onBulkAdd }: BulkAddPanelProps) {
  return (
    <details className="text-sm">
      <summary className="text-zinc-500 cursor-pointer hover:text-zinc-300">批量导入（每行一个提示词）</summary>
      <textarea
        rows={4}
        placeholder="粘贴多行提示词..."
        className="w-full mt-2 px-3 py-2 bg-zinc-800 border border-zinc-700 text-white text-sm resize-none focus:outline-none focus:border-cyberpunk-yellow"
        onBlur={(e) => {
          if (e.target.value.trim()) {
            onBulkAdd(e.target.value)
            e.target.value = ''
          }
        }}
      />
    </details>
  )
}
