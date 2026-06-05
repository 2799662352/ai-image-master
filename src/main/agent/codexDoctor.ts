// Runs `codex doctor --json` against the bundled binary and parses the stable,
// redacted diagnostic report into a UI-friendly shape. The report schema is
// owned by codex (rust-v0.137.0):
//   { schemaVersion, generatedAt, overallStatus, codexVersion,
//     checks: { "<id>": { id, category, status, summary, details,
//                         remediation, durationMs } } }
//
// We keep the spawn behind an injectable `run` so `parseDoctorReport` and
// `runCodexDoctor` are unit-testable without touching a real process.

import { spawn } from 'node:child_process'
import type { DoctorCheck, DoctorReport, DoctorStatus } from '../../types/agent'

export type { DoctorCheck, DoctorReport, DoctorStatus } from '../../types/agent'

export interface ProcessResult {
  stdout: string
  stderr: string
  code: number | null
}

export type ProcessRunner = (
  binaryPath: string,
  args: string[],
  opts: { timeoutMs: number; env?: NodeJS.ProcessEnv },
) => Promise<ProcessResult>

export interface RunCodexDoctorOptions {
  binaryPath: string
  timeoutMs?: number
  env?: NodeJS.ProcessEnv
  /** Injectable for tests; defaults to a real child_process spawn. */
  run?: ProcessRunner
}

const DEFAULT_DOCTOR_TIMEOUT_MS = 30_000

export async function runCodexDoctor(options: RunCodexDoctorOptions): Promise<DoctorReport> {
  const run = options.run ?? defaultProcessRunner
  const timeoutMs = options.timeoutMs ?? DEFAULT_DOCTOR_TIMEOUT_MS
  const result = await run(options.binaryPath, ['doctor', '--json'], {
    timeoutMs,
    env: options.env,
  })
  // doctor exits non-zero when overallStatus is warn/fail — that's expected and
  // still produces a full JSON report on stdout, so we parse regardless of code
  // and only fall back to the exit/stderr context when stdout has no JSON.
  try {
    return parseDoctorReport(result.stdout)
  } catch (err) {
    const detail = result.stderr.trim() || `exit code ${result.code}`
    throw new Error(`codex doctor produced no parseable report (${detail})`, { cause: err })
  }
}

export function parseDoctorReport(stdout: string): DoctorReport {
  const json = extractJsonObject(stdout)
  if (!json) {
    throw new Error('codex doctor output could not parse: no JSON object found')
  }
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch (err) {
    throw new Error(`codex doctor output could not parse: ${err instanceof Error ? err.message : String(err)}`)
  }
  if (!raw || typeof raw !== 'object') {
    throw new Error('codex doctor output could not parse: top-level value is not an object')
  }
  const obj = raw as Record<string, unknown>
  const checksMap = (obj.checks && typeof obj.checks === 'object' ? obj.checks : {}) as Record<string, unknown>
  const checks: DoctorCheck[] = Object.entries(checksMap).map(([id, value]) =>
    normalizeCheck(id, value),
  )
  return {
    schemaVersion: typeof obj.schemaVersion === 'number' ? obj.schemaVersion : 0,
    generatedAt: typeof obj.generatedAt === 'string' ? obj.generatedAt : '',
    overallStatus: typeof obj.overallStatus === 'string' ? (obj.overallStatus as DoctorStatus) : 'fail',
    codexVersion: typeof obj.codexVersion === 'string' ? obj.codexVersion : 'unknown',
    checks,
  }
}

function normalizeCheck(fallbackId: string, value: unknown): DoctorCheck {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>
  return {
    id: typeof v.id === 'string' ? v.id : fallbackId,
    category: typeof v.category === 'string' ? v.category : 'general',
    status: typeof v.status === 'string' ? (v.status as DoctorStatus) : 'fail',
    summary: typeof v.summary === 'string' ? v.summary : '',
    details: v.details && typeof v.details === 'object' ? (v.details as Record<string, unknown>) : {},
    remediation: typeof v.remediation === 'string' ? v.remediation : null,
    durationMs: typeof v.durationMs === 'number' ? v.durationMs : 0,
  }
}

/**
 * Returns the outermost JSON object substring from `text`, tolerating leading
 * log lines the binary may print before the report. Best-effort: scans from the
 * first `{` to the last `}`.
 */
function extractJsonObject(text: string): string | null {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  return text.slice(start, end + 1)
}

const defaultProcessRunner: ProcessRunner = (binaryPath, args, opts) =>
  new Promise<ProcessResult>((resolve, reject) => {
    const child = spawn(binaryPath, args, {
      env: opts.env ?? process.env,
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch { /* ignore */ }
      reject(new Error(`codex doctor timed out after ${opts.timeoutMs}ms`))
    }, opts.timeoutMs)
    timer.unref?.()

    child.stdout?.on('data', (chunk) => { stdout += String(chunk) })
    child.stderr?.on('data', (chunk) => { stderr += String(chunk) })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ stdout, stderr, code })
    })
  })
