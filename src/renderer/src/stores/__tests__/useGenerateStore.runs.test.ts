import { beforeEach, describe, expect, it, vi } from 'vitest'
import { initialState, useGenerateStore } from '../useGenerateStore'
import type { ApiActions } from '../../hooks/useService'

/**
 * `runs[]` —— 状态卡族(M5)的数据源。以前 store 只有 inFlightCount + 一条 error,
 * 结果区画不出「哪一次在跑 / 哪一次失败」。现在每次 generate() 都有一张卡:
 * 点下去就有 RUN,失败留 ERR(可重试 / 可收掉),成功退场让位给结果卡。
 */

function createMockApi(overrides: Partial<ApiActions> = {}): ApiActions {
  return {
    generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://result.jpg'] }),
    understandImage: vi.fn(),
    testConnection: vi.fn(),
    saveApiKey: vi.fn(),
    saveVisionApiKey: vi.fn(),
    getAllSites: vi.fn().mockReturnValue({}),
    setSite: vi.fn(),
    getStoredApiKey: vi.fn().mockReturnValue(null),
    getStoredVisionApiKey: vi.fn().mockReturnValue(null),
    getCurrentSite: vi.fn(),
    getSiteConfig: vi.fn(),
    currentSiteKey: '',
    ...overrides,
  } as ApiActions
}

/** A generateImage that resolves only when the test says so. */
function deferredGenerate() {
  let resolve!: (v: unknown) => void
  const promise = new Promise((r) => {
    resolve = r
  })
  return { fn: vi.fn().mockReturnValue(promise), resolve }
}

describe('useGenerateStore — runs', () => {
  beforeEach(() => {
    useGenerateStore.setState({ ...initialState, prompt: '一只猫', ratio: '16:9', resolution: '2K', count: 2 })
  })

  it('a RUN card appears the instant generate() is called, carrying the form snapshot', async () => {
    const d = deferredGenerate()
    const api = createMockApi({ generateImage: d.fn })
    const pending = useGenerateStore.getState().generate(api, 'gpt-image-2.5-flare')

    const runs = useGenerateStore.getState().runs
    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({ status: 'running', prompt: '一只猫', modelKey: 'gpt-image-2.5-flare', ratio: '16:9', resolution: '2K', count: 2 })
    expect(runs[0].startedAt).toBeGreaterThan(0)

    d.resolve({ success: true, urls: ['http://a.jpg', 'http://b.jpg'] })
    await pending
  })

  it('a successful run leaves the list; its results point back via runId with elapsed/createdAt/model/resolution', async () => {
    const api = createMockApi({ generateImage: vi.fn().mockResolvedValue({ success: true, urls: ['http://a.jpg', 'http://b.jpg'] }) })
    await useGenerateStore.getState().generate(api, 'm')
    const s = useGenerateStore.getState()
    expect(s.runs).toEqual([])
    expect(s.resultMeta).toHaveLength(2)
    expect(s.resultMeta[0].runId).toBeTruthy()
    expect(s.resultMeta[0].runId).toBe(s.resultMeta[1].runId)
    expect(s.resultMeta[0].createdAt).toBeGreaterThan(0)
    expect(s.resultMeta[0].elapsedMs).toBeGreaterThanOrEqual(0)
    expect(s.resultMeta[0]).toMatchObject({ modelKey: 'm', resolution: '2K' })
  })

  it('a failed run stays as an ERR card with the reason, and dismissRun removes it', async () => {
    const api = createMockApi({ generateImage: vi.fn().mockResolvedValue({ success: false, error: '账户余额不足' }) })
    await useGenerateStore.getState().generate(api, 'm')
    const [run] = useGenerateStore.getState().runs
    expect(run).toMatchObject({ status: 'error', error: '账户余额不足' })
    expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt)

    useGenerateStore.getState().dismissRun(run.id)
    expect(useGenerateStore.getState().runs).toEqual([])
  })

  it('a thrown error also becomes an ERR card', async () => {
    const api = createMockApi({ generateImage: vi.fn().mockRejectedValue(new Error('boom')) })
    await useGenerateStore.getState().generate(api, 'm')
    expect(useGenerateStore.getState().runs[0]).toMatchObject({ status: 'error', error: 'boom' })
  })

  it('retryRun re-sends the ORIGINAL parameters even after the form changed, and swaps the ERR card for a new RUN', async () => {
    const generateImage = vi.fn().mockResolvedValueOnce({ success: false, error: 'HTTP 500' }).mockResolvedValueOnce({ success: true, urls: ['http://ok.jpg'] })
    const api = createMockApi({ generateImage })
    await useGenerateStore.getState().generate(api, 'model-A')
    const failed = useGenerateStore.getState().runs[0]

    // User moves on: new prompt, new ratio, new model in the form.
    useGenerateStore.setState({ prompt: '一条狗', ratio: '1:1', resolution: '1K', count: 1 })

    const outcome = await useGenerateStore.getState().retryRun(api, failed.id)
    expect(outcome).toEqual({ added: 1 })
    expect(useGenerateStore.getState().runs).toEqual([])
    // Second call reproduced the first call's parameters, not the current form.
    const secondCall = generateImage.mock.calls[1][0]
    expect(secondCall).toMatchObject({ prompt: '一只猫', ratio: '16:9', resolution: '2K', count: 2, model: 'model-A' })
    // The form itself is untouched by the retry.
    expect(useGenerateStore.getState().prompt).toBe('一条狗')
  })

  it('retryRun ignores unknown ids and running runs', async () => {
    const d = deferredGenerate()
    const api = createMockApi({ generateImage: d.fn })
    const pending = useGenerateStore.getState().generate(api, 'm')
    const running = useGenerateStore.getState().runs[0]
    expect(await useGenerateStore.getState().retryRun(api, running.id)).toEqual({ added: 0 })
    expect(await useGenerateStore.getState().retryRun(api, 'nope')).toEqual({ added: 0 })
    d.resolve({ success: true, urls: ['http://a.jpg'] })
    await pending
  })

  it('clearResults drops results and ERR cards but keeps in-flight runs; removeResult drops exactly one result', async () => {
    const api = createMockApi({ generateImage: vi.fn().mockResolvedValueOnce({ success: false, error: 'x' }).mockResolvedValueOnce({ success: true, urls: ['http://a.jpg', 'http://b.jpg'] }) })
    await useGenerateStore.getState().generate(api, 'm')
    await useGenerateStore.getState().generate(api, 'm')
    const d = deferredGenerate()
    const pending = useGenerateStore.getState().generate(createMockApi({ generateImage: d.fn }), 'm')

    let s = useGenerateStore.getState()
    expect(s.runs.map((r) => r.status)).toEqual(['running', 'error'])
    expect(s.resultUrls).toHaveLength(2)

    const keep = s.resultMeta[1].id
    useGenerateStore.getState().removeResult(s.resultMeta[0].id)
    s = useGenerateStore.getState()
    expect(s.resultUrls).toEqual(['http://b.jpg'])
    expect(s.resultMeta.map((m) => m.id)).toEqual([keep])

    useGenerateStore.getState().clearResults()
    s = useGenerateStore.getState()
    expect(s.resultUrls).toEqual([])
    expect(s.runs.map((r) => r.status)).toEqual(['running'])

    d.resolve({ success: true, urls: ['http://c.jpg'] })
    await pending
    expect(useGenerateStore.getState().runs).toEqual([])
    expect(useGenerateStore.getState().resultUrls).toEqual(['http://c.jpg'])
  })
})
