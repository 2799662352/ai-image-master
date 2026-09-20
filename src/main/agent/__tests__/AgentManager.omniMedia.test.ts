/**
 * Omni main agent (qwen3.8-omni-flash): audio / video attachments and references
 * must reach the backend as media sentinels (relayed to COS), never as `localAudio`
 * (codex strips audio for slugs it does not know) or bare path mentions. Every other
 * model keeps the codex-native path byte-for-byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import { parseOmniMediaSentinel } from '../omniMediaInput'
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
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-omni-media-'))
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
    // Pretend every channel table is registered on the live spawn so a qwen turn
    // routes in-process (`thread/start.modelProvider`) instead of demanding the
    // restart transaction a fake backend cannot honour.
    hasRegisteredProviderChannel() { return true },
    setProvider() {},
    async restartCodex() {},
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

interface SavedAttachmentFixture {
  originalName: string
  localPath: string
  mime: string
  size: number
}

/**
 * The catalog (and with it each model's credential availability) is built when the
 * manager is constructed, so the Miau key for the qwen channel has to be on disk
 * before `new AgentManager` — same recipe as AgentManager.test.ts's credential gate.
 */
async function writeProviderState(selectedModelId: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, 'codex-providers.json'),
    JSON.stringify({
      version: 2,
      selectedGatewayId: 'rightcode',
      selectedModelId,
      apiKeys: { rightcode: 'sk-test', qwen: 'miau-key' },
      customProviders: [],
    }),
    'utf8',
  )
}

function makeManager(
  backend: IAgentBackend,
  opts: {
    relay?: (filePath: string, mime: string, size?: number) => Promise<string>
    saved?: SavedAttachmentFixture[]
  } = {},
): AgentManager {
  return new AgentManager({
    userDataDir: tmpDir,
    backend,
    store: {
      createThread: async () => ({ id: 'thread-1' }),
      addMessage: async () => ({ id: 'msg-1' }),
      updateLastMessageAt: async () => undefined,
    } as any,
    attachments: {
      ingest: async () => (opts.saved ?? []).map((item, index) => ({
        id: `att-${index}`,
        threadId: 'thread-1',
        uploadedAt: new Date(0),
        ...item,
      })),
    } as any,
    relayMediaToCos: opts.relay ?? (async () => { throw new Error('relay must not be called') }),
  })
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

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

function sentinelsOf(input: AgentInput) {
  return input.items
    .filter((item): item is Extract<AgentInput['items'][number], { type: 'text' }> => item.type === 'text')
    .map((item) => parseOmniMediaSentinel(item.text))
    .filter((ref) => ref !== null)
}

function promptOf(input: AgentInput): string {
  const first = input.items[0]
  return first.type === 'text' ? first.text : ''
}

const OMNI = 'qwen3.8-omni-flash'

describe('AgentManager omni native media', () => {
  it('turns a video attachment + audio reference into relayed sentinels and emits no localAudio', async () => {
    const audioPath = path.join(workspaceDir, 'voice.wav')
    await fs.writeFile(audioPath, 'wav')
    const uploadedVideo = path.join(tmpDir, 'uploads', 'sha-clip.mp4')
    const relay = vi.fn(async (filePath: string) => `https://cos.example.com/relay/${path.basename(filePath)}`)
    await writeProviderState(OMNI)
    const backend = makeBackend()
    const mgr = makeManager(backend, {
      relay,
      saved: [{ originalName: '开场-1.mp4', localPath: uploadedVideo, mime: 'video/mp4', size: 126 }],
    })
        await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: '看看这段开场,顺便听听录音',
      model: OMNI,
      attachments: [{ name: '开场-1.mp4', mime: 'video/mp4', path: path.join(workspaceDir, '开场-1.mp4'), size: 126 }],
      references: [localReference(audioPath, { openBehavior: 'audio', preview: { mime: 'audio/wav' } })],
    })
    await flushMicrotasks()

    const { input } = backend.calls[0]
    expect(sentinelsOf(input)).toEqual([
      { kind: 'audio', url: 'https://cos.example.com/relay/voice.wav', format: 'wav', name: 'voice.wav' },
      { kind: 'video', url: 'https://cos.example.com/relay/sha-clip.mp4', name: '开场-1.mp4' },
    ])
    expect(input.items.some((item) => item.type === 'localAudio')).toBe(false)
    expect(relay.mock.calls.map(([p, mime, size]) => [path.basename(p), mime, size])).toEqual([
      ['voice.wav', 'audio/wav', undefined],
      ['sha-clip.mp4', 'video/mp4', 126],
    ])
    // The on-disk anchor for the attachment stays in the prompt so file tools still reach it.
    expect(promptOf(input)).toContain(uploadedVideo)
  })

  it('sets a local video reference aside as a sentinel instead of a bare path mention', async () => {
    const videoPath = path.join(workspaceDir, 'ref.mov')
    await fs.writeFile(videoPath, 'mov')
    const relay = vi.fn(async () => 'https://cos.example.com/relay/ref.mov')
    await writeProviderState(OMNI)
    const backend = makeBackend()
    const mgr = makeManager(backend, { relay })
        await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: '这段参考视频里的运镜',
      model: OMNI,
      attachments: [],
      references: [localReference(videoPath, { type: 'video', openBehavior: 'video', preview: { mime: 'video/quicktime' } })],
    })
    await flushMicrotasks()

    const { input } = backend.calls[0]
    expect(sentinelsOf(input)).toEqual([{ kind: 'video', url: 'https://cos.example.com/relay/ref.mov', name: 'ref.mov' }])
    expect(promptOf(input)).not.toContain('ref.mov:')
    expect(relay).toHaveBeenCalledWith(path.resolve(videoPath), 'video/quicktime', undefined)
  })

  it('degrades an audio container upstream cannot decode to a path mention (no localAudio, no sentinel)', async () => {
    const uploaded = path.join(tmpDir, 'uploads', 'sha-memo.m4a')
    const relay = vi.fn(async () => 'https://cos.example.com/relay/never')
    await writeProviderState(OMNI)
    const backend = makeBackend()
    const mgr = makeManager(backend, {
      relay,
      saved: [{ originalName: 'memo.m4a', localPath: uploaded, mime: 'audio/mp4', size: 9 }],
    })
        await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: '转写',
      model: OMNI,
      attachments: [{ name: 'memo.m4a', mime: 'audio/mp4', path: path.join(workspaceDir, 'memo.m4a'), size: 9 }],
      references: [],
    })
    await flushMicrotasks()

    const { input } = backend.calls[0]
    expect(sentinelsOf(input)).toEqual([])
    expect(input.items.some((item) => item.type === 'localAudio')).toBe(false)
    expect(promptOf(input)).toContain(`memo.m4a: ${uploaded}`)
    expect(relay).not.toHaveBeenCalled()
  })

  it('keeps the turn alive when the relay fails: the file falls back to a path mention', async () => {
    const uploaded = path.join(tmpDir, 'uploads', 'sha-clip.mp4')
    await writeProviderState(OMNI)
    const backend = makeBackend()
    const mgr = makeManager(backend, {
      relay: async () => { throw new Error('COS 503') },
      saved: [{ originalName: 'clip.mp4', localPath: uploaded, mime: 'video/mp4', size: 9 }],
    })
        await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: '看看',
      model: OMNI,
      attachments: [{ name: 'clip.mp4', mime: 'video/mp4', path: path.join(workspaceDir, 'clip.mp4'), size: 9 }],
      references: [],
    })
    await flushMicrotasks()

    expect(backend.calls).toHaveLength(1)
    const { input } = backend.calls[0]
    expect(sentinelsOf(input)).toEqual([])
    expect(promptOf(input)).toContain(`clip.mp4: ${uploaded}`)
  })

  it('leaves every other model on the codex-native path (localAudio item, video as path mention, relay untouched)', async () => {
    const audioPath = path.join(workspaceDir, 'voice.wav')
    await fs.writeFile(audioPath, 'wav')
    const videoPath = path.join(workspaceDir, 'ref.mov')
    await fs.writeFile(videoPath, 'mov')
    const relay = vi.fn(async () => 'https://cos.example.com/relay/never')
    await writeProviderState('gpt-5.6-sol')
    const backend = makeBackend()
    const mgr = makeManager(backend, { relay })
    await mgr.setAllowedRoots([workspaceDir])

    await mgr.sendMessage({
      content: '看看',
      model: 'gpt-5.6-sol',
      attachments: [],
      references: [
        localReference(audioPath, { openBehavior: 'audio', preview: { mime: 'audio/wav' } }),
        localReference(videoPath, { type: 'video', openBehavior: 'video', preview: { mime: 'video/quicktime' } }),
      ],
    })
    await flushMicrotasks()

    const { input } = backend.calls[0]
    expect(input.items).toContainEqual({ type: 'localAudio', path: path.resolve(audioPath) })
    expect(sentinelsOf(input)).toEqual([])
    expect(promptOf(input)).toContain(`ref.mov: ${path.resolve(videoPath)}`)
    expect(relay).not.toHaveBeenCalled()
  })
})
