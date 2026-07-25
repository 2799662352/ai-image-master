import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

import type {
  AgentApiResult,
  CodexSkillListItem,
  CodexSkillScope,
} from '../../../../types/agent'
import { getAgentApi } from '../../utils/agentBridge'
import { useAgentChatStore } from '../agent-chat/store'
import { useTabStore } from '../../stores'
import { SkillEditor } from './SkillEditor'

type SkillsApi = {
  openSkillsFolder?: () => Promise<AgentApiResult & { path?: string }>
  shell?: {
    showItemInFolder?: (p: string) => Promise<void>
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
  const [folderMessage, setFolderMessage] = useState<string | null>(null)
  const appendInputText = useAgentChatStore((state) => state.appendInputText)
  const switchTab = useTabStore((state) => state.switchTab)
  const mountedRef = useRef(false)
  const loadRequestIdRef = useRef(0)

  const loadItems = useCallback(async () => {
    const requestId = loadRequestIdRef.current + 1
    loadRequestIdRef.current = requestId
    const canUpdate = () => mountedRef.current && requestId === loadRequestIdRef.current
    const api = getAgentApi()
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
    const api = getAgentApi()
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

  function handleInsert(name: string): void {
    const mention = `/${name} `
    appendInputText(mention)
    insertIntoChat(mention)
  }

  async function openSkillsFolder(): Promise<void> {
    const electron = getElectronApi()
    if (!electron?.openSkillsFolder) {
      setFolderMessage('打开 Skills 文件夹 API 不可用。')
      return
    }

    const result = await electron.openSkillsFolder()
    const ok = (result as { success?: boolean; ok?: boolean }).success ?? (result as { ok?: boolean }).ok
    if (ok) {
      setFolderMessage(result.path ? `已打开：${result.path}` : '已打开 Skills 文件夹。')
      return
    }
    setFolderMessage((result as { error?: string }).error ?? '打开 Skills 文件夹失败。')
  }

  async function revealSkillInFolder(filePath: string): Promise<void> {
    const electron = getElectronApi()
    if (!electron?.shell?.showItemInFolder) {
      setFolderMessage('打开所在位置 API 不可用。')
      return
    }
    try {
      await electron.shell.showItemInFolder(filePath)
    } catch (reason) {
      setFolderMessage(errorMessage(reason))
    }
  }

  async function openSkillsRoot(scope: CodexSkillScope): Promise<void> {
    const api = getAgentApi()
    if (!api?.openSkillsRoot) {
      setFolderMessage('打开 Skills 根目录 API 不可用。')
      return
    }
    try {
      const result = await api.openSkillsRoot(scope)
      if (result.ok) {
        setFolderMessage(`已打开 ${scope.toUpperCase()} 根目录：${result.path}`)
      } else {
        setFolderMessage(result.error ?? `打开 ${scope.toUpperCase()} 根目录失败。`)
      }
    } catch (reason) {
      setFolderMessage(errorMessage(reason))
    }
  }

  // Codex official scope names: user / repo / system (https://developers.openai.com/codex/skills)
  const userItems = items.filter((item) => item.scope === 'user')
  const repoItems = items.filter((item) => item.scope === 'repo')
  const systemItems = items.filter((item) => item.scope === 'system')

  if (loading) {
    return (
      <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-6 text-sm text-zinc-300">
        <span className="inline-flex items-center gap-2">
          <span className="h-2 w-2 animate-pulse rounded-full bg-cyan-300" aria-hidden="true" />
          Loading skills…
        </span>
      </section>
    )
  }

  const totalCount = items.length
  const userCount = userItems.length
  const repoCount = repoItems.length
  const systemCount = systemItems.length

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-baseline gap-2">
            <h2 className="text-lg font-semibold text-cyan-100">Skills</h2>
            <span className="font-mono text-[11px] text-zinc-500">
              {totalCount} total · {repoCount} repo · {userCount} user
              {systemCount > 0 ? ` · ${systemCount} system` : ''}
            </span>
          </div>
          <p className="mt-1 text-sm text-zinc-500">
            Manage Codex skills. Type <code className="rounded bg-zinc-900 px-1 py-px font-mono text-[11px] text-cyan-200">/</code> or <code className="rounded bg-zinc-900 px-1 py-px font-mono text-[11px] text-cyan-200">$</code> in chat to invoke one.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={() => switchTab('marketplace')}
            className="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-cyberpunk-yellow/40 bg-cyberpunk-yellow/10 px-3 py-2 text-sm text-cyberpunk-yellow font-semibold transition-colors duration-200 hover:bg-cyberpunk-yellow/20 hover:border-cyberpunk-yellow/60"
            aria-label="浏览 Skill 商城"
            title="去 Skill 商城下载更多技能"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="5" cy="11" r="1" />
              <circle cx="11" cy="11" r="1" />
              <path d="M1 1h2l1.5 7h7.5l1-5H4" />
            </svg>
            Skill 商城
          </button>
          <button
            type="button"
            onClick={() => void openSkillsFolder()}
            className="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-zinc-700 px-3 py-2 text-sm text-zinc-200 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M1.5 4.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
              <path d="M1.5 4.5V3a1 1 0 0 1 1-1h3.2l1.3 1.5h5a1 1 0 0 1 1 1v.5" />
            </svg>
            打开 Skills 文件夹
          </button>
          <button
            type="button"
            onClick={() => setEditing('new')}
            className="cursor-pointer inline-flex items-center gap-1.5 rounded-md border border-cyan-400/30 bg-cyan-500/10 px-3 py-2 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/20 hover:border-cyan-400/50"
          >
            <svg width="13" height="13" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true">
              <path d="M7 3v8M3 7h8" />
            </svg>
            New Skill
          </button>
        </div>
      </div>

      {folderMessage ? (
        <div className="rounded-xl border border-cyan-400/20 bg-cyan-500/10 p-3 text-sm text-cyan-100">
          {folderMessage}
        </div>
      ) : null}

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
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/40 p-8 text-center">
          <p className="text-sm font-medium text-zinc-300">No skills yet</p>
          <p className="mt-2 text-xs text-zinc-500">
            Click <span className="text-cyan-200">New Skill</span> to create one, or drop a
            SKILL.md folder into your skills directory.
          </p>
        </div>
      ) : (
        <>
          <SkillGroup
            scope="repo"
            title="REPO (<projectRoot>/.agents)"
            items={repoItems}
            confirmDelete={confirmDelete}
            onConfirmDelete={setConfirmDelete}
            onDelete={deleteSkill}
            onEdit={setEditing}
            onInsert={handleInsert}
            onReveal={revealSkillInFolder}
            onOpenRoot={openSkillsRoot}
          />
          <SkillGroup
            scope="user"
            title="USER (~/.agents)"
            items={userItems}
            confirmDelete={confirmDelete}
            onConfirmDelete={setConfirmDelete}
            onDelete={deleteSkill}
            onEdit={setEditing}
            onInsert={handleInsert}
            onReveal={revealSkillInFolder}
            onOpenRoot={openSkillsRoot}
          />
          {systemItems.length > 0 ? (
            <SkillGroup
              scope="system"
              title="SYSTEM (随应用打包，只读)"
              items={systemItems}
              confirmDelete={confirmDelete}
              onConfirmDelete={setConfirmDelete}
              onDelete={deleteSkill}
              onEdit={setEditing}
              onInsert={handleInsert}
              onReveal={revealSkillInFolder}
              onOpenRoot={openSkillsRoot}
            />
          ) : null}
        </>
      )}
    </section>
  )
}

function SkillGroup({
  scope,
  title,
  items,
  confirmDelete,
  onConfirmDelete,
  onDelete,
  onEdit,
  onInsert,
  onReveal,
  onOpenRoot,
}: {
  scope: CodexSkillScope
  title: string
  items: CodexSkillListItem[]
  confirmDelete: string | null
  onConfirmDelete: (id: string | null) => void
  onDelete: (id: string) => Promise<void>
  onEdit: (id: string) => void
  onInsert: (name: string) => void
  onReveal: (path: string) => Promise<void>
  onOpenRoot: (scope: CodexSkillScope) => Promise<void>
}): React.JSX.Element {
  const scopeLabel = scope.toUpperCase()
  return (
    <section className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold uppercase tracking-[0.18em] text-zinc-500">{title}</h3>
        <button
          type="button"
          aria-label={`Open ${scopeLabel} skills folder`}
          title={`在文件管理器中打开 ${scopeLabel} 根目录`}
          onClick={() => void onOpenRoot(scope)}
          className="cursor-pointer inline-flex items-center gap-1 rounded-md border border-zinc-800 px-2 py-1 text-[11px] font-medium uppercase tracking-wider text-zinc-400 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100"
        >
          <svg width="11" height="11" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M1.5 4.5h11v7a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1Z" />
            <path d="M1.5 4.5V3a1 1 0 0 1 1-1h3.2l1.3 1.5h5a1 1 0 0 1 1 1v.5" />
          </svg>
          打开
        </button>
      </div>
      {items.length === 0 ? (
        <div className="rounded-xl border border-zinc-800/70 bg-zinc-950/50 p-4 text-sm text-zinc-500">
          No skills in this scope.
        </div>
      ) : (
        <div className="space-y-3">
          {items.map((item) => {
            const readOnly = item.readOnly === true || item.scope === 'system'
            return (
            <article key={item.id} className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h4 className="text-base font-semibold text-zinc-100">
                    {item.name}
                    {readOnly ? (
                      <span className="ml-2 rounded border border-zinc-700 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-zinc-400">
                        Read-only
                      </span>
                    ) : null}
                  </h4>
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
                    aria-label={`Open location of ${item.name}`}
                    title="在文件管理器中打开"
                    onClick={() => void onReveal(item.path)}
                    className="cursor-pointer rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 transition-colors duration-200 hover:border-cyan-400/40 hover:text-cyan-100"
                  >
                    打开位置
                  </button>
                  {!readOnly ? (
                    <>
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
                    </>
                  ) : null}
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
            )
          })}
        </div>
      )}
    </section>
  )
}

function getElectronApi() {
  return (window as Window & { electronAPI?: SkillsApi }).electronAPI
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
