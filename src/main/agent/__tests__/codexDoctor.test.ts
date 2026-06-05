import { describe, expect, it, vi } from 'vitest'
import { parseDoctorReport, runCodexDoctor } from '../codexDoctor'

// A trimmed but representative `codex doctor --json` payload (the real one has
// ~10 checks). Field names mirror the rust-v0.137.0 schema:
// { schemaVersion, generatedAt, overallStatus, codexVersion, checks:{id:{...}} }
const SAMPLE = JSON.stringify({
  schemaVersion: 1,
  generatedAt: '1780634295s since unix epoch',
  overallStatus: 'fail',
  codexVersion: '0.137.0',
  checks: {
    'auth.credentials': {
      id: 'auth.credentials',
      category: 'auth',
      status: 'fail',
      summary: 'no Codex credentials were found',
      details: { 'auth file': 'C:/Users/x/.codex/auth.json' },
      remediation: 'Run codex login or provide an API key.',
      durationMs: 0,
    },
    'config.load': {
      id: 'config.load',
      category: 'config',
      status: 'ok',
      summary: 'config loaded',
      details: { 'mcp servers': '19' },
      remediation: null,
      durationMs: 2,
    },
  },
})

describe('parseDoctorReport', () => {
  it('parses a clean JSON payload into a typed report with checks as an array', () => {
    const report = parseDoctorReport(SAMPLE)
    expect(report.overallStatus).toBe('fail')
    expect(report.codexVersion).toBe('0.137.0')
    expect(report.schemaVersion).toBe(1)
    expect(report.checks).toHaveLength(2)
    const auth = report.checks.find((c) => c.id === 'auth.credentials')
    expect(auth).toMatchObject({
      category: 'auth',
      status: 'fail',
      summary: 'no Codex credentials were found',
      remediation: 'Run codex login or provide an API key.',
    })
    expect(auth?.details).toEqual({ 'auth file': 'C:/Users/x/.codex/auth.json' })
  })

  it('extracts the JSON object when the binary prints leading log noise', () => {
    const noisy = `2026-06-05 some warmup log line\n${SAMPLE}\n`
    const report = parseDoctorReport(noisy)
    expect(report.overallStatus).toBe('fail')
    expect(report.checks).toHaveLength(2)
  })

  it('throws a descriptive error when no JSON object is present', () => {
    expect(() => parseDoctorReport('command not found')).toThrow(/could not parse/i)
  })
})

describe('runCodexDoctor', () => {
  it('invokes the binary with `doctor --json` and returns the parsed report', async () => {
    const run = vi.fn().mockResolvedValue({ stdout: SAMPLE, stderr: '', code: 1 })
    const report = await runCodexDoctor({ binaryPath: '/bin/codex', run })
    expect(run).toHaveBeenCalledWith('/bin/codex', ['doctor', '--json'], expect.any(Object))
    // Non-zero exit (overallStatus=fail) must NOT prevent us from returning the
    // report — doctor exits non-zero precisely when it has findings to show.
    expect(report.overallStatus).toBe('fail')
    expect(report.checks).toHaveLength(2)
  })

  it('surfaces a runner failure as a thrown error', async () => {
    const run = vi.fn().mockRejectedValue(new Error('spawn ENOENT'))
    await expect(runCodexDoctor({ binaryPath: '/bin/codex', run })).rejects.toThrow(/ENOENT/)
  })
})
