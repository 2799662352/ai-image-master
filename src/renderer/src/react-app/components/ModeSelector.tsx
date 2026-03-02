import { useState } from 'react'
import { useDirectorStore } from '../stores/useDirectorStore'

export function ModeSelector() {
  const currentMode = useDirectorStore((s) => s.currentMode)
  const setMode = useDirectorStore((s) => s.setMode)
  const [multiSceneText, setMultiSceneText] = useState('')

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-sliders-h text-yellow-400 mr-2" />
        生成模式
      </h3>

      <div className="flex space-x-3">
        <button
          onClick={() => setMode('single')}
          className={`flex-1 px-4 py-2 rounded-none font-bold uppercase tracking-tighter transition-colors ${
            currentMode === 'single'
              ? 'bg-[#FCE300] text-black'
              : 'bg-[#09090B] border border-[#3F3F46] text-white'
          }`}
        >
          <i className="fas fa-image mr-2" />
          单图模式
        </button>
        <button
          onClick={() => setMode('multi')}
          className={`flex-1 px-4 py-2 rounded-none font-bold uppercase tracking-tighter transition-colors ${
            currentMode === 'multi'
              ? 'bg-[#FCE300] text-black'
              : 'bg-[#09090B] border border-[#3F3F46] text-white'
          }`}
        >
          <i className="fas fa-layer-group mr-2" />
          多提示词模式
        </button>
      </div>

      {currentMode === 'multi' && (
        <div className="mt-4">
          <h3 className="text-white font-semibold flex items-center mb-3">
            <i className="fas fa-list-alt text-orange-400 mr-2" />
            多场景提示词
          </h3>
          <textarea
            value={multiSceneText}
            onChange={(e) => setMultiSceneText(e.target.value)}
            placeholder={`每行一个场景描述，例如：\n场景1: 赛博朋克城市夜景\n场景2: 未来科技实验室\n场景3: 霓虹灯下的街道`}
            className="w-full h-32 px-3 py-2 bg-[#09090B] border border-[#3F3F46] rounded-none text-white font-mono text-sm placeholder-white placeholder-opacity-30 focus:outline-none focus:ring-2 focus:ring-yellow-400 resize-none"
          />
        </div>
      )}
    </div>
  )
}
