import { useState } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

const TEMPLATES = [
  { key: 'anime', name: '日式动画', icon: '🎌' },
  { key: 'manga', name: '黑白漫画', icon: '📖' },
  { key: 'movie', name: '电影分镜', icon: '🎬' },
  { key: 'webtoon', name: '韩式条漫', icon: '📱' },
  { key: 'comic', name: '美漫风格', icon: '💥' },
  { key: 'illustration', name: '插画风格', icon: '🎨' },
  { key: 'cinematic', name: '影院级写实', icon: '🎥' },
  { key: 'theatrical', name: '剧场版动画', icon: '🎭' },
]

export function TemplateSelector() {
  const currentTemplate = useDirectorStore((s) => s.currentTemplate)
  const setTemplate = useDirectorStore((s) => s.setTemplate)
  const [showPicker, setShowPicker] = useState(false)

  const active = TEMPLATES.find((t) => t.key === currentTemplate)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-white font-semibold flex items-center">
          <i className="fas fa-palette mr-2 text-pink-400" />
          风格模板
        </h3>
        <button
          onClick={() => setShowPicker(!showPicker)}
          className="bg-pink-500 hover:bg-pink-600 text-white px-3 py-1.5 rounded-none text-sm transition-colors"
        >
          选择模板
        </button>
      </div>

      <div className="bg-[#09090B] border border-[#3F3F46] rounded-none p-3 flex items-center justify-between">
        <span className="text-white text-sm">
          {active ? `${active.icon} ${active.name}` : '默认（无模板）'}
        </span>
        {currentTemplate && (
          <button
            onClick={() => setTemplate(null)}
            className="text-white opacity-50 hover:opacity-100 text-xs transition-opacity"
          >
            清除
          </button>
        )}
      </div>

      {showPicker && (
        <div className="grid grid-cols-2 gap-2 mt-3">
          {TEMPLATES.map((t) => {
            const selected = currentTemplate === t.key
            return (
              <button
                key={t.key}
                onClick={() => {
                  setTemplate(t.key)
                  setShowPicker(false)
                }}
                className={`bg-[#09090B] border border-[#3F3F46] rounded-none p-3 cursor-pointer text-left transition-all ${
                  selected ? 'ring-2 ring-pink-400' : 'hover:bg-white hover:bg-opacity-5'
                }`}
              >
                <span className="text-lg mr-2">{t.icon}</span>
                <span className="text-white text-sm">{t.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
