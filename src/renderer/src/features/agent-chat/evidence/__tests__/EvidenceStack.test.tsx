import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentReference } from '../../../../../../types/agent-reference'
import type { TimelineItem } from '../../../../../../types/agent-timeline'
import { useFileExplorerStore } from '../../../file-explorer/store'
import { EvidenceStack } from '../EvidenceStack'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const openReference = vi.fn<(reference: AgentReference) => Promise<void>>(async () => undefined)

const shellItem = (overrides: Partial<Extract<TimelineItem, { type: 'shell' }>> = {}): TimelineItem => ({
  type: 'shell',
  id: 'cmd_1',
  startedAt: 1,
  endedAt: 2,
  command: 'npm run test',
  stdout: 'ok',
  stderr: '',
  exitCode: 0,
  ...overrides,
})

const fileEditItem = (
  overrides: Partial<Extract<TimelineItem, { type: 'fileEdit' }>> = {},
): TimelineItem => ({
  type: 'fileEdit',
  id: 'edit_1',
  startedAt: 1,
  endedAt: 2,
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

const activityItem = (
  overrides: Partial<Extract<TimelineItem, { type: 'activity' }>> = {},
): TimelineItem => ({
  type: 'activity',
  id: 'act_1',
  startedAt: 1,
  endedAt: 2,
  kind: 'mcpToolCall',
  label: 'mcp:read_file',
  detail: '{"path":"src/App.tsx"}',
  status: 'success',
  ...overrides,
})

const artifactItem = (): TimelineItem => ({
  type: 'artifact',
  id: 'artifact_1',
  startedAt: 1,
  endedAt: 2,
  artifacts: [
    {
      id: 'artifact_ref_1',
      kind: 'file',
      name: 'report.md',
      mime: 'text/markdown',
      size: 42,
      uri: 'local-file:/tmp/report.md',
    },
  ],
})

const attachmentItem = (): TimelineItem => ({
  type: 'attachment',
  id: 'attachment_1',
  startedAt: 1,
  endedAt: 2,
  attachments: [
    {
      id: 'attachment_ref_1',
      kind: 'file',
      name: 'input.txt',
      mime: 'text/plain',
      size: 12,
      uri: 'local-file:/tmp/input.txt',
    },
  ],
})

function renderStack(items: TimelineItem[]): ReturnType<typeof render> {
  return render(<EvidenceStack items={items} />)
}

function advanceClickDelay(): void {
  act(() => {
    vi.advanceTimersByTime(250)
  })
}

describe('EvidenceStack', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    openReference.mockClear()
    useFileExplorerStore.setState({ tabs: [], activeTabId: null, openReference } as never)
  })

  it('renders compact evidence chips and hides details by default', () => {
    renderStack([shellItem(), fileEditItem(), activityItem(), artifactItem(), attachmentItem()])

    expect(screen.getByRole('button', { name: /cmd npm run test success · exit 0/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /file src\/App\.tsx \+1 -1/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /mcp mcp:read_file success/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /file report\.md 1 artifact/i })).toBeTruthy()
    expect(screen.getByRole('button', { name: /file input\.txt 1 attachment/i })).toBeTruthy()
    expect(screen.queryByText('Open in panel')).toBeNull()
    expect(screen.queryByText('ok')).toBeNull()
  })

  it('expands inline details on single click without opening the panel', () => {
    renderStack([shellItem()])

    fireEvent.click(screen.getByRole('button', { name: /cmd npm run test/i }))
    advanceClickDelay()

    expect(screen.getByText('Command')).toBeTruthy()
    expect(screen.getAllByText('npm run test')).toHaveLength(2)
    expect(screen.getByText('ok')).toBeTruthy()
    expect(openReference).not.toHaveBeenCalled()
  })

  it('opens the first reference on double click without leaving inline details expanded', () => {
    renderStack([shellItem()])

    const chip = screen.getByRole('button', { name: /cmd npm run test/i })
    fireEvent.click(chip)
    fireEvent.click(chip)
    fireEvent.doubleClick(chip)
    advanceClickDelay()

    expect(openReference).toHaveBeenCalledTimes(1)
    expect(openReference.mock.calls[0]?.[0]).toMatchObject({ openBehavior: 'shellOutput' })
    expect(screen.queryByText('Command')).toBeNull()
    expect(screen.queryByText('ok')).toBeNull()
  })

  it('clears pending single-click expansion when unmounted', () => {
    const { unmount } = renderStack([shellItem()])

    fireEvent.click(screen.getByRole('button', { name: /cmd npm run test/i }))
    expect(vi.getTimerCount()).toBe(1)

    unmount()
    expect(vi.getTimerCount()).toBe(0)

    advanceClickDelay()
    expect(screen.queryByText('Command')).toBeNull()
  })

  it('supports Enter to expand and modifier Enter to open the reference', () => {
    renderStack([shellItem()])

    const chip = screen.getByRole('button', { name: /cmd npm run test/i })
    fireEvent.keyDown(chip, { key: 'Enter' })

    expect(screen.getByText('Command')).toBeTruthy()
    expect(openReference).not.toHaveBeenCalled()

    fireEvent.keyDown(chip, { key: 'Enter', ctrlKey: true })

    expect(openReference).toHaveBeenCalledTimes(1)
    expect(openReference.mock.calls[0]?.[0]).toMatchObject({ openBehavior: 'shellOutput' })
  })

  it('shows an Open in panel action in expanded details', () => {
    renderStack([shellItem()])

    fireEvent.click(screen.getByRole('button', { name: /cmd npm run test/i }))
    advanceClickDelay()
    fireEvent.click(screen.getByRole('button', { name: 'Open in panel' }))

    expect(openReference).toHaveBeenCalledTimes(1)
    expect(openReference.mock.calls[0]?.[0]).toMatchObject({ openBehavior: 'shellOutput' })
  })

  it('keeps inline details visible when opening the panel fails', async () => {
    openReference.mockRejectedValueOnce(new Error('panel unavailable'))
    renderStack([shellItem()])

    fireEvent.click(screen.getByRole('button', { name: /cmd npm run test/i }))
    advanceClickDelay()

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Open in panel' }))
    })

    expect(screen.getByText('Could not open reference in panel.')).toBeTruthy()
    expect(screen.getByText('Command')).toBeTruthy()
    expect(screen.getByText('ok')).toBeTruthy()
  })

  it('shows a fallback when a file changed without a diff', () => {
    renderStack([
      fileEditItem({
        changes: [{ path: 'src/App.tsx', operation: 'edit', diff: '', added: 1, removed: 1 }],
      }),
    ])

    fireEvent.click(screen.getByRole('button', { name: /file src\/App\.tsx/i }))
    advanceClickDelay()

    expect(screen.getByText('File changed, but no diff was provided.')).toBeTruthy()
  })

  it('shows No output for expanded shell items with empty stdout and stderr', () => {
    renderStack([shellItem({ stdout: '', stderr: '' })])

    fireEvent.click(screen.getByRole('button', { name: /cmd npm run test/i }))
    advanceClickDelay()

    expect(screen.getByText('No output')).toBeTruthy()
  })

  it('renders activity items without detail or reference as inert chips', () => {
    renderStack([activityItem({ detail: undefined })])

    expect(screen.queryByRole('button', { name: /mcp mcp:read_file success/i })).toBeNull()

    const chip = screen.getByText('mcp:read_file').closest('span')
    expect(chip).toBeTruthy()
    if (!chip) return
    expect(within(chip).queryByText('Expand')).toBeNull()
    fireEvent.click(chip)
    fireEvent.keyDown(chip, { key: 'Enter' })
    advanceClickDelay()

    expect(screen.queryByText('Open in panel')).toBeNull()
    expect(screen.queryByText('{"path":"src/App.tsx"}')).toBeNull()
  })
})
