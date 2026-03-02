import { useState, useCallback } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

const TEMPLATES = [
  { key: 'anime', name: '日式动画', icon: '🎌', desc: 'TV anime 风格，赛璐璐着色' },
  { key: 'manga', name: '黑白漫画', icon: '📖', desc: '网点纸 + 动态线条' },
  { key: 'movie', name: '电影分镜', icon: '🎬', desc: '电影级光影，景深效果' },
  { key: 'webtoon', name: '韩式条漫', icon: '📱', desc: '全彩柔和着色，竖版' },
  { key: 'comic', name: '美漫风格', icon: '💥', desc: '粗线条 + 网点 + 动作感' },
  { key: 'illustration', name: '插画风格', icon: '🎨', desc: '精细艺术插画' },
  { key: 'cinematic', name: '影院级写实', icon: '🎥', desc: '8K 写实摄影，自然景深' },
  { key: 'theatrical', name: '剧场版动画', icon: '🎭', desc: '剧场版品质，电影级动画' },
]

export function TemplateSelector() {
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const setTemplate = useDirectorStore((s) => s.setTemplate)
  const [showModal, setShowModal] = useState(false)

  const active = TEMPLATES.find((t) => t.key === currentTemplate)

  const handleSelect = useCallback((key: string) => {
    setTemplate(key)
    setShowModal(false)
  }, [setTemplate])

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
                {active ? active.name : '默认（无模板）'}
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
                {TEMPLATES.map((t) => {
                  const selected = currentTemplate === t.key
                  return (
                    <button
                      key={t.key}
                      onClick={() => handleSelect(t.key)}
                      className={`text-left p-4 border-2 rounded-none transition-all ${
                        selected
                          ? 'border-pink-400 bg-pink-400 bg-opacity-10'
                          : 'border-[#3F3F46] bg-[#27272A] hover:border-[#FCE300] hover:border-opacity-50'
                      }`}
                    >
                      <div className="flex items-center space-x-3 mb-2">
                        <span className="text-2xl">{t.icon}</span>
                        <div>
                          <div className="text-white font-semibold text-sm">{t.name}</div>
                          <div className="text-white opacity-40 text-xs">{t.desc}</div>
                        </div>
                      </div>
                      {selected && (
                        <div className="flex items-center text-pink-400 text-xs mt-1">
                          <i className="fas fa-check-circle mr-1" />
                          当前使用
                        </div>
                      )}
                    </button>
                  )
                })}
              </div>
            </div>

            <div className="px-6 py-3 border-t border-[#3F3F46] flex items-center justify-between">
              <span className="text-white opacity-30 text-xs">
                {currentTemplate ? `已选: ${active?.name}` : '未选择模板'}
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
    </>
  )
}
