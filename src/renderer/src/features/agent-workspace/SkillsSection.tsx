import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

import type { AgentApiResult, CodexSkillListItem } from '../../../../types/agent'
import { SkillEditor } from './SkillEditor'

type SkillsApi = {
  agent?: {
    listSkills?: () => Promise<CodexSkillListItem[]>
    deleteSkill?: (id: string) => Promise<AgentApiResult>
  }
}

type SkillsSectionProps = {
  insertIntoChat: (text: string) => void
}

type EditingState = 'new' | string | null

export function SkillsSection({ insertIntoChat }: SkillsSectionProps): React.JSX.Element {
  const [items, setItems] = useState<CodexSkillListItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [editing, setEditing] = useState<EditingState>(null)
  const mountedRef = useRef(false)
  const loadRequestIdRef = useRef(0)

  const loadItems = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    const canUpdate = () => mountedRef.current && requestId === loadRequestIdRef.current
    const api = getSkillsApi()
    if (!api?.listSkills) {
      if (canUpdate()) {
        setError('Codex skills API is unavailable.')
        setLoading(false)
      }
      return
    }

    try {
      const nextItems = await api.listSkills()
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

  async function deleteSkill(id: string): Promise<void> {
    const api = getSkillsApi()
    if (!api?.deleteSkill) {
      setError('Codex skills API is unavailable.')
      return
    }

    try {
      const result = await api.deleteSkill(id)
      if (!mountedRef.current) {
        return
      }
      if (!result.ok) {
        setError(result.error ?? 'Failed to delete skill.')
        return
      }

      setConfirmDelete(null)
      void loadItems()
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    }
  }

  const personalItems = items.filter((item) => item.scope === 'personal')
  const workspaceItems = items.filter((item) => item.scope === 'workspace')

  if (loading) {
    return (
      <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
        Loading skills...
      </section>
    )
  }

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-cyan-100">Skills</h2>
          <p className="mt-1 text-sm text-zinc-500">Manage Codex skills and insert skill mentions into chat.</p>
        </div>
        <button
          type="button"
          onClick={() => setEditing('new')}
          className="cursor-pointer rounded-md border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/20"
        >
          New Skill
        </button>
      </div>

      {editing ? (
        <SkillEditor
          mode={editing}
          onClose={() => {
            setEditing(null)
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
          No skills yet.
        </div>
      ) : (
        <>
          <SkillGroup
            title="Workspace (<projectRoot>/.agents)"
            items={workspaceItems}
            confirmDelete={confirmDelete}
            onConfirmDelete={setConfirmDelete}
            onDelete={deleteSkill}
            onEdit={setEditing}
            onInsert={(name) => insertIntoChat(`/${name}`)}
          />
          <SkillGroup
            title="Personal (~/.agents)"
            items={personalItems}
            confirmDelete={confirmDelete}
            onConfirmDelete={setConfirmDelete}
            onDelete={deleteSkill}
            onEdit={setEditing}
            onInsert={(name) => insertIntoChat(`/${name}`)}
          />
        </>
      )}
    </section>
  )
}

function SkillGroup({
  title,
  items,
  confirmDelete,
  onConfirmDelete,
  onDelete,
  onEdit,
  onInsert,
}: {
  title: string
  items: CodexSkillListItem[]
  confirmDelete: string | null
  onConfirmDelete: (id: string | null) => void
  onDelete: (id: string) => Promise<void>
  onEdit: (id: string) => void
  onInsert: (name: string) => void
}): React.JSX.Element {
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">{title}</h3>
      {items.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/50 p-4 text-sm text-zinc-500">
          No skills in this scope.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => (
            <article key={item.id} className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-base font-semibold text-zinc-100">{item.name}</h4>
                  {item.description ? <p className="mt-1 text-sm text-zinc-400">{item.description}</p> : null}
                  <p className="mt-2 break-all text-xs text-zinc-500">{item.path}</p>
                </div>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => onInsert(item.name)}
                    className="cursor-pointer rounded-md border border-cyan-400/30 px-3 py-1.5 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/10"
                  >
                    Insert
                  </button>
                  <button
                    type="button"
                    aria-label={`Edit ${item.name}`}
                    onClick={() => onEdit(item.id)}
                    className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete ${item.name}`}
                    onClick={() => onConfirmDelete(item.id)}
                    className="cursor-pointer rounded-md border border-rose-400/30 px-3 py-1.5 text-sm text-rose-200 transition-colors duration-200 hover:bg-rose-500/10"
                  >
                    Delete
                  </button>
                </div>
              </div>

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
                    onClick={() => void onDelete(item.id)}
                    className="cursor-pointer rounded-md bg-rose-500/20 px-2 py-1 text-rose-50 hover:bg-rose-500/30"
                  >
                    Confirm delete
                  </button>
                  <button
                    type="button"
                    onClick={() => onConfirmDelete(null)}
                    className="cursor-pointer rounded-md px-2 py-1 text-zinc-300 hover:bg-zinc-800"
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

function getSkillsApi() {
  return (window as Window & { electronAPI?: SkillsApi }).electronAPI?.agent
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
