import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'

import type { DoctorCheck, DoctorReport, DoctorStatus } from '../../../../types/agent'

type DoctorApi = {
  agent?: {
    codexDoctor?: () => Promise<{ ok: boolean; error?: string; report?: DoctorReport }>
  }
}

export function DoctorSection(): React.JSX.Element {
  const [report, setReport] = useState<DoctorReport | null>(null)
  const [error, setError] = useState<string>()
  const [running, setRunning] = useState(false)
  const mountedRef = useRef(false)

  const runDoctor = useCallback(async () => {
    const api = getDoctorApi()
    if (!api?.codexDoctor) {
      setError('Codex doctor API is unavailable.')
      return
    }
    setRunning(true)
    setError(undefined)
    try {
      const res = await api.codexDoctor()
      if (!mountedRef.current) return
      if (!res?.ok || !res.report) {
        setError(res?.error ?? 'codex doctor failed.')
        return
      }
      setReport(res.report)
    } catch (reason) {
      if (mountedRef.current) setError(reason instanceof Error ? reason.message : String(reason))
    } finally {
      if (mountedRef.current) setRunning(false)
    }
  }, [])

  useEffect(() => {
    mountedRef.current = true
    void runDoctor()
    return () => {
      mountedRef.current = false
    }
  }, [runDoctor])

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-cyan-100">Doctor</h2>
          <p className="mt-1 text-sm text-zinc-500">
            Diagnose the local Codex install — auth, config, MCP, git, and app-server health.
          </p>
        </div>
        <div className="flex items-center gap-3">
          {report ? <OverallBadge status={report.overallStatus} /> : null}
          <button
            type="button"
            onClick={() => void runDoctor()}
            disabled={running}
            className="cursor-pointer rounded-md border border-cyan-400/30 px-3 py-1.5 text-sm text-cyan-100 transition-colors duration-200 hover:bg-cyan-500/10 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {running ? 'Running…' : 'Re-run'}
          </button>
        </div>
      </div>

      {report ? (
        <p className="text-xs text-zinc-500">
          Codex <span className="text-zinc-300">{report.codexVersion}</span>
          {report.checks.length > 0 ? ` · ${report.checks.length} checks` : ''}
        </p>
      ) : null}

      {error ? (
        <div className="rounded-xl border border-amber-400/30 bg-amber-500/10 p-3 text-sm text-amber-100">
          {error}
        </div>
      ) : null}

      {!report && !error && running ? (
        <div className="rounded-xl border border-cyan-400/15 bg-zinc-950/70 p-4 text-sm text-zinc-300">
          Running diagnostics…
        </div>
      ) : null}

      {report ? (
        <div className="space-y-3">
          {report.checks.map((check) => (
            <CheckRow key={check.id} check={check} />
          ))}
        </div>
      ) : null}
    </section>
  )
}

function CheckRow({ check }: { check: DoctorCheck }): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const detailEntries = Object.entries(check.details ?? {})
  return (
    <article className="rounded-xl border border-zinc-800/80 bg-zinc-950/70 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <StatusDot status={check.status} />
            <span className="text-sm font-semibold text-zinc-100">{check.summary || check.id}</span>
          </div>
          <p className="mt-1 text-xs uppercase tracking-[0.14em] text-zinc-600">{check.category}</p>
          {check.remediation ? (
            <p className="mt-2 text-xs text-amber-200/90">↳ {check.remediation}</p>
          ) : null}
        </div>
        {detailEntries.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            className="shrink-0 cursor-pointer rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-400 transition-colors hover:border-cyan-400/40 hover:text-cyan-100"
          >
            {open ? 'Hide' : 'Details'}
          </button>
        ) : null}
      </div>
      {open && detailEntries.length > 0 ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,180px)_1fr] gap-x-3 gap-y-1 rounded-lg border border-zinc-800 bg-zinc-950 p-3 text-xs">
          {detailEntries.map(([key, value]) => (
            <div key={key} className="contents">
              <dt className="truncate text-zinc-500">{key}</dt>
              <dd className="break-all text-zinc-300">{formatDetail(value)}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </article>
  )
}

function OverallBadge({ status }: { status: DoctorStatus }): React.JSX.Element {
  const { label, className } = statusStyle(status)
  return (
    <span className={`rounded-full px-3 py-1 text-xs font-semibold ${className}`}>{label}</span>
  )
}

function StatusDot({ status }: { status: DoctorStatus }): React.JSX.Element {
  const color =
    status === 'ok'
      ? 'bg-emerald-400'
      : status === 'warn'
        ? 'bg-amber-400'
        : status === 'fail'
          ? 'bg-rose-500'
          : 'bg-zinc-500'
  return <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${color}`} aria-hidden />
}

function statusStyle(status: DoctorStatus): { label: string; className: string } {
  switch (status) {
    case 'ok':
      return { label: 'Healthy', className: 'border border-emerald-400/30 bg-emerald-500/10 text-emerald-100' }
    case 'warn':
      return { label: 'Warnings', className: 'border border-amber-400/30 bg-amber-500/10 text-amber-100' }
    case 'fail':
      return { label: 'Issues found', className: 'border border-rose-500/30 bg-rose-500/10 text-rose-100' }
    default:
      return { label: String(status), className: 'border border-zinc-700 bg-zinc-800/60 text-zinc-300' }
  }
}

function formatDetail(value: unknown): string {
  if (typeof value === 'string') return value
  if (value === null || value === undefined) return '—'
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function getDoctorApi() {
  return (window as Window & { electronAPI?: DoctorApi }).electronAPI?.agent
}
