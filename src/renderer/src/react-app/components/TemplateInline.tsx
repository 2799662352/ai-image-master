import { useState, useCallback, useEffect } from 'react'
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
      <div className="bg-[#27272A] rounded-none px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center space-x-2 min-w-0">
            <i className="fas fa-palette text-pink-400 text-sm flex-shrink-0" />
            <span className="text-white text-sm font-medium flex-shrink-0">风格</span>
            <div className="flex items-center space-x-1.5 min-w-0">
              {active && <span className="text-base">{active.icon}</span>}
              <span className="text-white text-sm truncate">
                {active ? active.displayName : '无模板'}
              </span>
            </div>
            {selection && (
              <button
                onClick={handleClear}
                className="text-red-400 hover:text-red-300 text-xs transition-colors flex-shrink-0 cursor-pointer"
              >
                <i className="fas fa-times" />
              </button>
            )}
          </div>
          <button
            onClick={() => setShowModal(true)}
            className="bg-pink-500 hover:bg-pink-600 text-white px-2.5 py-1 rounded-none text-xs transition-all flex items-center space-x-1 flex-shrink-0 cursor-pointer"
          >
            <i className="fas fa-magic" />
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
