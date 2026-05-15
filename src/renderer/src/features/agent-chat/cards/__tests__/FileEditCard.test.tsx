import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FileEditItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { FileEditCard } from '../FileEditCard'

function item(overrides: Partial<FileEditItem> = {}): FileEditItem {
  return {
    type: 'fileEdit',
    id: 'edit-1',
    startedAt: 1,
    endedAt: 2,
    changes: [
      {
        path: 'docs/a.md',
        operation: 'create',
        diff: ['--- /dev/null', '+++ b/docs/a.md', '@@ -0,0 +1 @@', '+# Title'].join('\n'),
        added: 1,
        removed: 0,
      },
    ],
    totalAdded: 1,
    totalRemoved: 0,
    ...overrides,
  }
}

describe('FileEditCard', () => {
  beforeEach(() => {
    useFileExplorerStore.setState({
      openAiChange: vi.fn(),
      openTab: vi.fn(),
    } as never)
  })

  it('renders markdown create as a draft card and opens the created file', () => {
    const openTab = vi.fn()
    useFileExplorerStore.setState({ openTab } as never)

    render(<FileEditCard item={item()} />)

    fireEvent.click(screen.getByRole('button', { name: /open docs\/a.md/i }))
    expect(openTab).toHaveBeenCalledWith('docs/a.md', 'workspace')
  })

  it('opens AI change detail for non-markdown edits', () => {
    const openAiChange = vi.fn()
    useFileExplorerStore.setState({ openAiChange } as never)

    const change = {
      path: 'src/a.ts',
      operation: 'edit' as const,
      diff: ['--- a/src/a.ts', '+++ b/src/a.ts', '@@ -1 +1 @@', '-old', '+new'].join('\n'),
      added: 1,
      removed: 1,
    }

    render(<FileEditCard item={item({ changes: [change], totalAdded: 1, totalRemoved: 1 })} />)

    fireEvent.click(screen.getByRole('button', { name: /open diff for src\/a.ts/i }))
    expect(openAiChange).toHaveBeenCalledWith(change)
  })

  it('uses a compact file list for multi-file changes', () => {
    render(
      <FileEditCard
        item={item({
          changes: [
            { path: 'a.ts', operation: 'edit', diff: '-a\n+b', added: 1, removed: 1 },
            { path: 'b.ts', operation: 'edit', diff: '-c\n+d', added: 1, removed: 1 },
          ],
          totalAdded: 2,
          totalRemoved: 2,
        })}
      />,
    )

    expect(screen.getByText('a.ts')).toBeTruthy()
    expect(screen.getByText('b.ts')).toBeTruthy()
    expect(screen.queryByText('-a')).toBeNull()
  })
})
