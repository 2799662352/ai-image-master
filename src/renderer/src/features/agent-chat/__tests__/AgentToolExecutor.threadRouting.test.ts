import { beforeEach, describe, expect, it, vi } from 'vitest'

// 本文件只关心「分发层把谁的线程 id 交给谁」,画布 / 导演台桥的内部不在范围内 ——
// 把两个桥单例换成探针,断言它们收到的 threadId。
vi.mock('../../agent-workspace/canvas/canvasBridge', () => ({
  canvasBridge: {
    hasEditor: vi.fn(() => true),
    waitForEditor: vi.fn(async () => ({}) as never),
    handle: vi.fn(async () => ({ ok: true })),
  },
}))
vi.mock('../../../components/shared/image-editors/director/directorBridge', () => ({
  directorBridge: {
    handle: vi.fn(async () => ({ ok: true })),
  },
}))

import { AgentToolExecutor } from '../AgentToolExecutor'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID } from '../imageChannels'
import { canvasBridge } from '../../agent-workspace/canvas/canvasBridge'
import { directorBridge } from '../../../components/shared/image-editors/director/directorBridge'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import type { ArtifactItem, Message } from '../../../../../types/agent-timeline'

const canvas = canvasBridge as unknown as { handle: ReturnType<typeof vi.fn> }
const director = directorBridge as unknown as { handle: ReturnType<typeof vi.fn> }

type Deferred = { resolve: (v: { success: true; images: string[] }) => void }
type Privates = {
  call: (toolName: string, params: Record<string, unknown>, threadId?: string) => Promise<unknown>
  generateImage: (params: unknown, requestThreadId?: string) => Promise<unknown>
  generateImages: (params: unknown, requestThreadId?: string) => Promise<unknown>
}

function exec(): Privates {
  return new AgentToolExecutor() as unknown as Privates
}

function artifactsOf(messages: Message[]): ArtifactItem[] {
  return messages.flatMap((m) => m.items.filter((i): i is ArtifactItem => i.type === 'artifact'))
}

/** 与 `switchThread` 同样的「快照旧的 → 装入新的」,去掉 IPC。 */
function switchTo(next: string): void {
  useAgentChatStore.setState((cur) => {
    const threadSlices = { ...cur.threadSlices }
    if (cur.threadId) {
      threadSlices[cur.threadId] = {
        messages: cur.messages,
        isRunning: cur.isRunning,
        tokenUsage: cur.tokenUsage,
        error: cur.error,
      }
    }
    const incoming = threadSlices[next]
    delete threadSlices[next]
    return { threadId: next, threadSlices, messages: incoming?.messages ?? [] }
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  localStorage.clear()
  useAgentChatStore.setState({
    messages: [],
    threadId: undefined,
    threadSlices: {},
    selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID,
  })
  ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, {
    init: vi.fn(async () => {}),
    addToHistory: vi.fn(async () => null),
  })
})

describe('出图气泡:按发起线程归属(已经正确,锁住别回退)', () => {
  it('A 在后台出图、用户已切到 B:A 的气泡只进 A,B 干净', async () => {
    const gens: Deferred[] = []
    ServiceRegistry.register(SERVICE_KEYS.API, {
      generateImage: vi.fn(() => new Promise((r) => gens.push({ resolve: r }))),
    })

    useAgentChatStore.setState({ threadId: 'A', messages: [] })
    const pending = exec().generateImage({ prompt: 'cat from A' }, 'A')
    switchTo('B')
    gens[0].resolve({ success: true, images: ['data:image/png;base64,AAA'] })
    await pending

    const s = useAgentChatStore.getState()
    expect(artifactsOf(s.messages)).toHaveLength(0)
    const a = artifactsOf(s.threadSlices.A?.messages ?? [])
    expect(a).toHaveLength(1)
    expect(a[0].status).toBe('done')
    expect(a[0].prompt).toBe('cat from A')
  })

  it('两个对话各出一张且交叉完成:各回各家', async () => {
    const gens: Record<string, Deferred> = {}
    ServiceRegistry.register(SERVICE_KEYS.API, {
      generateImage: vi.fn(
        (req: { prompt: string }) => new Promise((r) => { gens[req.prompt] = { resolve: r } }),
      ),
    })

    useAgentChatStore.setState({ threadId: 'A', messages: [] })
    const pa = exec().generateImage({ prompt: 'from A' }, 'A')
    switchTo('B')
    const pb = exec().generateImage({ prompt: 'from B' }, 'B')

    gens['from B'].resolve({ success: true, images: ['data:image/png;base64,BBB'] })
    await pb
    switchTo('A')
    gens['from A'].resolve({ success: true, images: ['data:image/png;base64,AAA'] })
    await pa

    const s = useAgentChatStore.getState()
    expect(s.threadId).toBe('A')
    expect(artifactsOf(s.messages).map((i) => i.prompt)).toEqual(['from A'])
    expect(artifactsOf(s.threadSlices.B?.messages ?? []).map((i) => i.prompt)).toEqual(['from B'])
  })

  it('批量 generate_images 同样各回各家', async () => {
    ServiceRegistry.register(SERVICE_KEYS.API, {
      generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,XXX'] })),
    })
    useAgentChatStore.setState({ threadId: 'B', messages: [] })
    await exec().generateImages({ prompts: ['p1', 'p2'] }, 'A')

    const s = useAgentChatStore.getState()
    expect(artifactsOf(s.messages)).toHaveLength(0)
    expect(artifactsOf(s.threadSlices.A?.messages ?? [])).toHaveLength(2)
  })
})

describe('画布导出类工具:按发起线程落附件,不是按「此刻屏幕上是谁」', () => {
  // 这五个工具会把导出的图 / 视频存成**线程附件**(FK 在 threadId),
  // canvas_focus_region 的虚拟视口也是按线程分的。
  const THREAD_SENSITIVE = [
    'canvas_snapshot',
    'get_canvas_image',
    'get_canvas_video',
    'save_snapshot',
    'canvas_focus_region',
  ] as const

  it.each(THREAD_SENSITIVE)('%s:A 后台发起、B 在前台 → 桥收到 A', async (tool) => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call(tool, { shapeId: 's1' }, 'A')

    expect(canvas.handle).toHaveBeenCalledTimes(1)
    expect(canvas.handle).toHaveBeenCalledWith(tool, { shapeId: 's1', threadId: 'A' })
  })

  it.each(THREAD_SENSITIVE)('%s:请求没带线程 id(老 codex / 手动调用)→ 仍回退到活动线程', async (tool) => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call(tool, {}, undefined)

    expect(canvas.handle).toHaveBeenCalledWith(tool, { threadId: 'B' })
  })

  it('与线程无关的画布工具:不注入 threadId,参数原样交给桥', async () => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call('canvas_create_shape', { type: 'note' }, 'A')

    expect(canvas.handle).toHaveBeenCalledWith('canvas_create_shape', { type: 'note' })
  })
})

describe('导演台工具:按发起线程落附件', () => {
  const DIRECTOR_TOOLS = ['director_capture', 'director_record', 'director_scene', 'director_snapshot'] as const

  it.each(DIRECTOR_TOOLS)('%s:A 后台发起、B 在前台 → 桥收到 A', async (tool) => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call(tool, { action: 'x' }, 'A')

    expect(director.handle).toHaveBeenCalledTimes(1)
    expect(director.handle).toHaveBeenCalledWith(tool, { action: 'x', threadId: 'A' })
  })

  it.each(DIRECTOR_TOOLS)('%s:请求没带线程 id → 仍回退到活动线程', async (tool) => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call(tool, { action: 'x' }, undefined)

    expect(director.handle).toHaveBeenCalledWith(tool, { action: 'x', threadId: 'B' })
  })
})
