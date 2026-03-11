import { useState, useEffect, useRef } from 'react'
import type { PassCardData } from '../../services/pipeline/types'
import { ProgressBar } from '../shared/ProgressBar'
import { PassCard } from '../shared/PassCard'
import { useStoryboardStore, STORYBOARD_PASS_DEFS } from './stores/useStoryboardStore'
import { StoryboardResult } from './StoryboardResult'

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

const STATUS_DISPLAY: Record<PassStatus, { text: string; color: string }> = {
  pending:   { text: '等待中',     color: 'text-white opacity-30' },
  running:   { text: '⏳ 进行中', color: 'text-blue-400' },
  completed: { text: '✓ 完成',    color: 'text-green-400' },
  retrying:  { text: '🔄 精修中', color: 'text-yellow-400' },
  failed:    { text: '✗ 失败',    color: 'text-red-400' },
}

function useElapsedTimer(running: boolean) {
  const startRef = useRef(Date.now())
  const [elapsed, setElapsed] = useState(0)

  useEffect(() => {
    if (!running) return
    startRef.current = Date.now()
    const id = setInterval(() => setElapsed(Date.now() - startRef.current), 500)
    return () => clearInterval(id)
  }, [running])

  return elapsed
}

export function StoryboardAnalysisApp() {
  const status = useStoryboardStore((s) => s.analysisStatus)
  const passStatuses = useStoryboardStore((s) => s.passStatuses)
  const passCards = useStoryboardStore((s) => s.passCards) as PassCardData[]
  const percentage = useStoryboardStore((s) => s.progressPercentage)
  const [expanded, setExpanded] = useState(true)

  const isFinished = status === 'completed'
  const isFailed = status === 'failed'
  const isRunning = status === 'running'
  const showDetails = !isFinished || expanded

  const runningIdx = passStatuses.findIndex(s => s === 'running')
  const completedCount = passStatuses.filter(s => s === 'completed').length
  const stepDisplay = runningIdx >= 0 ? runningIdx + 1 : completedCount
  const currentLabel = runningIdx >= 0 ? STORYBOARD_PASS_DEFS[runningIdx]?.label ?? '分析中...' : (completedCount > 0 ? '处理中...' : '启动中...')

  const totalElapsed = passCards.reduce((sum, c) => sum + c.elapsed, 0)
  const totalSkillCount = new Set(passCards.flatMap(c => c.appliedSkills)).size

  const liveElapsed = useElapsedTimer(isRunning)

  const handleCancel = () => {
    document.dispatchEvent(new CustomEvent('storyboard:cancel'))
  }

  return (
    <div className="space-y-4">
      <div className="bg-[#27272A] rounded-none p-6 space-y-5">
        {isFinished ? (
          <button onClick={() => setExpanded(v => !v)} className="w-full flex items-center gap-3 cursor-pointer group">
            <i className="fas fa-check-circle text-2xl text-green-400" />
            <div className="flex-1 min-w-0 text-left">
              <p className="text-sm font-medium text-white">
                分镜分析完成
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
              <i className={`fas fa-brain text-2xl ${isFailed ? 'text-red-400' : 'text-blue-400 animate-pulse'}`} />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-white truncate">{isFailed ? '分析失败' : currentLabel}</p>
                <p className="text-xs text-white opacity-50 mt-0.5">
                  步骤 {stepDisplay}/{STORYBOARD_PASS_DEFS.length}
                  <span className="ml-2">{(liveElapsed / 1000).toFixed(0)}s</span>
                </p>
              </div>
              {isRunning && (
                <button onClick={handleCancel} className="px-3 py-1.5 bg-red-600 text-white text-xs font-bold rounded-none hover:bg-red-500 transition-colors flex items-center gap-1">
                  <i className="fas fa-times" /> 取消
                </button>
              )}
            </div>
            <ProgressBar percentage={percentage} />
          </>
        )}

        {showDetails && (
          <div className="grid gap-2 grid-cols-2 sm:grid-cols-4">
            {STORYBOARD_PASS_DEFS.map((def, idx) => {
              const ps: PassStatus = (passStatuses[idx] as PassStatus) ?? 'pending'
              const display = STATUS_DISPLAY[ps]
              const isActive = ps === 'running'
              const card = passCards.find(c => c.pass === idx)
              const elapsedStr = card ? `${(card.elapsed / 1000).toFixed(1)}s` : ''
              return (
                <div key={idx} className={`flex items-center gap-2 px-3 py-2 rounded-none text-xs transition-colors ${isActive ? 'bg-white bg-opacity-5 border border-white border-opacity-10 ring-1 ring-blue-500/40' : 'bg-[#09090B] border border-[#3F3F46]'}`}>
                  <i className={`fas ${def.icon} ${isActive ? 'text-blue-400' : 'text-white opacity-50'}`} />
                  <span className="text-white truncate">{def.label}</span>
                  {elapsedStr && <span className="text-white/30 text-[10px]">{elapsedStr}</span>}
                  <span className={`ml-auto whitespace-nowrap ${display.color}`}>{display.text}</span>
                </div>
              )
            })}
          </div>
        )}

        {showDetails && passCards.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-[#3F3F46]">
            <p className="text-xs text-white opacity-50 font-medium">阶段结果</p>
            {passCards.map(card => (
              <PassCard key={card.pass} card={card} icon={STORYBOARD_PASS_DEFS[card.pass]?.icon ?? 'fa-check'} />
            ))}
          </div>
        )}
      </div>

      <StoryboardResult />
    </div>
  )
}
