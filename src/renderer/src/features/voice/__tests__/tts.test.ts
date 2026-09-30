import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../services/api/ApiService', () => ({ SEED_AUDIO_SITE_KEY: 'miau-test' }))

import {
  markdownToSpeech,
  removeParentheses,
  speechTextFromReply,
  splitSentences,
  truncateForSpeech,
} from '../tts/speechText'
import { TtsAdapter, type GeneratedSpeech, type SpeechRequest } from '../tts/ttsAdapter'
import { TtsManager } from '../tts/ttsManager'
import { generateSpeechPieces } from '../tts/ttsGeneration'
import { SeedAudioTtsAdapter, buildSpeechPrompt } from '../tts/seedAudioTtsAdapter'
import { DEFAULT_VOICE_PROMPT } from '../voiceDefaults'

class ScriptedAdapter extends TtsAdapter {
  requests: string[] = []
  constructor(private readonly script: ((text: string) => GeneratedSpeech | null | Error)[]) {
    super()
  }
  async generateSpeech({ text }: SpeechRequest): Promise<GeneratedSpeech | null> {
    this.requests.push(text)
    const step = this.script.shift() ?? ((t: string) => ({ url: `blob:${t}` }))
    const result = step(text)
    if (result instanceof Error) throw result
    return result
  }
  switchModel(): void {}
}

const speechFor = (text: string): GeneratedSpeech => ({ url: `blob:${text}` })

describe('speech text', () => {
  it('splits on punctuation and merges neighbours up to the max length', () => {
    expect(splitSentences('你好，今天天气不错。我们出去走走吧！好不好？', 15)).toEqual([
      '你好，今天天气不错。',
      '我们出去走走吧！好不好？',
    ])
    expect(splitSentences('一。二。三。', 1)).toEqual(['一。', '二。', '三。'])
    expect(splitSentences('Hello, world. Fine!', 8)).toEqual(['Hello,', 'world.', 'Fine!'])
    expect(splitSentences('  ', 15)).toEqual([])
  })

  it('drops stage directions in parentheses and asterisks', () => {
    expect(removeParentheses('好的(点头)，我来（笑）看看*挥手*')).toBe('好的，我来看看')
  })

  it('reads markdown as plain speech', () => {
    const reply = [
      '## 结果',
      '改好了 **两处**,见 [PR #336](https://github.com/x/y/pull/336)。',
      '- 修了 `voskAdapter.ts`',
      '```ts',
      'const secret = 1',
      '```',
      '| a | b |',
      '| --- | --- |',
      '详情 https://example.com/very/long',
    ].join('\n')
    const speech = markdownToSpeech(reply)
    expect(speech).toBe('结果 改好了 两处,见 PR #336。 修了 voskAdapter.ts a b 详情')
    expect(speech).not.toMatch(/secret|https|\*\*|`|##/)
  })

  it('keeps identifiers with underscores intact', () => {
    expect(markdownToSpeech('调用 ask_user_tool 即可')).toBe('调用 ask_user_tool 即可')
  })

  it('truncates on a sentence boundary', () => {
    expect(truncateForSpeech('第一句。第二句很长很长。', 8)).toBe('第一句。')
    expect(truncateForSpeech('没有标点的长句子', 4)).toBe('没有标点')
    expect(truncateForSpeech('短', 10)).toBe('短')
    expect(speechTextFromReply('**好**(笑)。后面不念了。', 3)).toBe('好。')
  })
})

describe('TtsManager', () => {
  it('retries once with a 350 ms backoff, then gives up', async () => {
    const sleep = vi.fn(async () => {})
    const manager = new TtsManager({ sleep })
    const adapter = new ScriptedAdapter([() => new Error('upstream 503'), () => null])
    manager.setAdapter(adapter)
    expect(await manager.generateTts('你好')).toBeNull()
    expect(adapter.requests).toEqual(['你好', '你好'])
    expect(sleep).toHaveBeenCalledTimes(1)
    expect(sleep).toHaveBeenCalledWith(350)
    expect(manager.lastError).toBe('朗读引擎没有返回音频')
  })

  it('returns the second attempt when the first fails', async () => {
    const manager = new TtsManager({ sleep: async () => {} })
    manager.setAdapter(new ScriptedAdapter([() => new Error('timeout'), speechFor]))
    expect(await manager.generateTts('再来')).toEqual({ url: 'blob:再来' })
    expect(manager.lastError).toBeNull()
  })

  it('stops retrying once aborted and skips empty text', async () => {
    const abort = new AbortController()
    const manager = new TtsManager({ sleep: async () => abort.abort() })
    const adapter = new ScriptedAdapter([() => new Error('boom')])
    manager.setAdapter(adapter)
    expect(await manager.generateTts('x', abort.signal)).toBeNull()
    expect(adapter.requests).toEqual(['x'])
    expect(await manager.generateTts('   ')).toBeNull()
    expect(adapter.requests).toEqual(['x'])
  })
})

describe('generateSpeechPieces', () => {
  async function collect(manager: TtsManager, text: string, splitEnabled: boolean): Promise<string[]> {
    const urls: string[] = []
    for await (const piece of generateSpeechPieces(manager, { text, splitEnabled, maxSentenceLength: 6 })) {
      urls.push(piece.url)
    }
    return urls
  }

  it('speaks the whole reply in one piece when splitting is off', async () => {
    const manager = new TtsManager()
    const adapter = new ScriptedAdapter([])
    manager.setAdapter(adapter)
    expect(await collect(manager, '第一句。第二句。', false)).toEqual(['blob:第一句。第二句。'])
  })

  it('yields sentence by sentence and stops at the first failed one', async () => {
    const manager = new TtsManager({ sleep: async () => {} })
    const adapter = new ScriptedAdapter([speechFor, () => null, () => null])
    manager.setAdapter(adapter)
    expect(await collect(manager, '第一句。第二句。第三句。', true)).toEqual(['blob:第一句。'])
    expect(adapter.requests).toEqual(['第一句。', '第二句。', '第二句。'])
  })
})

describe('SeedAudioTtsAdapter', () => {
  it('asks for a verbatim, voice-only reading through the Miau gateway', async () => {
    const generateAudio = vi.fn(async () => ({ success: true, audioBase64: btoa('ID3fake'), format: 'mp3' }))
    const createObjectURL = vi.fn(() => 'blob:speech')
    const revokeObjectURL = vi.fn()
    Object.assign(URL, { createObjectURL, revokeObjectURL })
    const adapter = new SeedAudioTtsAdapter(() => ({ generateAudio }))
    adapter.switchModel({ voicePrompt: '一位低沉的男声' })
    const speech = await adapter.generateSpeech({ text: '你好。' })
    expect(generateAudio).toHaveBeenCalledWith(
      expect.objectContaining({
        input: buildSpeechPrompt('一位低沉的男声', '你好。'),
        responseFormat: 'mp3',
        siteKey: 'miau-test',
      }),
    )
    expect(buildSpeechPrompt('一位低沉的男声', '你好。')).toMatch(/^一位低沉的男声,一字不差地朗读.*不要背景音乐和音效:你好。$/)
    expect(buildSpeechPrompt('  ', 'x')).toContain(DEFAULT_VOICE_PROMPT)
    const blob = (createObjectURL.mock.calls[0] as unknown[])[0] as Blob
    expect(blob.type).toBe('audio/mpeg')
    expect(speech?.url).toBe('blob:speech')
    speech?.release?.()
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:speech')
  })

  it('turns a gateway failure into an error the manager can retry', async () => {
    const adapter = new SeedAudioTtsAdapter(() => ({
      generateAudio: async () => ({ success: false, error: '余额不足' }),
    }))
    await expect(adapter.generateSpeech({ text: 'x' })).rejects.toThrow('余额不足')
  })
})
