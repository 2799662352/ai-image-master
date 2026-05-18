import { useCallback, useEffect, useMemo, useState } from 'react'

import { useToastStore } from '../stores'
import type {
  Catalog,
  CatalogEntry,
  InstalledRecord,
} from '../../../types/marketplace'

type ViewKey = 'available' | 'installed' | 'updates'

/**
 * Skill Marketplace (v4.3.5 MVP).
 *
 * Three views over the user's marketplace state:
 *   - Available: catalog entries not yet on this machine
 *   - Installed: skills the user has either installed via marketplace OR that
 *                were "adopted" from the v4.3.4 bundled-mirror leftovers
 *   - Updates:   installed skills whose catalog version differs from their
 *                local install version (semver-agnostic — any string diff)
 *
 * Everything renders from two pieces of state: `catalog` (fetched from
 * Tencent COS on mount) and `installed` (read from the local marketplace
 * ledger). The user actions Install / Update / Uninstall mutate the latter
 * and we just re-derive the views.
 */
export default function MarketplacePage() {
  const addToast = useToastStore((s) => s.addToast)
  const api = (window as { electronAPI?: any }).electronAPI

  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [installed, setInstalled] = useState<InstalledRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [view, setView] = useState<ViewKey>('available')
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

  const { availableEntries, installedEntries, updateEntries } = useMemo(() => {
    const entries = catalog?.skills ?? []
    const available: CatalogEntry[] = []
    const installedRows: Array<{ entry: CatalogEntry | null; record: InstalledRecord }> = []
    const updates: Array<{ entry: CatalogEntry; record: InstalledRecord }> = []
    const seen = new Set<string>()

    for (const e of entries) {
      const rec = installedByName.get(e.name)
      seen.add(e.name)
      if (!rec) {
        available.push(e)
      } else {
        installedRows.push({ entry: e, record: rec })
        if (rec.version !== e.version) updates.push({ entry: e, record: rec })
      }
    }
    // Adopted/Installed records whose catalog entry has gone missing — still
    // show them so the user can uninstall them.
    for (const rec of installed) {
      if (!seen.has(rec.name)) installedRows.push({ entry: null, record: rec })
    }
    return {
      availableEntries: available,
      installedEntries: installedRows,
      updateEntries: updates,
    }
  }, [catalog, installed, installedByName])

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

  return (
    <div className="h-full overflow-auto px-6 py-6 bg-cyberpunk-black text-white">
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold uppercase tracking-tight">
            <span className="text-cyberpunk-yellow">SKILL</span> MARKETPLACE
          </h1>
          <p className="text-xs text-zinc-500 mt-1">
            从腾讯云目录按需安装 Codex skill。安装后位于 <code>~/.agents/skills/</code>，可在 Agent Workspace 中使用。
          </p>
        </div>
        <button
          onClick={handleRefresh}
          disabled={loading}
          className="px-3 py-1.5 text-sm border border-cyberpunk-yellow/50 hover:bg-cyberpunk-yellow/10 disabled:opacity-50 rounded"
        >
          {loading ? '加载中…' : '刷新目录'}
        </button>
      </header>

      <nav className="flex gap-1 mb-4 border-b border-zinc-700">
        <TabButton active={view === 'available'} onClick={() => setView('available')}>
          可安装 ({availableEntries.length})
        </TabButton>
        <TabButton active={view === 'installed'} onClick={() => setView('installed')}>
          已安装 ({installedEntries.length})
        </TabButton>
        <TabButton active={view === 'updates'} onClick={() => setView('updates')}>
          有更新 ({updateEntries.length})
        </TabButton>
      </nav>

      {error && (
        <div className="mb-4 px-3 py-2 border border-red-500/40 bg-red-500/5 text-sm text-red-300">
          {error}
        </div>
      )}

      {loading && !catalog && (
        <div className="text-center text-zinc-500 py-12">正在拉取技能目录…</div>
      )}

      {view === 'available' && (
        <SkillList
          empty="所有可用 skill 都已安装。"
          rows={availableEntries.map((entry) => ({
            key: entry.name,
            title: entry.name,
            version: entry.version,
            description: entry.description,
            size: entry.size,
            actions: (
              <button
                onClick={() => handleInstall(entry.name)}
                disabled={busyName === entry.name}
                className="px-3 py-1 text-sm bg-cyberpunk-yellow text-cyberpunk-black font-semibold rounded hover:opacity-90 disabled:opacity-50"
              >
                {busyName === entry.name ? '安装中…' : '安装'}
              </button>
            ),
          }))}
        />
      )}

      {view === 'installed' && (
        <SkillList
          empty="还没有安装任何技能。"
          rows={installedEntries.map(({ entry, record }) => ({
            key: record.name,
            title: record.name,
            version: record.version,
            description: entry?.description ?? '（目录中已无此 skill，可能是手动添加或已下架）',
            badge:
              record.source === 'adopted'
                ? { label: '已认领', color: 'text-blue-300 border-blue-500/40' }
                : null,
            actions: (
              <button
                onClick={() => handleUninstall(record.name)}
                disabled={busyName === record.name}
                className="px-3 py-1 text-sm border border-zinc-600 hover:border-red-500/50 hover:text-red-300 rounded disabled:opacity-50"
              >
                {busyName === record.name ? '卸载中…' : '卸载'}
              </button>
            ),
          }))}
        />
      )}

      {view === 'updates' && (
        <SkillList
          empty="所有已安装 skill 均为最新版本。"
          rows={updateEntries.map(({ entry, record }) => ({
            key: record.name,
            title: record.name,
            version: `${record.version} → ${entry.version}`,
            description: entry.description,
            size: entry.size,
            actions: (
              <button
                onClick={() => handleInstall(record.name)}
                disabled={busyName === record.name}
                className="px-3 py-1 text-sm bg-cyberpunk-yellow text-cyberpunk-black font-semibold rounded hover:opacity-90 disabled:opacity-50"
              >
                {busyName === record.name ? '更新中…' : '升级'}
              </button>
            ),
          }))}
        />
      )}
    </div>
  )
}

interface TabButtonProps {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}
function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm border-b-2 transition-colors ${
        active
          ? 'border-cyberpunk-yellow text-cyberpunk-yellow font-semibold'
          : 'border-transparent text-zinc-400 hover:text-white'
      }`}
    >
      {children}
    </button>
  )
}

interface SkillRow {
  key: string
  title: string
  version: string
  description: string
  size?: number
  badge?: { label: string; color: string } | null
  actions: React.ReactNode
}

function SkillList({ rows, empty }: { rows: SkillRow[]; empty: string }) {
  if (rows.length === 0) {
    return <div className="text-center text-zinc-500 py-12">{empty}</div>
  }
  return (
    <ul className="divide-y divide-zinc-800 border border-zinc-800 rounded">
      {rows.map((r) => (
        <li
          key={r.key}
          className="px-4 py-3 flex items-start gap-4 hover:bg-white/5 transition-colors"
        >
          <div className="flex-1 min-w-0">
            <div className="flex items-baseline gap-2 mb-1">
              <span className="font-semibold text-white">{r.title}</span>
              <span className="text-xs text-zinc-500">v{r.version}</span>
              {typeof r.size === 'number' && (
                <span className="text-xs text-zinc-600">{(r.size / 1024).toFixed(1)} KB</span>
              )}
              {r.badge && (
                <span className={`text-xs border px-1.5 py-0.5 rounded ${r.badge.color}`}>
                  {r.badge.label}
                </span>
              )}
            </div>
            <p className="text-xs text-zinc-400 line-clamp-3 leading-relaxed">{r.description}</p>
          </div>
          <div className="shrink-0">{r.actions}</div>
        </li>
      ))}
    </ul>
  )
}
