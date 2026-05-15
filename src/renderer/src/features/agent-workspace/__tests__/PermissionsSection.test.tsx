import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionsSection } from '../PermissionsSection'

const status = {
  sandboxMode: 'danger-full-access',
  approvalPolicy: 'never',
  webSearch: 'live',
  writableRoots: [],
}

const safeStatus = {
  sandboxMode: 'workspace-write',
  approvalPolicy: 'on-request',
  webSearch: 'cached',
  writableRoots: [],
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('PermissionsSection', () => {
  it('loads and renders Codex permissions from the session status API', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getSessionStatus: vi.fn().mockResolvedValue(status),
          setSessionConfig: vi.fn().mockResolvedValue(status),
        },
      },
    })

    render(<PermissionsSection />)

    expect(await screen.findByText(/Sandbox/i)).toBeTruthy()
    expect(screen.getByText('danger-full-access')).toBeTruthy()
    expect(screen.getByText('never')).toBeTruthy()
  })

  it('keeps permission controls visible when applying a config change fails', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getSessionStatus: vi.fn().mockResolvedValue(safeStatus),
          setSessionConfig: vi.fn().mockRejectedValue(new Error('session config change cancelled')),
        },
      },
    })

    render(<PermissionsSection />)

    expect(await screen.findByText(/Sandbox/i)).toBeTruthy()

    fireEvent.click(screen.getByText('danger-full-access'))
    fireEvent.click(screen.getByText('Apply permissions'))

    expect(await screen.findByText('session config change cancelled')).toBeTruthy()
    expect(screen.getByText(/Sandbox/i)).toBeTruthy()
    expect(screen.getByText('Apply permissions')).toBeTruthy()
  })
})
