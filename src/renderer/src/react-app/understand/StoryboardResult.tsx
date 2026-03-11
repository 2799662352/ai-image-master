import { useState } from 'react'
import { useStoryboardStore } from './stores/useStoryboardStore'

const TAB_BASE = 'px-4 py-2 rounded-none text-sm font-medium cursor-pointer transition-colors duration-200'
const TAB_ACTIVE = `${TAB_BASE} bg-[#FCE300] text-black font-bold`
const TAB_INACTIVE = `${TAB_BASE} text-white/60 hover:text-white/80 hover:bg-[#3F3F46]`

export function StoryboardResult() {
  const formattedText = useStoryboardStore((s) => s.formattedText)
  const jsonText = useStoryboardStore((s) => s.jsonText)
  const [tab, setTab] = useState<'formatted' | 'json'>('formatted')
  const [copyLabel, setCopyLabel] = useState('复制')

  if (!formattedText && !jsonText) return null

  const currentText = tab === 'formatted' ? formattedText : jsonText

  const handleCopy = async () => {
    if (!currentText) return
    try {
      await navigator.clipboard.writeText(currentText)
      setCopyLabel('已复制')
      setTimeout(() => setCopyLabel('复制'), 1500)
    } catch {
      setCopyLabel('复制失败')
      setTimeout(() => setCopyLabel('复制'), 1500)
    }
  }

  const handleImport = () => {
    document.dispatchEvent(new CustomEvent('storyboard:import-to-director'))
  }

  return (
    <div className="bg-[#27272A] rounded-none p-4">
      <h3 className="text-white font-semibold flex items-center mb-3">
        <i className="fas fa-scroll text-green-400 mr-2" />
        分镜数据
      </h3>
      <div className="flex gap-1 bg-[#09090B] border border-[#3F3F46] rounded-none p-1 mb-3">
        <button className={tab === 'formatted' ? TAB_ACTIVE : TAB_INACTIVE} onClick={() => setTab('formatted')}>
          <i className="fas fa-align-left mr-1" /> 格式化文本
        </button>
        <button className={tab === 'json' ? TAB_ACTIVE : TAB_INACTIVE} onClick={() => setTab('json')}>
          <i className="fas fa-code mr-1" /> JSON
        </button>
      </div>
      <div className="bg-[#09090B] border border-[#3F3F46] rounded-none p-4 font-mono text-sm text-white/90 overflow-auto whitespace-pre-wrap" style={{ maxHeight: 800, lineHeight: 1.8 }}>
        {currentText}
      </div>
      <div className="flex gap-2 mt-3">
        <button onClick={handleCopy} className="px-4 py-2 bg-[#09090B] border border-[#3F3F46] hover:bg-[#3F3F46] text-white rounded-none transition-colors duration-200 cursor-pointer flex items-center gap-1">
          <i className={`fas ${copyLabel === '已复制' ? 'fa-check' : 'fa-copy'}`} /> <span>{copyLabel}</span>
        </button>
        <button onClick={handleImport} className="px-6 py-3 bg-[#FCE300] text-black font-bold rounded-none hover:bg-yellow-400 transition-colors duration-200 cursor-pointer flex items-center gap-2">
          <i className="fas fa-film" /> 导入导演模式
        </button>
      </div>
    </div>
  )
}
