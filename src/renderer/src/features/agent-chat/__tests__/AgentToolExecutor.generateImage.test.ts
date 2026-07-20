import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useAgentChatStore } from '../store'
import { DEFAULT_IMAGE_CHANNEL_ID } from '../imageChannels'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import type { ArtifactItem } from '../../../../../types/agent-timeline'
import { getCodexArtifacts } from '../codexArtifactPersistence'

type ApiFake = { generateImage: ReturnType<typeof vi.fn> }
type HistoryFake = { init: ReturnType<typeof vi.fn>; addToHistory: ReturnType<typeof vi.fn> }

function registerFakes(api: ApiFake, history: HistoryFake) {
  ServiceRegistry.register(SERVICE_KEYS.API, api)
  ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, history)
}

function makeHistory(): HistoryFake {
  return { init: vi.fn(async () => {}), addToHistory: vi.fn(async () => null) }
}

// generateImage is private; reach it directly for a focused unit test.
function callGenerate(params: Record<string, unknown>): Promise<unknown> {
  return (new AgentToolExecutor() as unknown as { generateImage: (p: unknown) => Promise<unknown> }).generateImage(params)
}

function callGenerateBatch(
  params: Record<string, unknown>,
  executor = new AgentToolExecutor(),
): Promise<{ successes: unknown[]; failures: Array<{ index: number; error: string }>; savedPaths: string[] }> {
  return (
    executor as unknown as {
      generateImages: (
        p: unknown,
      ) => Promise<{ successes: unknown[]; failures: Array<{ index: number; error: string }>; savedPaths: string[] }>
    }
  ).generateImages(params)
}

function setChannel(id: string): void {
  useAgentChatStore.setState({ selectedImageChannel: id })
}

beforeEach(() => {
  localStorage.clear()
  // Reset to the default channel (VIP) before each test; individual tests set a
  // specific channel to exercise the authoritative-picker behavior.
  useAgentChatStore.setState({ messages: [], selectedImageChannel: DEFAULT_IMAGE_CHANNEL_ID })
})

describe('AgentToolExecutor.generateImage', () => {
  it('defaults to VIP (no site pin) when the user has not picked a channel', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())

    await callGenerate({ prompt: 'a cat', ratio: '16:9' })

    expect(api.generateImage).toHaveBeenCalledTimes(1)
    const sent = api.generateImage.mock.calls[0][0]
    expect(sent.model).toBe('gpt-image-2-vip') // default channel = VIP
    expect(sent.siteKey).toBeUndefined() // VIP is not Miau-only
    expect(sent.ratio).toBe('16:9')
    expect(sent.resolution).toBe('2K') // default applied
  })

  it('renders on the user-picked 腾讯 image2 channel and pins the Miau site', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    const history = makeHistory()
    registerFakes(api, history)
    setChannel('custom-imagemodel-gt')

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(api.generateImage.mock.calls[0][0].model).toBe('custom-imagemodel-gt')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBe('antigravity')
    expect(result.model).toBe('custom-imagemodel-gt')
    expect(history.addToHistory.mock.calls[0][4]).toBe('custom-imagemodel-gt')
  })

  it('renders on the user-picked 万相 2.7 pro channel and pins the Miau site', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('wan2.7-image-pro')

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(api.generateImage.mock.calls[0][0].model).toBe('wan2.7-image-pro')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBe('antigravity')
    expect(result.model).toBe('wan2.7-image-pro')
  })

  it('renders on the user-picked VIP channel and does NOT pin a site (uses current site)', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('gpt-image-2-vip')

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(api.generateImage.mock.calls[0][0].model).toBe('gpt-image-2-vip')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBeUndefined()
    expect(result.model).toBe('gpt-image-2-vip')
  })

  it('renders on the user-picked Seedream 5.0 Pro channel and pins the Miau site', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('doubao-seedream-5-0-pro-260628')

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(api.generateImage.mock.calls[0][0].model).toBe('doubao-seedream-5-0-pro-260628')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBe('antigravity')
    expect(result.model).toBe('doubao-seedream-5-0-pro-260628')
  })

  it('renders on the user-picked nano2 channel (gemini-3.1-flash-image), no site pin', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('gemini-3.1-flash-image')

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(api.generateImage.mock.calls[0][0].model).toBe('gemini-3.1-flash-image')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBeUndefined()
    expect(result.model).toBe('gemini-3.1-flash-image')
  })

  it('lets the agent OVERRIDE the user channel with an explicit valid model (agent autonomy)', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('gpt-image-2-vip') // user default = VIP

    // Agent deliberately switches to 万相 for a 组图 series → agent choice wins.
    await callGenerate({ prompt: '同一只猫的四季', model: 'wan2.7-image-pro' })

    expect(api.generateImage.mock.calls[0][0].model).toBe('wan2.7-image-pro')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBe('antigravity')
  })

  it('honors the user channel when the agent omits model (picker is the default)', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('custom-imagemodel-gt') // user picked 腾讯

    await callGenerate({ prompt: 'a cat' }) // no model → user default

    expect(api.generateImage.mock.calls[0][0].model).toBe('custom-imagemodel-gt')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBe('antigravity')
  })

  it('falls back to the user channel (then VIP) for an unknown/hallucinated agent model', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('gemini-3.1-flash-image') // user picked Nano2

    // Bogus model → not a valid override → falls back to the user's channel.
    await callGenerate({ prompt: 'a cat', model: 'totally-made-up-model' })

    expect(api.generateImage.mock.calls[0][0].model).toBe('gemini-3.1-flash-image')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBeUndefined()
  })

  it('falls back to VIP when the stored channel is stale/unknown', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())
    setChannel('totally-made-up-channel')

    await callGenerate({ prompt: 'a cat' })

    expect(api.generateImage.mock.calls[0][0].model).toBe('gpt-image-2-vip')
    expect(api.generateImage.mock.calls[0][0].siteKey).toBeUndefined()
  })

  it('records the image to history under the "codex" type', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    const history = makeHistory()
    registerFakes(api, history)

    await callGenerate({ prompt: 'a cat' })

    expect(history.addToHistory).toHaveBeenCalledTimes(1)
    const [type, prompt, urls, , model] = history.addToHistory.mock.calls[0]
    expect(type).toBe('codex')
    expect(prompt).toBe('a cat')
    expect(urls).toEqual(['data:image/png;base64,AAA'])
    expect(model).toBe('gpt-image-2-vip')
  })

  it('appends a new assistant artifact bubble with one ref per image (status done)', async () => {
    const api: ApiFake = {
      generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA', 'data:image/png;base64,BBB'] })),
    }
    registerFakes(api, makeHistory())

    await callGenerate({ prompt: 'two cats' })

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    expect(messages[0].role).toBe('assistant')
    const item = messages[0].items[0] as ArtifactItem
    expect(item.type).toBe('artifact')
    expect(item.status).toBe('done')
    expect(item.artifacts).toHaveLength(2)
    expect(item.artifacts[0].kind).toBe('image')
  })

  it('shows a generating bubble while the request is in flight', async () => {
    let resolveGen: (v: { success: true; images: string[] }) => void = () => {}
    const api: ApiFake = {
      generateImage: vi.fn(() => new Promise((r) => { resolveGen = r })),
    }
    registerFakes(api, makeHistory())

    const pending = callGenerate({ prompt: 'a slow cat' })

    // Bubble appears immediately in the generating state, before resolution.
    const inFlight = useAgentChatStore.getState().messages[0].items[0] as ArtifactItem
    expect(inFlight.status).toBe('generating')
    expect(inFlight.prompt).toBe('a slow cat')
    expect(inFlight.artifacts).toHaveLength(0)

    resolveGen({ success: true, images: ['data:image/png;base64,AAA'] })
    await pending

    const settled = useAgentChatStore.getState().messages[0].items[0] as ArtifactItem
    expect(settled.status).toBe('done')
    expect(settled.artifacts).toHaveLength(1)
  })

  it('returns a COMPACT result without echoing base64 back to the agent', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    // No threadId / no attachments API in this test → nothing saved locally,
    // history fake returns null. Compact shape only; never any base64.
    expect(result).toEqual({ ok: true, count: 1, model: 'gpt-image-2-vip', historyId: null, paths: [] })
    expect(JSON.stringify(result)).not.toContain('base64')
  })

  it('returns the saved local file path(s) so the agent can read/move them (codex-native parity)', async () => {
    // Codex native image_gen always reports the saved path; replicate that.
    useAgentChatStore.setState({ messages: [], threadId: 'thread-1' })
    const savedPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\deadbeef.png'
    const save = vi.fn(async () => ({ ok: true as const, path: savedPath }))
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = { attachments: { save } }

    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    const history: HistoryFake = { init: vi.fn(async () => {}), addToHistory: vi.fn(async () => ({ id: 42 })) }
    registerFakes(api, history)

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(save).toHaveBeenCalledTimes(1)
    expect(result).toEqual({
      ok: true,
      count: 1,
      model: 'gpt-image-2-vip',
      historyId: 42,
      paths: [savedPath],
    })
    expect(getCodexArtifacts('thread-1')[0]).toMatchObject({
      historyId: 42,
      paths: [savedPath],
    })
    expect(JSON.stringify(result)).not.toContain('base64')

    // The bubble carries the prominent "saved" banner with the folder.
    const item = useAgentChatStore.getState().messages[0].items[0] as ArtifactItem
    expect(item.save).toMatchObject({
      status: 'saved',
      dir: 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads',
      paths: [savedPath],
    })

    useAgentChatStore.setState({ threadId: undefined })
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('returns success WITHOUT blocking when history persistence hangs (generation alone decides success)', async () => {
    // Reproduces the Prisma P1017 wedge: the image rendered fine but
    // addToHistory never settles. The tool response must NOT wait on it.
    vi.useFakeTimers()
    try {
      const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
      const history: HistoryFake = {
        init: vi.fn(async () => {}),
        addToHistory: vi.fn(() => new Promise(() => {})), // hangs forever
      }
      registerFakes(api, history)

      const pending = callGenerate({ prompt: 'a cat' })
      // Burn through the persistence budget; generation itself already resolved.
      await vi.advanceTimersByTimeAsync(10_000)
      const result = (await pending) as Record<string, unknown>

      expect(result).toEqual({
        ok: true,
        count: 1,
        model: 'gpt-image-2-vip',
        historyId: null,
        paths: [],
        persistencePending: true,
      })

      // The user-facing bubble settled long before the budget expired, AND it
      // carries the eye-catching "saving in background" banner state.
      const item = useAgentChatStore.getState().messages[0].items[0] as ArtifactItem
      expect(item.status).toBe('done')
      expect(item.save).toEqual({ status: 'pending' })
    } finally {
      vi.useRealTimers()
    }
  })

  it('flips the SAME bubble banner from pending → saved when the late save settles', async () => {
    vi.useFakeTimers()
    try {
      const savedPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\late.png'
      useAgentChatStore.setState({ messages: [], threadId: 'thread-late' })
      let resolveSave: (v: { ok: true; path: string }) => void = () => {}
      ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
        attachments: { save: vi.fn(() => new Promise((r) => { resolveSave = r })) },
      }
      const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
      const history: HistoryFake = { init: vi.fn(async () => {}), addToHistory: vi.fn(async () => ({ id: 7 })) }
      registerFakes(api, history)

      const pending = callGenerate({ prompt: 'a cat' })
      await vi.advanceTimersByTimeAsync(10_000)
      await pending

      const pendingItem = useAgentChatStore.getState().messages[0].items[0] as ArtifactItem
      expect(pendingItem.save).toEqual({ status: 'pending' })

      // Background save finally settles → same bubble shows the saved folder.
      resolveSave({ ok: true, path: savedPath })
      await vi.advanceTimersByTimeAsync(0)

      const savedItem = useAgentChatStore.getState().messages[0].items[0] as ArtifactItem
      expect(savedItem.save).toMatchObject({ status: 'saved', paths: [savedPath] })
      expect(savedItem.save?.dir).toBe('C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads')
    } finally {
      useAgentChatStore.setState({ threadId: undefined })
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
      vi.useRealTimers()
    }
  })

  it('throws when generation fails and leaves an error bubble (so the agent + user see it)', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: false, error: 'boom' })) }
    registerFakes(api, makeHistory())

    await expect(callGenerate({ prompt: 'a cat' })).rejects.toThrow('boom')

    const { messages } = useAgentChatStore.getState()
    expect(messages).toHaveLength(1)
    const item = messages[0].items[0] as ArtifactItem
    expect(item.status).toBe('error')
    expect(item.error).toBe('boom')
  })

  describe('referenceImages resolution (codex passes uploads-dir file paths)', () => {
    function setAttachments(readThumb: ReturnType<typeof vi.fn> | undefined) {
      ;(window as unknown as { electronAPI?: unknown }).electronAPI = readThumb
        ? { attachments: { readThumb } }
        : {}
    }

    afterEach(() => {
      delete (window as unknown as { electronAPI?: unknown }).electronAPI
    })

    it('reads a local path ref via attachments.readThumb and inlines it as a data URL', async () => {
      const readThumb = vi.fn(async () => ({ ok: true, base64: 'QUJD', mime: 'image/jpeg' }))
      setAttachments(readThumb)
      const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
      registerFakes(api, makeHistory())

      const localPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\abc.jpg'
      await callGenerate({ prompt: 'edit this', referenceImages: [localPath] })

      expect(readThumb).toHaveBeenCalledWith(localPath)
      const sent = api.generateImage.mock.calls[0][0]
      expect(sent.referenceImages).toEqual(['data:image/jpeg;base64,QUJD'])
    })

    it('passes data: and http(s) refs through without touching readThumb', async () => {
      const readThumb = vi.fn()
      setAttachments(readThumb)
      const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
      registerFakes(api, makeHistory())

      await callGenerate({
        prompt: 'mix',
        referenceImages: ['data:image/png;base64,ZZZ', 'https://example.com/x.png'],
      })

      expect(readThumb).not.toHaveBeenCalled()
      const sent = api.generateImage.mock.calls[0][0]
      expect(sent.referenceImages).toEqual(['data:image/png;base64,ZZZ', 'https://example.com/x.png'])
    })

    it('throws an explicit error (and never calls the API) when no ref can be read', async () => {
      const readThumb = vi.fn(async () => ({ ok: false, reason: 'file not found' }))
      setAttachments(readThumb)
      const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
      registerFakes(api, makeHistory())

      await expect(
        callGenerate({ prompt: 'edit', referenceImages: ['C:\\nope.jpg'] }),
      ).rejects.toThrow(/参考图无法读取/)
      expect(api.generateImage).not.toHaveBeenCalled()
      // No dangling "generating" bubble — resolution failed before begin.
      expect(useAgentChatStore.getState().messages).toHaveLength(0)
    })
  })
})

describe('AgentToolExecutor.generateImages', () => {
  afterEach(() => {
    delete (window as unknown as { electronAPI?: unknown }).electronAPI
  })

  it('runs a 9-image batch with bounded concurrency while preserving result order', async () => {
    const executor = new AgentToolExecutor()
    const prompts = Array.from({ length: 9 }, (_, i) => `shot-${i + 1}`)
    let active = 0
    let maxActive = 0

    ;(
      executor as unknown as {
        generateImage: (params: { prompt: string }) => Promise<{ ok: true; paths: string[] }>
      }
    ).generateImage = vi.fn(async ({ prompt }) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((resolve) => setTimeout(resolve, 5))
      active--
      return { ok: true, paths: [`C:\\out\\${prompt}.png`] }
    })

    const result = await callGenerateBatch({ prompts }, executor)

    expect(maxActive).toBe(3)
    expect(result.successes).toHaveLength(9)
    expect(result.failures).toEqual([])
    expect(result.savedPaths).toEqual(prompts.map((prompt) => `C:\\out\\${prompt}.png`))
  })

  it('reads one shared local reference at full fidelity only once before fan-out', async () => {
    const localPath = 'C:\\Users\\me\\AppData\\Roaming\\app\\agent\\uploads\\large.png'
    const readThumb = vi.fn(async () => ({
      ok: true as const,
      base64: 'FULL_RESOLUTION',
      mime: 'image/png',
    }))
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
      attachments: { readThumb },
    }

    const api: ApiFake = {
      generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })),
    }
    registerFakes(api, makeHistory())
    const prompts = Array.from({ length: 9 }, (_, i) => `variation-${i + 1}`)

    const result = await callGenerateBatch({ prompts, referenceImages: [localPath] })

    expect(result.successes).toHaveLength(9)
    expect(readThumb).toHaveBeenCalledTimes(1)
    expect(readThumb).toHaveBeenCalledWith(localPath)
    expect(api.generateImage).toHaveBeenCalledTimes(9)
    for (const [request] of api.generateImage.mock.calls) {
      expect(request.referenceImages).toEqual(['data:image/png;base64,FULL_RESOLUTION'])
    }
  })
})
