import { useState, useMemo } from 'react'
import type { PassCardData } from '../../services/pipeline/types'
import { useDirectorStore } from '../stores/useDirectorStore'

type PassStatus = 'pending' | 'running' | 'completed' | 'retrying' | 'failed'

const PASS_DEFS_FULL = [
  { label: '技能选择',     icon: 'fa-brain' },
  { label: '场景分析',     icon: 'fa-eye' },
  { label: '角色锚定',     icon: 'fa-user-tag' },
  { label: '风格锚点',     icon: 'fa-palette' },
  { label: '分镜+Prompt', icon: 'fa-th-large' },
  { label: '质量校验',     icon: 'fa-check-double' },
  { label: '图像生成',     icon: 'fa-image' },
]

const PASS_DEFS_FAST = [
  { label: '技能选择',     icon: 'fa-brain' },
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

const MAX_INLINE_STRING = 2000

function sanitizeRawForDisplay(input: unknown): unknown {
  const visited = new WeakSet<object>()

  const walk = (value: unknown): unknown => {
    if (typeof value === 'string') {
      if (/^data:image\/[a-zA-Z0-9+.-]+;base64,/.test(value)) {
        return '[base64 image omitted]'
      }
      // 兜底：超长字符串统一截断，避免弹窗被巨量文本撑爆
      if (value.length > MAX_INLINE_STRING) {
        return `${value.slice(0, MAX_INLINE_STRING)}... [truncated ${value.length - MAX_INLINE_STRING} chars]`
      }
      return value
    }
    if (!value || typeof value !== 'object') return value
    if (visited.has(value as object)) return '[circular]'
    visited.add(value as object)

    if (Array.isArray(value)) return value.map(walk)

    const obj = value as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(obj)) {
      out[k] = walk(v)
    }
    return out
  }

  return walk(input)
}

function collectImageUrls(input: unknown): string[] {
  if (!input || typeof input !== 'object') return []
  const images = (input as any)?.images
  if (!Array.isArray(images)) return []
  return images
    .map((img: any) => img?.url)
    .filter((url: unknown): url is string => typeof url === 'string' && url.length > 0)
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
  const [viewingRaw, setViewingRaw] = useState<PassCardData | null>(null)
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
  const sanitizedRaw = useMemo(
    () => (viewingRaw ? sanitizeRawForDisplay(viewingRaw.raw) : null),
    [viewingRaw],
  )
  const previewUrls = useMemo(
    () => (viewingRaw ? collectImageUrls(viewingRaw.raw) : []),
    [viewingRaw],
  )

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

          <div className="h-2 bg-white bg-opacity-20 rounded-full overflow-hidden">
            <div
              className="h-full rounded-full transition-all duration-500 ease-out"
              style={{
                width: `${percentage}%`,
                background: pipelinePasses <= 5
                  ? 'linear-gradient(90deg, #F59E0B, #EF4444)'
                  : 'linear-gradient(90deg, #3B82F6, #8B5CF6)',
              }}
            />
          </div>
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
          {passCards.map((card) => {
            const def = passDefs[card.pass]
            return (
              <div key={card.pass} className="bg-[#09090B] border border-[#3F3F46] rounded-none px-3 py-2 text-xs">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-white font-medium">
                    <i className={`fas ${def?.icon ?? 'fa-check'} mr-1.5 text-green-400`} />
                    {card.label}
                  </span>
                  <div className="flex items-center gap-2">
                    <span className="text-white opacity-30">{(card.elapsed / 1000).toFixed(1)}s</span>
                    {card.raw != null && (
                      <button
                        onClick={() => setViewingRaw(card)}
                        className="text-blue-400 hover:text-blue-300 transition-colors"
                      >
                        查看完整数据 →
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex flex-wrap gap-1 mb-1.5">
                  {card.appliedSkills.length > 0 ? (
                    card.appliedSkills.map((skillId) => (
                      <span
                        key={skillId}
                        className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-blue-400/40 bg-blue-500/10 text-[10px] text-blue-300"
                        title={skillId}
                      >
                        {skillId}
                      </span>
                    ))
                  ) : (
                    <span className="inline-flex items-center px-1.5 py-0.5 rounded-sm border border-white/10 bg-white/5 text-[10px] text-white/30">
                      no skill
                    </span>
                  )}
                </div>
                {card.summary && (
                  <p className="text-white opacity-50 line-clamp-2">{card.summary}</p>
                )}
              </div>
            )
          })}
        </div>
      )}

      {viewingRaw && (
        <div
          className="fixed inset-0 bg-black/80 z-[60000] flex items-center justify-center p-4"
          onClick={() => setViewingRaw(null)}
        >
          <div
            className="bg-[#09090B] border-2 border-[#3F3F46] rounded-none w-full max-w-2xl max-h-[80vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="px-6 py-4 border-b border-[#3F3F46] flex items-center justify-between">
              <h3 className="text-white font-bold flex items-center">
                <i className="fas fa-database mr-2 text-cyan-400" />
                Pass {viewingRaw.pass}: {viewingRaw.label}
              </h3>
              <div className="flex items-center gap-3">
                <span className="text-white opacity-30 text-xs">{(viewingRaw.elapsed / 1000).toFixed(1)}s</span>
                <button onClick={() => setViewingRaw(null)} className="text-white opacity-50 hover:opacity-100">
                  <i className="fas fa-times text-lg" />
                </button>
              </div>
            </div>
            <div className="flex-1 overflow-auto p-4">
              {previewUrls.length > 0 && (
                <div className="mb-4 grid grid-cols-2 gap-2">
                  {previewUrls.map((url, idx) => (
                    <img
                      key={`${idx}-${url.slice(0, 32)}`}
                      src={url}
                      alt={`Generated ${idx + 1}`}
                      className="w-full max-h-40 object-contain bg-black/30 border border-[#3F3F46]"
                    />
                  ))}
                </div>
              )}
              <pre className="text-white opacity-70 text-xs font-mono whitespace-pre-wrap break-words leading-relaxed">
                {JSON.stringify(sanitizedRaw, null, 2)}
              </pre>
            </div>
            <div className="px-6 py-3 border-t border-[#3F3F46] flex justify-end gap-2">
              <button
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(JSON.stringify(sanitizedRaw, null, 2))
                    const toast = (window as any).toastManagerTS ?? (window as any).toastManager
                    toast?.show?.('已复制到剪贴板', 'success')
                  } catch { /* ignore */ }
                }}
                className="px-4 py-2 bg-[#27272A] border border-[#3F3F46] text-white rounded-none text-sm hover:bg-white hover:bg-opacity-5 transition-colors"
              >
                <i className="fas fa-copy mr-2" />
                复制
              </button>
              <button
                onClick={() => setViewingRaw(null)}
                className="px-4 py-2 bg-[#FCE300] text-black font-bold rounded-none text-sm"
              >
                关闭
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
