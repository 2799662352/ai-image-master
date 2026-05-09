import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

import type { AgentApiResult, CodexMcpServerListItem } from '../../../../types/agent'
import { McpEditor } from './McpEditor'
import { useAgentWorkspaceStore } from './useAgentWorkspaceStore'

type McpApi = {
  agent?: {
    listMcp?: () => Promise<CodexMcpServerListItem[]>
    deleteMcp?: (id: string) => Promise<AgentApiResult>
    setMcpEnabled?: (id: string, enabled: boolean) => Promise<AgentApiResult>
    restartCodex?: () => Promise<AgentApiResult>
  }
}

type EditingState = 'new' | string | null

export function McpSection(): React.JSX.Element {
  const [items, setItems] = useState<CodexMcpServerListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingState>(null)
  const [mutationInFlight, setMutationInFlight] = useState(false)
  const mountedRef = useRef(false)
  const loadRequestIdRef = useRef(0)
  const mutationInFlightRef = useRef(false)
  const setConfigDirty = useAgentWorkspaceStore((state) => state.setConfigDirty)

  const loadItems = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    const canUpdate = () => mountedRef.current && requestId === loadRequestIdRef.current
    const api = getMcpApi()
    if (!api?.listMcp) {
      if (canUpdate()) {
        setError('Codex MCP API is unavailable.')
        setLoading(false)
      }
      return
    }

    try {
      const nextItems = await api.listMcp()
      if (canUpdate()) {
        setItems(nextItems)
        setError(undefined)
        setLoading(false)
      }
    } catch (reason) {
      if (canUpdate()) {
        setError(errorMessage(reason))
        setLoading(false)
      }
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void loadItems()

    return () => {
      mountedRef.current = false
    }
  }, [loadItems])

  function startMutation(): boolean {
    if (mutationInFlightRef.current) {
      return false
    }

    mutationInFlightRef.current = true
    if (mountedRef.current) {
      setMutationInFlight(true)
    }
    return true
  }

  function finishMutation(): void {
    mutationInFlightRef.current = false
    if (mountedRef.current) {
      setMutationInFlight(false)
    }
  }

  async function deleteServer(id: string): Promise<void> {
    const api = getMcpApi()
    if (!api?.deleteMcp) {
      if (mountedRef.current) {
        setError('Codex MCP API is unavailable.')
      }
      return
    }
    if (!startMutation()) {
      return
    }

    try {
      const result = await api.deleteMcp(id)
      if (!mountedRef.current) {
        return
      }
      if (!result.ok) {
        setError(result.error ?? 'Failed to delete MCP server.')
        return
      }

      setConfirmDelete(null)
      setConfigDirty(true)
      await loadItems()
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    } finally {
      finishMutation()
    }
  }

  async function toggleServer(item: CodexMcpServerListItem): Promise<void> {
    const api = getMcpApi()
    if (!api?.setMcpEnabled) {
      if (mountedRef.current) {
        setError('Codex MCP API is unavailable.')
      }
      return
    }
    if (!startMutation()) {
      return
    }

    try {
      const result = await api.setMcpEnabled(item.id, !item.enabled)
      if (!mountedRef.current) {
        return
      }
      if (!result.ok) {
        setError(result.error ?? 'Failed to update MCP server.')
        return
      }

      setConfigDirty(true)
      await loadItems()
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    } finally {
      finishMutation()
    }
  }

  const personalItems = items.filter((item) => item.scope === 'personal')
  const workspaceItems = items.filter((item) => item.scope === 'workspace')

  if (loading) {
    return (
      <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
        Loading MCP servers...
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-cyan-100">MCP servers</h2>
          <p className="mt-1 text-sm text-zinc-500">Manage Codex MCP server entries by config scope.</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="cursor-pointer rounded-md border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/20"
        >
          New MCP Server
        </button>
      </div>

      {editing ? (
        <McpEditor
          mode={editing}
          onClose={() => {
            setEditing(null)
            setConfigDirty(true)
            void loadItems()
          }}
        />
      ) : null}

      {error ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      {items.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4 text-sm text-zinc-400">
          No MCP servers yet.
        </div>
      ) : (
        <>
          <McpGroup
            title="Personal (~/.codex)"
            items={personalItems}
            confirmDelete={confirmDelete}
            onConfirmDelete={setConfirmDelete}
            onDelete={deleteServer}
            onEdit={setEditing}
            onToggle={toggleServer}
            actionsDisabled={mutationInFlight}
          />
          <McpGroup
            title="Workspace (<projectRoot>/.codex)"
            items={workspaceItems}
            confirmDelete={confirmDelete}
            onConfirmDelete={setConfirmDelete}
            onDelete={deleteServer}
            onEdit={setEditing}
            onToggle={toggleServer}
            actionsDisabled={mutationInFlight}
          />
        </>
      )}
    </section>
  )
}

function McpGroup({
  title,
  items,
  confirmDelete,
  onConfirmDelete,
  onDelete,
  onEdit,
  onToggle,
  actionsDisabled,
}: {
  title: string
  items: CodexMcpServerListItem[]
  confirmDelete: string | null
  onConfirmDelete: (id: string | null) => void
  onDelete: (id: string) => Promise<void>
  onEdit: (id: string) => void
  onToggle: (item: CodexMcpServerListItem) => Promise<void>
  actionsDisabled: boolean
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">{title}</h3>
      {items.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/50 p-4 text-sm text-zinc-500">
          No servers in this scope.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <article key={item.id} className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h4 className="text-base font-semibold text-zinc-100">{item.name}</h4>
                    {!item.enabled ? (
                      <span className="rounded-full border border-zinc-700 px-2 py-0.5 text-[11px] uppercase tracking-[0.16em] text-zinc-500">
                        Disabled
                      </span>
                    ) : null}
                  </div>
                  {item.description ? <p className="mt-1 text-sm text-zinc-400">{item.description}</p> : null}
                  <p className="mt-2 break-all text-sm text-zinc-500">{item.argsSummary || item.command}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    aria-label={`${item.enabled ? 'Disable' : 'Enable'} ${item.name}`}
                    disabled={actionsDisabled}
                    onClick={() => void onToggle(item)}
                    className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    {item.enabled ? 'Disable' : 'Enable'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${item.name}`}
                    disabled={actionsDisabled}
                    onClick={() => onEdit(item.id)}
                    className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${item.name}`}
                    disabled={actionsDisabled}
                    onClick={() => onConfirmDelete(item.id)}
                    className="cursor-pointer rounded-md border border-rose-400/30 px-3 py-1.5 text-sm text-rose-200 transition-colors duration-200 hover:bg-rose-500/10 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Delete
                  </button>
                </div>
              </div>

              {item.envKeysRedacted.length > 0 ? (
                <div className="mt-3 flex flex-wrap gap-2">
                  {item.envKeysRedacted.map((key) => (
                    <span
                      key={key}
                      className="rounded-full border border-cyan-400/20 bg-cyan-500/10 px-2 py-1 text-[12px] text-cyan-100"
                    >
                      {key}
                    </span>
                  ))}
                </div>
              ) : null}

              {item.warnings.length > 0 ? (
                <ul className="mt-3 space-y-1 text-[12px] text-amber-100">
                  {item.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              ) : null}

              {confirmDelete === item.id ? (
                <div className="mt-3 flex flex-wrap items-center gap-2 rounded-lg border border-rose-400/30 bg-rose-500/10 p-3 text-sm text-rose-100">
                  <span>Delete {item.name}?</span>
                  <button
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => void onDelete(item.id)}
                    className="cursor-pointer rounded-md bg-rose-500/20 px-2 py-1 text-rose-50 hover:bg-rose-500/30 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    disabled={actionsDisabled}
                    onClick={() => onConfirmDelete(null)}
                    className="cursor-pointer rounded-md px-2 py-1 text-zinc-300 hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    Cancel
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      )}
    </section>
  )
}

function getMcpApi() {
  return (window as Window & { electronAPI?: McpApi }).electronAPI?.agent
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
