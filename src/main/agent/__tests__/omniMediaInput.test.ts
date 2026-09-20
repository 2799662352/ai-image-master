/**
 * omniMediaInput — native audio / video for the omni main agent.
 *
 * Wire shapes pinned against the production Miau gateway (2026-09-20):
 *   input_audio needs `audio_url` + `format` ∈ {mp3,wav,amr,3gp,3gpp,aac} (400 otherwise);
 *   input_video needs `video_url`; both only inside user messages.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  buildOmniMediaSentinel,
  isNativeVideo,
  modelAcceptsNativeMedia,
  nativeAudioFormat,
  parseOmniMediaSentinel,
  planOmniNativeMedia,
  rewriteOmniMediaInput,
} from '../omniMediaInput'

const VIDEO_URL = 'https://cos.example.com/image-history/media-relay/2026/09/20/clip.mp4'
const AUDIO_URL = 'https://cos.example.com/image-history/media-relay/2026/09/20/talk.mp3'

describe('modelAcceptsNativeMedia', () => {
  it('is true only for the omni slug (3.7 / 3.8-max / gpt stay on the codex-native path)', () => {
    expect(modelAcceptsNativeMedia('qwen3.8-omni-flash')).toBe(true)
    expect(modelAcceptsNativeMedia(' qwen3.8-omni-flash ')).toBe(true)
    for (const other of ['qwen3.8-max', 'qwen3.7-max-dashscope', 'gpt-5.6-sol', '', undefined, null]) {
      expect(modelAcceptsNativeMedia(other)).toBe(false)
    }
  })
})

describe('nativeAudioFormat / isNativeVideo', () => {
  it('maps by extension first (case-insensitive, ignores query), then by mime; rejects containers upstream 400s on', () => {
    expect(nativeAudioFormat('C:/rec/talk.MP3')).toBe('mp3')
    expect(nativeAudioFormat('https://x/a.wav?sig=1')).toBe('wav')
    expect(nativeAudioFormat('https://x/blob', 'audio/aac')).toBe('aac')
    expect(nativeAudioFormat('https://x/blob', 'audio/mpeg; charset=binary')).toBe('mp3')
    // m4a / ogg / opus / flac: the gateway answers "Invalid format" — never send them natively.
    expect(nativeAudioFormat('C:/rec/a.m4a', 'audio/mp4')).toBeNull()
    expect(nativeAudioFormat('C:/rec/a.ogg', 'audio/ogg')).toBeNull()
    expect(nativeAudioFormat('C:/rec/a.flac')).toBeNull()
  })

  it('recognises video by mime or container extension', () => {
    expect(isNativeVideo('C:/v/开场-1.mp4')).toBe(true)
    expect(isNativeVideo('https://x/a.MOV?x=1')).toBe(true)
    expect(isNativeVideo('C:/v/blob', 'video/webm')).toBe(true)
    expect(isNativeVideo('C:/v/a.mp3')).toBe(false)
    expect(isNativeVideo('C:/v/a.png', 'image/png')).toBe(false)
  })
})

describe('sentinel round trip', () => {
  it('builds a single-line tag and parses it back (escaping quotes / ampersands in name and url)', () => {
    const audio = buildOmniMediaSentinel({ kind: 'audio', url: AUDIO_URL + '?a=1&b="2"', format: 'mp3', name: 'say "hi".mp3' })
    expect(audio).toBe(
      `<catimation_media kind="audio" name="say &quot;hi&quot;.mp3" format="mp3" url="${AUDIO_URL}?a=1&amp;b=&quot;2&quot;" />`,
    )
    expect(parseOmniMediaSentinel(audio)).toEqual({
      kind: 'audio', url: AUDIO_URL + '?a=1&b="2"', format: 'mp3', name: 'say "hi".mp3',
    })
    const video = buildOmniMediaSentinel({ kind: 'video', url: VIDEO_URL, name: '开场-1.mp4' })
    expect(parseOmniMediaSentinel(`  ${video}\n`)).toEqual({ kind: 'video', url: VIDEO_URL, name: '开场-1.mp4' })
  })

  it('refuses anything that is not exactly one well-formed https sentinel', () => {
    expect(parseOmniMediaSentinel('see <catimation_media kind="video" url="https://x/a.mp4" /> above')).toBeNull()
    expect(parseOmniMediaSentinel('<catimation_media kind="video" url="http://x/a.mp4" />')).toBeNull()
    expect(parseOmniMediaSentinel('<catimation_media kind="audio" url="https://x/a.mp3" />')).toBeNull() // no format
    expect(parseOmniMediaSentinel('<catimation_media kind="audio" format="m4a" url="https://x/a.m4a" />')).toBeNull()
    expect(parseOmniMediaSentinel('<catimation_media kind="image" url="https://x/a.png" />')).toBeNull()
    expect(parseOmniMediaSentinel('plain text')).toBeNull()
  })
})

describe('rewriteOmniMediaInput (bridge side)', () => {
  const sentinelVideo = buildOmniMediaSentinel({ kind: 'video', url: VIDEO_URL, name: 'clip.mp4' })
  const sentinelAudio = buildOmniMediaSentinel({ kind: 'audio', url: AUDIO_URL, format: 'mp3' })
  const body = () => ({
    model: 'qwen3.8-omni-flash',
    stream: true,
    input: [
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: sentinelVideo }] },
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: '看看这段' },
          { type: 'input_text', text: sentinelVideo },
          { type: 'input_text', text: sentinelAudio },
          { type: 'input_image', image_url: 'https://x/a.png', detail: 'auto' },
        ],
      },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: sentinelVideo }] },
      { type: 'function_call', name: 'x', arguments: '{}', call_id: 'c1' },
    ],
  })

  it('rewrites sentinel text parts of USER messages into DashScope Responses media parts, leaving everything else alone', () => {
    const b = body()
    expect(rewriteOmniMediaInput(b)).toBe(2)
    expect(b.input[1].content).toEqual([
      { type: 'input_text', text: '看看这段' },
      { type: 'input_video', video_url: VIDEO_URL },
      { type: 'input_audio', audio_url: AUDIO_URL, format: 'mp3' },
      { type: 'input_image', image_url: 'https://x/a.png', detail: 'auto' },
    ])
    // developer / assistant messages: upstream only takes media in user messages.
    expect(b.input[0].content).toEqual([{ type: 'input_text', text: sentinelVideo }])
    expect(b.input[2].content).toEqual([{ type: 'output_text', text: sentinelVideo }])
    expect(b.input[3]).toEqual({ type: 'function_call', name: 'x', arguments: '{}', call_id: 'c1' })
    // Replayed history hits the bridge again on the next turn — idempotent.
    expect(rewriteOmniMediaInput(b)).toBe(0)
  })

  it('does nothing for non-omni models (the sentinel stays readable text for them)', () => {
    for (const model of ['qwen3.8-max', 'grok-4.6', undefined]) {
      const b = { ...body(), model }
      expect(rewriteOmniMediaInput(b as Record<string, unknown>)).toBe(0)
      expect((b.input[1] as { content: unknown[] }).content[1]).toEqual({ type: 'input_text', text: sentinelVideo })
    }
  })

  it('tolerates bodies without input arrays or messages without a type tag', () => {
    expect(rewriteOmniMediaInput({ model: 'qwen3.8-omni-flash' })).toBe(0)
    const untagged = { model: 'qwen3.8-omni-flash', input: [{ role: 'user', content: [{ type: 'input_text', text: sentinelVideo }] }] }
    expect(rewriteOmniMediaInput(untagged)).toBe(1)
    expect(untagged.input[0].content).toEqual([{ type: 'input_video', video_url: VIDEO_URL }])
  })
})

describe('planOmniNativeMedia (main-process side)', () => {
  const relay = vi.fn(async (filePath: string) => `https://cos.example.com/relay/${filePath.split(/[\\/]/).pop()}`)

  it('relays local audio references + audio/video attachments into sentinels and drops the localAudio items', async () => {
    relay.mockClear()
    const plan = await planOmniNativeMedia({
      referenceItems: [
        { type: 'localImage', path: 'C:/u/a.png' },
        { type: 'localAudio', path: 'C:/u/voice.wav' },
        { type: 'audio', url: 'https://cdn.example.com/song.mp3?x=1' },
      ],
      videoReferences: [
        { label: 'ref.mov', path: 'C:/u/ref.mov' },
        { label: 'remote.mp4', url: 'https://cdn.example.com/remote.mp4' },
      ],
      attachments: [
        { originalName: '开场-1.mp4', mime: 'video/mp4', localPath: 'C:/u/uploads/abc.mp4', size: 126_094_328 },
        { originalName: 'talk.mp3', mime: 'audio/mpeg', localPath: 'C:/u/uploads/def.mp3', size: 1234 },
        { originalName: 'doc.pdf', mime: 'application/pdf', localPath: 'C:/u/uploads/ghi.pdf', size: 10 },
      ],
      relay,
    })

    // Images are not our business; audio items were consumed.
    expect(plan.referenceItems).toEqual([{ type: 'localImage', path: 'C:/u/a.png' }])
    expect(plan.mediaItems.map((item) => item.type === 'text' ? parseOmniMediaSentinel(item.text) : item)).toEqual([
      { kind: 'audio', url: 'https://cos.example.com/relay/voice.wav', format: 'wav', name: 'voice.wav' },
      { kind: 'audio', url: 'https://cdn.example.com/song.mp3?x=1', format: 'mp3', name: 'song.mp3' },
      { kind: 'video', url: 'https://cos.example.com/relay/ref.mov', name: 'ref.mov' },
      { kind: 'video', url: 'https://cdn.example.com/remote.mp4', name: 'remote.mp4' },
      { kind: 'video', url: 'https://cos.example.com/relay/abc.mp4', name: '开场-1.mp4' },
      { kind: 'audio', url: 'https://cos.example.com/relay/def.mp3', format: 'mp3', name: 'talk.mp3' },
    ])
    // Remote URLs are never re-uploaded; local files are relayed with a real mime + size.
    expect(relay.mock.calls.map(([p, mime, size]) => [p, mime, size])).toEqual([
      ['C:/u/voice.wav', 'audio/wav', undefined],
      ['C:/u/ref.mov', 'video/quicktime', undefined],
      ['C:/u/uploads/abc.mp4', 'video/mp4', 126_094_328],
      ['C:/u/uploads/def.mp3', 'audio/mpeg', 1234],
    ])
    expect([...plan.consumedAttachmentPaths].map((p) => p.replace(/\\/g, '/'))).toEqual(
      expect.arrayContaining([expect.stringMatching(/uploads\/abc\.mp4$/), expect.stringMatching(/uploads\/def\.mp3$/)]),
    )
    expect(plan.consumedAttachmentPaths.size).toBe(2)
    expect(plan.fallbackMentions).toEqual([])
  })

  it('degrades unsupported audio containers and relay failures to path mentions instead of failing the turn', async () => {
    const flaky = vi.fn(async (filePath: string) => {
      if (filePath.endsWith('.mp4')) throw new Error('COS 503')
      return `https://cos.example.com/relay/${filePath.split('/').pop()}`
    })
    const plan = await planOmniNativeMedia({
      referenceItems: [{ type: 'localAudio', path: 'C:/u/memo.m4a' }],
      videoReferences: [],
      attachments: [
        { originalName: 'clip.mp4', mime: 'video/mp4', localPath: 'C:/u/uploads/clip.mp4', size: 5 },
        { originalName: 'note.ogg', mime: 'audio/ogg', localPath: 'C:/u/uploads/note.ogg', size: 5 },
        { originalName: 'ok.wav', mime: 'audio/wav', localPath: 'C:/u/uploads/ok.wav', size: 5 },
      ],
      relay: flaky,
    })
    expect(plan.mediaItems).toHaveLength(1)
    expect(parseOmniMediaSentinel((plan.mediaItems[0] as { text: string }).text)).toMatchObject({ kind: 'audio', format: 'wav' })
    expect(plan.fallbackMentions).toEqual([
      'memo.m4a: C:/u/memo.m4a',
      'clip.mp4: C:/u/uploads/clip.mp4',
      'note.ogg: C:/u/uploads/note.ogg',
    ])
    // Consumed regardless: neither a `localAudio` (codex would strip it) nor a duplicate sentinel may follow.
    expect(plan.consumedAttachmentPaths.size).toBe(3)
  })

  it('deduplicates the same file reaching the plan twice', async () => {
    relay.mockClear()
    const plan = await planOmniNativeMedia({
      referenceItems: [{ type: 'localAudio', path: 'C:/u/uploads/same.mp3' }],
      videoReferences: [],
      attachments: [{ originalName: 'same.mp3', mime: 'audio/mpeg', localPath: 'C:/u/uploads/same.mp3', size: 1 }],
      relay,
    })
    expect(relay).toHaveBeenCalledTimes(1)
    expect(plan.mediaItems).toHaveLength(1)
  })
})
