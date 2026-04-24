import { useState, useCallback } from 'react'
import {
  TEMPLATE_MAP,
  persistTemplateOverride,
  resetTemplateOverride,
  addCustomTemplate,
  deleteCustomTemplate,
  updateCustomTemplate,
  getAllTemplates,
} from '../constants/templates'

interface EditorState {
  key: string
  name: string
  prefix: string
  suffix: string
  negative: string
  negativeEnabled: boolean
  isBuiltin: boolean
}

interface TemplatePickerModalProps {
  isOpen: boolean
  onClose: () => void
  currentTemplate: string | null
  onSelect: (key: string) => void
  onClear: () => void
}

export function TemplatePickerModal({
  isOpen,
  onClose,
  currentTemplate,
  onSelect,
  onClear,
}: TemplatePickerModalProps) {
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [listVersion, setListVersion] = useState(0)

  const active = currentTemplate ? TEMPLATE_MAP[currentTemplate] : null

  const handleSelect = useCallback(
    (key: string) => {
      onSelect(key)
      onClose()
    },
    [onSelect, onClose],
  )

  const openEditor = useCallback((key: string) => {
    const t = TEMPLATE_MAP[key]
    if (!t) return
    setEditor({
      key,
      name: t.displayName,
      prefix: t.prefix,
      suffix: t.suffix,
      negative: t.negative,
      negativeEnabled: t.negativeEnabled ?? false,
      isBuiltin: !key.startsWith('custom-'),
    })
  }, [])

  if (!isOpen && !editor) return null

  return (
    <>
      {isOpen && (
        <div
          className="fixed inset-0 bg-[#09090B]/90 z-[50000] flex items-center justify-center p-4"
          onClick={onClose}
        >
          <div
            className="bg-[#09090B] border-2 border-[#3F3F46] rounded-none w-full max-w-2xl max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b-2 border-[#3F3F46] flex items-center justify-between">
              <h2 className="text-white font-bold text-lg uppercase tracking-wider flex items-center">
                <i className="fas fa-palette mr-3 text-pink-400" />
                风格模板
              </h2>
              <button
                onClick={onClose}
                className="text-white opacity-50 hover:opacity-100 transition-opacity"
              >
                <i className="fas fa-times text-xl" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-3">
                {getAllTemplates().map((t) => {
                  const key = t.key
                  const isCustom = key.startsWith('custom-')
                  const selected = currentTemplate === key
                  return (
                    <div
                      key={key}
                      className={`relative group border-2 rounded-none p-4 transition-all cursor-pointer ${
                        selected
                          ? 'border-[#FCE300] bg-[#FCE300]/10'
                          : 'border-[#3F3F46] bg-[#27272A] hover:border-[#FCE300]'
                      }`}
                      onClick={() => handleSelect(key)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-white flex items-center text-sm uppercase tracking-tight">
                            <span className="text-lg mr-2">{t.icon}</span>
                            {t.displayName}
                            <span className="ml-2 text-xs text-white opacity-30">
                              {isCustom ? '自定义' : '内置'}
                            </span>
                          </h4>
                          <p className="text-white opacity-40 text-xs mt-1 line-clamp-2">
                            {t.prefix.length > 60 ? `${t.prefix.substring(0, 60)}...` : t.prefix}
                          </p>
                        </div>
                        <div className="flex items-center gap-1 ml-2 flex-shrink-0">
                          <button
                            onClick={(e) => {
                              e.stopPropagation()
                              openEditor(key)
                            }}
                            className="w-8 h-8 bg-[#3F3F46] hover:bg-[#FCE300] text-white opacity-50 hover:text-black hover:opacity-100 rounded-none flex items-center justify-center transition-all"
                            title="编辑"
                          >
                            <i className="fas fa-edit text-sm" />
                          </button>
                          {isCustom && (
                            <button
                              onClick={(e) => {
                                e.stopPropagation()
                                deleteCustomTemplate(key)
                                if (currentTemplate === key) onClear()
                                setListVersion((v) => v + 1)
                              }}
                              className="w-8 h-8 bg-[#3F3F46] hover:bg-red-600 text-white opacity-50 hover:opacity-100 rounded-none flex items-center justify-center transition-all"
                              title="删除"
                            >
                              <i className="fas fa-trash text-sm" />
                            </button>
                          )}
                        </div>
                      </div>
                      {selected && (
                        <div className="flex items-center text-[#FCE300] text-xs mt-2">
                          <i className="fas fa-check-circle mr-1" />
                          当前使用
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-[#3F3F46] flex items-center justify-between">
              <span className="text-white opacity-30 text-xs">
                {currentTemplate ? `已选: ${active?.displayName}` : '未选择模板'}
              </span>
              <div className="flex gap-2">
                <button
                  onClick={() => {
                    setEditor({
                      key: '',
                      name: '',
                      prefix: '',
                      suffix: '',
                      negative: 'blurry, lowres, bad anatomy, worst quality',
                      negativeEnabled: false,
                      isBuiltin: false,
                    })
                  }}
                  className="bg-[#3F3F46] hover:bg-[#52525B] text-white px-3 py-2 rounded-none text-sm transition-colors flex items-center gap-1"
                >
                  <i className="fas fa-plus" />
                  新建模板
                </button>
                <button
                  onClick={onClose}
                  className="bg-[#FCE300] text-black font-bold px-4 py-2 rounded-none text-sm uppercase tracking-tighter hover:scale-105 transition-all"
                >
                  确定
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div
          className="fixed inset-0 bg-[#09090B]/90 z-[50001] flex items-center justify-center p-4"
          onClick={() => setEditor(null)}
        >
          <div
            className="bg-[#09090B] border-2 border-[#3F3F46] rounded-none w-full max-w-xl max-h-[85vh] overflow-hidden flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b-2 border-[#3F3F46] flex items-center justify-between">
              <h2 className="text-white font-bold text-lg uppercase tracking-wider">
                <i className="fas fa-edit mr-2 text-[#FCE300]" />
                编辑模板
              </h2>
              <button
                onClick={() => setEditor(null)}
                className="text-white opacity-50 hover:opacity-100"
              >
                <i className="fas fa-times text-xl" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div>
                <label className="text-white text-sm font-medium block mb-1">模板名称</label>
                <input
                  value={editor.name}
                  onChange={(e) => setEditor({ ...editor, name: e.target.value })}
                  disabled={editor.isBuiltin}
                  className="w-full px-3 py-2 bg-[#27272A] border border-[#3F3F46] rounded-none text-white text-sm focus:outline-none focus:border-[#FCE300] disabled:opacity-50"
                />
              </div>
              <div>
                <label className="text-white text-sm font-medium block mb-1">
                  前缀提示词 (Prefix)
                </label>
                <textarea
                  value={editor.prefix}
                  onChange={(e) => setEditor({ ...editor, prefix: e.target.value })}
                  rows={4}
                  className="w-full px-3 py-2 bg-[#27272A] border border-[#3F3F46] rounded-none text-white text-sm font-mono focus:outline-none focus:border-[#FCE300] resize-y"
                />
              </div>
              <div>
                <label className="text-white text-sm font-medium block mb-1">
                  后缀提示词 (Suffix)
                </label>
                <textarea
                  value={editor.suffix}
                  onChange={(e) => setEditor({ ...editor, suffix: e.target.value })}
                  rows={3}
                  className="w-full px-3 py-2 bg-[#27272A] border border-[#3F3F46] rounded-none text-white text-sm font-mono focus:outline-none focus:border-[#FCE300] resize-y"
                />
              </div>
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-white text-sm font-medium">反向提示词 (Negative)</label>
                  <button
                    onClick={() =>
                      setEditor({ ...editor, negativeEnabled: !editor.negativeEnabled })
                    }
                    className={`px-2 py-0.5 text-xs font-bold rounded-none transition-colors ${
                      editor.negativeEnabled
                        ? 'bg-[#FCE300] text-black'
                        : 'bg-[#3F3F46] text-white opacity-50'
                    }`}
                  >
                    {editor.negativeEnabled ? 'ON' : 'OFF'}
                  </button>
                </div>
                <textarea
                  value={editor.negative}
                  onChange={(e) => setEditor({ ...editor, negative: e.target.value })}
                  rows={3}
                  disabled={!editor.negativeEnabled}
                  className={`w-full px-3 py-2 bg-[#27272A] border border-[#3F3F46] rounded-none text-white text-sm font-mono focus:outline-none focus:border-[#FCE300] resize-y ${
                    !editor.negativeEnabled ? 'opacity-30' : ''
                  }`}
                />
              </div>
            </div>

            <div className="px-6 py-3 border-t border-[#3F3F46] flex items-center justify-between">
              {editor.isBuiltin && (
                <button
                  onClick={() => {
                    resetTemplateOverride(editor.key)
                    const orig = TEMPLATE_MAP[editor.key]
                    if (orig)
                      setEditor({
                        ...editor,
                        prefix: orig.prefix,
                        suffix: orig.suffix,
                        negative: orig.negative,
                        negativeEnabled: orig.negativeEnabled ?? false,
                      })
                  }}
                  className="text-white opacity-50 hover:opacity-100 text-xs transition-opacity"
                >
                  <i className="fas fa-undo mr-1" />
                  恢复默认
                </button>
              )}
              <div className="flex gap-2 ml-auto">
                <button
                  onClick={() => setEditor(null)}
                  className="px-4 py-2 bg-[#3F3F46] text-white rounded-none text-sm hover:bg-[#52525B] transition-colors"
                >
                  取消
                </button>
                <button
                  onClick={() => {
                    if (editor.key && editor.key.startsWith('custom-')) {
                      updateCustomTemplate(editor.key, {
                        displayName: editor.name,
                        desc: '',
                        icon: '✏️',
                        prefix: editor.prefix,
                        suffix: editor.suffix,
                        negative: editor.negative,
                        negativeEnabled: editor.negativeEnabled,
                      })
                    } else if (editor.key) {
                      persistTemplateOverride(editor.key, {
                        prefix: editor.prefix,
                        suffix: editor.suffix,
                        negative: editor.negative,
                        negativeEnabled: editor.negativeEnabled,
                      })
                    } else {
                      const newKey = addCustomTemplate({
                        displayName: editor.name || '自定义模板',
                        desc: '',
                        icon: '✏️',
                        prefix: editor.prefix,
                        suffix: editor.suffix,
                        negative: editor.negative,
                        negativeEnabled: editor.negativeEnabled,
                      })
                      onSelect(newKey)
                    }
                    setEditor(null)
                    setListVersion((v) => v + 1)
                    const toast =
                      (window as any).toastManagerTS ?? (window as any).toastManager
                    toast?.show?.('模板已保存', 'success')
                  }}
                  className="px-4 py-2 bg-[#FCE300] text-black font-bold rounded-none text-sm uppercase tracking-tighter hover:scale-105 transition-all"
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  )
}
