import { useState } from 'react'
import type { PassCardData } from '../../services/pipeline/types'
import { AppliedSkillsBadges } from './AppliedSkillsBadges'
import { RawDataModal } from './RawDataModal'

interface PassCardProps {
  card: PassCardData
  icon?: string
}

export function PassCard({ card, icon = 'fa-check' }: PassCardProps) {
  const [viewingRaw, setViewingRaw] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const hasSummary = !!card.summary && card.summary !== card.label

  const verifyReport = card.passName === 'verifyConsistency' ? (card.raw as any)?.report : null
  const verifyIssues: string[] = verifyReport?.issues ?? []
  const verifyOk = verifyReport?.ok ?? (verifyReport ? verifyReport.score >= 6 : null)

  return (
    <>
      <div className="bg-[#09090B] border border-[#3F3F46] rounded-none px-3 py-2 text-xs">
        <div
          className={`flex items-center justify-between ${hasSummary ? 'cursor-pointer' : ''}`}
          onClick={() => { if (hasSummary) setExpanded(v => !v) }}
        >
          <span className="text-white font-medium flex items-center gap-1.5">
            <i className={`fas ${icon} ${verifyOk === false ? 'text-yellow-400' : 'text-green-400'}`} />
            {card.label}
            {verifyOk !== null && (
              <span className={`ml-1 ${verifyOk ? 'text-green-400' : 'text-yellow-400'}`}>
                {verifyOk ? '通过' : '未通过'}
              </span>
            )}
            {hasSummary && <i className={`fas fa-chevron-${expanded ? 'up' : 'down'} text-white/20 text-[9px] ml-1`} />}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-white opacity-30">{(card.elapsed / 1000).toFixed(1)}s</span>
            {card.raw != null && (
              <button onClick={(e) => { e.stopPropagation(); setViewingRaw(true) }} className="text-blue-400 hover:text-blue-300 transition-colors">
                查看完整数据 →
              </button>
            )}
          </div>
        </div>

        {verifyReport && !expanded && (
          <div className="mt-1.5 text-white/50">
            评分 {verifyReport.score}/10
            {verifyIssues.length > 0 && <span className="ml-2 text-yellow-400/70">{verifyIssues.length} 个问题</span>}
          </div>
        )}

        {expanded && (
          <>
            <div className="flex flex-wrap gap-1 mt-1.5 mb-1.5">
              <AppliedSkillsBadges skills={card.appliedSkills} />
            </div>
            {hasSummary && (
              <p className="text-white opacity-50 whitespace-pre-wrap leading-relaxed max-h-60 overflow-auto">{card.summary}</p>
            )}
            {verifyIssues.length > 0 && (
              <div className="mt-2 space-y-1">
                <p className="text-yellow-400/80 font-medium">问题反馈：</p>
                <ul className="list-disc list-inside space-y-0.5 text-white/60">
                  {verifyIssues.map((issue, i) => (
                    <li key={i}>{issue}</li>
                  ))}
                </ul>
              </div>
            )}
            {verifyReport && (
              <div className="flex flex-wrap gap-2 mt-2">
                {[
                  { label: '角色一致', ok: verifyReport.characterConsistency },
                  { label: '光影连贯', ok: verifyReport.lightingContinuity },
                  { label: '叙事流畅', ok: verifyReport.narrativeFlow },
                  { label: '空间连贯', ok: verifyReport.spatialCoherence },
                ].map(({ label, ok }) => (
                  <span key={label} className={`px-1.5 py-0.5 rounded-sm border ${ok ? 'border-green-700/50 text-green-400/80' : 'border-red-700/50 text-red-400/80'}`}>
                    {ok ? '✓' : '✗'} {label}
                  </span>
                ))}
                {typeof verifyReport.styleConsistency === 'number' && (
                  <span className={`px-1.5 py-0.5 rounded-sm border ${verifyReport.styleConsistency >= 6 ? 'border-green-700/50 text-green-400/80' : 'border-red-700/50 text-red-400/80'}`}>
                    风格 {verifyReport.styleConsistency}/10
                  </span>
                )}
              </div>
            )}
          </>
        )}
      </div>
      {viewingRaw && <RawDataModal card={card} onClose={() => setViewingRaw(false)} />}
    </>
  )
}
