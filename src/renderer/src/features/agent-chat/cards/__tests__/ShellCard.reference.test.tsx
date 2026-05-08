import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../../types/agent-reference'
import type { ShellItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { ShellCard } from '../ShellCard'

afterEach(cleanup)

const baseItem: ShellItem = {
  type: 'shell',
  id: 'cmd_1',
  startedAt: 1,
  endedAt: 2,
  command: 'npm run test',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
}

describe('ShellCard reference action', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens shell output by calling openReference with a shellOutput reference', () => {
    const openReference = vi.fn<(reference: AgentReference) => Promise<void>>(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<ShellCard item={baseItem} />)
    fireEvent.click(screen.getByText(/Open output/i))

    expect(openReference).toHaveBeenCalledTimes(1)
    expect(openReference.mock.calls[0]?.[0]).toMatchObject({
      type: 'command',
      label: 'npm run test',
      openBehavior: 'shellOutput',
    })
  })

  it('renders Open output even for empty-command items because label fallback derives a reference', () => {
    render(<ShellCard item={{ ...baseItem, command: '' }} />)
    expect(screen.queryByText(/Open output/i)).not.toBeNull()
  })
})
