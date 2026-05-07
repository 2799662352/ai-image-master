import { useEffect, useMemo, useRef, useState } from 'react'
import { AGENT_MODELS, findModel, type ModelOption, type ModelTier } from './models'
import { useAgentChatStore } from './store'

const TIER_ORDER: ModelTier[] = ['Fast', 'Medium', 'High', 'Extra High']

const TIER_BADGE: Record<ModelTier, string> = {
  Fast: 'text-emerald-300/90 bg-emerald-500/10 border-emerald-400/30',
  Medium: 'text-cyan-300/90 bg-cyan-500/10 border-cyan-400/30',
  High: 'text-amber-300/90 bg-amber-500/10 border-amber-400/30',
  'Extra High': 'text-fuchsia-300/90 bg-fuchsia-500/10 border-fuchsia-400/30',
}

interface ModelPickerProps {
  disabled?: boolean
}

export function ModelPicker({ disabled }: ModelPickerProps) {
  const selectedModelId = useAgentChatStore((state) => state.selectedModelId)
  const setSelectedModel = useAgentChatStore((state) => state.setSelectedModel)

  const [isOpen, setIsOpen] = useState(false)
  const [query, setQuery] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  const selected = findModel(selectedModelId) ?? AGENT_MODELS[0]

  // Filter + group
  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = q
      ? AGENT_MODELS.filter(
          (m) =>
            m.label.toLowerCase().includes(q) ||
            m.id.toLowerCase().includes(q) ||
            m.description.toLowerCase().includes(q),
        )
      : [...AGENT_MODELS]

    const buckets = new Map<ModelTier, ModelOption[]>()
    for (const tier of TIER_ORDER) buckets.set(tier, [])
    for (const m of filtered) buckets.get(m.tier)?.push(m)
    return TIER_ORDER
      .map((tier) => ({ tier, items: buckets.get(tier) ?? [] }))
      .filter((g) => g.items.length > 0)
  }, [query])

  // Close on outside click + Escape
  useEffect(() => {
    if (!isOpen) return undefined
    function onDown(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) {
        setIsOpen(false)
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setIsOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    // Auto-focus search when opening
    setTimeout(() => searchRef.current?.focus(), 0)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [isOpen])

  function handlePick(id: string) {
    setSelectedModel(id)
    setIsOpen(false)
    setQuery('')
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        disabled={disabled}
        onClick={() => setIsOpen((v) => !v)}
        className="flex items-center gap-1.5 rounded-md border border-zinc-700/80 bg-zinc-900/70 px-2 py-1 text-[11px] text-zinc-200 transition hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        title={`${selected.label} · ${selected.tier}`}
      >
        <span className="font-medium">{selected.label}</span>
        <span
          className={`hidden rounded border px-1 text-[9px] uppercase tracking-wider sm:inline ${TIER_BADGE[selected.tier]}`}
        >
          {selected.tier}
        </span>
        <svg
          width="10"
          height="10"
          viewBox="0 0 12 12"
          aria-hidden
          className={`opacity-70 transition ${isOpen ? 'rotate-180' : ''}`}
        >
          <path d="M2 4l4 4 4-4" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {isOpen ? (
        <div
          role="listbox"
          className="absolute bottom-full left-0 z-[40001] mb-2 w-[300px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 shadow-[0_24px_60px_rgba(0,0,0,0.6)] backdrop-blur"
        >
          <div className="border-b border-zinc-800/80 p-2">
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search models"
              className="w-full rounded border border-zinc-800 bg-black/40 px-2 py-1 text-[12px] text-zinc-100 outline-none placeholder:text-zinc-500 focus:border-cyan-400/40"
            />
          </div>

          <div className="max-h-[320px] overflow-y-auto py-1">
            {grouped.length === 0 ? (
              <div className="px-3 py-4 text-center text-[11px] text-zinc-500">No models match.</div>
            ) : (
              grouped.map((group) => (
                <div key={group.tier} className="mb-1">
                  <div className="px-3 py-1 text-[9px] uppercase tracking-[0.18em] text-zinc-500">
                    {group.tier}
                  </div>
                  {group.items.map((m) => {
                    const isActive = m.id === selectedModelId
                    return (
                      <button
                        key={m.id}
                        type="button"
                        role="option"
                        aria-selected={isActive}
                        onClick={() => handlePick(m.id)}
                        className={`flex w-full items-center justify-between gap-2 px-3 py-1.5 text-left text-[12px] transition ${
                          isActive
                            ? 'bg-cyan-500/10 text-cyan-100'
                            : 'text-zinc-200 hover:bg-zinc-800/60 hover:text-cyan-100'
                        }`}
                        title={m.description}
                      >
                        <span className="flex min-w-0 flex-col">
                          <span className="truncate font-medium">{m.label}</span>
                          <span className="truncate text-[10px] text-zinc-500">{m.id}</span>
                        </span>
                        <span className="flex items-center gap-1.5">
                          <span
                            className={`rounded border px-1 py-[1px] text-[9px] uppercase tracking-wider ${TIER_BADGE[m.tier]}`}
                          >
                            {m.tier}
                          </span>
                          {isActive ? (
                            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden>
                              <path
                                d="M2 6l3 3 5-6"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                fill="none"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </svg>
                          ) : null}
                        </span>
                      </button>
                    )
                  })}
                </div>
              ))
            )}
          </div>

          <div className="border-t border-zinc-800/80 px-3 py-1.5 text-[10px] text-zinc-500">
            via API易 · base_url <code className="text-zinc-400">https://api.apiyi.com/v1</code>
          </div>
        </div>
      ) : null}
    </div>
  )
}
