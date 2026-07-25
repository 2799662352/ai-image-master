import { useEffect, useRef, useState } from 'react'
import type React from 'react'
import YAML from 'yaml'

import type { CodexConfigScope, CodexSkillInput } from '../../../../types/agent'
import { getAgentApi } from '../../utils/agentBridge'
import { useAutosizeTextarea } from '../../hooks/useAutosizeTextarea'

type SkillEditorProps = {
  mode: 'new' | string
  onClose: () => void
}

const emptyInput: CodexSkillInput = {
  name: '',
  scope: 'workspace',
  description: '',
  whenToUse: '',
  instructions: '',
}

export function SkillEditor({ mode, onClose }: SkillEditorProps): React.JSX.Element {
  const [input, setInput] = useState<CodexSkillInput>(emptyInput)
  const [view, setView] = useState<'form' | 'raw'>('form')
  const [rawText, setRawText] = useState('')
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const mountedRef = useRef(false)
  const instructionsRef = useRef<HTMLTextAreaElement>(null)
  const rawRef = useRef<HTMLTextAreaElement>(null)
  useAutosizeTextarea(instructionsRef, input.instructions, { minRows: 12, maxRows: 32 })
  useAutosizeTextarea(rawRef, rawText, { minRows: 18, maxRows: 40 })

  useEffect(() => {
    mountedRef.current = true

    return () => {
      mountedRef.current = false
    }
  }, [])

  useEffect(() => {
    if (mode === 'new') {
      setInput(emptyInput)
      return
    }

    let cancelled = false
    const api = getAgentApi()
    if (!api?.getSkillDetail) {
      setError('Codex skills API is unavailable.')
      return
    }

    void api.getSkillDetail(mode).then(
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
    const api = getAgentApi()
    if (!api?.saveSkill) {
      setError('Codex skills API is unavailable.')
      return
    }

    const inputToSave = view === 'raw' ? skillMdToInput(rawText, input.scope) : input
    if (!inputToSave) {
      setError('Invalid SKILL.md frontmatter.')
      return
    }

    setSaving(true)
    setSaved(false)
    setError(null)
    try {
      const result = await api.saveSkill(inputToSave)
      if (!mountedRef.current) {
        return
      }
      if (!result?.ok) {
        setError(result?.error ?? 'Save failed.')
        return
      }

      setSaved(true)
      onClose()
    } catch (reason) {
      if (mountedRef.current) {
        setError(errorMessage(reason))
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  function showRaw(): void {
    setError(null)
    setRawText(inputToSkillMd(input))
    setView('raw')
  }

  function showForm(): void {
    if (view === 'form') {
      return
    }

    const nextInput = skillMdToInput(rawText, input.scope)
    if (!nextInput) {
      setError('Invalid SKILL.md frontmatter.')
      return
    }

    setError(null)
    setInput(nextInput)
    setView('form')
  }

  return (
    <div className="space-y-3 rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex gap-2">
          <button type="button" className={tabClassName(view === 'form')} onClick={showForm}>
            Form
          </button>
          <button type="button" className={tabClassName(view === 'raw')} onClick={showRaw}>
            Raw
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
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
              onChange={(event) => setInput({ ...input, name: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100"
            />
          </Field>
          <Field label="Scope">
            <select
              value={input.scope}
              onChange={(event) => setInput({ ...input, scope: event.target.value as CodexConfigScope })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
            >
              <option value="workspace">Workspace (.agents)</option>
              <option value="personal">Personal (~/.agents)</option>
            </select>
          </Field>
          <Field label="Description">
            <input
              value={input.description}
              onChange={(event) => setInput({ ...input, description: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
            />
          </Field>
          <Field label="When to use">
            <input
              value={input.whenToUse}
              onChange={(event) => setInput({ ...input, whenToUse: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 text-sm text-zinc-100"
            />
          </Field>
          <Field label="Instructions">
            <textarea
              ref={instructionsRef}
              value={input.instructions}
              onChange={(event) => setInput({ ...input, instructions: event.target.value })}
              className="rounded border border-zinc-800 bg-zinc-950 px-2 py-1 font-mono text-sm text-zinc-100 transition-[height] duration-100"
            />
          </Field>
        </div>
      ) : (
        <textarea
          ref={rawRef}
          data-testid="skill-raw-editor"
          value={rawText}
          onChange={(event) => setRawText(event.target.value)}
          className="w-full rounded border border-zinc-800 bg-zinc-950 p-2 font-mono text-xs text-zinc-100 transition-[height] duration-100"
        />
      )}

      {error ? <div className="text-sm text-red-300">{error}</div> : null}
      <div className="flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
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

function inputToSkillMd(input: CodexSkillInput): string {
  const frontmatter: Record<string, string> = { name: input.name }
  if (input.description) {
    frontmatter.description = input.description
  }
  if (input.whenToUse) {
    frontmatter.whenToUse = input.whenToUse
  }

  return `---\n${YAML.stringify(frontmatter).trimEnd()}\n---\n${input.instructions}\n`
}

function skillMdToInput(text: string, scope: CodexConfigScope): CodexSkillInput | null {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/)
  if (!match) {
    return null
  }

  let frontmatter: unknown
  try {
    frontmatter = YAML.parse(match[1]) ?? {}
  } catch {
    return null
  }
  if (!frontmatter || typeof frontmatter !== 'object') {
    return null
  }

  const record = frontmatter as Record<string, unknown>
  return {
    name: typeof record.name === 'string' ? record.name : '',
    scope,
    description: typeof record.description === 'string' ? record.description : '',
    whenToUse: typeof record.whenToUse === 'string' ? record.whenToUse : '',
    instructions: match[2].trimStart(),
  }
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
