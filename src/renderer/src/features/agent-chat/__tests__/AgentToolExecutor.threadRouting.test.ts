import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
import { getCodexArtifacts } from '../codexArtifactPersistence'
import { DETACHED_OUTPUT_THREAD_ID, resetDetachedToolOutputForTest } from '../detachedToolOutput'
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

  // 以前这里回退到活动线程:认不出是谁发起的导出,就记到用户正在看的对话头上,
  // 还和那个对话共用一份虚拟视口。现在落到游离线程,任何对话都不沾。
  it.each(THREAD_SENSITIVE)('%s:请求没带线程 id → 交给游离线程,不借用屏幕上的对话', async (tool) => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call(tool, { shapeId: 's1' }, undefined)

    expect(canvas.handle).toHaveBeenCalledTimes(1)
    expect(canvas.handle).toHaveBeenCalledWith(tool, { shapeId: 's1', threadId: DETACHED_OUTPUT_THREAD_ID })
  })

  it.each(THREAD_SENSITIVE)('%s:没带线程 id、屏幕上也没有对话 → 同样是游离线程(不是 undefined)', async (tool) => {
    await exec().call(tool, {}, undefined)

    expect(canvas.handle).toHaveBeenCalledWith(tool, { threadId: DETACHED_OUTPUT_THREAD_ID })
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

  it.each(DIRECTOR_TOOLS)('%s:请求没带线程 id → 交给游离线程,不借用屏幕上的对话', async (tool) => {
    useAgentChatStore.setState({ threadId: 'B' })
    await exec().call(tool, { action: 'x' }, undefined)

    expect(director.handle).toHaveBeenCalledTimes(1)
    expect(director.handle).toHaveBeenCalledWith(tool, { action: 'x', threadId: DETACHED_OUTPUT_THREAD_ID })
  })
})

/**
 * 认不出发起方的调用(主进程按 Codex `_meta` 查不到任何对话)= 游离调用。
 *
 * 以前渲染端拿「此刻屏幕上的对话」顶上:一位用户的日志里 1,512 次出图有 718 次
 * 是这样落的位,于是在人物图对话里看到了别的项目的场景图,而且每次重载都还在
 * (气泡被 recordCodexArtifact 记到了那个对话名下)。
 */
describe('游离调用:结果照样生成、照样保存,但不进任何对话', () => {
  const SAVED = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\stray.png'

  function everyArtifact(): ArtifactItem[] {
    const s = useAgentChatStore.getState()
    return [
      ...artifactsOf(s.messages),
      ...Object.values(s.threadSlices).flatMap((slice) => artifactsOf(slice?.messages ?? [])),
    ]
  }

  function installSave() {
    const save = vi.fn(async () => ({ ok: true as const, path: SAVED }))
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { attachments: { save } }
    return save
  }

  function registerApi(history = { init: vi.fn(async () => {}), addToHistory: vi.fn(async () => ({ id: 42 })) }) {
    const api = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    ServiceRegistry.register(SERVICE_KEYS.API, api)
    ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, history)
    return { api, history }
  }

  beforeEach(() => {
    resetDetachedToolOutputForTest()
    useAgentChatStore.setState({ notices: [] })
  })

  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('出图:屏幕上的对话里没有气泡,别的对话里也没有', async () => {
    registerApi()
    installSave()
    useAgentChatStore.setState({ threadId: 'B', messages: [], threadSlices: { A: { messages: [] } as never } })

    await exec().generateImage({ prompt: '别的项目的场景' }, undefined)

    expect(everyArtifact()).toHaveLength(0)
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })

  it('出图:生成中也不露面(不是「先画进来、完成后再撤」)', async () => {
    let finish: (v: { success: true; images: string[] }) => void = () => {}
    ServiceRegistry.register(SERVICE_KEYS.API, {
      generateImage: vi.fn(() => new Promise((r) => { finish = r })),
    })
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    const pending = exec().generateImage({ prompt: 'slow stray' }, undefined)
    expect(everyArtifact()).toHaveLength(0)

    finish({ success: true, images: ['data:image/png;base64,AAA'] })
    await pending
    expect(everyArtifact()).toHaveLength(0)
  })

  it('出图:图照样生成、文件照样落盘(挂在游离线程名下),路径照样回给 agent', async () => {
    const { api, history } = registerApi()
    const save = installSave()
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    const result = await exec().generateImage({ prompt: 'stray' }, undefined)

    expect(api.generateImage).toHaveBeenCalledTimes(1)
    expect(save).toHaveBeenCalledTimes(1)
    expect(save.mock.calls[0][0]).toMatchObject({ threadId: DETACHED_OUTPUT_THREAD_ID })
    // 历史记录(作品库)照记 —— 用户付了钱的图得找得到。
    expect(history.addToHistory).toHaveBeenCalledTimes(1)
    expect(result).toMatchObject({ ok: true, count: 1, historyId: 42, paths: [SAVED] })
  })

  // 这一条才是「重载之后还在」的根:气泡是一次性的,锚点是永久的。
  it('出图:不给任何对话记「重载后还原」的锚点', async () => {
    registerApi()
    installSave()
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    await exec().generateImage({ prompt: 'stray' }, undefined)

    expect(getCodexArtifacts('B')).toEqual([])
    expect(getCodexArtifacts(DETACHED_OUTPUT_THREAD_ID)).toEqual([])
    // 不只是这两个 id 没有:锚点库里一条都没写(没有落到别的什么 key 上)。
    expect(localStorage.getItem('catimation:codex-artifacts:v1')).toBeNull()
    // 对照:有主的调用会记 —— 否则上面几条在「压根不记」时也会通过。
    await exec().generateImage({ prompt: 'owned' }, 'B')
    expect(getCodexArtifacts('B')).toHaveLength(1)
  })

  it('出图:保存超时转后台的那条路也不往对话里补气泡', async () => {
    vi.useFakeTimers()
    try {
      let finishSave: (v: { ok: true; path: string }) => void = () => {}
      ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
        attachments: { save: vi.fn(() => new Promise((r) => { finishSave = r })) },
      }
      registerApi()
      useAgentChatStore.setState({ threadId: 'B', messages: [] })

      const pending = exec().generateImage({ prompt: 'stray' }, undefined)
      await vi.advanceTimersByTimeAsync(10_000)
      await expect(pending).resolves.toMatchObject({ ok: true, persistencePending: true })

      finishSave({ ok: true, path: SAVED })
      await vi.advanceTimersByTimeAsync(0)

      expect(everyArtifact()).toHaveLength(0)
      expect(getCodexArtifacts('B')).toEqual([])
    } finally {
      vi.useRealTimers()
    }
  })

  it('出图失败:错误照样抛给 agent,对话里不留错误气泡,也不提示', async () => {
    ServiceRegistry.register(SERVICE_KEYS.API, {
      generateImage: vi.fn(async () => ({ success: false, error: 'boom' })),
    })
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    await expect(exec().generateImage({ prompt: 'stray' }, undefined)).rejects.toThrow('boom')

    expect(everyArtifact()).toHaveLength(0)
    expect(useAgentChatStore.getState().notices).toEqual([])
  })

  it('批量出图:九张一张都不进对话,路径齐全', async () => {
    registerApi()
    installSave()
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    const result = (await exec().generateImages(
      { prompts: Array.from({ length: 9 }, (_, i) => `stray-${i}`) },
      undefined,
    )) as { successes: unknown[]; failures: unknown[]; savedPaths: string[] }

    expect(result.successes).toHaveLength(9)
    expect(result.failures).toEqual([])
    expect(result.savedPaths).toHaveLength(9)
    expect(everyArtifact()).toHaveLength(0)
  })

  it('告诉用户一次(全局提示),九张不刷九条', async () => {
    registerApi()
    installSave()
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    await exec().generateImages({ prompts: Array.from({ length: 9 }, (_, i) => `stray-${i}`) }, undefined)

    const notices = useAgentChatStore.getState().notices.filter((n) => n.kind === 'toolOutputDetached')
    expect(notices).toHaveLength(1)
    expect(notices[0].message).toContain('没有显示在任何对话里')
    expect(notices[0].message).toContain('已保存')
  })

  it('有主的调用不出这条提示', async () => {
    registerApi()
    installSave()
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    await exec().generateImage({ prompt: 'owned' }, 'B')

    expect(useAgentChatStore.getState().notices).toEqual([])
  })

  // 上面都是直接调私有方法。真实入口是主进程发来的 `agent:tool-request`:
  // 出图走「先回执、后台跑、跑完广播」那条路,线程 id 从 request 上取。
  it('从真实入口(主进程发来的请求)进来也一样:没带 threadId 的不进对话,带了的进它自己的对话', async () => {
    registerApi()
    const save = vi.fn(async () => ({ ok: true as const, path: SAVED }))
    let deliver: (request: Record<string, unknown>) => void = () => {}
    const sendImageTaskUpdate = vi.fn()
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      attachments: { save },
      agent: {
        onToolRequest: (listener: (request: Record<string, unknown>) => void) => {
          deliver = listener
          return () => {}
        },
        sendToolResponse: vi.fn(),
        sendImageTaskUpdate,
      },
    }
    useAgentChatStore.setState({ threadId: 'B', messages: [] })
    const stop = new AgentToolExecutor().start()

    deliver({ id: 'r1', toolName: 'generate_image', params: { prompt: 'stray', __taskId: 't1' } })
    await vi.waitFor(() =>
      expect(sendImageTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't1', status: 'succeeded' })),
    )
    expect(everyArtifact()).toHaveLength(0)
    // 主进程拿到的结果里路径是全的 —— agent 那边不受影响。
    expect(sendImageTaskUpdate.mock.calls[0][0].result).toMatchObject({ ok: true, paths: [SAVED] })

    deliver({ id: 'r2', toolName: 'generate_image', params: { prompt: 'owned', __taskId: 't2' }, threadId: 'B' })
    await vi.waitFor(() =>
      expect(sendImageTaskUpdate).toHaveBeenCalledWith(expect.objectContaining({ taskId: 't2', status: 'succeeded' })),
    )
    expect(artifactsOf(useAgentChatStore.getState().messages).map((i) => i.prompt)).toEqual(['owned'])

    stop()
  })

  it('真实入口的其它工具(同步回执那条路)也是从 request 上取线程', async () => {
    let deliver: (request: Record<string, unknown>) => void = () => {}
    const sendToolResponse = vi.fn()
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      agent: {
        onToolRequest: (listener: (request: Record<string, unknown>) => void) => {
          deliver = listener
          return () => {}
        },
        sendToolResponse,
      },
    }
    useAgentChatStore.setState({ threadId: 'B', messages: [] })
    const stop = new AgentToolExecutor().start()

    deliver({ id: 'r1', toolName: 'canvas_snapshot', params: {}, threadId: 'A' })
    deliver({ id: 'r2', toolName: 'director_capture', params: {} })
    await vi.waitFor(() => expect(sendToolResponse).toHaveBeenCalledTimes(2))

    expect(canvas.handle).toHaveBeenCalledWith('canvas_snapshot', { threadId: 'A' })
    expect(director.handle).toHaveBeenCalledWith('director_capture', { threadId: DETACHED_OUTPUT_THREAD_ID })

    stop()
  })
})

describe('游离调用:ask_user 不把问题弹给不相干的对话', () => {
  const QUESTION = {
    question: '用哪一版?',
    options: [
      { id: 'a', label: 'A 版' },
      { id: 'b', label: 'B 版' },
    ],
  }

  function choiceCards(): unknown[] {
    const s = useAgentChatStore.getState()
    const all = [...s.messages, ...Object.values(s.threadSlices).flatMap((slice) => slice?.messages ?? [])]
    return all.flatMap((m) => m.items.filter((i) => i.type === 'choiceRequest'))
  }

  it('立刻回答 agent「没人看到这个问题」,不挂起等超时', async () => {
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    const answer = (await exec().call('ask_user', QUESTION, undefined)) as {
      answered: boolean
      skipped?: boolean
      selected: unknown[]
      note?: string
    }

    expect(answer.answered).toBe(false)
    expect(answer.skipped).toBe(true)
    expect(answer.selected).toEqual([])
    // agent 得知道这不是用户点了「跳过」。
    expect(answer.note).toContain('没有展示给用户')
    expect(answer.note).toContain('不要当作用户已同意')
  })

  it('屏幕上的对话里不出现选项卡片', async () => {
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    await exec().call('ask_user', QUESTION, undefined)

    expect(choiceCards()).toHaveLength(0)
  })

  it('每次给出的是各自独立的回答对象(调用方改它不会污染下一次)', async () => {
    const first = (await exec().call('ask_user', QUESTION, undefined)) as { selected: unknown[]; note?: string }
    first.note = 'mutated'
    first.selected.push('x')
    const second = (await exec().call('ask_user', QUESTION, undefined)) as { selected: unknown[]; note?: string }

    expect(second.note).toContain('没有展示给用户')
    expect(second.selected).toEqual([])
  })

  it('对照:有主的 ask_user 仍然把卡片放进发起它的对话', async () => {
    useAgentChatStore.setState({ threadId: 'B', messages: [] })

    void exec().call('ask_user', QUESTION, 'B')
    await vi.waitFor(() => expect(choiceCards()).toHaveLength(1))
  })

  it('没有问题文本仍然报参数错误(游离不掩盖调用方的错)', async () => {
    await expect(exec().call('ask_user', { question: '  ' }, undefined)).rejects.toThrow(/requires a question/)
  })
})
