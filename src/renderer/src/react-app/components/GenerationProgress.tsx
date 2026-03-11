import { useState, useMemo } from 'react'
import type { PassCardData } from '../../services/pipeline/types'
import { useDirectorStore } from '../stores/useDirectorStore'
import { ProgressBar } from '../shared/ProgressBar'
import { PassCard } from '../shared/PassCard'

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

const PASS_DEFS_FULL = [
  { label: '导演规划',     icon: 'fa-tasks' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '一致性校验',   icon: 'fa-check-double' },
  { label: '图像生成',     icon: 'fa-image' },
]

const PASS_DEFS_FAST = [
  { label: '导演规划',     icon: 'fa-tasks' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
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
  collapsed?: boolean
}

export function GenerationProgress({ collapsed = false }: GenerationProgressProps) {
  const progress = useDirectorStore((s) => s.currentProgress)
  const passStatuses = useDirectorStore((s) => s.passStatuses)
  const passCards = useDirectorStore((s) => s.passCards) as PassCardData[]
  const percentage = useDirectorStore((s) => s.progressPercentage)

  const [expanded, setExpanded] = useState(false)
  const pipelinePasses = progress?.totalPasses ?? 5
  const passDefs = useMemo(
    () => pipelinePasses <= 5 ? PASS_DEFS_FAST : PASS_DEFS_FULL,
    [pipelinePasses],
  )
  const totalSlots = passDefs.length

  const currentLabel = progress?.label ?? '准备中…'
  const currentPass = progress?.pass ?? 0

  const isFinished = collapsed
  const showDetails = !isFinished || expanded

  const totalElapsed = passCards.reduce((sum, c) => sum + c.elapsed, 0)
  const totalSkillCount = new Set(passCards.flatMap(c => c.appliedSkills)).size

  return (
    <div className="bg-[#27272A] rounded-none p-6 space-y-5">
      {isFinished ? (
        <button
          onClick={() => setExpanded((v) => !v)}
          className="w-full flex items-center gap-3 cursor-pointer group"
        >
          <i className="fas fa-check-circle text-2xl text-green-400" />
          <div className="flex-1 min-w-0 text-left">
            <p className="text-sm font-medium text-white">
              生成完成
              <span className="ml-2 text-white/40 font-normal">
                {passCards.length} 阶段 · {totalSkillCount} skills · {(totalElapsed / 1000).toFixed(1)}s
              </span>
            </p>
          </div>
          <i className={`fas fa-chevron-${expanded ? 'up' : 'down'} text-white/30 group-hover:text-white/60 transition-colors`} />
        </button>
      ) : (
        <>
          <div className="flex items-center gap-3">
            <i className="fas fa-film text-2xl text-purple-400 animate-pulse" />
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium text-white truncate">{currentLabel}</p>
              <p className="text-xs text-white opacity-50 mt-0.5">
                步骤 {currentPass}/{totalSlots}
                {pipelinePasses <= 5 && <span className="ml-2 text-yellow-400/70">⚡ 快速</span>}
              </p>
            </div>
          </div>

          <ProgressBar percentage={percentage} variant={pipelinePasses <= 5 ? 'fast' : 'default'} />
        </>
      )}

      {showDetails && (
        <div className={`grid gap-2 ${totalSlots <= 5 ? 'grid-cols-2 sm:grid-cols-3' : 'grid-cols-2 sm:grid-cols-3'}`}>
          {passDefs.map((def, idx) => {
            const status: PassStatus = (passStatuses[idx] as PassStatus) ?? 'pending'
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
      )}

      {showDetails && passCards.length > 0 && (
        <div className="space-y-2 pt-2 border-t border-[#3F3F46]">
          <p className="text-xs text-white opacity-50 font-medium">阶段结果</p>
          {passCards.map((card) => (
            <PassCard key={card.pass} card={card} icon={passDefs[card.pass]?.icon ?? 'fa-check'} />
          ))}
        </div>
      )}

    </div>
  )
}
