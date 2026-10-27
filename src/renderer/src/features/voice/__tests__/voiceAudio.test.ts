import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SoundPlayer, type VoicePlaybackSignal } from '../audio/soundPlayer'
import { VoiceAnalyser } from '../audio/voiceAnalyser'
import { bindAvatarVoice, routeAvatarVoice, type AvatarVoiceTarget } from '../voiceRoute'

class FakeAudio {
  currentTime = 0
  crossOrigin: string | null = null
  onended: (() => unknown) | null = null
  onerror: (() => unknown) | null = null
  paused = true
  preload = ''
  volume = 1

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

function harness(onMouth?: (name: string, value: number) => void) {
  const audio: FakeAudio[] = []
  const player = new SoundPlayer((url) => {
    const item = new FakeAudio(url)
    audio.push(item)
    return item as unknown as HTMLAudioElement
  }, onMouth)
  const signals: VoicePlaybackSignal[] = []
  player.subscribeVoiceSignal((signal) => signals.push(signal))
  return { audio, player, signals }
}

const flush = async () => {
  await Promise.resolve()
  await Promise.resolve()
}

describe('SoundPlayer', () => {
  it('keeps the queued speaker and clears the analyser between voices', async () => {
    const start = vi.spyOn(VoiceAnalyser.prototype, 'start').mockImplementation(() => {})
    const stop = vi.spyOn(VoiceAnalyser.prototype, 'stop').mockImplementation(() => {})
    const { audio, player } = harness(vi.fn())
    player.playVoice('one', 'one.mp3', 1, 'A')
    player.playVoice('two', 'two.mp3', 1, 'B')
    await flush()
    expect(start).toHaveBeenLastCalledWith(audio[0], 'A')
    audio[0].finish()
    await flush()
    expect(stop).toHaveBeenCalled()
    expect(start).toHaveBeenLastCalledWith(audio[1], 'B')
    player.stopVoice()
    expect(stop).toHaveBeenCalledTimes(2)
    player.dispose()
    start.mockRestore()
    stop.mockRestore()
  })

  it('plays voices one at a time and signals start and finish in order', async () => {
    const { audio, player, signals } = harness()
    player.playVoice('voice-1', 'voice-1.mp3')
    player.playVoice('voice-2', 'voice-2.mp3')
    await flush()
    expect(audio).toHaveLength(1)
    expect(audio[0]).toMatchObject({ src: 'voice-1.mp3', crossOrigin: 'anonymous' })
    audio[0].finish()
    await flush()
    expect(audio).toHaveLength(2)
    expect(audio[1].src).toBe('voice-2.mp3')
    audio[1].finish()
    expect(signals).toEqual([
      { playbackId: 'voice-1', state: 'started' },
      { playbackId: 'voice-1', state: 'finished' },
      { playbackId: 'voice-2', state: 'started' },
      { playbackId: 'voice-2', state: 'finished' },
    ])
  })

  it('reports a failed voice and moves on to the next one', async () => {
    const { audio, player, signals } = harness()
    player.playVoice('bad', 'bad.mp3')
    player.playVoice('good', 'good.mp3')
    await flush()
    audio[0].onerror?.()
    await flush()
    expect(signals).toContainEqual({ playbackId: 'bad', state: 'failed', error: 'audio playback failed' })
    expect(audio[1].src).toBe('good.mp3')
  })

  it('stopVoice with an id only drops that queued voice', async () => {
    const { audio, player } = harness()
    player.playVoice('a', 'a.mp3')
    player.playVoice('b', 'b.mp3')
    player.playVoice('c', 'c.mp3')
    player.stopVoice('b')
    await flush()
    audio[0].finish()
    await flush()
    expect(audio.map((item) => item.src)).toEqual(['a.mp3', 'c.mp3'])
  })

  it('does not report voice start until autoplay is unlocked', async () => {
    const blocked = Object.assign(new Error('autoplay blocked'), { name: 'NotAllowedError' })
    const audio = new FakeAudio('voice.mp3')
    audio.play.mockRejectedValueOnce(blocked)
    const player = new SoundPlayer(() => audio as unknown as HTMLAudioElement)
    const signals: VoicePlaybackSignal[] = []
    const locks: boolean[] = []
    player.subscribeVoiceSignal((signal) => signals.push(signal))
    player.subscribeLock((locked) => locks.push(locked))

    player.playVoice('voice-locked', 'voice.mp3')
    await flush()
    expect(signals).toEqual([])
    expect(locks.at(-1)).toBe(true)

    await player.unlock()
    expect(locks.at(-1)).toBe(false)
    expect(signals).toEqual([{ playbackId: 'voice-locked', state: 'started' }])
    audio.finish()
    expect(signals.at(-1)).toEqual({ playbackId: 'voice-locked', state: 'finished' })
  })
})

describe('VoiceAnalyser', () => {
  let tick: FrameRequestCallback
  const disconnect = vi.fn()
  const source = { connect: vi.fn(), disconnect }
  const analyser = {
    fftSize: 256,
    connect: vi.fn(),
    disconnect,
    getFloatTimeDomainData: (data: Float32Array) => data.fill(0.1),
  }
  class FakeContext {
    state = 'running'
    destination = {}
    createMediaElementSource = vi.fn(() => source)
    createAnalyser = vi.fn(() => analyser)
    resume = vi.fn(async () => {})
    close = vi.fn(async () => {})
  }

  beforeEach(() => {
    vi.stubGlobal('AudioContext', FakeContext)
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn((callback: FrameRequestCallback) => {
        tick = callback
        return 1
      }),
    )
    vi.stubGlobal('cancelAnimationFrame', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('drives the mouth only while voice is actually playing', async () => {
    const listener = vi.fn()
    const driver = new VoiceAnalyser(listener)
    const audio = new Audio()
    Object.defineProperty(audio, 'paused', { value: false })
    driver.start(audio, 'pet')
    await Promise.resolve()
    tick(0)
    expect(listener).toHaveBeenLastCalledWith('pet', expect.any(Number))
    expect(listener.mock.lastCall![1]).toBeGreaterThan(0)
    audio.dispatchEvent(new Event('waiting'))
    tick(10)
    expect(listener).toHaveBeenLastCalledWith('pet', 0)
    audio.dispatchEvent(new Event('playing'))
    tick(20)
    expect(listener.mock.lastCall![1]).toBeGreaterThan(0)
    driver.stop()
    expect(listener).toHaveBeenLastCalledWith('pet', 0)
    expect(disconnect).toHaveBeenCalled()
    driver.dispose()
    driver.dispose()
  })

  it('does not create WebAudio for a voice without a speaker', () => {
    const driver = new VoiceAnalyser(vi.fn())
    driver.start(new Audio(), '')
    expect(requestAnimationFrame).not.toHaveBeenCalled()
    driver.dispose()
  })
})

describe('voiceRoute', () => {
  it('routes by speaker and only to avatars that can move their mouth', () => {
    const a: AvatarVoiceTarget = { capabilities: { mouth: true }, setMouthOpen: vi.fn() }
    const b: AvatarVoiceTarget = { capabilities: { mouth: false }, setMouthOpen: vi.fn() }
    const unbindA = bindAvatarVoice('A', a)
    const unbindB = bindAvatarVoice('B', b)
    routeAvatarVoice('B', 1)
    expect(a.setMouthOpen).not.toHaveBeenCalled()
    expect(b.setMouthOpen).not.toHaveBeenCalled()
    routeAvatarVoice('A', 0.6)
    expect(a.setMouthOpen).toHaveBeenLastCalledWith(0.6)
    unbindA()
    expect(a.setMouthOpen).toHaveBeenLastCalledWith(0)
    routeAvatarVoice('A', 1)
    expect(a.setMouthOpen).toHaveBeenLastCalledWith(0)
    unbindB()
  })
})
