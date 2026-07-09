import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentReference } from '../../../types/agent-reference'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

interface BackendCall {
  threadId: string | undefined
  input: AgentInput
}

let tmpDir: string
let workspaceDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-ref-input-'))
  workspaceDir = path.join(tmpDir, 'workspace')
  await fs.mkdir(workspaceDir)
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(): IAgentBackend & { calls: BackendCall[] } {
  const calls: BackendCall[] = []
  return {
    calls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel() {},
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

function makeManager(backend: IAgentBackend): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => ({ id: 'msg-1' }),
      updateLastMessageAt: async () => undefined,
    } as any,
    attachments: { ingest: async () => [] } as any,
  })
}

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

function localReference(filePath: string, overrides: Partial<AgentReference> = {}): AgentReference {
  return {
    id: `ref:${filePath}`,
    type: 'file',
    label: path.basename(filePath),
    source: { kind: 'localPath', path: filePath },
    status: 'ready',
    openBehavior: 'code',
    ...overrides,
  }
}

function remoteReference(url: string, overrides: Partial<AgentReference> = {}): AgentReference {
  return {
    id: `ref:${url}`,
    type: 'url',
    label: url,
    source: { kind: 'url', url },
    status: 'ready',
    openBehavior: 'url',
    ...overrides,
  }
}

describe('Codex structured reference inputs', () => {
  it('maps local image references to localImage items', async () => {
    const imagePath = path.join(workspaceDir, 'cat.png')
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await fs.writeFile(imagePath, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [localReference(imagePath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.items).toContainEqual({ type: 'localImage', path: path.resolve(imagePath) })
  })

  it('accepts local image references in an in-root name that starts with two dots', async () => {
    const imagePath = path.join(workspaceDir, '..assets', 'cat.png')
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await fs.mkdir(path.dirname(imagePath))
    await fs.writeFile(imagePath, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [localReference(imagePath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.items).toContainEqual({ type: 'localImage', path: path.resolve(imagePath) })
  })

  it('maps remote HTTPS image references to image items', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [
        remoteReference('https://example.com/cat.webp', {
          type: 'image',
          openBehavior: 'image',
          preview: { mime: 'image/webp' },
        }),
      ],
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.items).toContainEqual({ type: 'image', url: 'https://example.com/cat.webp' })
  })

  it('rejects remote HTTP image references', async () => {
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspaceDir])

    await expect(mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [
        remoteReference('http://example.com/cat.png', {
          type: 'image',
          openBehavior: 'image',
          preview: { mime: 'image/png' },
        }),
      ],
    })).rejects.toThrow('Reference URL uses unsupported protocol')

    expect(backend.calls).toEqual([])
  })

  it('rejects invalid remote references before creating a thread or ingesting attachments', async () => {
    let createThreadCalls = 0
    let ingestCalls = 0
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => {
          createThreadCalls += 1
          return { id: 'thread-1' }
        },
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: {
        ingest: async () => {
          ingestCalls += 1
          return []
        },
      } as any,
    })
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspaceDir])

    await expect(mgr.sendMessage({
      content: 'describe this',
      attachments: [{ name: 'cat.png', mime: 'image/png', path: path.join(workspaceDir, 'cat.png'), size: 12 }],
      references: [
        remoteReference('http://example.com/cat.png', {
          type: 'image',
          openBehavior: 'image',
          preview: { mime: 'image/png' },
        }),
      ],
    })).rejects.toThrow('Reference URL uses unsupported protocol')

    expect(createThreadCalls).toBe(0)
    expect(ingestCalls).toBe(0)
    expect(backend.calls).toEqual([])
  })

  it('keeps non-image local references as text mentions without localImage items', async () => {
    const textPath = path.join(workspaceDir, 'notes.txt')
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await fs.writeFile(textPath, 'notes')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'read this',
      attachments: [],
      references: [localReference(textPath, { preview: { mime: 'text/plain' } })],
    })
    await flushMicrotasks()

    const items = backend.calls[0].input.items
    expect(items.some((item) => item.type === 'localImage')).toBe(false)
    const textItem = items.find((item): item is Extract<typeof item, { type: 'text' }> => item.type === 'text')
    expect(textItem?.text).toContain(textPath)
  })

  it('dedupes duplicate local image attachment and reference paths', async () => {
    const imagePath = path.join(workspaceDir, 'cat.png')
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: {
        ingest: async () => [{
          id: 'att-1',
          originalName: 'cat.png',
          localPath: imagePath,
          mime: 'image/png',
          size: 12,
        }],
      } as any,
    })
    await mgr.setCodexApiKey('sk-test')
    await fs.writeFile(imagePath, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [{ name: 'cat.png', mime: 'image/png', path: imagePath, size: 12 }],
      references: [localReference(imagePath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })
    await flushMicrotasks()

    const localImagePaths = backend.calls[0].input.items
      .filter((item): item is Extract<typeof item, { type: 'localImage' }> => item.type === 'localImage')
      .map((item) => item.path)
    expect(localImagePaths).toEqual([path.resolve(imagePath)])
  })

  it('dedupes an uploaded image attachment and its original-path reference', async () => {
    const originalPath = path.join(workspaceDir, 'cat.png')
    const uploadedPath = path.join(tmpDir, 'uploads', 'sha-cat.png')
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: {
        ingest: async () => [{
          id: 'att-1',
          originalName: 'cat.png',
          localPath: uploadedPath,
          mime: 'image/png',
          size: 12,
        }],
      } as any,
    })
    await mgr.setCodexApiKey('sk-test')
    await fs.writeFile(originalPath, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [{ name: 'cat.png', mime: 'image/png', path: originalPath, size: 12 }],
      references: [localReference(originalPath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })
    await flushMicrotasks()

    const localImagePaths = backend.calls[0].input.items
      .filter((item): item is Extract<typeof item, { type: 'localImage' }> => item.type === 'localImage')
      .map((item) => item.path)
    expect(localImagePaths).toEqual([uploadedPath])
  })

  it('rejects local reference paths outside allowed roots', async () => {
    const outsidePath = path.join(tmpDir, 'outside.png')
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await fs.writeFile(outsidePath, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await expect(mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [localReference(outsidePath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })).rejects.toThrow('Reference path is outside allowed roots')

    expect(backend.calls).toEqual([])
  })

  it('rejects outside-root local references before creating a thread or ingesting attachments', async () => {
    let createThreadCalls = 0
    let ingestCalls = 0
    const outsidePath = path.resolve(workspaceDir, '..', 'sibling', 'cat.png')
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => {
          createThreadCalls += 1
          return { id: 'thread-1' }
        },
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: {
        ingest: async () => {
          ingestCalls += 1
          return []
        },
      } as any,
    })
    await mgr.setCodexApiKey('sk-test')
    await fs.mkdir(path.dirname(outsidePath), { recursive: true })
    await fs.writeFile(outsidePath, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await expect(mgr.sendMessage({
      content: 'describe this',
      attachments: [{ name: 'cat.png', mime: 'image/png', path: outsidePath, size: 12 }],
      references: [localReference(outsidePath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })).rejects.toThrow('Reference path is outside allowed roots')

    expect(createThreadCalls).toBe(0)
    expect(ingestCalls).toBe(0)
    expect(backend.calls).toEqual([])
  })

  // The fs IPC gate (fsIpc.resolveAllowedRoots) has ALWAYS whitelisted
  // `<userData>/agent/uploads` so attachment chips are clickable, but the
  // send gate historically validated references against workspace roots
  // only — so referencing a canonical uploads-cache path (drag from the
  // ATTACHMENTS tree, edit-and-resend of a sent message) previewed fine
  // and then died at click-Send with "Reference path is outside allowed
  // roots". The two gates must share the uploads whitelist.
  it('allows local references under the uploads cache directory', async () => {
    const uploadsDir = path.join(tmpDir, 'agent', 'uploads')
    const uploadedImage = path.join(uploadsDir, 'sha-cat.png')
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await fs.mkdir(uploadsDir, { recursive: true })
    await fs.writeFile(uploadedImage, 'image')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [localReference(uploadedImage, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })
    await flushMicrotasks()

    expect(backend.calls[0].input.items).toContainEqual({ type: 'localImage', path: path.resolve(uploadedImage) })
  })

  // Stale references (uploads written on another machine / user profile, or
  // cleaned up by AttachmentService.cleanup) used to hard-fail the whole
  // send: fs.realpath threw ENOENT and mapReferencesToInputItems rethrew as
  // "Reference path is outside allowed roots", holding the user's message
  // hostage to a dead chip. Unreadable paths are now SKIPPED with a notice;
  // only paths that EXIST outside allowed roots still hard-reject (that is
  // the arbitrary-file-read security boundary and it stays).
  it('skips stale (unreadable) local references instead of rejecting the send, and emits a notice', async () => {
    const stalePath = path.join(tmpDir, 'gone', 'other-machine.png')
    const events: AgentStreamEvent[] = []
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
      eventSink: (event) => events.push(event),
    })
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [localReference(stalePath, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })
    await flushMicrotasks()

    // The send goes through without the dead reference.
    expect(backend.calls).toHaveLength(1)
    expect(backend.calls[0].input.items.some((item) => item.type === 'localImage')).toBe(false)

    const notice = events.find(
      (event): event is Extract<AgentStreamEvent, { type: 'notice' }> => event.type === 'notice',
    )
    expect(notice).toBeDefined()
    expect(notice?.notice.kind).toBe('attachmentSkipped')
    expect(notice?.notice.level).toBe('warning')
    expect(notice?.notice.message).toContain('other-machine.png')
  })

  it('rejects local reference paths that symlink outside allowed roots', async () => {
    const outsideDir = path.join(tmpDir, 'outside-target')
    const outsideImage = path.join(outsideDir, 'secret.png')
    const linkDir = path.join(workspaceDir, 'linked-outside')
    const linkedImage = path.join(linkDir, 'secret.png')
    const backend = makeBackend()
    const mgr = makeManager(backend)
    await mgr.setCodexApiKey('sk-test')
    await fs.mkdir(outsideDir)
    await fs.writeFile(outsideImage, 'secret')
    await fs.symlink(outsideDir, linkDir, process.platform === 'win32' ? 'junction' : 'dir')
    await mgr.setAllowedRoots([workspaceDir])

    await expect(mgr.sendMessage({
      content: 'describe this',
      attachments: [],
      references: [localReference(linkedImage, { openBehavior: 'image', preview: { mime: 'image/png' } })],
    })).rejects.toThrow('Reference path is outside allowed roots')

    expect(backend.calls).toEqual([])
  })
})
