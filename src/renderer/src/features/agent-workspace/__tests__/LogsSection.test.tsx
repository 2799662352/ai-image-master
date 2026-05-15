import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { LogsSection } from '../LogsSection'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('LogsSection', () => {
  it('lists most recent audit entries', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getWorkspaceLogs: vi.fn().mockResolvedValue([
            { tsIso: '2026-05-09T03:00:00Z', action: 'mcp.save', scope: 'personal', name: 'github', ok: true },
          ]),
        },
      },
    })

    render(<LogsSection />)

    expect(await screen.findByText('mcp.save')).toBeTruthy()
    expect(screen.getByText('personal')).toBeTruthy()
    expect(screen.getByText('github')).toBeTruthy()
  })
})
