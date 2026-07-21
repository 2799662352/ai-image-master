import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentToolExecutor } from '../AgentToolExecutor'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import { getAudioLibraryStore } from '../../audio/AudioLibraryStore'

/**
 * codex MCP `generate_audio` 的渲染层处理:复用与音频页相同的
 * generateAudioToLibrary 共享核心。这里验证 ApiService 调用契约、三级持久化
 * 落库、以及回给 main(audioTools)的 banner 结构体。
 */

type AudioApiFake = { generateAudio: ReturnType<typeof vi.fn> }

function registerApi(api: AudioApiFake): void {
  ServiceRegistry.register(SERVICE_KEYS.API, api)
}

// generateAudio 是私有方法,和 generateImage 测试一样直达。
function callGenerateAudio(params: Record<string, unknown>): Promise<any> {
  return (new AgentToolExecutor() as unknown as { generateAudio: (p: unknown) => Promise<any> }).generateAudio(params)
}

beforeEach(async () => {
  localStorage.clear()
  // 清空共享内存库(jsdom 无 IndexedDB → AudioLibraryStore 走内存降级)
  const store = getAudioLibraryStore()
  for (const item of await store.list()) await store.remove(item.id)
})

afterEach(() => {
  delete (window as any).electronAPI
})

describe('AgentToolExecutor.generate_audio', () => {
  it('generates via ApiService with Miau pin and persists to COS + local + library', async () => {
    const generateAudio = vi.fn(async () => ({
      success: true,
      audioBase64: 'QUJD',
      format: 'mp3',
      duration: 8.2,
      originalDuration: 9,
    }))
    registerApi({ generateAudio })
    const uploadCos = vi.fn(async () => ({ success: true as const, url: 'https://cos.example.com/image-history/audio/a.mp3', key: 'k' }))
    const save = vi.fn(async () => ({ success: true as const, filePath: 'C:\\ud\\audio-history\\a.mp3' }))
    ;(window as any).electronAPI = { audioHistory: { uploadCos, save } }

    const result = await callGenerateAudio({ input: '一位女声说:你好。', format: 'mp3' })

    // ApiService 调用契约:input + Miau 站点 pin
    const sent = generateAudio.mock.calls[0][0]
    expect(sent.input).toBe('一位女声说:你好。')
    expect(sent.siteKey).toBe('antigravity')
    expect(sent.responseFormat).toBe('mp3')

    // 回给 main 的 banner 结构体
    expect(result.success).toBe(true)
    expect(result.remoteUrl).toContain('image-history/audio/')
    expect(result.filePath).toBe('C:\\ud\\audio-history\\a.mp3')
    expect(result.duration).toBe(8.2)
    expect(result.billedSeconds).toBe(9)

    // 落进共享作品库(音频页能看到)
    const items = await getAudioLibraryStore().list()
    expect(items.length).toBe(1)
    expect(items[0].prompt).toBe('一位女声说:你好。')
  })

  it('shows a chat artifact bubble (spinner → audio player) in the requesting thread', async () => {
    registerApi({
      generateAudio: vi.fn(async () => ({ success: true, audioBase64: 'QUJD', format: 'mp3', duration: 6 })),
    })
    ;(window as any).electronAPI = {
      audioHistory: { uploadCos: vi.fn(async () => ({ success: true as const, url: 'https://cos.example.com/audio/a.mp3', key: 'k' })) },
    }
    const { useAgentChatStore } = await import('../store')
    useAgentChatStore.setState({ messages: [], threadId: undefined })

    await callGenerateAudio({ input: '念一段旁白' })

    const items = useAgentChatStore.getState().messages.flatMap((m) => m.items)
    const artifact = items.find((i) => i.type === 'artifact') as any
    expect(artifact).toBeDefined()
    expect(artifact.status).toBe('done')
    expect(artifact.mediaKind).toBe('audio')
    expect(artifact.artifacts[0].uri).toBe('https://cos.example.com/audio/a.mp3')
    expect(artifact.artifacts[0].mime).toBe('audio/mpeg')
  })

  it('marks the bubble as error when generation fails', async () => {
    registerApi({ generateAudio: vi.fn(async () => ({ success: false, error: 'boom' })) })
    ;(window as any).electronAPI = { audioHistory: {} }
    const { useAgentChatStore } = await import('../store')
    useAgentChatStore.setState({ messages: [], threadId: undefined })

    await callGenerateAudio({ input: 'x' })

    const artifact = useAgentChatStore.getState().messages.flatMap((m) => m.items).find((i) => i.type === 'artifact') as any
    expect(artifact.status).toBe('error')
    expect(artifact.error).toBe('boom')
  })

  it('passes reference audios and non-default speed through', async () => {
    const generateAudio = vi.fn(async () => ({ success: true, audioBase64: 'QUJD', format: 'mp3', duration: 3 }))
    registerApi({ generateAudio })
    ;(window as any).electronAPI = { audioHistory: {} }

    await callGenerateAudio({
      input: '融合风格朗读',
      speed: 1.5,
      referenceAudios: ['https://example.com/ref.mp3'],
    })

    const sent = generateAudio.mock.calls[0][0]
    expect(sent.speed).toBe(1.5)
    expect(sent.referenceAudios).toEqual(['https://example.com/ref.mp3'])
  })

  it('returns a structured error when generation fails (no throw)', async () => {
    registerApi({ generateAudio: vi.fn(async () => ({ success: false, error: 'speaker not found' })) })
    ;(window as any).electronAPI = { audioHistory: {} }

    const result = await callGenerateAudio({ input: 'x' })
    expect(result.success).toBe(false)
    expect(result.error).toContain('speaker not found')
    expect((await getAudioLibraryStore().list()).length).toBe(0)
  })

  it('rejects empty input before calling the API', async () => {
    const generateAudio = vi.fn()
    registerApi({ generateAudio })
    const result = await callGenerateAudio({ input: '   ' })
    expect(result.success).toBe(false)
    expect(generateAudio).not.toHaveBeenCalled()
  })
})
