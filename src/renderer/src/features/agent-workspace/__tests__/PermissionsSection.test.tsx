import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionsSection } from '../PermissionsSection'

const status = {
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
    expect(screen.getByText('workspace-write')).toBeTruthy()
    expect(screen.getByText('on-request')).toBeTruthy()
  })
})
