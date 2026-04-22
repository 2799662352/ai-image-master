import { useState } from 'react'
import type { SplitConfig } from '../../../../types/storyboardSplit'

interface DefaultsBarProps {
  config: SplitConfig
  onChange: (config: SplitConfig) => void
}

export function DefaultsBar({ config, onChange }: DefaultsBarProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="bg-zinc-900/50 border border-zinc-700 rounded-lg">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 flex items-center justify-between text-sm text-zinc-400 hover:text-white transition-colors"
      >
        <span>⚙️ 高级参数</span>
        <span className="text-xs">{expanded ? '▲ 收起' : '▼ 展开'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-zinc-700/50">
          <label className="flex items-center justify-between mt-3">
            <span className="text-sm text-zinc-300">拆分模式</span>
            <select
              value={config.modelSamplingAuraFlow}
              onChange={(e) => onChange({ ...config, modelSamplingAuraFlow: parseFloat(e.target.value) })}
              className="bg-zinc-800 border border-zinc-600 text-white text-sm px-3 py-1.5 rounded"
            >
              <option value={0.1}>AI 分镜 (0.1)</option>
              <option value={1.0}>漫画分镜 (1.0)</option>
            </select>
          </label>

          <label className="flex items-center justify-between">
            <span className="text-sm text-zinc-300">仅拆第 N 张（留空拆全部）</span>
            <input
              type="number"
              min={0}
              value={config.processIndex ?? ''}
              onChange={(e) => {
                const val = e.target.value
                onChange({
                  ...config,
                  processIndex: val === '' ? undefined : parseInt(val, 10),
                })
              }}
              placeholder="全部"
              className="w-20 bg-zinc-800 border border-zinc-600 text-white text-sm px-2 py-1.5 rounded text-center"
            />
          </label>
        </div>
      )}
    </div>
  )
}
