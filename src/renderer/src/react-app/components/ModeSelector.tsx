import { useDirectorStore } from '../stores/useDirectorStore'

function parseSceneCount(text: string): number {
  if (!text.trim()) return 0
  return text.split(/\n\s*\n/).filter((s) => s.trim().length > 0).length
}

export function ModeSelector() {
  const currentMode = useDirectorStore((s) => s.currentMode)
  const setMode = useDirectorStore((s) => s.setMode)
  const multiSceneText = useDirectorStore((s) => s.multiSceneText)
  const setMultiSceneText = useDirectorStore((s) => s.setMultiSceneText)

  const sceneCount = parseSceneCount(multiSceneText)

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-sliders-h text-yellow-400 mr-2" />
        生成模式
      </h3>

      <div className="flex space-x-3">
        <button
          onClick={() => setMode('single')}
          className={`flex-1 flex items-center justify-center px-4 py-3 rounded-none font-bold uppercase tracking-tighter transition-all hover:scale-105 ${
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
          className={`flex-1 flex items-center justify-center px-4 py-3 rounded-none font-bold uppercase tracking-tighter transition-all hover:scale-105 ${
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
        <div className="mt-4 bg-[#27272A] rounded-none">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-white font-semibold flex items-center">
              <i className="fas fa-list-alt text-orange-400 mr-2" />
              多场景描述
            </h3>
            <span className="text-white opacity-50 text-sm">{sceneCount} 个场景</span>
          </div>
          <textarea
            value={multiSceneText}
            onChange={(e) => setMultiSceneText(e.target.value)}
            rows={8}
            placeholder={"每个场景用空行分隔，例如：\n\n场景1：男主站在雨中，背对镜头\n\n场景2：女主在窗边看书，阳光洒落\n\n场景3：两人在咖啡店相遇"}
            className="w-full px-4 py-3 bg-[#09090B] border border-[#3F3F46] rounded-none text-white font-mono text-sm placeholder-white placeholder-opacity-30 focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
          <p className="text-white opacity-30 text-xs mt-2">
            <i className="fas fa-info-circle mr-1" />
            用空行分隔不同场景，每个场景生成一张漫画分镜页面
          </p>
        </div>
      )}
    </div>
  )
}
