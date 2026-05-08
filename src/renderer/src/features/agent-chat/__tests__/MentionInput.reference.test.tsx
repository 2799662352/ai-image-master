import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeFileDrag, serializeQuoteDrag } from '../../file-explorer/dragHelpers'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

function makeDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as DataTransfer
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      fs: {
        stat: vi.fn(async () => ({ ok: true, size: 12, mime: 'text/typescript', mtime: 1 })),
      },
    },
    configurable: true,
  })
  useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
})

describe('MentionInput reference chips', () => {
  it('shows a reference chip for a file drop and does not insert [file:name] text', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeDataTransfer()
    serializeFileDrag(dt, 'D:/repo/main.ts')
    fireEvent.drop(textarea, { dataTransfer: dt })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(textarea.value).not.toContain('[file:main.ts]')
    expect(screen.getByText('main.ts')).toBeTruthy()
    expect(screen.getByText('file')).toBeTruthy()
  })

  it('still inserts pure markdown for code-selection drops', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeDataTransfer()
    serializeQuoteDrag(dt, '```ts\nconst x = 1\n```')
    fireEvent.drop(textarea, { dataTransfer: dt })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(textarea.value).toContain('```ts')
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('chip remove button removes both the chip and the underlying attachment', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const dt = makeDataTransfer()
    serializeFileDrag(dt, 'D:/repo/main.ts')
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments.length).toBe(1)
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(1)

    fireEvent.click(screen.getByLabelText('Remove main.ts'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments).toEqual([])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })
})
