import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/ServiceBridge', () => ({
  ServiceRegistry: { getRequired: vi.fn() },
  SERVICE_KEYS: { API: 'api' },
}))
vi.mock('../../../services/api/ApiService', () => ({ SEED_AUDIO_SITE_KEY: 'miau-test' }))

import { AsrAdapter, type TranscriptionCallback } from '../asr/asrAdapter'
import { SoundPlayer } from '../audio/soundPlayer'
import { TtsAdapter, type GeneratedSpeech, type SpeechRequest } from '../tts/ttsAdapter'
import { TtsManager } from '../tts/ttsManager'
import { VoiceSession, type VoiceChatBridge } from '../voiceSession'
import { DEFAULT_VOICE_SETTINGS, useVoiceStore } from '../voiceStore'

class FakeAsr extends AsrAdapter {
  calls: string[] = []
  status = 'Stopped'
  constructor(callback: TranscriptionCallback) {
    super('zh', callback)
  }
  emit(text: string, partial: boolean): void {
    this.callback(text, partial)
  }
  start(): void {
    this.calls.push('start')
    this.status = 'Running'
  }
  stop(): void {
    this.calls.push('stop')
    this.status = 'Stopped'
  }
  getStatus(): string {
    return this.status
  }
  pause(): void {
    this.calls.push('pause')
    this.status = 'Paused'
  }
  resume(): void {
    this.calls.push('resume')
    this.status = 'Running'
  }
}

class FakeTts extends TtsAdapter {
  spoken: string[] = []
  voice = ''
  async generateSpeech({ text }: SpeechRequest): Promise<GeneratedSpeech | null> {
    this.spoken.push(text)
    return { url: `blob:${this.spoken.length}`, release: vi.fn() }
  }
  switchModel(info: { voicePrompt?: string }): void {
    this.voice = info.voicePrompt ?? ''
  }
}

class FakeAudio {
  crossOrigin: string | null = null
  onended: (() => void) | null = null
  onerror: (() => void) | null = null
  paused = true
  preload = ''
  volume = 1
  currentTime = 0
  constructor(readonly src: string) {}
  pause = vi.fn(() => {
    this.paused = true
  })
  play = vi.fn(async () => {
    this.paused = false
  })
  finish(): void {
    this.paused = true
    this.onended?.()
  }
}

function fakeChat() {
  const listeners = new Set<(running: boolean) => void>()
  const chat = {
    draft: '',
    running: false,
    thread: 't1' as string | undefined,
    reply: null as string | null,
    sent: [] as string[],
    allow: true,
    setRunning(running: boolean) {
      chat.running = running
      for (const listener of listeners) listener(running)
    },
  }
  const bridge: VoiceChatBridge = {
    getDraft: () => chat.draft,
    setDraft: (text) => {
      chat.draft = text
    },
    canSubmit: () => chat.allow && !chat.running,
    submit: async (text) => {
      chat.sent.push(text)
      chat.draft = ''
      chat.setRunning(true)
      return true
    },
    isRunning: () => chat.running,
    subscribeRunning: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    threadKey: () => chat.thread,
    latestReply: () => chat.reply,
  }
  return { chat, bridge }
}

let session: VoiceSession | null = null

function setup() {
  const { chat, bridge } = fakeChat()
  const asr: FakeAsr[] = []
  const tts = new FakeTts()
  const audio: FakeAudio[] = []
  const player = new SoundPlayer((url) => {
    const item = new FakeAudio(url)
    audio.push(item)
    return item as unknown as HTMLAudioElement
  })
  session = new VoiceSession(bridge, {
    createAsrAdapter: (_settings, callback) => {
      const adapter = new FakeAsr(callback)
      asr.push(adapter)
      return adapter
    },
    createTtsAdapter: () => tts,
    player,
    tts: new TtsManager({ sleep: async () => {} }),
    resumeDelayMs: 0,
    silenceSubmitMs: 60_000,
  })
  return { chat, asr, tts, audio, session }
}

async function listening(h: ReturnType<typeof setup>): Promise<FakeAsr> {
  h.session.toggleListening()
  await vi.waitFor(() => expect(useVoiceStore.getState().asr.running).toBe(true))
  return h.asr[0]
}

beforeEach(() => {
  useVoiceStore.setState({
    settings: { ...DEFAULT_VOICE_SETTINGS, sendDelayMs: 0 },
    asr: { enabled: false, loading: false, running: false },
    commitPending: null,
    modelProgress: null,
    speaking: false,
    audioLocked: false,
    error: null,
  })
})

afterEach(() => {
  session?.dispose()
  session = null
})

describe('VoiceSession', () => {
  it('sends a spoken sentence, reads the reply and then listens again', async () => {
    useVoiceStore.getState().updateSettings({ ttsEnabled: true, voicePrompt: '一位少女' })
    const h = setup()
    const mic = await listening(h)

    mic.emit('今天天气', true)
    expect(h.chat.draft).toBe('今天天气')
    mic.emit('今天天气怎么样', false)
    await vi.waitFor(() => expect(h.chat.sent).toEqual(['今天天气怎么样']))
    expect(mic.calls.at(-1)).toBe('pause')
    expect(useVoiceStore.getState().asr).toEqual({ enabled: true, loading: false, running: false })

    h.chat.reply = '**晴天**,适合出门。'
    h.chat.setRunning(false)
    await vi.waitFor(() => expect(h.audio).toHaveLength(1))
    expect(h.tts.spoken).toEqual(['晴天,适合出门。'])
    expect(h.tts.voice).toBe('一位少女')
    expect(useVoiceStore.getState().speaking).toBe(true)
    expect(mic.calls).not.toContain('resume')

    h.audio[0].finish()
    await vi.waitFor(() => expect(mic.calls).toContain('resume'))
    expect(useVoiceStore.getState().speaking).toBe(false)
    expect(useVoiceStore.getState().asr.running).toBe(true)
  })

  it('resumes right after the turn when reading is off', async () => {
    const h = setup()
    const mic = await listening(h)
    mic.emit('打开画布', false)
    await vi.waitFor(() => expect(h.chat.sent).toEqual(['打开画布']))
    h.chat.reply = '已打开。'
    h.chat.setRunning(false)
    await vi.waitFor(() => expect(mic.calls).toContain('resume'))
    expect(h.tts.spoken).toEqual([])
  })

  it('keeps the transcript in the input when a message cannot be sent now', async () => {
    const h = setup()
    const mic = await listening(h)
    h.chat.allow = false
    mic.emit('稍后再发', false)
    await vi.waitFor(() => expect(mic.calls).toContain('resume'))
    expect(h.chat.draft).toBe('稍后再发')
    expect(h.chat.sent).toEqual([])
  })

  it('does not wipe what the user typed when the mic turns on', async () => {
    const h = setup()
    h.chat.draft = '我自己打的字'
    await listening(h)
    expect(h.chat.draft).toBe('我自己打的字')
  })

  it('stops reading when the next turn starts', async () => {
    useVoiceStore.getState().updateSettings({ ttsEnabled: true })
    const h = setup()
    h.chat.setRunning(true)
    h.chat.reply = '很长的一段回复。'
    h.chat.setRunning(false)
    await vi.waitFor(() => expect(h.audio).toHaveLength(1))
    h.chat.setRunning(true)
    expect(h.audio[0].pause).toHaveBeenCalled()
    await vi.waitFor(() => expect(useVoiceStore.getState().speaking).toBe(false))
  })

  it('does not read a reply from another thread', async () => {
    useVoiceStore.getState().updateSettings({ ttsEnabled: true })
    const h = setup()
    h.chat.setRunning(true)
    h.chat.thread = 't2'
    h.chat.reply = '别的线程'
    h.chat.setRunning(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.tts.spoken).toEqual([])
  })

  it('waits for a pause before sending, and joins what is said within it', async () => {
    useVoiceStore.getState().updateSettings({ sendDelayMs: 150 })
    const h = setup()
    const mic = await listening(h)

    mic.emit('今天天气不错。', false)
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(h.chat.sent).toEqual([])
    expect(h.chat.draft).toBe('今天天气不错。')
    expect(useVoiceStore.getState().commitPending?.delayMs).toBe(150)
    expect(mic.calls).not.toContain('pause')

    mic.emit('我们', true)
    expect(useVoiceStore.getState().commitPending).toBeNull()
    expect(h.chat.draft).toBe('今天天气不错。我们')
    mic.emit('我们去公园吧。', false)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(h.chat.sent).toEqual([])

    await vi.waitFor(() => expect(h.chat.sent).toEqual(['今天天气不错。我们去公园吧。']))
    expect(useVoiceStore.getState().commitPending).toBeNull()
  })

  it('waits twice as long when the sentence trails off', async () => {
    useVoiceStore.getState().updateSettings({ sendDelayMs: 100 })
    const h = setup()
    const mic = await listening(h)
    mic.emit('我想要一个红色的，然后。', false)
    expect(useVoiceStore.getState().commitPending?.delayMs).toBe(200)
    await new Promise((resolve) => setTimeout(resolve, 130))
    expect(h.chat.sent).toEqual([])
    await vi.waitFor(() => expect(h.chat.sent).toHaveLength(1))
  })

  it('only fills the input box when auto-send is off, after what the user typed', async () => {
    useVoiceStore.getState().updateSettings({ autoSend: false })
    const h = setup()
    h.chat.draft = '备注：'
    const mic = await listening(h)

    mic.emit('你好', true)
    expect(h.chat.draft).toBe('备注：你好')
    mic.emit('你好。', false)
    await vi.waitFor(() => expect(mic.calls).toContain('resume'))
    expect(h.chat.draft).toBe('备注：你好。')
    expect(h.chat.sent).toEqual([])

    mic.emit('再见', true)
    expect(h.chat.draft).toBe('备注：你好。再见')
    mic.emit('再见。', false)
    await vi.waitFor(() => expect(mic.calls.filter((call) => call === 'resume')).toHaveLength(2))
    expect(h.chat.draft).toBe('备注：你好。再见。')
    expect(h.chat.sent).toEqual([])
    expect(useVoiceStore.getState().asr.running).toBe(true)
  })

  it('refuses to start holding when nothing can be sent', () => {
    const h = setup()
    h.chat.allow = false
    expect(() => h.session.beginHold()).toThrow('当前无法开始语音输入。')
    expect(h.asr).toHaveLength(0)
  })
})
