import { useState, useEffect } from 'react'
import type { PipelineProgress, PassCardData } from '../../services/pipeline/types'

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

const PASS_LABELS = [
  '场景分析',
  '角色锚定',
  '分镜设计',
  'Prompt 组装',
  '质量校验',
  '图像生成',
]

const PASS_ICONS = [
  'fa-eye',
  'fa-user-tag',
  'fa-th-large',
  'fa-pen-fancy',
  'fa-check-double',
  'fa-image',
]

const STATUS_DISPLAY: Record<PassStatus, { text: string; color: string }> = {
  pending: { text: '等待中', color: 'text-zinc-500' },
  running: { text: '⏳ 进行中', color: 'text-blue-400' },
  completed: { text: '✓ 完成', color: 'text-green-400' },
  retrying: { text: '🔄 精修中', color: 'text-yellow-400' },
  failed: { text: '✗ 失败', color: 'text-red-400' },
}

interface GenerationProgressProps {
  progress: PipelineProgress | null
}

export function GenerationProgress({ progress }: GenerationProgressProps) {
  const [passStatuses, setPassStatuses] = useState<PassStatus[]>(
    () => Array(6).fill('pending') as PassStatus[]
  )
  const [passCards, setPassCards] = useState<PassCardData[]>([])
  const [percentage, setPercentage] = useState(0)

  useEffect(() => {
    if (!progress) return

    setPassStatuses((prev) => {
      const next = [...prev]
      for (let i = 0; i < progress.pass - 1; i++) {
        if (next[i] === 'pending' || next[i] === 'running') {
          next[i] = 'completed'
        }
      }
      const idx = progress.pass - 1
      if (idx >= 0 && idx < 6) {
        next[idx] = progress.status === 'completed' ? 'completed'
          : progress.status === 'retrying' ? 'retrying'
          : progress.status === 'failed' ? 'failed'
          : 'running'
      }
      return next
    })

    const base = ((progress.pass - 1) / progress.totalPasses) * 100
    const stepBonus = progress.status === 'completed'
      ? (1 / progress.totalPasses) * 100
      : (0.5 / progress.totalPasses) * 100
    setPercentage(Math.min(Math.round(base + stepBonus), 100))

    if (progress.passData) {
      setPassCards((prev) => {
        const exists = prev.some((c) => c.pass === progress.passData!.pass)
        return exists ? prev : [...prev, progress.passData!]
      })
    }
  }, [progress])

  const currentLabel = progress?.label ?? '准备中…'
  const currentPass = progress?.pass ?? 0
  const totalPasses = progress?.totalPasses ?? 6

  return (
    <div className="bg-[#27272A] rounded-none p-6 space-y-5">
      <div className="flex items-center gap-3">
        <i className="fas fa-film text-2xl text-purple-400 animate-pulse" />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium text-white truncate">{currentLabel}</p>
          <p className="text-xs text-zinc-400 mt-0.5">步骤 {currentPass}/{totalPasses}</p>
        </div>
      </div>

      <div className="h-2 bg-zinc-700 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all duration-500 ease-out"
          style={{
            width: `${percentage}%`,
            background: 'linear-gradient(90deg, #3B82F6, #8B5CF6)',
          }}
        />
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {PASS_LABELS.map((label, idx) => {
          const status = passStatuses[idx]
          const display = STATUS_DISPLAY[status]
          const isActive = status === 'running'
          return (
            <div
              key={idx}
              className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs transition-colors ${
                isActive ? 'bg-zinc-600/50 ring-1 ring-blue-500/40' : 'bg-zinc-700/40'
              }`}
            >
              <i className={`fas ${PASS_ICONS[idx]} ${isActive ? 'text-blue-400' : 'text-zinc-400'}`} />
              <span className="text-zinc-300 truncate">{label}</span>
              <span className={`ml-auto whitespace-nowrap ${display.color}`}>{display.text}</span>
            </div>
          )
        })}
      </div>

      {passCards.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-zinc-700">
          <p className="text-xs text-zinc-400 font-medium">阶段结果</p>
          {passCards.map((card) => (
            <div key={card.pass} className="bg-zinc-700/40 rounded-lg px-3 py-2 text-xs">
              <div className="flex items-center justify-between mb-1">
                <span className="text-zinc-200 font-medium">
                  <i className={`fas ${PASS_ICONS[card.pass - 1] ?? 'fa-check'} mr-1.5 text-green-400`} />
                  {card.label}
                </span>
                <span className="text-zinc-500">{(card.elapsed / 1000).toFixed(1)}s</span>
              </div>
              {card.summary && (
                <p className="text-zinc-400 line-clamp-2">{card.summary}</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
