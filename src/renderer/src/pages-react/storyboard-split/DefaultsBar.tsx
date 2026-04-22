import { useState } from 'react'
import type { SplitConfig } from '../../../../types/storyboardSplit'

interface DefaultsBarProps {
  config: SplitConfig
  onChange: (config: SplitConfig) => void
}

export function DefaultsBar({ config, onChange }: DefaultsBarProps) {
  const [expanded, setExpanded] = useState(false)

  return (
    <div className="d-neon-frame">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        className="w-full px-4 py-2 flex items-center justify-between d-mono text-[11px] text-[color:var(--donor-ink-dim)] hover:text-[color:var(--donor-cyan)] transition-colors tracking-widest uppercase"
      >
        <span>⚙ PARAMS // パラメータ</span>
        <span>{expanded ? '▲' : '▼'}</span>
      </button>

      {expanded && (
        <div className="px-4 pb-3 space-y-3 border-t border-[color:var(--donor-magenta-dim)]">
          <label className="flex items-center justify-between mt-3">
            <span className="d-mono text-[11px] text-[color:var(--donor-ink)]">拆分模式</span>
            <select
              value={config.modelSamplingAuraFlow}
              onChange={(e) => onChange({ ...config, modelSamplingAuraFlow: parseFloat(e.target.value) })}
              className="bg-[color:var(--donor-bg-1)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[11px] px-3 py-1.5"
            >
              <option value={0.1}>AI 分镜 (0.1)</option>
              <option value={1.0}>漫画分镜 (1.0)</option>
            </select>
          </label>

          <label className="flex items-center justify-between">
            <span className="d-mono text-[11px] text-[color:var(--donor-ink)]">仅拆第 N 张 (空=全部)</span>
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
              placeholder="ALL"
              className="w-20 bg-[color:var(--donor-bg-1)] border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[11px] px-2 py-1.5 text-center"
            />
          </label>
        </div>
      )}
    </div>
  )
}
