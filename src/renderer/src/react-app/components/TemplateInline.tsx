import { useState, useCallback, useEffect } from 'react'
import { Layers, Pencil, X } from 'lucide-react'
import { useTemplateStore } from '../stores/useTemplateStore'
import { TEMPLATE_MAP } from '../constants/templates'
import { TemplatePickerModal } from './TemplatePickerModal'

interface TemplateInlineProps {
  context: string
}

export function TemplateInline({ context }: TemplateInlineProps) {
  const selection = useTemplateStore((s) => s.selections[context] ?? null)
  const setSelection = useTemplateStore((s) => s.setSelection)
  const [showModal, setShowModal] = useState(false)

  const active = selection ? TEMPLATE_MAP[selection] : null

  useEffect(() => {
    if (selection && !TEMPLATE_MAP[selection]) {
      setSelection(context, null)
    }
  }, [selection, context, setSelection])

  const handleSelect = useCallback(
    (key: string) => {
      setSelection(context, key)
    },
    [context, setSelection],
  )

  const handleClear = useCallback(() => {
    setSelection(context, null)
  }, [context, setSelection])

  return (
    <>
      {/* 设计稿 M4 · 2:粉色 FA 调色板 → 线性图标;「选择」由粉色实心改黄描边 mono(粉只留给导演台) */}
      <div className="bg-[#27272A] rounded-none px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <Layers size={14} className="flex-shrink-0 text-zinc-300" aria-hidden />
            <span className="text-white text-sm font-medium flex-shrink-0">风格</span>
            <div className="flex items-center space-x-1.5 min-w-0">
              {active && <span className="text-base">{active.icon}</span>}
              <span className={`text-sm truncate ${active ? 'text-white' : 'text-zinc-400'}`}>
                {active ? active.displayName : '无模板'}
              </span>
            </div>
            {selection && (
              <button
                onClick={handleClear}
                aria-label="清除风格模板"
                className="flex-shrink-0 cursor-pointer text-red-400 transition-colors hover:text-red-300"
              >
                <X size={12} aria-hidden />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="flex h-7 flex-shrink-0 cursor-pointer items-center gap-1.5 border border-cyberpunk-yellow/70 bg-cyberpunk-yellow/10 px-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.12em] text-cyberpunk-yellow transition-colors hover:bg-cyberpunk-yellow hover:text-cyberpunk-black"
          >
            <Pencil size={12} aria-hidden />
            <span>选择</span>
          </button>
        </div>
      </div>

      <TemplatePickerModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        currentTemplate={selection}
        onSelect={handleSelect}
        onClear={handleClear}
      />
    </>
  )
}
