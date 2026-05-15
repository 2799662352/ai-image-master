import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActivityItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { ActivityCard } from '../ActivityCard'

afterEach(cleanup)

const item: ActivityItem = {
  type: 'activity',
  id: 'mcp_1',
  startedAt: 1,
  endedAt: 2,
  kind: 'mcpToolCall',
  label: 'mcp:github/get_file_contents',
  detail: '{"owner":"openai","repo":"codex"}',
  status: 'success',
}

describe('ActivityCard reference action', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({ tabs: [], activeTabId: null })
  })

  it('opens MCP details via openReference', () => {
    const openReference = vi.fn(async () => undefined)
    useFileExplorerStore.setState({ openReference } as never)

    render(<ActivityCard item={item} />)
    fireEvent.click(screen.getByText(/Open details/i))

    expect(openReference).toHaveBeenCalledWith(expect.objectContaining({
      type: 'mcp',
      openBehavior: 'jsonResource',
    }))
  })
})
