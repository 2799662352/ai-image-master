import { afterEach, describe, expect, it, vi } from 'vitest'
import { AsrAdapter, type TranscriptionCallback } from '../asr/asrAdapter'
import { StreamingAsrController, type AsrEvent, type StreamingAsrControllerOptions } from '../asr/streamingAsrController'

class FakeAdapter extends AsrAdapter {
  calls: string[] = []
  status = 'Stopped'
  startDelay: Promise<void> | null = null
  finishImpl: (() => Promise<void> | void) | null = null

  constructor(callback: TranscriptionCallback, language = 'en') {
    super(language, callback)
  }

  emit(text: string, isPartial: boolean): void {
    this.callback(text, isPartial)
  }

  async start(): Promise<void> {
    this.calls.push('start')
    if (this.startDelay) await this.startDelay
    this.status = 'Running'
  }

  stop(): void {
    this.calls.push('stop')
    this.status = 'Stopped'
  }

  async finish(): Promise<void> {
    if (this.finishImpl) await this.finishImpl()
    else this.stop()
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

class WarmHoldAdapter extends FakeAdapter {
  async finishHold({ cancel = false }: { cancel?: boolean } = {}): Promise<boolean> {
    this.calls.push(cancel ? 'cancel-hold' : 'finish-hold')
    this.status = 'Paused'
    return true
  }
}

interface Harness {
  controller: StreamingAsrController
  adapters: FakeAdapter[]
  events: AsrEvent[]
  submitted: string[]
  errors: [string, string][]
}

const open: StreamingAsrController[] = []

function harness(
  options: Partial<StreamingAsrControllerOptions> & {
    makeAdapter?: (callback: TranscriptionCallback) => FakeAdapter
  } = {},
): Harness {
  const adapters: FakeAdapter[] = []
  const events: AsrEvent[] = []
  const submitted: string[] = []
  const errors: [string, string][] = []
  const { makeAdapter = (callback) => new FakeAdapter(callback), ...rest } = options
  const controller = new StreamingAsrController({
    adapterFactory: (callback) => {
      const adapter = makeAdapter(callback)
      adapters.push(adapter)
      return adapter
    },
    emitEvent: (event) => events.push(event),
    submitFinal: (text) => {
      submitted.push(text)
    },
    onError: (operation, error) => errors.push([operation, error instanceof Error ? error.message : String(error)]),
    resumeDelayMs: 10,
    ...rest,
  })
  open.push(controller)
  return { controller, adapters, events, submitted, errors }
}

async function started(h: Harness): Promise<FakeAdapter> {
  await vi.waitFor(() => expect(h.adapters[0]?.status).toBe('Running'))
  return h.adapters[0]
}

afterEach(() => {
  for (const controller of open.splice(0)) controller.close()
  vi.useRealTimers()
})

describe('StreamingAsrController · continuous listening', () => {
  it('submits a final result, pauses for the turn and resumes after the reply', async () => {
    const loading: boolean[] = []
    const h = harness({ onLoadingChanged: (value) => loading.push(value) })
    h.controller.userResume()
    const adapter = await started(h)
    expect(loading).toEqual([true, false])
    expect(h.events).toContainEqual({ type: 'asr.state', enabled: true, loading: true, running: false })
    expect(h.events.at(-1)).toEqual({ type: 'asr.state', enabled: true, loading: false, running: true })

    adapter.emit('hello', true)
    expect(h.events.at(-1)).toEqual({ type: 'asr.partial', text: 'hello' })

    adapter.emit('hello world', false)
    await vi.waitFor(() => expect(h.submitted).toEqual(['hello world']))
    expect(adapter.calls.at(-1)).toBe('pause')
    expect(h.events.slice(-2)).toEqual([
      { type: 'asr.final', text: 'hello world' },
      { type: 'asr.state', enabled: true, loading: false, running: false },
    ])

    h.controller.replyFinished()
    await vi.waitFor(() => expect(adapter.calls).toContain('resume'))
    expect(h.events.slice(-2)).toEqual([
      { type: 'asr.partial', text: '' },
      { type: 'asr.state', enabled: true, loading: false, running: true },
    ])

    h.controller.close()
    await vi.waitFor(() => expect(adapter.calls.at(-1)).toBe('stop'))
  })

  it('user pause cancels the automatic resume', async () => {
    const h = harness({ makeAdapter: (callback) => new FakeAdapter(callback, 'zh') })
    h.controller.userResume()
    const adapter = await started(h)
    adapter.emit('你 好', false)
    await vi.waitFor(() => expect(h.submitted).toEqual(['你好']))
    h.controller.userPause()
    await vi.waitFor(() => expect(adapter.calls.at(-1)).toBe('stop'))
    h.controller.replyFinished()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(adapter.calls).not.toContain('resume')
    expect(h.controller.enabled).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'asr.state', enabled: false, loading: false, running: false })
  })

  it('starts capture again after a user pause released it', async () => {
    const h = harness()
    h.controller.userResume()
    const adapter = await started(h)
    h.controller.userPause()
    await vi.waitFor(() => expect(adapter.calls).toEqual(['start', 'stop']))
    h.controller.userResume()
    await vi.waitFor(() => expect(adapter.calls).toEqual(['start', 'stop', 'start']))
    expect(h.adapters).toHaveLength(1)
  })

  it('does not report listening when the adapter never enters a running state', async () => {
    class DeadAdapter extends FakeAdapter {
      async start(): Promise<void> {
        this.calls.push('start')
      }
    }
    const h = harness({ makeAdapter: (callback) => new DeadAdapter(callback) })
    h.controller.userResume()
    await vi.waitFor(() => expect(h.errors).toHaveLength(1))
    expect(h.errors[0][0]).toBe('start')
    expect(h.errors[0][1]).toMatch(/没有进入运行状态/)
    expect(h.controller.enabled).toBe(false)
    expect(h.events.at(-1)).toEqual({ type: 'asr.state', enabled: false, loading: false, running: false })
  })

  it('a rejected submission resumes listening without publishing a final', async () => {
    const h = harness({ submitFinal: () => false, resumeDelayMs: 0 })
    h.controller.userResume()
    const adapter = await started(h)
    adapter.emit('rejected', false)
    await vi.waitFor(() => expect(adapter.calls).toContain('resume'))
    expect(h.controller.enabled).toBe(true)
    expect(h.events.some((event) => event.type === 'asr.final')).toBe(false)
  })

  it('turn pause keeps the mic enabled until the user turns it off', async () => {
    const h = harness()
    h.controller.userResume()
    await started(h)
    expect(h.controller.pauseForTurn()).toBe(true)
    expect(h.controller.enabled).toBe(true)
    expect(h.events.at(-1)).toEqual({ type: 'asr.state', enabled: true, loading: false, running: false })
    h.controller.userPause()
    expect(h.controller.enabled).toBe(false)
    expect(h.controller.pauseForTurn()).toBe(false)
  })

  it('does not append a final that the partial already ends with', async () => {
    const h = harness({ makeAdapter: (callback) => new FakeAdapter(callback, 'zh') })
    h.controller.userResume()
    const adapter = await started(h)
    adapter.emit('今天天气', true)
    adapter.emit('天气', false)
    await vi.waitFor(() => expect(h.submitted).toEqual(['今天天气']))
  })

  it('suppresses events after close', async () => {
    const h = harness()
    h.controller.userResume()
    const adapter = await started(h)
    h.controller.close()
    const count = h.events.length
    adapter.emit('too late', true)
    adapter.emit('too late', false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.events).toHaveLength(count)
    expect(h.submitted).toEqual([])
  })

  it('a pause during a slow start leaves capture stopped', async () => {
    let release!: () => void
    const h = harness({
      makeAdapter: (callback) => {
        const adapter = new FakeAdapter(callback)
        adapter.startDelay = new Promise<void>((resolve) => {
          release = resolve
        })
        return adapter
      },
    })
    h.controller.userResume()
    await vi.waitFor(() => expect(h.adapters[0]?.calls).toEqual(['start']))
    h.controller.userPause()
    release()
    await vi.waitFor(() => expect(h.adapters[0].calls).toEqual(['start', 'stop']))
    expect(h.events.at(-1)).toEqual({ type: 'asr.state', enabled: false, loading: false, running: false })
  })

  it('cancelling a lazy load and resuming again starts the loaded adapter once', async () => {
    let releaseFactory!: () => void
    const gate = new Promise<void>((resolve) => {
      releaseFactory = resolve
    })
    const adapters: FakeAdapter[] = []
    const controller = new StreamingAsrController({
      adapterFactory: async (callback) => {
        await gate
        const adapter = new FakeAdapter(callback)
        adapters.push(adapter)
        return adapter
      },
      emitEvent: () => {},
      submitFinal: () => {},
    })
    open.push(controller)
    controller.userResume()
    controller.userPause()
    releaseFactory()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adapters[0].calls).not.toContain('start')
    controller.userResume()
    await vi.waitFor(() => expect(adapters[0].calls).toContain('start'))
  })
})

describe('StreamingAsrController · silence fallback', () => {
  it('submits a partial transcript after silence when the engine never finalizes', async () => {
    const h = harness({ silenceSubmitMs: 10 })
    h.controller.userResume()
    const adapter = await started(h)
    adapter.emit('silence fallback', true)
    await vi.waitFor(() => expect(h.submitted).toEqual(['silence fallback']))
    expect(h.events).toContainEqual({ type: 'asr.final', text: 'silence fallback' })
    expect(adapter.calls.at(-1)).toBe('pause')
    adapter.emit('silence fallback', false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(h.submitted).toEqual(['silence fallback'])
  })

  it('waits 3.5 s by default so natural pauses do not cut a sentence', async () => {
    const h = harness()
    h.controller.userResume()
    const adapter = await started(h)
    vi.useFakeTimers()
    adapter.emit('keep listening', true)
    vi.advanceTimersByTime(3499)
    expect(h.submitted).toEqual([])
    vi.advanceTimersByTime(1)
    vi.useRealTimers()
    await vi.waitFor(() => expect(h.submitted).toEqual(['keep listening']))
  })

  it('user pause cancels a pending silence submission', async () => {
    const h = harness({ silenceSubmitMs: 10 })
    h.controller.userResume()
    const adapter = await started(h)
    adapter.emit('do not submit', true)
    h.controller.userPause()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.submitted).toEqual([])
  })

  it('repeated identical partials do not postpone the silence submission', async () => {
    const h = harness({ silenceSubmitMs: 100 })
    h.controller.userResume()
    const adapter = await started(h)
    vi.useFakeTimers()
    adapter.emit('stable transcript', true)
    vi.advanceTimersByTime(60)
    adapter.emit('stable transcript', true)
    vi.advanceTimersByTime(40)
    vi.useRealTimers()
    await vi.waitFor(() => expect(h.submitted).toEqual(['stable transcript']))
  })
})

describe('StreamingAsrController · hold to talk', () => {
  async function holding(options: Parameters<typeof harness>[0] = {}): Promise<Harness & { adapter: FakeAdapter }> {
    const h = harness({ silenceSubmitMs: 10, ...options })
    h.controller.beginHold()
    const adapter = await started(h)
    return { ...h, adapter }
  }

  it('streams segments without sending until release', async () => {
    const h = await holding()
    h.adapter.emit('hello', false)
    h.adapter.emit('wor', true)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(h.submitted).toEqual([])
    expect(h.events.at(-1)).toEqual({ type: 'asr.partial', text: 'hello wor' })
    h.adapter.finishImpl = () => {
      h.adapter.emit('world', false)
      h.adapter.stop()
    }
    await h.controller.finishHold()
    await h.controller.finishHold()
    h.adapter.emit('late result', false)
    expect(h.submitted).toEqual(['hello world'])
    expect(h.controller.enabled).toBe(false)
    expect(h.events).toContainEqual({ type: 'asr.final', text: 'hello world' })
    h.controller.replyFinished()
    expect(h.adapter.status).toBe('Stopped')
  })

  it('cancel discards the text and allows the next recording', async () => {
    const h = await holding()
    h.adapter.emit('discard', false)
    await h.controller.finishHold({ cancel: true })
    expect(h.submitted).toEqual([])
    const last = h.events.at(-1)
    expect(last?.type === 'asr.state' && last.enabled).toBe(false)
    h.controller.beginHold()
    await vi.waitFor(() => expect(h.adapter.status).toBe('Running'))
    h.adapter.emit('new', true)
    await h.controller.finishHold()
    expect(h.submitted).toEqual(['new'])
  })

  it('reuses an adapter that can stay warm, without a loading flash', async () => {
    const h = await holding({ makeAdapter: (callback) => new WarmHoldAdapter(callback) })
    h.adapter.emit('first', true)
    await h.controller.finishHold()
    expect(h.submitted).toEqual(['first'])
    expect(h.adapter.calls).toEqual(['start', 'finish-hold'])
    const from = h.events.length
    h.controller.beginHold()
    await vi.waitFor(() => expect(h.adapter.status).toBe('Running'))
    h.adapter.emit('second', true)
    await h.controller.finishHold()
    expect(h.submitted).toEqual(['first', 'second'])
    expect(h.adapter.calls).toEqual(['start', 'finish-hold', 'resume', 'finish-hold'])
    expect(h.adapters).toHaveLength(1)
    expect(h.events.slice(from).some((event) => event.type === 'asr.state' && event.loading)).toBe(false)
  })

  it('a cancelled hold can keep an expensive adapter warm', async () => {
    const h = await holding({ makeAdapter: (callback) => new WarmHoldAdapter(callback) })
    h.adapter.emit('discard', true)
    await h.controller.finishHold({ cancel: true })
    h.controller.beginHold()
    await vi.waitFor(() => expect(h.adapter.status).toBe('Running'))
    expect(h.submitted).toEqual([])
    expect(h.adapter.calls).toEqual(['start', 'cancel-hold', 'resume'])
  })

  it('an empty recording does not submit', async () => {
    const h = await holding()
    await h.controller.finishHold()
    expect(h.submitted).toEqual([])
    expect(h.controller.enabled).toBe(false)
  })

  it('releasing while the engine is still loading never starts capture', async () => {
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const adapters: FakeAdapter[] = []
    const submitted: string[] = []
    let entered = false
    const controller = new StreamingAsrController({
      adapterFactory: async (callback) => {
        entered = true
        await gate
        const adapter = new FakeAdapter(callback)
        adapters.push(adapter)
        return adapter
      },
      emitEvent: () => {},
      submitFinal: (text) => {
        submitted.push(text)
      },
    })
    open.push(controller)
    controller.beginHold()
    await vi.waitFor(() => expect(entered).toBe(true))
    await controller.finishHold()
    release()
    await vi.waitFor(() => expect(adapters).toHaveLength(1))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(adapters[0].calls).not.toContain('start')
    expect(submitted).toEqual([])
    controller.beginHold()
    await vi.waitFor(() => expect(adapters[0].status).toBe('Running'))
    adapters[0].emit('next hold', true)
    await controller.finishHold()
    expect(submitted).toEqual(['next hold'])
  })

  it('a finalization failure keeps the draft and sends nothing', async () => {
    const h = await holding()
    h.adapter.emit('draft', true)
    h.adapter.finishImpl = () => {
      throw new Error('decoder failed')
    }
    await expect(h.controller.finishHold()).rejects.toThrow('decoder failed')
    expect(h.submitted).toEqual([])
    expect(h.controller.enabled).toBe(false)
    await vi.waitFor(() => expect(h.adapter.status).toBe('Stopped'))
  })

  it('a duplicate begin does not reset the transcript', async () => {
    const h = await holding()
    h.adapter.emit('keep', true)
    h.controller.beginHold()
    await h.controller.finishHold()
    expect(h.submitted).toEqual(['keep'])
  })

  it('keeps the transcript in the input when the submission is rejected', async () => {
    const h = await holding({ submitFinal: () => false })
    h.adapter.emit('keep draft', true)
    await expect(h.controller.finishHold()).rejects.toThrow(/留在输入框/)
    expect(h.events.some((event) => event.type === 'asr.final')).toBe(false)
    expect(h.events.at(-2)).toEqual({ type: 'asr.partial', text: 'keep draft' })
    const last = h.events.at(-1)
    expect(last?.type === 'asr.state' && last.enabled).toBe(false)
  })

  it('publishes the final only after the submission is accepted', async () => {
    const observed: [string, boolean][] = []
    const events: AsrEvent[] = []
    const h = await holding({
      emitEvent: (event) => events.push(event),
      submitFinal: (text) => {
        observed.push([text, events.some((event) => event.type === 'asr.final')])
        return true
      },
    })
    h.adapter.emit('accepted', true)
    await h.controller.finishHold()
    expect(observed).toEqual([['accepted', false]])
    expect(events).toContainEqual({ type: 'asr.final', text: 'accepted' })
  })
})
