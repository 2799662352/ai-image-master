import { useState, useEffect, useMemo } from 'react'
import type { PipelineProgress, PassCardData } from '../../services/pipeline/types'

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

const PASS_DEFS_FULL = [
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '质量校验',     icon: 'fa-check-double' },
  { label: '图像生成',     icon: 'fa-image' },
]

const PASS_DEFS_FAST = [
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '图像生成',     icon: 'fa-image' },
]

const STATUS_DISPLAY: Record<PassStatus, { text: string; color: string }> = {
  pending:   { text: '等待中',     color: 'text-white opacity-30' },
  running:   { text: '⏳ 进行中', color: 'text-blue-400' },
  completed: { text: '✓ 完成',    color: 'text-green-400' },
  retrying:  { text: '🔄 精修中', color: 'text-yellow-400' },
  failed:    { text: '✗ 失败',    color: 'text-red-400' },
}

interface GenerationProgressProps {
  progress: PipelineProgress | null
}

export function GenerationProgress({ progress }: GenerationProgressProps) {
  const totalPasses = progress?.totalPasses ?? 5
  const passDefs = useMemo(
    () => totalPasses <= 4 ? PASS_DEFS_FAST : PASS_DEFS_FULL,
    [totalPasses],
  )

  const [passStatuses, setPassStatuses] = useState<PassStatus[]>(
    () => Array(totalPasses).fill('pending') as PassStatus[]
  )
  const [passCards, setPassCards] = useState<PassCardData[]>([])
  const [percentage, setPercentage] = useState(0)

  useEffect(() => {
    setPassStatuses(Array(totalPasses).fill('pending') as PassStatus[])
  }, [totalPasses])

  useEffect(() => {
    if (!progress) return

    setPassStatuses((prev) => {
      const next = [...prev]
      while (next.length < totalPasses) next.push('pending')
      for (let i = 0; i < progress.pass - 1; i++) {
        if (i < next.length && (next[i] === 'pending' || next[i] === 'running')) {
          next[i] = 'completed'
        }
      }
      const idx = progress.pass - 1
      if (idx >= 0 && idx < next.length) {
        next[idx] = progress.status === 'completed' ? 'completed'
          : progress.status === 'retrying' ? 'retrying'
          : progress.status === 'failed' ? 'failed'
          : 'running'
      }
      return next
    })

    const base = ((progress.pass - 1) / totalPasses) * 100
    const stepBonus = progress.status === 'completed'
      ? (1 / totalPasses) * 100
      : (0.5 / totalPasses) * 100
    setPercentage(Math.min(Math.round(base + stepBonus), 100))

    if (progress.passData) {
      setPassCards((prev) => {
        const exists = prev.some((c) => c.pass === progress.passData!.pass)
        return exists ? prev : [...prev, progress.passData!]
      })
    }
  }, [progress, totalPasses])

  const currentLabel = progress?.label ?? '准备中…'
  const currentPass = progress?.pass ?? 0

  return (
    <div className="bg-[#27272A] rounded-none p-6 space-y-5">
      <div className="flex items-center gap-3">
        <i className="fas fa-film text-2xl text-purple-400 animate-pulse" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{currentLabel}</p>
          <p className="text-xs text-white opacity-50 mt-0.5">
            步骤 {currentPass}/{totalPasses}
            {totalPasses <= 4 && <span className="ml-2 text-yellow-400/70">⚡ 快速</span>}
          </p>
        </div>
      </div>

      <div className="h-2 bg-white bg-opacity-20 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${percentage}%`,
            background: totalPasses <= 4
              ? 'linear-gradient(90deg, #F59E0B, #EF4444)'
              : 'linear-gradient(90deg, #3B82F6, #8B5CF6)',
          }}
        />
      </div>

      <div className={`grid gap-2 ${totalPasses <= 4 ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
        {passDefs.map((def, idx) => {
          const status = passStatuses[idx] ?? 'pending'
          const display = STATUS_DISPLAY[status]
          const isActive = status === 'running'
          return (
            <div
              key={idx}
              className={`flex items-center gap-2 px-3 py-2 rounded-none text-xs transition-colors ${
                isActive
                  ? 'bg-white bg-opacity-5 border border-white border-opacity-10 ring-1 ring-blue-500/40'
                  : 'bg-[#09090B] border border-[#3F3F46]'
              }`}
            >
              <i className={`fas ${def.icon} ${isActive ? 'text-blue-400' : 'text-white opacity-50'}`} />
              <span className="text-white truncate">{def.label}</span>
              <span className={`ml-auto whitespace-nowrap ${display.color}`}>{display.text}</span>
            </div>
          )
        })}
      </div>

      {passCards.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-[#3F3F46]">
          <p className="text-xs text-white opacity-50 font-medium">阶段结果</p>
          {passCards.map((card) => {
            const def = passDefs[card.pass - 1]
            return (
              <div key={card.pass} className="bg-[#09090B] border border-[#3F3F46] rounded-none px-3 py-2 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white font-medium">
                    <i className={`fas ${def?.icon ?? 'fa-check'} mr-1.5 text-green-400`} />
                    {card.label}
                  </span>
                  <span className="text-white opacity-30">{(card.elapsed / 1000).toFixed(1)}s</span>
                </div>
                {card.summary && (
                  <p className="text-white opacity-50 line-clamp-2">{card.summary}</p>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
