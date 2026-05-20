import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MentionInput } from '../MentionInput'
import { useAgentChatStore } from '../store'

afterEach(cleanup)

type TestElectronAPI = {
  agent: { sendMessage: ReturnType<typeof vi.fn>; cancel: ReturnType<typeof vi.fn> }
  fs: { stat: ReturnType<typeof vi.fn> }
  getFilePath: ReturnType<typeof vi.fn>
}

// jsdom's DataTransfer constructor doesn't carry `files`, so we build a
// minimal stand-in that mirrors what Electron hands us on a real OS drop:
// `types` includes 'Files', `files` is a FileList-like with N File objects,
// and `getData(_anyType_)` returns '' so existing parseQuoteDrop /
// parseFileDrop short-circuit and we fall through to Tier 3.
function makeExternalFileTransfer(files: File[]): DataTransfer {
  return {
    types: ['Files'],
    files: files as unknown as FileList,
    getData: () => '',
    setData: () => {},
  } as unknown as DataTransfer
}

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    value: {
      agent: { sendMessage: vi.fn(), cancel: vi.fn() },
      fs: {
        stat: vi.fn(async () => ({ ok: true, size: 42, mime: 'image/png', mtime: 1 })),
      },
      // Real preload: webUtils.getPathForFile. We mimic per-file mapping.
      getFilePath: vi.fn((file: File) => `D:/desktop/${file.name}`),
    },
    configurable: true,
  })
  useAgentChatStore.setState({ input: '', attachments: [], pendingReferences: [] } as never)
})

describe('MentionInput external OS file drop', () => {
  it('adds attachment-only for each externally dropped file (NO pending reference)', async () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeExternalFileTransfer([
      new File(['a'], 'photo.png', { type: 'image/png' }),
      new File(['b'], 'note.md', { type: 'text/markdown' }),
    ])
    fireEvent.drop(textarea, { dataTransfer: dt })

    // onDrop is async (awaits fs.stat); flush microtasks
    await new Promise((r) => setTimeout(r, 0))

    const paths = useAgentChatStore.getState().attachments.map((a) => a.path)
    expect(paths).toEqual(['D:/desktop/photo.png', 'D:/desktop/note.md'])
    // Reference-list MUST stay empty for external drops. References travel
    // through mapReferencesToInputItems on the main side, which calls
    // `fs.realpath` and runs an assertContained check against allowedRoots
    // — exactly what AttachmentService.ingest skips for source paths. Pushing
    // an external path here would surface as `agent:send-message` failing with
    // "Reference path is outside allowed roots: <path>" at click-Send. Mirror
    // onFileChange (lines 730-754), which already attaches without referencing
    // for the exact same reason — the AttachmentService canonicalizes the file
    // into `<userData>/agent/uploads/<hash>.ext` and main returns the in-root
    // canonical path via result.userMessageItems.
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(0)
  })

  it('ignores files when getFilePath returns "" (synthetic File from clipboard)', async () => {
    const api = (window as unknown as { electronAPI: TestElectronAPI }).electronAPI
    api.getFilePath.mockImplementation(() => '')
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const dt = makeExternalFileTransfer([new File(['x'], 'pasted.png', { type: 'image/png' })])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    expect(useAgentChatStore.getState().attachments).toEqual([])
    expect(useAgentChatStore.getState().pendingReferences).toEqual([])
  })

  it('uses File.size/type for external drops without calling fsApi.stat (REAL assertContained would reject OS paths)', async () => {
    const api = (window as unknown as { electronAPI: TestElectronAPI }).electronAPI
    // Mimic main-process behavior: fs:stat rejects external OS paths via
    // assertContained, exactly like users see in production ("无法读取").
    api.fs.stat.mockResolvedValue({ ok: false, reason: 'path outside allowed roots' })

    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    const file = new File(['hello world!'], 'photo.png', { type: 'image/png' })
    expect(file.size).toBeGreaterThan(0)
    const dt = makeExternalFileTransfer([file])
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    const attachments = useAgentChatStore.getState().attachments
    expect(attachments).toHaveLength(1)
    expect(attachments[0]).toMatchObject({
      name: 'photo.png',
      mime: 'image/png',
      size: file.size,
      path: 'D:/desktop/photo.png',
    })
    // Root-cause guard: stat must NEVER be called for external drops.
    expect(api.fs.stat).not.toHaveBeenCalled()
  })

  it('does not trigger Tier 3 when internal MIME is present (regression guard)', async () => {
    render(<MentionInput />)
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    // Simulate an internal drag: types includes our internal MIME and files is empty.
    const dt = {
      types: ['application/x-catimation-file-paths'],
      files: [] as unknown as FileList,
      getData: (t: string) =>
        t === 'application/x-catimation-file-paths' ? JSON.stringify(['D:/repo/main.ts']) : '',
      setData: () => {},
    } as unknown as DataTransfer
    fireEvent.drop(textarea, { dataTransfer: dt })
    await new Promise((r) => setTimeout(r, 0))

    // Tier 2 path used: 1 attachment, getFilePath never called.
    const api = (window as unknown as { electronAPI: TestElectronAPI }).electronAPI
    expect(api.getFilePath).not.toHaveBeenCalled()
    expect(useAgentChatStore.getState().attachments.length).toBe(1)
    // Internal MIME drops DO push a pending reference (the @-mention chip),
    // because workspace paths pass main-side allowedRoots and this is the
    // expected behavior when dragging from FileExplorerPanel. The asymmetry
    // with external drops is intentional — locked in by this assertion
    // alongside the corresponding "no reference" assert in the external case.
    expect(useAgentChatStore.getState().pendingReferences.length).toBe(1)
  })
})
