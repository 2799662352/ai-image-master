import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { VoiceApi, VoiceRealtimeMessage } from '../../../../../types/voice'
import { QwenRealtimeAsrAdapter } from '../asr/qwenRealtimeAsrAdapter'
import { QwenRealtimeTtsAdapter } from '../tts/qwenRealtimeTtsAdapter'
import { SpeechGate, pcm16Base64 } from '../realtime/pcm'
import {
  createRealtimeOpener,
  type OpenRealtime,
  type RealtimeConnection,
  type RealtimeEvent,
  type RealtimeHandlers,
} from '../realtime/realtimeSocket'

class FakeConnection implements RealtimeConnection {
  sent: RealtimeEvent[] = []
  closed = false
  constructor(
    readonly model: string,
    private readonly handlers: RealtimeHandlers,
  ) {}
  send(event: RealtimeEvent): void {
    this.sent.push(event)
  }
  close(): void {
    this.closed = true
  }
  emit(event: RealtimeEvent): void {
    this.handlers.onEvent(event)
  }
  serverClose(reason = ''): void {
    this.handlers.onClose?.({ code: 1000, reason })
  }
  types(): string[] {
    return this.sent.map((event) => event.type)
  }
}

class FakeRealtime {
  connections: FakeConnection[] = []
  failures: Error[] = []
  open: OpenRealtime = async (model, handlers) => {
    const failure = this.failures.shift()
    if (failure) throw failure
    const connection = new FakeConnection(model, handlers)
    this.connections.push(connection)
    return connection
  }
  get last(): FakeConnection {
    return this.connections[this.connections.length - 1]
  }
}

function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error)
    reader.readAsText(blob)
  })
}

const LOUD = () => new Float32Array(2048).fill(0.2)
const QUIET = () => new Float32Array(2048)

function fakeCapture() {
  const state = { push: (_samples: Float32Array) => {}, stopped: 0 }
  const startCapture = vi.fn(async (onChunk: (samples: Float32Array) => void) => {
    state.push = onChunk
    return {
      stop: async () => {
        state.stopped += 1
      },
    }
  })
  return { state, startCapture }
}

describe('createRealtimeOpener', () => {
  function fakeApi() {
    let listener: ((message: VoiceRealtimeMessage) => void) | null = null
    const sent: [string, string][] = []
    const api: VoiceApi = {
      ensureAsrModel: vi.fn(),
      onAsrModelProgress: vi.fn(),
      realtimeOpen: vi.fn(async () => {
        // 主进程在 invoke 返回之前就推来了首条事件。
        listener?.({ id: 'rt_1', kind: 'event', data: '{"type":"session.created"}' })
        return { ok: true as const, id: 'rt_1' }
      }),
      realtimeSend: vi.fn((id: string, data: string) => sent.push([id, data])),
      realtimeClose: vi.fn(),
      onRealtimeMessage: (cb) => {
        listener = cb
        return () => undefined
      },
    }
    return { api, sent, push: (message: VoiceRealtimeMessage) => listener?.(message) }
  }

  it('replays events that arrived before the open call resolved, then routes the rest', async () => {
    const { api, push } = fakeApi()
    const events: string[] = []
    const onClose = vi.fn()
    await createRealtimeOpener(api)('qwen3-asr-flash-realtime', {
      onEvent: (event) => events.push(event.type),
      onClose,
    })
    push({ id: 'rt_1', kind: 'event', data: '{"type":"session.updated"}' })
    push({ id: 'rt_1', kind: 'event', data: 'not json' })
    push({ id: 'rt_1', kind: 'closed', code: 1000, reason: 'bye' })
    expect(events).toEqual(['session.created', 'session.updated'])
    expect(onClose).toHaveBeenCalledWith({ code: 1000, reason: 'bye' })
  })

  it('stamps an event_id on every outgoing event and surfaces open errors', async () => {
    const { api, sent } = fakeApi()
    const connection = await createRealtimeOpener(api)('qwen3-tts-flash-realtime', { onEvent: () => undefined })
    connection.send({ type: 'session.finish' })
    const payload = JSON.parse(sent[0][1]) as RealtimeEvent
    expect(sent[0][0]).toBe('rt_1')
    expect(payload.type).toBe('session.finish')
    expect(payload.event_id).toMatch(/^event_/)

    api.realtimeOpen = vi.fn(async () => ({ ok: false as const, error: '平台余额未就绪:请先选择计费池' }))
    await expect(
      createRealtimeOpener(api)('qwen3-tts-flash-realtime', { onEvent: () => undefined }),
    ).rejects.toThrow('请先选择计费池')
  })
})

describe('SpeechGate', () => {
  it('holds silence back, releases the preroll on speech, and closes after the hangover', () => {
    const gate = new SpeechGate({ chunkMs: 100, prerollMs: 200, hangoverMs: 300 })
    const quiet = [QUIET(), QUIET(), QUIET()]
    expect(quiet.flatMap((chunk) => gate.push(chunk))).toEqual([])

    const loud = LOUD()
    // 开口时带上最近两块预录。
    expect(gate.push(loud)).toEqual([quiet[1], quiet[2], loud])
    const tail = [QUIET(), QUIET(), QUIET()]
    expect(tail.map((chunk) => gate.push(chunk).length)).toEqual([1, 1, 1])
    expect(gate.push(QUIET())).toEqual([])
  })
})

describe('pcm16Base64', () => {
  it('encodes little-endian signed 16-bit samples with clipping', () => {
    const bytes = Uint8Array.from(atob(pcm16Base64(new Float32Array([0, 1, -1, 2]))), (c) => c.charCodeAt(0))
    const view = new DataView(bytes.buffer)
    expect([0, 2, 4, 6].map((offset) => view.getInt16(offset, true))).toEqual([0, 32767, -32768, 32767])
  })
})

describe('QwenRealtimeAsrAdapter', () => {
  let realtime: FakeRealtime
  let capture: ReturnType<typeof fakeCapture>
  let results: [string, boolean][]
  let onFault: ReturnType<typeof vi.fn>

  function makeAdapter() {
    return new QwenRealtimeAsrAdapter('zh', (text, partial) => results.push([text, partial]), {
      open: realtime.open,
      startCapture: capture.startCapture,
      onFault,
    })
  }

  beforeEach(() => {
    realtime = new FakeRealtime()
    capture = fakeCapture()
    results = []
    onFault = vi.fn()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('configures server VAD at 16 kHz and streams only while someone is speaking', async () => {
    const adapter = makeAdapter()
    await adapter.start()
    const connection = realtime.last
    expect(connection.model).toBe('qwen3-asr-flash-realtime')
    expect(connection.sent[0]).toEqual({
      type: 'session.update',
      session: {
        input_audio_format: 'pcm',
        sample_rate: 16000,
        input_audio_transcription: { language: 'zh' },
        turn_detection: { type: 'server_vad', threshold: 0.0, silence_duration_ms: 400 },
      },
    })

    capture.state.push(QUIET())
    expect(connection.types()).toEqual(['session.update'])
    capture.state.push(LOUD())
    expect(connection.types().filter((type) => type === 'input_audio_buffer.append')).toHaveLength(2)
    expect(connection.sent[2]).toEqual({ type: 'input_audio_buffer.append', audio: pcm16Base64(LOUD()) })
    expect(adapter.getStatus()).toBe('Running')
  })

  it('reports text+stash as partials and the completed transcript as final', async () => {
    await makeAdapter().start()
    const connection = realtime.last
    connection.emit({ type: 'conversation.item.input_audio_transcription.text', text: '今天', stash: '天气' })
    connection.emit({ type: 'conversation.item.input_audio_transcription.text', text: '', stash: '' })
    connection.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: '今天天气不错。' })
    expect(results).toEqual([
      ['今天天气', true],
      ['今天天气不错。', false],
    ])
  })

  it('drops audio while paused', async () => {
    const adapter = makeAdapter()
    await adapter.start()
    adapter.pause()
    capture.state.push(LOUD())
    expect(realtime.last.types()).toEqual(['session.update'])
    adapter.resume()
    capture.state.push(LOUD())
    expect(realtime.last.types()).toContain('input_audio_buffer.append')
  })

  it('on finish flushes the buffer with session.finish and waits for session.finished', async () => {
    const adapter = makeAdapter()
    await adapter.start()
    const connection = realtime.last
    capture.state.push(LOUD())

    const finishing = adapter.finish()
    await vi.waitFor(() => expect(connection.types()).toContain('session.finish'))
    expect(connection.closed).toBe(false)
    connection.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: '发出去' })
    connection.emit({ type: 'session.finished' })
    await finishing
    expect(results).toEqual([['发出去', false]])
    expect(connection.closed).toBe(true)
    expect(capture.state.stopped).toBe(1)
    expect(adapter.getStatus()).toBe('Stopped')
  })

  it('skips session.finish when nothing was sent and gives up waiting after a timeout', async () => {
    const silent = makeAdapter()
    await silent.start()
    await silent.finish()
    expect(realtime.last.types()).toEqual(['session.update'])

    vi.useFakeTimers()
    const slow = makeAdapter()
    await slow.start()
    capture.state.push(LOUD())
    const finishing = slow.finish()
    await vi.advanceTimersByTimeAsync(4000)
    await finishing
    expect(realtime.last.closed).toBe(true)
  })

  it('reconnects on the next utterance after the server dropped an idle connection', async () => {
    await makeAdapter().start()
    const first = realtime.last
    first.serverClose()

    capture.state.push(LOUD())
    await vi.waitFor(() => expect(realtime.connections).toHaveLength(2))
    const second = realtime.last
    await vi.waitFor(() => expect(second.types()).toEqual(['session.update', 'input_audio_buffer.append']))
    expect(first.types()).toEqual(['session.update'])
  })

  it('surfaces upstream errors while listening and fails the finish', async () => {
    const adapter = makeAdapter()
    await adapter.start()
    capture.state.push(LOUD())
    realtime.last.emit({ type: 'error', error: { code: 'Arrearage', message: '账户余额不足' } })
    expect(onFault).toHaveBeenCalledWith(new Error('账户余额不足'))

    const finishing = adapter.finish()
    await vi.waitFor(() => expect(realtime.last.types()).toContain('session.finish'))
    realtime.last.emit({ type: 'session.finished' })
    await expect(finishing).rejects.toThrow('千问实时识别没能完成这段语音')
  })

  it('does not open the microphone when the gateway refuses the connection', async () => {
    realtime.failures.push(new Error('平台余额未就绪:请先选择计费池'))
    await expect(makeAdapter().start()).rejects.toThrow('请先选择计费池')
    expect(capture.startCapture).not.toHaveBeenCalled()
  })
})

describe('QwenRealtimeTtsAdapter', () => {
  let realtime: FakeRealtime
  let created: Blob[]

  beforeEach(() => {
    realtime = new FakeRealtime()
    created = []
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        created.push(blob)
        return `blob:tts-${created.length}`
      }),
      revokeObjectURL: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('synthesizes one sentence per connection and returns the stitched mp3', async () => {
    const adapter = new QwenRealtimeTtsAdapter(realtime.open, 'Serena')
    const speech = adapter.generateSpeech({ text: '你好呀' })
    await vi.waitFor(() => expect(realtime.connections).toHaveLength(1))
    const connection = realtime.last
    expect(connection.model).toBe('qwen3-tts-flash-realtime')
    expect(connection.sent).toEqual([
      {
        type: 'session.update',
        session: {
          voice: 'Serena',
          mode: 'server_commit',
          language_type: 'Chinese',
          response_format: 'mp3',
          sample_rate: 24000,
        },
      },
      { type: 'input_text_buffer.append', text: '你好呀' },
      { type: 'input_text_buffer.commit' },
      { type: 'session.finish' },
    ])

    connection.emit({ type: 'response.audio.delta', delta: btoa('ID3') })
    connection.emit({ type: 'response.audio.delta', delta: btoa('mp3') })
    connection.emit({ type: 'session.finished' })
    const result = await speech
    expect(result?.url).toBe('blob:tts-1')
    expect(created[0].type).toBe('audio/mpeg')
    expect(await blobText(created[0])).toBe('ID3mp3')
    expect(connection.closed).toBe(true)
    result?.release?.()
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:tts-1')
  })

  it('switches voice without rebuilding the adapter', async () => {
    const adapter = new QwenRealtimeTtsAdapter(realtime.open)
    adapter.switchModel({ voice: 'Ethan', voicePrompt: 'ignored' })
    void adapter.generateSpeech({ text: '嗨' }).catch(() => undefined)
    await vi.waitFor(() => expect(realtime.connections).toHaveLength(1))
    expect((realtime.last.sent[0].session as { voice: string }).voice).toBe('Ethan')
  })

  it('fails on an upstream error or a connection that closes without audio', async () => {
    const adapter = new QwenRealtimeTtsAdapter(realtime.open)
    const failing = adapter.generateSpeech({ text: '一' })
    await vi.waitFor(() => expect(realtime.connections).toHaveLength(1))
    realtime.last.emit({ type: 'error', error: { code: 'InvalidParameter', message: 'voice not found' } })
    await expect(failing).rejects.toThrow('千问合成失败: voice not found')
    expect(realtime.last.closed).toBe(true)

    const dropped = adapter.generateSpeech({ text: '二' })
    await vi.waitFor(() => expect(realtime.connections).toHaveLength(2))
    realtime.last.serverClose('gateway timeout')
    await expect(dropped).rejects.toThrow('千问合成连接已断开: gateway timeout')
  })

  it('cancels and closes the connection when aborted', async () => {
    const adapter = new QwenRealtimeTtsAdapter(realtime.open)
    const abort = new AbortController()
    const speech = adapter.generateSpeech({ text: '停', signal: abort.signal })
    await vi.waitFor(() => expect(realtime.connections).toHaveLength(1))
    abort.abort()
    await expect(speech).rejects.toMatchObject({ name: 'AbortError' })
    expect(realtime.last.closed).toBe(true)
  })
})
