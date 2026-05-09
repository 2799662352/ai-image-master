import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Message, TimelineItem } from '../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../file-explorer/store'
import { MessageBubble } from '../MessageBubble'

afterEach(() => {
  cleanup()
})

const openReference = vi.fn(async () => undefined)

const textItem = (id: string, content: string): TimelineItem => ({
  type: 'text',
  id,
  startedAt: 1,
  content,
})

const shellItem = (
  id: string,
  overrides: Partial<Extract<TimelineItem, { type: 'shell' }>> = {},
): TimelineItem => ({
  type: 'shell',
  id,
  startedAt: 2,
  endedAt: 3,
  command: 'npm run test',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
  ...overrides,
})

const fileEditItem = (
  id: string,
  overrides: Partial<Extract<TimelineItem, { type: 'fileEdit' }>> = {},
): TimelineItem => ({
  type: 'fileEdit',
  id,
  startedAt: 4,
  endedAt: 5,
  changes: [
    {
      path: 'src/App.tsx',
      operation: 'edit',
      diff: '@@\n-old\n+new',
      added: 1,
      removed: 1,
    },
  ],
  totalAdded: 1,
  totalRemoved: 1,
  ...overrides,
})

function assistantMessage(items: TimelineItem[]): Message {
  return {
    id: 'msg_1',
    role: 'assistant',
    createdAt: 1,
    items,
  }
}

function renderMessage(items: TimelineItem[]): ReturnType<typeof render> {
  return render(<MessageBubble message={assistantMessage(items)} />)
}

describe('MessageBubble evidence grouping', () => {
  beforeEach(() => {
    openReference.mockClear()
    useFileExplorerStore.setState({ tabs: [], activeTabId: null, openReference } as never)
  })

  it('renders narrative text with adjacent shell and file evidence as compact chips', () => {
    renderMessage([
      textItem('text_1', 'Here is the result.'),
      shellItem('cmd_1'),
      fileEditItem('edit_1'),
    ])

    expect(screen.getByText('Here is the result.')).toBeTruthy()
    expect(screen.getByRole('button', { name: /cmd npm run test success · exit 0/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /file src\/App\.tsx \+1 -1/i })).toBeTruthy()
    expect(screen.queryByText('Open output')).toBeNull()
    expect(screen.queryByText('Open diff')).toBeNull()
  })

  it('keeps separate evidence placements when narrative text appears between evidence items', () => {
    renderMessage([
      textItem('text_1', 'Before evidence'),
      shellItem('cmd_1', { command: 'echo first' }),
      textItem('text_2', 'Between evidence'),
      fileEditItem('edit_1', {
        changes: [
          {
            path: 'src/second.ts',
            operation: 'edit',
            diff: '@@\n-old\n+new',
            added: 2,
            removed: 0,
          },
        ],
        totalAdded: 2,
        totalRemoved: 0,
      }),
      textItem('text_3', 'After evidence'),
    ])

    expect(screen.getByRole('button', { name: /cmd echo first success · exit 0/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /file src\/second\.ts \+2 -0/i })).toBeTruthy()

    const renderedText = document.body.textContent ?? ''
    expect(renderedText.indexOf('Before evidence')).toBeLessThan(renderedText.indexOf('echo first'))
    expect(renderedText.indexOf('echo first')).toBeLessThan(renderedText.indexOf('Between evidence'))
    expect(renderedText.indexOf('Between evidence')).toBeLessThan(renderedText.indexOf('src/second.ts'))
    expect(renderedText.indexOf('src/second.ts')).toBeLessThan(renderedText.indexOf('After evidence'))
  })
})
