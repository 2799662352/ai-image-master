import { useState, useCallback } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

interface StyleTemplate {
  name: string
  prefix: string
  suffix: string
  negative: string
  negativeEnabled?: boolean
}

const BUILTIN_TEMPLATES: Record<string, StyleTemplate & { icon: string; displayName: string; desc: string }> = {
  anime: { icon: '🎌', displayName: '日式动画', desc: 'TV anime 赛璐璐着色', name: 'anime', prefix: 'anime screencap, TV anime, storyboard panel, sequential storytelling, narrative composition, ', suffix: ', masterpiece, best quality, absurdres, very aesthetic, full color, anime cel shading, TV anime coloring', negative: 'blurry, lowres, upscaled, artistic error, film grain, scan artifacts, bad anatomy, worst quality', negativeEnabled: false },
  manga: { icon: '📖', displayName: '黑白漫画', desc: '网点纸 + 动态线条', name: 'manga', prefix: 'manga panel, comic storyboard, sequential art, black and white manga, screentone, ', suffix: ', masterpiece, best quality, manga style, high contrast, dynamic lines, speech bubbles layout', negative: 'blurry, lowres, bad anatomy, worst quality, color, photorealistic, 3d render', negativeEnabled: false },
  movie: { icon: '🎬', displayName: '电影分镜', desc: '电影级光影景深', name: 'movie', prefix: 'cinematic storyboard, film still, movie scene, cinematography, ', suffix: ', masterpiece, best quality, cinematic lighting, depth of field, widescreen, film grain, color grading', negative: 'anime, cartoon, illustration, bad anatomy, worst quality, low quality', negativeEnabled: false },
  webtoon: { icon: '📱', displayName: '韩式条漫', desc: '全彩柔和竖版', name: 'webtoon', prefix: 'webtoon style, korean manhwa, full color comic, vertical scroll format, ', suffix: ', masterpiece, best quality, soft shading, clean lineart, vibrant colors, romantic atmosphere', negative: 'blurry, lowres, bad anatomy, worst quality, black and white, monochrome', negativeEnabled: false },
  comic: { icon: '💥', displayName: '美漫风格', desc: '粗线条网点动作感', name: 'comic', prefix: 'american comic style, superhero comic, comic book panel, bold lineart, ', suffix: ', masterpiece, best quality, dynamic pose, strong contrast, halftone dots, action scene', negative: 'blurry, lowres, bad anatomy, worst quality, anime style, soft shading', negativeEnabled: false },
  illustration: { icon: '🎨', displayName: '插画风格', desc: '精细艺术插画', name: 'illustration', prefix: 'illustration, detailed artwork, artistic composition, ', suffix: ', masterpiece, best quality, highly detailed, beautiful lighting, artistic, professional illustration', negative: 'blurry, lowres, bad anatomy, worst quality, bad quality, simple background', negativeEnabled: false },
  cinematic: { icon: '🎥', displayName: '影院级写实', desc: '8K 写实自然景深', name: 'cinematic', prefix: 'Cinematic Contact Sheet, award-winning trailer storyboard, precise grid layout with equal panels. ', suffix: ', photorealistic, sequence photography, 8K resolution, natural depth of field', negative: 'text, speech bubbles, dialogue, watermark, blurry, low quality, inconsistent characters', negativeEnabled: false },
  theatrical: { icon: '🎭', displayName: '剧场版动画', desc: '剧场版品质电影级', name: 'theatrical', prefix: '((劇場版クオリティのスクリーンショット:1.5)), ', suffix: ', 高品質, 8k, masterpiece, best quality, cinematic lighting, highly detailed', negative: '低品質, 作画崩壊, 実写, 3D, 異なる画風', negativeEnabled: false },
}

const TEMPLATE_KEYS = Object.keys(BUILTIN_TEMPLATES)

interface EditorState {
  key: string
  name: string
  prefix: string
  suffix: string
  negative: string
  negativeEnabled: boolean
  isBuiltin: boolean
}

export function TemplateSelector() {
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const setTemplate = useDirectorStore((s) => s.setTemplate)
  const [showModal, setShowModal] = useState(false)
  const [editor, setEditor] = useState<EditorState | null>(null)

  const active = currentTemplate ? BUILTIN_TEMPLATES[currentTemplate] : null

  const handleSelect = useCallback((key: string) => {
    setTemplate(key)
    setShowModal(false)
  }, [setTemplate])

  const handleClear = useCallback(() => {
    setTemplate(null)
  }, [setTemplate])

  const openEditor = useCallback((key: string) => {
    const t = BUILTIN_TEMPLATES[key]
    if (!t) return
    setEditor({
      key,
      name: t.displayName,
      prefix: t.prefix,
      suffix: t.suffix,
      negative: t.negative,
      negativeEnabled: t.negativeEnabled ?? false,
      isBuiltin: true,
    })
  }, [])

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
            className="bg-pink-500 hover:bg-pink-600 text-white px-3 py-1.5 rounded-none text-sm transition-all flex items-center space-x-1"
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
                className="text-red-400 hover:text-red-300 text-xs transition-colors"
              >
                <i className="fas fa-times mr-1" />
                清除
              </button>
            )}
          </div>
        </div>
      </div>

      {showModal && (
        <div
          className="fixed inset-0 bg-[#09090B] bg-opacity-90 z-[50000] flex items-center justify-center p-4"
          onClick={() => setShowModal(false)}
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
                onClick={() => setShowModal(false)}
                className="text-white opacity-50 hover:opacity-100 transition-opacity"
              >
                <i className="fas fa-times text-xl" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-3">
                {TEMPLATE_KEYS.map((key) => {
                  const t = BUILTIN_TEMPLATES[key]
                  const selected = currentTemplate === key
                  return (
                    <div
                      key={key}
                      className={`relative group border-2 rounded-none p-4 transition-all cursor-pointer ${
                        selected
                          ? 'border-[#FCE300] bg-[#FCE300] bg-opacity-10'
                          : 'border-[#3F3F46] bg-[#27272A] hover:border-[#FCE300]'
                      }`}
                      onClick={() => handleSelect(key)}
                    >
                      <div className="flex items-start justify-between">
                        <div className="flex-1 min-w-0">
                          <h4 className="font-bold text-white flex items-center text-sm uppercase tracking-tight">
                            <span className="text-lg mr-2">{t.icon}</span>
                            {t.displayName}
                            <span className="ml-2 text-xs text-white opacity-30">内置</span>
                          </h4>
                          <p className="text-white opacity-40 text-xs mt-1 line-clamp-2">
                            {t.prefix.substring(0, 60)}...
                          </p>
                        </div>
                        <button
                          onClick={(e) => { e.stopPropagation(); openEditor(key) }}
                          className="w-8 h-8 bg-[#3F3F46] hover:bg-[#FCE300] text-white opacity-50 hover:text-black hover:opacity-100 rounded-none flex items-center justify-center transition-all ml-2 flex-shrink-0"
                          title="编辑"
                        >
                          <i className="fas fa-edit text-sm" />
                        </button>
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
              <button
                onClick={() => setShowModal(false)}
                className="bg-[#FCE300] text-black font-bold px-4 py-2 rounded-none text-sm uppercase tracking-tighter hover:scale-105 transition-all"
              >
                确定
              </button>
            </div>
          </div>
        </div>
      )}

      {editor && (
        <div
          className="fixed inset-0 bg-[#09090B] bg-opacity-90 z-[50001] flex items-center justify-center p-4"
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
              <button onClick={() => setEditor(null)} className="text-white opacity-50 hover:opacity-100">
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
                <label className="text-white text-sm font-medium block mb-1">前缀提示词 (Prefix)</label>
                <textarea
                  value={editor.prefix}
                  onChange={(e) => setEditor({ ...editor, prefix: e.target.value })}
                  rows={4}
                  className="w-full px-3 py-2 bg-[#27272A] border border-[#3F3F46] rounded-none text-white text-sm font-mono focus:outline-none focus:border-[#FCE300] resize-y"
                />
              </div>
              <div>
                <label className="text-white text-sm font-medium block mb-1">后缀提示词 (Suffix)</label>
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
                    onClick={() => setEditor({ ...editor, negativeEnabled: !editor.negativeEnabled })}
                    className={`px-2 py-0.5 text-xs font-bold rounded-none transition-colors ${
                      editor.negativeEnabled ? 'bg-[#FCE300] text-black' : 'bg-[#3F3F46] text-white opacity-50'
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
                    const orig = BUILTIN_TEMPLATES[editor.key]
                    setEditor({ ...editor, prefix: orig.prefix, suffix: orig.suffix, negative: orig.negative, negativeEnabled: orig.negativeEnabled ?? false })
                  }}
                  className="text-white opacity-50 hover:opacity-100 text-xs transition-opacity"
                >
                  <i className="fas fa-undo mr-1" />
                  恢复默认
                </button>
              )}
              <div className="flex gap-2 ml-auto">
                <button onClick={() => setEditor(null)} className="px-4 py-2 bg-[#3F3F46] text-white rounded-none text-sm hover:bg-[#52525B] transition-colors">
                  取消
                </button>
                <button
                  onClick={() => {
                    BUILTIN_TEMPLATES[editor.key] = { ...BUILTIN_TEMPLATES[editor.key], prefix: editor.prefix, suffix: editor.suffix, negative: editor.negative, negativeEnabled: editor.negativeEnabled }
                    setEditor(null)
                    const toast = (window as any).toastManagerTS ?? (window as any).toastManager
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
