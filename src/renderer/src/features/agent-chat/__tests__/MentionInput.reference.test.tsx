import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeFileDrag, serializeQuoteDrag } from '../../file-explorer/dragHelpers'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'
import type { AgentSendMessagePayload } from '../../../../../types/agent'

afterEach(cleanup)

type TestElectronAPI = {
  agent: {
    sendMessage: ReturnType<typeof vi.fn>
    cancel: ReturnType<typeof vi.fn>
  }
  fs: {
    stat: ReturnType<typeof vi.fn>
  }
}

function makeDataTransfer(): DataTransfer {
  const data = new Map<string, string>()
  return {
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? '',
  } as unknown as DataTransfer
}

function getTestElectronAPI(): TestElectronAPI {
  return (window as unknown as Window & { electronAPI: TestElectronAPI }).electronAPI
}

beforeEach(() => {
  const sendMessage = vi.fn(async () => ({ threadId: 'thread-1' }))
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: {
        sendMessage,
        cancel: vi.fn(),
      },
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
    serializeFileDrag(dt, ['D:/repo/main.ts'])
    fireEvent.drop(textarea, { dataTransfer: dt })

    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(textarea.value).not.toContain('[file:main.ts]')
    expect(screen.getByText('main.ts')).toBeTruthy()
    expect(screen.getByText('file')).toBeTruthy()
  })

  it('drops multiple selected files in one go and creates one chip per file', async () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeDataTransfer()
    serializeFileDrag(dt, [
      'D:/repo/a.ts',
      'D:/repo/b.ts',
      'D:/repo/c.ts',
    ])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const paths = useAgentChatStore.getState().attachments.map((a) => a.path)
    expect(paths).toEqual(['D:/repo/a.ts', 'D:/repo/b.ts', 'D:/repo/c.ts'])
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(3)
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
    serializeFileDrag(dt, ['D:/repo/main.ts'])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments.length).toBe(1)
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(1)

    fireEvent.click(screen.getByLabelText('Remove main.ts'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments).toEqual([])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('removing one same-basename reference chip removes only its matching attachment', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const first = makeDataTransfer()
    serializeFileDrag(first, ['D:/repo/a/main.ts'])
    fireEvent.drop(textarea, { dataTransfer: first })
    const second = makeDataTransfer()
    serializeFileDrag(second, ['D:/repo/b/main.ts'])
    fireEvent.drop(textarea, { dataTransfer: second })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments.map((attachment) => attachment.path)).toEqual([
      'D:/repo/a/main.ts',
      'D:/repo/b/main.ts',
    ])

    fireEvent.click(screen.getAllByLabelText('Remove main.ts')[0])
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments.map((attachment) => attachment.path)).toEqual([
      'D:/repo/b/main.ts',
    ])
    expect(useAgentChatStore.getState().pendingReferences.map((reference) => reference.source)).toEqual([
      { kind: 'localPath', path: 'D:/repo/b/main.ts' },
    ])
  })

  it('does not remove same-basename attachments when local reference path has no match', async () => {
    useAgentChatStore.setState({
      attachments: [{ name: 'main.ts', mime: 'text/typescript', size: 12, path: 'D:/repo/a/main.ts' }],
      pendingReferences: [{
        id: 'ref:D:/repo/missing/main.ts',
        type: 'file',
        label: 'main.ts',
        source: { kind: 'localPath', path: 'D:/repo/missing/main.ts' },
        status: 'ready',
        openBehavior: 'code',
      }],
    } as never)

    render(<MentionInput />)

    fireEvent.click(screen.getByLabelText('Remove main.ts'))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().attachments.map((attachment) => attachment.path)).toEqual([
      'D:/repo/a/main.ts',
    ])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('sends pending references as payload.references and clears them after IPC success', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:/repo/cat.png'])
    getTestElectronAPI().fs.stat.mockResolvedValueOnce({
      ok: true,
      size: 12,
      mime: 'image/png',
      mtime: 1,
    })
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    fireEvent.change(textarea, { target: { value: 'describe this' } })
    fireEvent.submit(textarea.closest('form')!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    const sendMessage = getTestElectronAPI().agent.sendMessage
    const payload = sendMessage.mock.calls[0][0] as AgentSendMessagePayload
    expect(payload.references?.map((reference) => reference.label)).toEqual(['cat.png'])
    expect(payload.content).toBe('describe this')
    expect(payload.content).not.toContain('[file:cat.png]')
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('clicking the chip label opens the reference in the file panel', async () => {
    const { useFileExplorerStore } = await import('../../file-explorer/store')
    const openReference = vi.fn()
    useFileExplorerStore.setState({ openReference } as never)

    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:/repo/notes.txt'])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    // The chip has two buttons — the "label" area (which opens) and the "x"
    // (which removes). Click the label area, not the remove button.
    const chipOpenButton = screen.getByTitle('file: notes.txt')
    fireEvent.click(chipOpenButton)

    expect(openReference).toHaveBeenCalledTimes(1)
    const arg = (openReference.mock.calls[0] as unknown as [{ label: string }])[0]
    expect(arg.label).toBe('notes.txt')
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(1)
  })

  it('preserves pending references when IPC send fails', async () => {
    const sendMessage = getTestElectronAPI().agent.sendMessage
    sendMessage.mockRejectedValueOnce(new Error('send failed'))
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:/repo/cat.png'])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    fireEvent.change(textarea, { target: { value: 'describe this' } })
    fireEvent.submit(textarea.closest('form')!)
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(useAgentChatStore.getState().pendingReferences.map((reference) => reference.label)).toEqual(['cat.png'])
  })
})
