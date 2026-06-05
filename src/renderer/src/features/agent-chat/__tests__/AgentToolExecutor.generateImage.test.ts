import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { useAgentChatStore } from '../store'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import type { ArtifactItem } from '../../../../../types/agent-timeline'

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

beforeEach(() => {
  useAgentChatStore.setState({ messages: [] })
})

describe('AgentToolExecutor.generateImage', () => {
  it('forces gpt-image-2-vip regardless of the requested model', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())

    await callGenerate({ prompt: 'a cat', model: 'gpt-image-2', ratio: '16:9' })

    expect(api.generateImage).toHaveBeenCalledTimes(1)
    const sent = api.generateImage.mock.calls[0][0]
    expect(sent.model).toBe('gpt-image-2-vip')
    expect(sent.ratio).toBe('16:9')
    expect(sent.resolution).toBe('1K') // default applied
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

  it('appends a new assistant artifact bubble with one ref per image', async () => {
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
    expect(item.artifacts).toHaveLength(2)
    expect(item.artifacts[0].kind).toBe('image')
  })

  it('returns a COMPACT result without echoing base64 back to the agent', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: true, images: ['data:image/png;base64,AAA'] })) }
    registerFakes(api, makeHistory())

    const result = (await callGenerate({ prompt: 'a cat' })) as Record<string, unknown>

    expect(result).toEqual({ ok: true, count: 1, model: 'gpt-image-2-vip' })
    expect(JSON.stringify(result)).not.toContain('base64')
  })

  it('throws when generation fails (so the agent sees the error)', async () => {
    const api: ApiFake = { generateImage: vi.fn(async () => ({ success: false, error: 'boom' })) }
    registerFakes(api, makeHistory())

    await expect(callGenerate({ prompt: 'a cat' })).rejects.toThrow('boom')
    expect(useAgentChatStore.getState().messages).toHaveLength(0)
  })
})
