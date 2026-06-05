import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { DoctorSection } from '../DoctorSection'
import type { DoctorReport } from '../../../../../types/agent'

const REPORT: DoctorReport = {
  schemaVersion: 1,
  generatedAt: '1780634295s since unix epoch',
  overallStatus: 'fail',
  codexVersion: '0.137.0',
  checks: [
    {
      id: 'auth.credentials',
      category: 'auth',
      status: 'fail',
      summary: 'no Codex credentials were found',
      details: { 'auth file': 'C:/Users/x/.codex/auth.json' },
      remediation: 'Run codex login or provide an API key.',
      durationMs: 0,
    },
    {
      id: 'config.load',
      category: 'config',
      status: 'ok',
      summary: 'config loaded',
      details: { 'mcp servers': '19' },
      remediation: null,
      durationMs: 2,
    },
  ],
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

function installApi(codexDoctor: ReturnType<typeof vi.fn>): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { agent: { codexDoctor } },
  })
}

describe('DoctorSection', () => {
  it('auto-runs codex doctor on mount and renders overall status + checks', async () => {
    const codexDoctor = vi.fn().mockResolvedValue({ ok: true, report: REPORT })
    installApi(codexDoctor)

    render(<DoctorSection />)

    expect(await screen.findByText('no Codex credentials were found')).toBeTruthy()
    expect(codexDoctor).toHaveBeenCalledTimes(1)
    expect(screen.getByText(/0\.137\.0/)).toBeTruthy()
    expect(screen.getByText('config loaded')).toBeTruthy()
    // Remediation for the failing check is surfaced.
    expect(screen.getByText(/Run codex login/)).toBeTruthy()
  })

  it('surfaces an error when the doctor call fails', async () => {
    const codexDoctor = vi.fn().mockResolvedValue({ ok: false, error: 'spawn ENOENT' })
    installApi(codexDoctor)

    render(<DoctorSection />)

    expect(await screen.findByText(/spawn ENOENT/)).toBeTruthy()
  })

  it('re-runs diagnostics when the Re-run button is clicked', async () => {
    const codexDoctor = vi.fn().mockResolvedValue({ ok: true, report: REPORT })
    installApi(codexDoctor)

    render(<DoctorSection />)
    expect(await screen.findByText('config loaded')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: /re-run/i }))
    await waitFor(() => expect(codexDoctor).toHaveBeenCalledTimes(2))
  })
})
