import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

import type {
  AppInfo,
  AppsListResponse,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigMigrationItem,
  MarketplaceAddParams,
  MarketplaceAddResponse,
  MarketplaceRemoveResponse,
  MarketplaceUpgradeResponse,
  PluginInstallParams,
  PluginInstallResponse,
  PluginListResponse,
  PluginSummary,
} from '../../../../types/codexPlugins'

// Codex native plugin / app / external-agent-import surface (app-server v2,
// ≥0.140). Reads enumerate what the bundled Codex exposes (local marketplaces
// always; remote catalogs + apps only when feature-flagged + ChatGPT-authed);
// writes (install/uninstall plugins, add/remove/upgrade marketplaces, apply an
// external-agent import) go through the same `agent:*` IPC envelope and refresh
// the list on success. Destructive writes are gated behind an inline confirm.
type ConnectorsApi = {
  agent?: {
    listPlugins?: () => Promise<{ ok: boolean; error?: string; data?: PluginListResponse }>
    listApps?: () => Promise<{ ok: boolean; error?: string; data?: AppsListResponse }>
    detectExternalAgentConfig?: () => Promise<{ ok: boolean; error?: string; data?: ExternalAgentConfigDetectResponse }>
    installPlugin?: (params: PluginInstallParams) => Promise<{ ok: boolean; error?: string; data?: PluginInstallResponse }>
    uninstallPlugin?: (pluginId: string) => Promise<{ ok: boolean; error?: string }>
    addMarketplace?: (params: MarketplaceAddParams) => Promise<{ ok: boolean; error?: string; data?: MarketplaceAddResponse }>
    removeMarketplace?: (marketplaceName: string) => Promise<{ ok: boolean; error?: string; data?: MarketplaceRemoveResponse }>
    upgradeMarketplaces?: (marketplaceName?: string) => Promise<{ ok: boolean; error?: string; data?: MarketplaceUpgradeResponse }>
    importExternalAgentConfig?: (
      migrationItems: ExternalAgentConfigMigrationItem[],
    ) => Promise<{ ok: boolean; error?: string; data?: { importId: string } }>
  }
}

type SubTab = 'plugins' | 'apps' | 'import'

const SUB_TABS: Array<{ key: SubTab; label: string }> = [
  { key: 'plugins', label: 'Plugins' },
  { key: 'apps', label: 'Apps' },
  { key: 'import', label: 'Import' },
]

export function ConnectorsSection(): React.JSX.Element {
  const [tab, setTab] = useState<SubTab>('plugins')

  return (
    <section className="space-y-4">
      <div>
        <h2 className="text-lg font-semibold text-cyan-100">Connectors</h2>
        <p className="mt-1 text-sm text-zinc-500">
          Codex native plugins, apps, and importable agent configs (app-server v2).
        </p>
      </div>

      <div className="flex gap-1 rounded-lg border border-zinc-800/80 bg-zinc-950/60 p-1">
        {SUB_TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={
              'flex-1 cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors duration-200 ' +
              (tab === t.key
                ? 'bg-cyan-500/15 text-cyan-100'
                : 'text-zinc-400 hover:bg-zinc-800/60 hover:text-zinc-100')
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'plugins' ? <PluginsPanel /> : null}
      {tab === 'apps' ? <AppsPanel /> : null}
      {tab === 'import' ? <ImportPanel /> : null}
    </section>
  )
}

// ─── Plugins ──────────────────────────────────────────────────────────────────

interface FlatPlugin extends PluginSummary {
  marketplace: string
  /** Owning marketplace's local path (null ⇒ remote → install by name). */
  marketplacePath: string | null
}

interface MarketplaceRef {
  name: string
  path: string | null
}

function PluginsPanel(): React.JSX.Element {
  const [plugins, setPlugins] = useState<FlatPlugin[] | null>(null)
  const [marketplaces, setMarketplaces] = useState<MarketplaceRef[]>([])
  const [featured, setFeatured] = useState<string[]>([])
  const [loadErrors, setLoadErrors] = useState<string[]>([])
  const fetcher = useCallback(async () => {
    const api = getApi()
    if (!api?.listPlugins) throw new Error('Plugin API is unavailable.')
    const res = await api.listPlugins()
    if (!res?.ok || !res.data) throw new Error(res?.error ?? 'plugin/list failed.')
    const flat = res.data.marketplaces.flatMap((m) =>
      m.plugins.map((p) => ({ ...p, marketplace: m.name, marketplacePath: m.path })),
    )
    setPlugins(flat)
    setMarketplaces(res.data.marketplaces.map((m) => ({ name: m.name, path: m.path })))
    setFeatured(res.data.featuredPluginIds ?? [])
    setLoadErrors((res.data.marketplaceLoadErrors ?? []).map((e) => e.message))
  }, [])

  const { error, running, reload } = useAsyncLoad(fetcher)
  // Write outcomes (install auth notes, marketplace results, failures) live at
  // the panel level so they survive the post-write reload that re-mounts cards.
  const [notice, setNotice] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const runWrite = useCallback(
    async (label: string, fn: () => Promise<{ ok: boolean; error?: string }>, onOk?: () => void) => {
      setBusy(true)
      setActionError(undefined)
      try {
        const res = await fn()
        if (!res?.ok) {
          setActionError(res?.error ?? `${label} failed.`)
          return false
        }
        onOk?.()
        reload()
        return true
      } catch (reason) {
        setActionError(reason instanceof Error ? reason.message : String(reason))
        return false
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  return (
    <PanelShell
      title="Plugins"
      hint="Plugins discovered across local marketplaces (remote catalogs require ChatGPT auth)."
      error={error}
      running={running}
      empty={plugins !== null && plugins.length === 0}
      emptyText="No plugins found in any marketplace."
      onReload={reload}
    >
      <MarketplaceBar
        marketplaces={marketplaces}
        busy={busy || running}
        onAdd={(source) => void runWrite('Add marketplace', () => requireApi('addMarketplace')({ source }), () => setNotice(`Added marketplace from ${source}.`))}
        onUpgradeAll={() => void runWrite('Upgrade marketplaces', () => requireApi('upgradeMarketplaces')(undefined), () => setNotice('Upgraded all marketplaces.'))}
        onUpgradeOne={(name) => void runWrite('Upgrade marketplace', () => requireApi('upgradeMarketplaces')(name), () => setNotice(`Upgraded ${name}.`))}
        onRemove={(name) => void runWrite('Remove marketplace', () => requireApi('removeMarketplace')(name), () => setNotice(`Removed marketplace ${name}.`))}
      />

      {notice ? (
        <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-100">
          {actionError}
        </div>
      ) : null}

      {loadErrors.length > 0 ? (
        <div className="rounded-lg border border-amber-400/30 bg-amber-500/10 p-3 text-xs text-amber-100">
          {loadErrors.length} marketplace load error(s): {loadErrors.join('; ')}
        </div>
      ) : null}
      {plugins?.map((p) => (
        <PluginCard
          key={`${p.marketplace}:${p.id}`}
          plugin={p}
          featured={featured.includes(p.id)}
          busy={busy}
          onInstall={() => void installWithAuthNote(p, setNotice, setActionError, reload, setBusy)}
          onUninstall={() => void runWrite('Uninstall', () => requireApi('uninstallPlugin')(p.id), () => setNotice(`Uninstalled ${p.name}.`))}
        />
      ))}
    </PanelShell>
  )
}

/** Install a plugin and, if the backend reports apps requiring ChatGPT auth,
 *  surface them as a panel notice. Kept as a free function (not a hook) so the
 *  single install response drives both the reload and the auth note. */
async function installWithAuthNote(
  p: FlatPlugin,
  setNotice: (s: string) => void,
  setActionError: (s?: string) => void,
  reload: () => void,
  setBusy: (b: boolean) => void,
): Promise<void> {
  const api = getApi()
  if (!api?.installPlugin) {
    setActionError('Install API is unavailable.')
    return
  }
  const params: PluginInstallParams = p.marketplacePath
    ? { marketplacePath: p.marketplacePath, pluginName: p.name }
    : { remoteMarketplaceName: p.marketplace, pluginName: p.name }
  setBusy(true)
  setActionError(undefined)
  try {
    const res = await api.installPlugin(params)
    if (!res?.ok) {
      setActionError(res?.error ?? 'Install failed.')
      return
    }
    const apps = res.data?.appsNeedingAuth ?? []
    if (apps.length > 0) {
      setNotice(`Installed ${p.name}. ${apps.length} app(s) need ChatGPT sign-in: ${apps.map((a) => a.name).join(', ')}.`)
    } else {
      setNotice(`Installed ${p.name}.`)
    }
    reload()
  } catch (reason) {
    setActionError(reason instanceof Error ? reason.message : String(reason))
  } finally {
    setBusy(false)
  }
}

function MarketplaceBar({
  marketplaces,
  busy,
  onAdd,
  onUpgradeAll,
  onUpgradeOne,
  onRemove,
}: {
  marketplaces: MarketplaceRef[]
  busy: boolean
  onAdd: (source: string) => void
  onUpgradeAll: () => void
  onUpgradeOne: (name: string) => void
  onRemove: (name: string) => void
}): React.JSX.Element {
  const [source, setSource] = useState('')
  return (
    <div className="space-y-2 rounded-xl border border-zinc-800/80 bg-zinc-950/50 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <input
          type="text"
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Marketplace source (git URL or path)"
          className="min-w-0 flex-1 rounded-md border border-zinc-700/70 bg-zinc-900/60 px-3 py-1.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-cyan-400/40 focus:outline-none"
        />
        <button
          type="button"
          disabled={busy || source.trim().length === 0}
          onClick={() => {
            onAdd(source.trim())
            setSource('')
          }}
          className="cursor-pointer rounded-md border border-cyan-400/30 px-3 py-1.5 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={onUpgradeAll}
          className="cursor-pointer rounded-md border border-zinc-700/70 px-3 py-1.5 text-sm text-zinc-200 transition-colors duration-200 hover:bg-zinc-800/60 disabled:cursor-not-allowed disabled:opacity-50"
        >
          Upgrade all
        </button>
      </div>
      {marketplaces.length > 0 ? (
        <ul className="space-y-1">
          {marketplaces.map((m) => (
            <li key={m.name} className="flex items-center justify-between gap-2 text-xs text-zinc-400">
              <span className="truncate">
                {m.name}
                {m.path ? '' : ' · remote'}
              </span>
              <span className="flex shrink-0 items-center gap-1">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => onUpgradeOne(m.name)}
                  className="cursor-pointer rounded border border-zinc-700/70 px-2 py-0.5 text-[11px] text-zinc-300 hover:bg-zinc-800/60 disabled:opacity-50"
                >
                  Upgrade
                </button>
                <ConfirmButton
                  label="Remove"
                  confirmLabel="Confirm remove"
                  tone="rose"
                  disabled={busy}
                  onConfirm={() => onRemove(m.name)}
                />
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  )
}

function PluginCard({
  plugin,
  featured,
  busy,
  onInstall,
  onUninstall,
}: {
  plugin: FlatPlugin
  featured: boolean
  busy: boolean
  onInstall: () => void
  onUninstall: () => void
}): React.JSX.Element {
  const desc = plugin.interface?.shortDescription ?? plugin.interface?.longDescription ?? null
  return (
    <article className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">
              {plugin.interface?.displayName || plugin.name}
            </span>
            {featured ? (
              <span className="rounded-full border border-cyan-400/30 bg-cyan-500/10 px-2 py-0.5 text-[10px] uppercase tracking-wide text-cyan-100">
                Featured
              </span>
            ) : null}
            {plugin.installed ? (
              <Badge tone="emerald">{plugin.enabled ? 'Installed' : 'Installed · disabled'}</Badge>
            ) : (
              <Badge tone="zinc">Available</Badge>
            )}
            {plugin.availability === 'DISABLED_BY_ADMIN' ? <Badge tone="rose">Admin-disabled</Badge> : null}
          </div>
          <p className="mt-1 text-xs uppercase tracking-[0.14em] text-zinc-600">
            {plugin.marketplace} · {plugin.source.type}
            {plugin.localVersion ? ` · v${plugin.localVersion}` : ''}
          </p>
          {desc ? <p className="mt-2 text-sm text-zinc-400">{desc}</p> : null}
          {plugin.keywords.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {plugin.keywords.slice(0, 8).map((k) => (
                <span key={k} className="rounded border border-zinc-700/70 px-1.5 py-0.5 text-[10px] text-zinc-500">
                  {k}
                </span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="shrink-0">
          {plugin.installed ? (
            <ConfirmButton
              label="Uninstall"
              confirmLabel="Confirm uninstall"
              tone="rose"
              disabled={busy || plugin.availability === 'DISABLED_BY_ADMIN'}
              onConfirm={onUninstall}
            />
          ) : (
            <button
              type="button"
              disabled={busy || plugin.availability === 'DISABLED_BY_ADMIN'}
              onClick={onInstall}
              className="cursor-pointer rounded-md border border-cyan-400/30 px-3 py-1.5 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              Install
            </button>
          )}
        </div>
      </div>
    </article>
  )
}

// ─── Apps ─────────────────────────────────────────────────────────────────────

// The apps RPC wire method is `app/list` (singular). A Codex build that predates
// it rejects the call with a JSON-RPC "unknown variant" error (the method isn't
// in its `client_request_definitions!`). On such builds apps are surfaced as
// plugins from the curated marketplace via `plugin/list`, so degrade to an
// explanatory note instead of dumping the raw variant list.
function isAppsUnsupported(message: string | undefined): boolean {
  if (!message) return false
  return /unknown variant|apps\/list|method not found|unsupported|not implemented/i.test(message)
}

function AppsPanel(): React.JSX.Element {
  const [apps, setApps] = useState<AppInfo[] | null>(null)
  const [unsupported, setUnsupported] = useState(false)
  const fetcher = useCallback(async () => {
    setUnsupported(false)
    const api = getApi()
    if (!api?.listApps) {
      setUnsupported(true)
      return
    }
    const res = await api.listApps()
    if (!res?.ok || !res.data) {
      if (isAppsUnsupported(res?.error)) {
        setUnsupported(true)
        return
      }
      throw new Error(res?.error ?? 'app/list failed.')
    }
    setApps(res.data.data ?? [])
  }, [])

  const { error, running, reload } = useAsyncLoad(fetcher)

  if (unsupported) {
    return (
      <PanelShell
        title="Apps"
        hint="此 Codex 版本不支持 apps 接口。"
        running={running}
        empty={false}
        emptyText=""
        onReload={reload}
      >
        <article className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4 text-sm text-zinc-400">
          当前 Codex 后端不支持 <code className="text-zinc-300">app/list</code> 方法(版本过旧)。apps
          / connectors 也会作为插件由策展市场提供,请到 <span className="text-cyberpunk-yellow">Plugins</span>{' '}
          标签页查看与安装(例如 Linear、Gmail、Google Calendar)。
        </article>
      </PanelShell>
    )
  }

  return (
    <PanelShell
      title="Apps"
      hint="Experimental — requires ChatGPT sign-in and the apps feature flag on the Codex backend."
      error={error}
      running={running}
      empty={apps !== null && apps.length === 0}
      emptyText="No apps available (not signed in to ChatGPT, or the feature is disabled)."
      onReload={reload}
    >
      {apps?.map((app) => (
        <article key={app.id} className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-zinc-100">{app.name}</span>
            {typeof app.category === 'string' ? <Badge tone="zinc">{app.category}</Badge> : null}
          </div>
          {typeof app.description === 'string' ? (
            <p className="mt-1 text-sm text-zinc-400">{app.description}</p>
          ) : null}
          <p className="mt-1 text-[10px] uppercase tracking-[0.14em] text-zinc-600">{app.id}</p>
        </article>
      ))}
    </PanelShell>
  )
}

// ─── Import (external agent config) ───────────────────────────────────────────

function ImportPanel(): React.JSX.Element {
  const [items, setItems] = useState<ExternalAgentConfigMigrationItem[] | null>(null)
  const fetcher = useCallback(async () => {
    const api = getApi()
    if (!api?.detectExternalAgentConfig) throw new Error('Import API is unavailable.')
    const res = await api.detectExternalAgentConfig()
    if (!res?.ok || !res.data) throw new Error(res?.error ?? 'externalAgentConfig/detect failed.')
    setItems(res.data.items ?? [])
  }, [])

  const { error, running, reload } = useAsyncLoad(fetcher)
  const [notice, setNotice] = useState<string>()
  const [actionError, setActionError] = useState<string>()
  const [busy, setBusy] = useState(false)

  const applyOne = useCallback(
    async (item: ExternalAgentConfigMigrationItem) => {
      const api = getApi()
      if (!api?.importExternalAgentConfig) {
        setActionError('Import API is unavailable.')
        return
      }
      setBusy(true)
      setActionError(undefined)
      setNotice(undefined)
      try {
        const res = await api.importExternalAgentConfig([item])
        if (!res?.ok) {
          setActionError(res?.error ?? 'Import failed.')
          return
        }
        setNotice(`Import started${res.data?.importId ? ` (${res.data.importId})` : ''}.`)
        reload()
      } catch (reason) {
        setActionError(reason instanceof Error ? reason.message : String(reason))
      } finally {
        setBusy(false)
      }
    },
    [reload],
  )

  return (
    <PanelShell
      title="Import external agent config"
      hint="Detects importable configs from other agents (Claude Code, etc.). Apply to migrate one into Codex."
      error={error}
      running={running}
      empty={items !== null && items.length === 0}
      emptyText="No importable external agent configs detected."
      onReload={reload}
    >
      {notice ? (
        <div className="rounded-lg border border-emerald-400/30 bg-emerald-500/10 p-3 text-xs text-emerald-100">
          {notice}
        </div>
      ) : null}
      {actionError ? (
        <div className="rounded-lg border border-rose-500/30 bg-rose-500/10 p-3 text-xs text-rose-100">
          {actionError}
        </div>
      ) : null}
      {items?.map((item, i) => (
        <article key={i} className="space-y-2 rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4">
          <pre className="overflow-x-auto whitespace-pre-wrap break-all text-xs text-zinc-400">
            {safeStringify(item)}
          </pre>
          <div className="flex justify-end">
            <ConfirmButton
              label="Apply"
              confirmLabel="Confirm import"
              tone="cyan"
              disabled={busy}
              onConfirm={() => void applyOne(item)}
            />
          </div>
        </article>
      ))}
    </PanelShell>
  )
}

// ─── Shared shell + helpers ───────────────────────────────────────────────────

function PanelShell({
  title,
  hint,
  error,
  running,
  empty,
  emptyText,
  onReload,
  children,
}: {
  title: string
  hint: string
  error?: string
  running: boolean
  empty: boolean
  emptyText: string
  onReload: () => void
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <p className="max-w-xl text-sm text-zinc-500">{hint}</p>
        <button
          type="button"
          onClick={onReload}
          disabled={running}
          className="cursor-pointer rounded-md border border-cyan-400/30 px-3 py-1.5 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {running ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {error ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      {running && !error ? (
        <div className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
          Loading {title.toLowerCase()}…
        </div>
      ) : null}

      {!running && !error && empty ? (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4 text-sm text-zinc-500">
          {emptyText}
        </div>
      ) : null}

      {children}
    </div>
  )
}

/** Resolve a write method off the agent API or throw a uniform "unavailable"
 *  error that the caller's try/catch turns into an inline action error. */
function requireApi<K extends keyof NonNullable<ConnectorsApi['agent']>>(
  name: K,
): NonNullable<NonNullable<ConnectorsApi['agent']>[K]> {
  const fn = getApi()?.[name]
  if (!fn) throw new Error(`${String(name)} API is unavailable.`)
  return fn as NonNullable<NonNullable<ConnectorsApi['agent']>[K]>
}

/** Two-step inline confirm: first click arms (label → confirmLabel + Cancel),
 *  second click fires `onConfirm`. Avoids window.confirm (blocked under jsdom /
 *  sandboxed renderer) and keeps the destructive gate testable + in-flow. */
function ConfirmButton({
  label,
  confirmLabel,
  tone,
  disabled,
  onConfirm,
}: {
  label: string
  confirmLabel: string
  tone: 'rose' | 'cyan'
  disabled?: boolean
  onConfirm: () => void
}): React.JSX.Element {
  const [armed, setArmed] = useState(false)
  const accent =
    tone === 'rose'
      ? 'border-rose-500/40 text-rose-100 hover:bg-rose-500/10'
      : 'border-cyan-400/30 text-cyan-100 hover:bg-cyan-500/10'
  if (armed) {
    return (
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          disabled={disabled}
          onClick={() => {
            setArmed(false)
            onConfirm()
          }}
          className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${accent}`}
        >
          {confirmLabel}
        </button>
        <button
          type="button"
          onClick={() => setArmed(false)}
          className="cursor-pointer rounded-md border border-zinc-700/70 px-3 py-1.5 text-sm text-zinc-300 transition-colors duration-200 hover:bg-zinc-800/60"
        >
          Cancel
        </button>
      </span>
    )
  }
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => setArmed(true)}
      className={`cursor-pointer rounded-md border px-3 py-1.5 text-sm transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-50 ${accent}`}
    >
      {label}
    </button>
  )
}

function Badge({ tone, children }: { tone: 'emerald' | 'zinc' | 'rose'; children: React.ReactNode }): React.JSX.Element {
  const cls =
    tone === 'emerald'
      ? 'border-emerald-400/30 bg-emerald-500/10 text-emerald-100'
      : tone === 'rose'
        ? 'border-rose-500/30 bg-rose-500/10 text-rose-100'
        : 'border-zinc-700 bg-zinc-800/60 text-zinc-300'
  return <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${cls}`}>{children}</span>
}

/** Runs `fetcher` on mount; exposes `{ error, running, reload }`. Mirrors the
 *  mount-and-refresh pattern used by DoctorSection, with a mounted guard so a
 *  late resolve after unmount/sub-tab switch never sets state on a dead node. */
function useAsyncLoad(fetcher: () => Promise<void>): { error?: string; running: boolean; reload: () => void } {
  const [error, setError] = useState<string>()
  const [running, setRunning] = useState(false)
  const mountedRef = useRef(false)

  const run = useCallback(async () => {
    setRunning(true)
    setError(undefined)
    try {
      await fetcher()
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }, [fetcher])

  useEffect(() => {
    mountedRef.current = true
    void run()
    return () => {
      mountedRef.current = false
    }
  }, [run])

  return { error, running, reload: () => void run() }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function getApi() {
  return (window as Window & { electronAPI?: ConnectorsApi }).electronAPI?.agent
}
