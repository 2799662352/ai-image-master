import { useCallback, useEffect, useMemo, useState } from 'react'

import { useToastStore } from '../stores'
import type {
  Catalog,
  CatalogEntry,
  InstalledRecord,
} from '../../../types/marketplace'

/**
 * Skill Marketplace — Cursor-marketplace-style layout.
 *
 * Left sidebar: category filters (Featured / 分类 / All / Installed / Updates).
 * Right pane: search box + responsive grid of skill cards.
 * Each card: emoji icon + name + one-line description + Get/Update/Installed pill.
 *
 * Categories are inferred from the skill name prefix — we don't ship taxonomy
 * metadata in the catalog (yet), so the prefix convention
 *   director-*       → Director (12)
 *   storyboard-*     → Storyboard (7)
 *   codex-research-* → Methodology (1)
 * is the source of truth. New prefixes show up under "Other" without code
 * changes; if a category grows large enough to warrant its own bucket, add a
 * row to `CATEGORIES` below.
 */

type Section = 'featured' | 'director' | 'storyboard' | 'research' | 'other' | 'installed' | 'updates'

interface CategoryDef {
  key: Section
  label: string
  icon: string
  blurb?: string
  /** Return true if this catalog entry belongs to the section. Featured /
   *  Installed / Updates are handled separately and don't use `match`. */
  match?: (entry: CatalogEntry) => boolean
}

const CATEGORIES: CategoryDef[] = [
  { key: 'featured', label: 'Featured', icon: '✨', blurb: '推荐技能 — 适合大多数用户' },
  { key: 'director', label: 'Director', icon: '🎬', blurb: '导演模式 — 镜头、构图、连续性', match: (e) => e.name.startsWith('director-') },
  { key: 'storyboard', label: 'Storyboard', icon: '🎞️', blurb: '分镜模式 — 物理、对白、风格', match: (e) => e.name.startsWith('storyboard-') },
  { key: 'research', label: 'Methodology', icon: '🔬', blurb: '研究 / 方法论 — 学术化提示词工程', match: (e) => e.name.startsWith('codex-research') },
  { key: 'other', label: 'Other', icon: '📦', blurb: '其他 / 未分类', match: (e) => !e.name.startsWith('director-') && !e.name.startsWith('storyboard-') && !e.name.startsWith('codex-research') },
  { key: 'installed', label: 'Installed', icon: '✓', blurb: '本机已安装的技能' },
  { key: 'updates', label: 'Updates', icon: '⬆', blurb: '本地版本与目录版本不一致' },
]

const FEATURED_NAMES = new Set<string>([
  'codex-research-grounded-prompting',
  'director-prompt-engineering',
  'director-structured-captioning',
  'storyboard-structure',
])

function iconFor(entry: CatalogEntry): string {
  if (entry.name.startsWith('director-')) return '🎬'
  if (entry.name.startsWith('storyboard-')) return '🎞️'
  if (entry.name.startsWith('codex-research')) return '🔬'
  return '📦'
}

export default function MarketplacePage() {
  const addToast = useToastStore((s) => s.addToast)
  const api = (window as { electronAPI?: any }).electronAPI

  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [installed, setInstalled] = useState<InstalledRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [section, setSection] = useState<Section>('featured')
  const [search, setSearch] = useState('')
  const [error, setError] = useState<string | null>(null)

  const refreshCatalog = useCallback(
    async (force: boolean) => {
      const res = await api?.marketplace?.fetchCatalog?.(force)
      if (!res?.ok) {
        setError(res?.error ?? '无法连接到技能市场服务器')
        return null
      }
      setError(null)
      setCatalog(res.catalog)
      return res.catalog
    },
    [api],
  )

  const refreshInstalled = useCallback(async () => {
    const res = await api?.marketplace?.listInstalled?.()
    if (!res?.ok) {
      setError(res?.error ?? '读取已安装清单失败')
      return
    }
    setInstalled(res.installed)
  }, [api])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    Promise.all([refreshCatalog(false), refreshInstalled()])
      .catch((err: unknown) => {
        if (!cancelled) setError(String((err as Error)?.message ?? err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [refreshCatalog, refreshInstalled])

  const installedByName = useMemo(() => {
    const m = new Map<string, InstalledRecord>()
    for (const rec of installed) m.set(rec.name, rec)
    return m
  }, [installed])

  // Section counts + filtered view all derived from the same catalog +
  // installed snapshot; recomputed only when those change.
  const { counts, visible } = useMemo(() => {
    const entries = catalog?.skills ?? []
    const byCategory = new Map<Section, CatalogEntry[]>()
    for (const c of CATEGORIES) {
      if (c.match) byCategory.set(c.key, entries.filter(c.match))
    }

    const featured = entries.filter((e) => FEATURED_NAMES.has(e.name))
    byCategory.set('featured', featured)

    const installedRows: CatalogEntry[] = entries.filter((e) => installedByName.has(e.name))
    byCategory.set('installed', installedRows)

    const updateRows = entries.filter((e) => {
      const rec = installedByName.get(e.name)
      return rec ? rec.version !== e.version : false
    })
    byCategory.set('updates', updateRows)

    const c: Record<Section, number> = {
      featured: byCategory.get('featured')?.length ?? 0,
      director: byCategory.get('director')?.length ?? 0,
      storyboard: byCategory.get('storyboard')?.length ?? 0,
      research: byCategory.get('research')?.length ?? 0,
      other: byCategory.get('other')?.length ?? 0,
      installed: installedRows.length,
      updates: updateRows.length,
    }

    const active = byCategory.get(section) ?? []
    const q = search.trim().toLowerCase()
    const filtered =
      q === ''
        ? active
        : active.filter(
            (e) =>
              e.name.toLowerCase().includes(q) ||
              (e.description ?? '').toLowerCase().includes(q),
          )

    return { counts: c, visible: filtered }
  }, [catalog, installedByName, section, search])

  const handleInstall = async (name: string) => {
    setBusyName(name)
    try {
      const res = await api?.marketplace?.install?.(name)
      if (res?.ok) {
        addToast({ message: `${name} 已安装`, type: 'success' })
        await refreshInstalled()
      } else {
        addToast({ message: res?.error ?? '安装失败', type: 'error' })
      }
    } finally {
      setBusyName(null)
    }
  }

  const handleUninstall = async (name: string) => {
    if (!window.confirm(`卸载 ${name}？此操作会删除 ~/.agents/skills/${name}/ 目录。`)) return
    setBusyName(name)
    try {
      const res = await api?.marketplace?.uninstall?.(name)
      if (res?.ok) {
        addToast({ message: `${name} 已卸载`, type: 'success' })
        await refreshInstalled()
      } else {
        addToast({ message: res?.error ?? '卸载失败', type: 'error' })
      }
    } finally {
      setBusyName(null)
    }
  }

  const handleRefresh = async () => {
    setLoading(true)
    try {
      await refreshCatalog(true)
      await refreshInstalled()
      addToast({ message: '市场目录已刷新', type: 'success' })
    } finally {
      setLoading(false)
    }
  }

  const activeCategory = CATEGORIES.find((c) => c.key === section) ?? CATEGORIES[0]

  return (
    <div className="flex h-full bg-cyberpunk-black text-white">
      {/* Sidebar */}
      <aside className="w-56 shrink-0 border-r border-zinc-800 bg-zinc-950/50 overflow-y-auto">
        <div className="px-4 py-5">
          <h1 className="text-lg font-bold uppercase tracking-wide">
            <span className="text-cyberpunk-yellow">Skill</span>
            <br />
            <span className="text-white">Marketplace</span>
          </h1>
          <p className="mt-1 text-[11px] text-zinc-500 leading-relaxed">
            按需安装 Codex skill<br />
            内容托管在腾讯云
          </p>
        </div>
        <nav className="px-2 pb-4 space-y-0.5">
          {CATEGORIES.map((cat) => {
            const count = counts[cat.key]
            const isActive = section === cat.key
            return (
              <button
                key={cat.key}
                onClick={() => setSection(cat.key)}
                className={`w-full flex items-center gap-2 px-3 py-2 rounded text-sm transition-colors text-left ${
                  isActive
                    ? 'bg-cyberpunk-yellow/15 text-cyberpunk-yellow border-l-2 border-cyberpunk-yellow'
                    : 'text-zinc-400 hover:text-white hover:bg-white/5 border-l-2 border-transparent'
                }`}
              >
                <span className="w-5 text-center">{cat.icon}</span>
                <span className="flex-1 truncate">{cat.label}</span>
                <span className="text-[10px] text-zinc-500 font-mono">{count}</span>
              </button>
            )
          })}
        </nav>
        <div className="border-t border-zinc-800 px-2 py-3">
          <button
            onClick={handleRefresh}
            disabled={loading}
            className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm text-zinc-400 hover:text-white rounded hover:bg-white/5 disabled:opacity-50"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M12 7a5 5 0 1 1-1.5-3.5L12 5" />
              <path d="M12 2v3h-3" />
            </svg>
            {loading ? '加载中…' : '刷新目录'}
          </button>
        </div>
      </aside>

      {/* Main pane */}
      <div className="flex-1 overflow-y-auto">
        <div className="sticky top-0 z-10 bg-cyberpunk-black/95 backdrop-blur border-b border-zinc-800">
          <div className="px-6 py-4">
            <div className="flex items-baseline gap-3 mb-3">
              <span className="text-2xl">{activeCategory.icon}</span>
              <h2 className="text-xl font-semibold">{activeCategory.label}</h2>
              {activeCategory.blurb && (
                <span className="text-xs text-zinc-500">— {activeCategory.blurb}</span>
              )}
            </div>
            <div className="relative">
              <svg
                className="absolute left-3 top-1/2 -translate-y-1/2 text-zinc-500"
                width="14"
                height="14"
                viewBox="0 0 14 14"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
              >
                <circle cx="6" cy="6" r="4" />
                <path d="m9 9 3 3" />
              </svg>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="搜索 skill 名称或描述…"
                className="w-full pl-9 pr-3 py-2 bg-zinc-900/70 border border-zinc-800 rounded text-sm focus:outline-none focus:border-cyberpunk-yellow/50 placeholder:text-zinc-600"
              />
            </div>
          </div>
        </div>

        <div className="px-6 py-6">
          {error && (
            <div className="mb-4 px-3 py-2 border border-red-500/40 bg-red-500/5 text-sm text-red-300 rounded">
              {error}
            </div>
          )}

          {loading && !catalog && (
            <div className="text-center text-zinc-500 py-16">正在拉取技能目录…</div>
          )}

          {!loading && visible.length === 0 && (
            <div className="text-center text-zinc-500 py-16">
              {search ? `没有匹配 "${search}" 的 skill` : '此分类暂无技能'}
            </div>
          )}

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
            {visible.map((entry) => {
              const installedRec = installedByName.get(entry.name)
              const hasUpdate = installedRec && installedRec.version !== entry.version
              return (
                <SkillCard
                  key={entry.name}
                  entry={entry}
                  installed={installedRec ?? null}
                  hasUpdate={!!hasUpdate}
                  busy={busyName === entry.name}
                  onInstall={() => handleInstall(entry.name)}
                  onUninstall={() => handleUninstall(entry.name)}
                />
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}

interface SkillCardProps {
  entry: CatalogEntry
  installed: InstalledRecord | null
  hasUpdate: boolean
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
}

function SkillCard({ entry, installed, hasUpdate, busy, onInstall, onUninstall }: SkillCardProps) {
  const icon = iconFor(entry)

  return (
    <article className="flex items-start gap-3 p-4 rounded border border-zinc-800 bg-zinc-950/60 hover:bg-zinc-900/60 hover:border-zinc-700 transition-colors">
      <div className="w-10 h-10 shrink-0 rounded bg-zinc-900 border border-zinc-800 flex items-center justify-center text-xl">
        {icon}
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 mb-0.5">
          <h3 className="font-semibold text-white truncate">{entry.name}</h3>
          <span className="text-[10px] text-zinc-500 font-mono shrink-0">
            v{entry.version}
            {hasUpdate && installed && (
              <span className="text-cyberpunk-yellow"> ← v{installed.version}</span>
            )}
          </span>
        </div>
        <p className="text-xs text-zinc-400 line-clamp-2 leading-relaxed">{entry.description}</p>
        <div className="flex items-center gap-2 mt-2 text-[10px] text-zinc-600">
          <span>{(entry.size / 1024).toFixed(1)} KB</span>
          {installed?.source === 'adopted' && (
            <span className="px-1.5 py-0.5 border border-blue-500/40 text-blue-300 rounded">
              已认领
            </span>
          )}
        </div>
      </div>
      <div className="shrink-0">
        {!installed && (
          <button
            onClick={onInstall}
            disabled={busy}
            className="inline-flex items-center justify-center w-24 h-7 text-xs bg-cyberpunk-yellow text-cyberpunk-black font-semibold rounded hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '安装中…' : 'Get'}
          </button>
        )}
        {installed && !hasUpdate && (
          <button
            onClick={onUninstall}
            disabled={busy}
            className="group relative inline-flex items-center justify-center w-24 h-7 text-xs border border-green-500/40 text-green-300 rounded hover:border-red-400/60 hover:bg-red-500/10 hover:text-red-200 disabled:opacity-50 transition-colors overflow-hidden"
            title="点击卸载"
          >
            <span className="absolute inset-0 flex items-center justify-center transition-opacity duration-150 group-hover:opacity-0">
              ✓ Installed
            </span>
            <span className="absolute inset-0 flex items-center justify-center opacity-0 transition-opacity duration-150 group-hover:opacity-100">
              Uninstall
            </span>
          </button>
        )}
        {installed && hasUpdate && (
          <button
            onClick={onInstall}
            disabled={busy}
            className="inline-flex items-center justify-center w-24 h-7 text-xs bg-cyberpunk-yellow/90 text-cyberpunk-black font-semibold rounded hover:opacity-90 disabled:opacity-50"
          >
            {busy ? '更新中…' : 'Update'}
          </button>
        )}
      </div>
    </article>
  )
}
