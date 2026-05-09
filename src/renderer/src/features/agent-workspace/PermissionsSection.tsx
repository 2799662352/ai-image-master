import { useEffect, useState } from 'react'

import type { CodexSessionConfig, CodexSessionStatus } from '../../../../types/agent'
import { CodexPermissionsPanel } from '../agent-chat/CodexPermissionsPanel'

type PermissionsApi = {
  agent?: {
    getSessionStatus?: () => Promise<CodexSessionStatus>
    setSessionConfig?: (patch: Partial<CodexSessionConfig>) => Promise<CodexSessionStatus | void>
  }
}

export function PermissionsSection() {
  const [status, setStatus] = useState<CodexSessionStatus>()
  const [error, setError] = useState<string>()

  useEffect(() => {
    let alive = true

    async function loadStatus(): Promise<void> {
      const api = getPermissionsApi()
      if (!api?.getSessionStatus || !api.setSessionConfig) {
        if (alive) setError('Codex permissions API is unavailable.')
        return
      }

      try {
        const nextStatus = await api.getSessionStatus()
        if (alive) {
          setStatus(nextStatus)
          setError(undefined)
        }
      } catch (reason) {
        if (alive) setError(errorMessage(reason))
      }
    }

    void loadStatus()

    return () => {
      alive = false
    }
  }, [])

  async function applyPermissions(patch: Partial<CodexSessionConfig>): Promise<void> {
    const api = getPermissionsApi()
    if (!api?.setSessionConfig || !api.getSessionStatus) {
      setError('Codex permissions API is unavailable.')
      return
    }

    try {
      const nextStatus = await api.setSessionConfig(patch)
      setStatus(nextStatus ?? (await api.getSessionStatus()))
      setError(undefined)
    } catch (reason) {
      setError(errorMessage(reason))
    }
  }

  if (!status && !error) {
    return (
      <section className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
        Loading Codex permissions...
      </section>
    )
  }

  if (error) {
    return (
      <section className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-4 text-sm text-amber-100">
        {error}
      </section>
    )
  }

  return <CodexPermissionsPanel status={status} onApply={applyPermissions} />
}

function getPermissionsApi() {
  return (window as Window & { electronAPI?: PermissionsApi }).electronAPI?.agent
}

function errorMessage(reason: unknown): string {
  return reason instanceof Error ? reason.message : String(reason)
}
