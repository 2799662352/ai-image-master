import { useState, useCallback, useEffect } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'
import { TEMPLATE_MAP } from '../constants/templates'
import { TemplatePickerModal } from './TemplatePickerModal'

export function TemplateSelector() {
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const setTemplate = useDirectorStore((s) => s.setTemplate)
  const [showModal, setShowModal] = useState(false)

  const active = currentTemplate ? TEMPLATE_MAP[currentTemplate] : null

  useEffect(() => {
    if (currentTemplate && !TEMPLATE_MAP[currentTemplate]) {
      setTemplate(null)
    }
  }, [currentTemplate, setTemplate])

  const handleSelect = useCallback(
    (key: string) => {
      setTemplate(key)
    },
    [setTemplate],
  )

  const handleClear = useCallback(() => {
    setTemplate(null)
  }, [setTemplate])

  return (
    <>
      <div className="bg-[#27272A] rounded-none p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-white font-semibold flex items-center">
            <i className="fas fa-palette mr-2 text-pink-400" />
            风格模板
          </h3>
          <button
            onClick={() => setShowModal(true)}
            className="bg-pink-500 hover:bg-pink-600 text-white px-3 py-1.5 rounded-none text-sm transition-all flex items-center space-x-1 cursor-pointer"
          >
            <i className="fas fa-magic" />
            <span>选择模板</span>
          </button>
        </div>

        <div className="bg-[#09090B] border border-[#3F3F46] rounded-none p-3">
          <div className="flex items-center justify-between">
            <div className="flex items-center space-x-2">
              {active && <span className="text-lg">{active.icon}</span>}
              <span className="text-white text-sm">
                {active ? active.displayName : '默认（无模板）'}
              </span>
            </div>
            {currentTemplate && (
              <button
                onClick={handleClear}
                className="text-red-400 hover:text-red-300 text-xs transition-colors cursor-pointer"
              >
                <i className="fas fa-times mr-1" />
                清除
              </button>
            )}
          </div>
        </div>
      </div>

      <TemplatePickerModal
        isOpen={showModal}
        onClose={() => setShowModal(false)}
        currentTemplate={currentTemplate}
        onSelect={handleSelect}
        onClear={handleClear}
      />
    </>
  )
}
