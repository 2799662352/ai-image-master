import { useEffect, useRef, useState } from 'react'
import type React from 'react'

import type { AgentApiResult, CodexConfigScope, CodexMcpServerInput } from '../../../../types/agent'

type McpEditorApi = {
  agent?: {
    getMcpDetail?: (id: string) => Promise<CodexMcpServerInput | null>
    saveMcp?: (input: CodexMcpServerInput) => Promise<AgentApiResult & { id?: string; warnings?: string[] }>
  }
}

type McpEditorProps = {
  mode: 'new' | string
  onClose: () => void
  onSaved?: () => void
  actionsDisabled?: boolean
  onBeforeSave?: () => boolean
  onAfterSave?: () => void
}

const emptyInput: CodexMcpServerInput = {
  name: '',
  scope: 'personal',
  enabled: true,
  command: '',
  args: [],
  env: [],
  description: '',
}

export function McpEditor({
  mode,
  onClose,
  onSaved,
  actionsDisabled = false,
  onBeforeSave,
  onAfterSave,
}: McpEditorProps): React.JSX.Element {
  const [input, setInput] = useState<CodexMcpServerInput>(emptyInput)
  const [view, setView] = useState<'form' | 'raw'>('form')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const closeTimerRef = useRef<number | undefined>()
  const editingExisting = mode !== 'new'

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
      if (closeTimerRef.current !== undefined) {
        window.clearTimeout(closeTimerRef.current)
      }
    }
  }, [])

  useEffect(() => {
    if (mode === 'new') {
      setInput(emptyInput)
      return
    }

    let cancelled = false
    const api = getMcpEditorApi()
    if (!api?.getMcpDetail) {
      setError('Codex MCP API is unavailable.')
      return
    }

    void api.getMcpDetail(mode).then(
      (detail) => {
        if (!cancelled && detail) {
          setInput(detail)
        }
      },
      (reason) => {
        if (!cancelled) {
          setError(errorMessage(reason))
        }
      },
    )

    return () => {
      cancelled = true
    }
  }, [mode])

  async function handleSave(): Promise<void> {
    const api = getMcpEditorApi()
    if (!api?.saveMcp) {
      setError('Codex MCP API is unavailable.')
      return
    }
    if (actionsDisabled || (onBeforeSave && !onBeforeSave())) {
      return
    }

    setSaving(true)
    setError(null)
    setSaved(false)
    try {
      const result = await api.saveMcp(input)
      if (!mountedRef.current) {
        return
      }
      if (!result?.ok) {
        setError(result?.error ?? 'Save failed.')
        return
      }

      setSaved(true)
      onSaved?.()
      closeTimerRef.current = window.setTimeout(() => {
        if (mountedRef.current) {
          onClose()
        }
      }, 200)
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    } finally {
      onAfterSave?.()
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  return (
    <div className="space-y-3 rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <button type="button" className={tabClassName(view === 'form')} onClick={() => setView('form')}>
            Form
          </button>
          <button type="button" className={tabClassName(view === 'raw')} onClick={() => setView('raw')}>
            Raw
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          disabled={saving}
          className="cursor-pointer rounded-md px-2 py-1 text-sm text-zinc-400 hover:bg-zinc-900 hover:text-zinc-200"
        >
          Close
        </button>
      </div>

      {view === 'form' ? (
        <div className="grid max-w-2xl gap-3">
          <Field label="Name">
            <input
              value={input.name}
              disabled={editingExisting}
              onChange={(event) => setInput({ ...input, name: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            />
          </Field>
          <Field label="Scope">
            <select
              value={input.scope}
              disabled={editingExisting}
              onChange={(event) => setInput({ ...input, scope: event.target.value as CodexConfigScope })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100 disabled:cursor-not-allowed disabled:opacity-60"
            >
              <option value="personal">Personal (~/.codex)</option>
              <option value="workspace">Workspace (.codex)</option>
            </select>
          </Field>
          <Field label="Command">
            <input
              value={input.command}
              onChange={(event) => setInput({ ...input, command: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100"
            />
          </Field>
          <ArgsEditor args={input.args} onChange={(args) => setInput({ ...input, args })} />
          <EnvEditor env={input.env} onChange={(env) => setInput({ ...input, env })} />
          <Field label="Description">
            <input
              value={input.description ?? ''}
              onChange={(event) => setInput({ ...input, description: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
            />
          </Field>
        </div>
      ) : (
        <div className="rounded-md border border-zinc-800 bg-zinc-950 p-3 text-sm text-zinc-500">
          Raw mode lands in Task 23.
        </div>
      )}

      <div className="max-w-2xl rounded border border-zinc-800/70 bg-zinc-950 p-2 font-mono text-xs text-zinc-300">
        {`${input.command} ${input.args.join(' ')}`.trim() || '<command preview>'} env=
        {input.env.map((row) => row.key).filter(Boolean).join(',')}
      </div>

      {error ? <div className="text-sm text-red-300">{error}</div> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving || actionsDisabled}
          onClick={() => void handleSave()}
          className="cursor-pointer rounded-md bg-cyan-500 px-3 py-1.5 text-sm font-medium text-zinc-950 hover:bg-cyan-400 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {saving ? 'Saving...' : 'Save'}
        </button>
        {saved ? <span className="text-sm text-emerald-300">Saved</span> : null}
      </div>
    </div>
  )
}

function ArgsEditor({ args, onChange }: { args: string[]; onChange: (args: string[]) => void }): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="text-sm text-zinc-400">Args</div>
      {args.map((arg, index) => (
        <div key={index} className="flex gap-2">
          <input
            value={arg}
            onChange={(event) => {
              const next = [...args]
              next[index] = event.target.value
              onChange(next)
            }}
            className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100"
          />
          <button
            type="button"
            onClick={() => onChange(args.filter((_, itemIndex) => itemIndex !== index))}
            className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200"
          >
            x
          </button>
        </div>
      ))}
      <button type="button" onClick={() => onChange([...args, ''])} className="cursor-pointer self-start text-sm text-cyan-300">
        + add arg
      </button>
    </div>
  )
}

function EnvEditor({
  env,
  onChange,
}: {
  env: Array<{ key: string; value: string }>
  onChange: (env: Array<{ key: string; value: string }>) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-1">
      <div className="text-sm text-zinc-400">Env</div>
      {env.map((row, index) => (
        <div key={index} className="flex gap-2">
          <input
            placeholder="KEY"
            value={row.key}
            onChange={(event) => {
              const next = [...env]
              next[index] = { ...row, key: event.target.value }
              onChange(next)
            }}
            className="w-1/3 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100"
          />
          <input
            type="password"
            placeholder="value (hidden)"
            value={row.value}
            onChange={(event) => {
              const next = [...env]
              next[index] = { ...row, value: event.target.value }
              onChange(next)
            }}
            className="flex-1 rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100"
          />
          <button
            type="button"
            onClick={() => onChange(env.filter((_, itemIndex) => itemIndex !== index))}
            className="cursor-pointer text-sm text-zinc-400 hover:text-zinc-200"
          >
            x
          </button>
        </div>
      ))}
      <button
        type="button"
        onClick={() => onChange([...env, { key: '', value: '' }])}
        className="cursor-pointer self-start text-sm text-cyan-300"
      >
        + add env
      </button>
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <label className="grid gap-1 text-sm">
      <span className="text-zinc-400">{label}</span>
      {children}
    </label>
  )
}

function tabClassName(active: boolean): string {
  return [
    'cursor-pointer rounded-md px-3 py-1.5 text-sm transition-colors duration-200',
    active ? 'bg-zinc-800 text-cyan-100' : 'text-zinc-400 hover:text-zinc-200',
  ].join(' ')
}

function getMcpEditorApi() {
  return (window as Window & { electronAPI?: McpEditorApi }).electronAPI?.agent
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
