import { type ChangeEvent } from 'react'
import type { DonorItemStatus } from '../../hooks/useHistoryData'

export type SortMode = 'newest' | 'oldest'
export type StatusFilter = 'all' | DonorItemStatus

interface Props {
  query: string
  onQueryChange: (v: string) => void
  model: string
  onModelChange: (v: string) => void
  models: string[]
  status: StatusFilter
  onStatusChange: (v: StatusFilter) => void
  sort: SortMode
  onSortChange: (v: SortMode) => void
  matchedCount: number
  totalCount: number
}

export default function DonorFilterBar({
  query,
  onQueryChange,
  model,
  onModelChange,
  models,
  status,
  onStatusChange,
  sort,
  onSortChange,
  matchedCount,
  totalCount,
}: Props) {
  const statusOpts: Array<{ v: StatusFilter; label: string }> = [
    { v: 'all', label: 'ALL' },
    { v: 'ok-cloud', label: 'CLOUD' },
    { v: 'ok-local', label: 'LOCAL' },
    { v: 'uploading', label: 'UPLOAD' },
    { v: 'failed', label: 'FAILED' },
  ]

  return (
    <div className="d-neon-frame--soft d-clip-tag mt-4 mb-4 p-3 md:p-4">
      <div className="flex flex-col md:flex-row gap-3 md:items-center">
        {/* 搜索 */}
        <div className="flex-1 min-w-[240px] relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 d-mono text-[color:var(--donor-cyan)] text-[13px]">
            $&gt;
          </span>
          <input
            type="search"
            value={query}
            onChange={(e: ChangeEvent<HTMLInputElement>) => onQueryChange(e.target.value)}
            placeholder="search by prompt // プロンプト検索..."
            className="w-full pl-8 pr-3 py-2 bg-[color:var(--donor-bg-1)]/80 border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[13px] placeholder:text-[color:var(--donor-ink-mute)] focus:border-[color:var(--donor-cyan)] focus:outline-none transition-colors"
          />
        </div>

        {/* 模型筛选 */}
        <div className="flex items-center gap-2">
          <span className="d-mono text-[11px] text-[color:var(--donor-ink-dim)] tracking-widest">MODEL/</span>
          <select
            value={model}
            onChange={(e) => onModelChange(e.target.value)}
            className="px-3 py-2 bg-[color:var(--donor-bg-1)]/80 border border-[color:var(--donor-magenta-dim)] text-[color:var(--donor-ink)] d-mono text-[12px] focus:border-[color:var(--donor-cyan)] focus:outline-none cursor-pointer"
          >
            <option value="">ANY</option>
            {models.map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </div>

        {/* 排序 */}
        <div className="flex items-center gap-2">
          <span className="d-mono text-[11px] text-[color:var(--donor-ink-dim)] tracking-widest">SORT/</span>
          <button
            type="button"
            onClick={() => onSortChange(sort === 'newest' ? 'oldest' : 'newest')}
            className="d-hover-invert-cyan px-3 py-2 d-mono text-[12px] tracking-widest uppercase"
          >
            {sort === 'newest' ? '▼ NEW' : '▲ OLD'}
          </button>
        </div>
      </div>

      {/* 状态切片 */}
      <div className="mt-3 flex items-center gap-2 flex-wrap">
        <span className="d-mono text-[11px] text-[color:var(--donor-ink-dim)] tracking-widest">STATUS/</span>
        {statusOpts.map((opt) => {
          const active = opt.v === status
          return (
            <button
              key={opt.v}
              type="button"
              onClick={() => onStatusChange(opt.v)}
              className={`px-3 py-1 d-mono text-[11px] tracking-widest uppercase border transition-colors cursor-pointer ${
                active
                  ? 'bg-[color:var(--donor-magenta)] text-[color:var(--donor-bg-0)] border-[color:var(--donor-magenta)]'
                  : 'bg-transparent text-[color:var(--donor-ink-dim)] border-[color:var(--donor-magenta-dim)] hover:border-[color:var(--donor-magenta)] hover:text-[color:var(--donor-magenta)]'
              }`}
              style={{ clipPath: 'polygon(4px 0, 100% 0, calc(100% - 4px) 100%, 0 100%)' }}
            >
              {active ? '▶ ' : ''}
              {opt.label}
            </button>
          )
        })}

        <span className="ml-auto d-mono text-[11px] text-[color:var(--donor-cyan)]">
          MATCH:{matchedCount.toString().padStart(3, '0')}/{totalCount.toString().padStart(3, '0')}
        </span>
      </div>
    </div>
  )
}
