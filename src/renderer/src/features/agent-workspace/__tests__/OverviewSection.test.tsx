import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { OverviewSection } from '../OverviewSection'

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

describe('OverviewSection', () => {
  it('shows Codex runtime status and available counts', async () => {
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        agent: {
          getSessionStatus: vi.fn().mockResolvedValue({
            sandboxMode: 'workspace-write',
            approvalPolicy: 'on-request',
            webSearch: 'cached',
            writableRoots: ['/a', '/b'],
          }),
          listMcp: vi.fn().mockResolvedValue([{ name: 'a' }, { name: 'b' }]),
          listSkills: vi.fn().mockResolvedValue([{ name: 'x' }]),
        },
      },
    })

    render(<OverviewSection />)

    expect(await screen.findByText('workspace-write')).toBeTruthy()
    expect(screen.getByText('on-request')).toBeTruthy()
    expect(screen.getByText('cached')).toBeTruthy()
    expect(screen.getByText('2 writable roots')).toBeTruthy()
    expect(screen.getByText('2 MCP servers')).toBeTruthy()
    expect(screen.getByText('1 skill')).toBeTruthy()
  })
})
