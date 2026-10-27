import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { serializeFileDrag, serializeQuoteDrag } from '../../file-explorer/dragHelpers'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'
import type { AgentSendMessagePayload } from '../../../../../types/agent'

// jsdom has no electronAPI.attachments, so the real small-thumb resolver stays
// null forever and an image tile would fall back to its name chip. Pass the src
// through — the tile tests below assert structure, not the IPC byte plumbing.
vi.mock('../../../components/shared/media/useResolvedMediaSrc', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../components/shared/media/useResolvedMediaSrc')>()
  return {
    ...actual,
    useResolvedMediaSrc: (src: string) => (typeof src === 'string' && src.length > 0 ? src : null),
  }
})

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

  // History: dropping an image used to mount a full <MediaThumbnail> per file,
  // whose media:thumb IPC + base64 round-trip froze the renderer on multi-file
  // drops — so composer thumbnails were removed entirely. Design D2/D5 brings a
  // LIGHTWEIGHT tile back: one 56px <img> via the chat's small-thumb resolver
  // (PR-A `attachments:read-thumb`), never the MediaThumbnail wrapper, and the
  // tile count is capped (MAX_COMPOSER_THUMBNAILS) so a mass drop degrades to
  // name chips instead of decoding every bitmap at once.
  it('renders ONE lightweight <img> tile for a queued image — no MediaThumbnail wrapper', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:/photos/cat.png'])
    getTestElectronAPI().fs.stat.mockResolvedValueOnce({
      ok: true,
      size: 12,
      mime: 'image/png',
      mtime: 1,
    })
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    const form = textarea.closest('form')
    if (!form) throw new Error('MentionInput form not found')
    // The tile represents the file; the labelled reference chip is not repeated.
    expect(screen.getByRole('img', { name: 'cat.png' })).toBeTruthy()
    expect(screen.queryByText('cat.png')).toBeNull()
    expect(form.querySelectorAll('[data-media-kind]').length).toBe(0)
    expect(form.querySelectorAll('img').length).toBe(1)
  })

  it('caps composer thumbnails: past MAX_COMPOSER_THUMBNAILS images degrade to name chips', async () => {
    const { MAX_COMPOSER_THUMBNAILS } = await import('../ComposerAttachmentTile')
    const many = Array.from({ length: MAX_COMPOSER_THUMBNAILS + 2 }, (_, i) => ({
      name: `shot-${i}.png`,
      mime: 'image/png',
      size: 4,
      buffer: new Uint8Array([137, 80, 78, 71]).buffer,
    }))
    ;(URL as unknown as { createObjectURL: unknown }).createObjectURL = vi.fn(() => 'blob:mock')
    ;(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn()
    useAgentChatStore.setState({ attachments: many } as never)
    render(<MentionInput />)
    const form = screen.getByRole('textbox').closest('form') as HTMLFormElement
    expect(form.querySelectorAll('img').length).toBe(MAX_COMPOSER_THUMBNAILS)
    expect(screen.getByText(`shot-${MAX_COMPOSER_THUMBNAILS}.png`)).toBeTruthy()
  })

  it('does NOT render an inline thumbnail when a video reference is queued', async () => {
    render(<MentionInput />)

    const textarea = screen.getByRole('textbox')
    const dt = makeDataTransfer()
    serializeFileDrag(dt, ['D:/clips/take-1.mp4'])
    getTestElectronAPI().fs.stat.mockResolvedValueOnce({
      ok: true,
      size: 1024,
      mime: 'video/mp4',
      mtime: 1,
    })
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(screen.getByText('take-1.mp4')).toBeTruthy()

    const form = textarea.closest('form')
    if (!form) throw new Error('MentionInput form not found')
    expect(form.querySelectorAll('[data-media-kind]').length).toBe(0)
    expect(form.querySelectorAll('video').length).toBe(0)
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
