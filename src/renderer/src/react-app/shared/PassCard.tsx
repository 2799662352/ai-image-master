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

  return (
    <>
      <div className="bg-[#09090B] border border-[#3F3F46] rounded-none px-3 py-2 text-xs">
        <div
          className={`flex items-center justify-between ${hasSummary ? 'cursor-pointer' : ''}`}
          onClick={() => { if (hasSummary) setExpanded(v => !v) }}
        >
          <span className="text-white font-medium flex items-center gap-1.5">
            <i className={`fas ${icon} text-green-400`} />
            {card.label}
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
        {expanded && (
          <>
            <div className="flex flex-wrap gap-1 mt-1.5 mb-1.5">
              <AppliedSkillsBadges skills={card.appliedSkills} />
            </div>
            {hasSummary && (
              <p className="text-white opacity-50 whitespace-pre-wrap leading-relaxed max-h-60 overflow-auto">{card.summary}</p>
            )}
          </>
        )}
      </div>
      {viewingRaw && <RawDataModal card={card} onClose={() => setViewingRaw(false)} />}
    </>
  )
}
