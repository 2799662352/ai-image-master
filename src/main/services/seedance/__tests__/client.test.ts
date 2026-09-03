import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({
  net: {
    fetch: (...args: unknown[]) => fetchMock(...args),
    request: vi.fn(),
  },
}))

import {
  seedanceClient,
  SeedanceApiError,
  VIDEO_CREATE_TIMEOUT_MS,
  VIDEO_QUERY_TIMEOUT_MS,
} from '../client'
import { setSeedanceRegionMemory } from '../region'

function jsonResponse(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 202 ? 'Accepted' : 'OK',
    text: async () => JSON.stringify(body),
  }
}

beforeEach(() => {
  fetchMock.mockReset()
  setSeedanceRegionMemory('global')
  delete process.env.SEEDANCE_BASE_URL
})

afterEach(() => {
  setSeedanceRegionMemory('global')
  delete process.env.SEEDANCE_BASE_URL
})

describe('seedanceClient.createTask', () => {
  it('解析标准 Ark 包裹响应 { success, data: { id } }', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: true, data: { id: 'task-enveloped' } }))
    const res = await seedanceClient.createTask({} as never, 'key')
    expect(res.id).toBe('task-enveloped')
  })

  it('POST 到 Ark 推荐新路径 /api/v3/contents/generations/ark/tasks（200）', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 'task-200', status: 'queued', created_at: 1 }, 200))
    const res = await seedanceClient.createTask({} as never, 'key')
    expect(res.id).toBe('task-200')
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
    expect(url).toBe('https://vvdance.ai/api/v3/contents/generations/ark/tasks')
    expect(init.method).toBe('POST')
  })

  // 根因回归（2026-06-18）：VVDance 创建接口对已受理的异步任务返回 HTTP 202 +
  // 扁平 body（无 data 包裹），如 { id, task_id, status:"running", created_at }。
  // 旧逻辑 `!json.data` 把它误判成失败 → 抛 "Seedance API 202" → 任务从未登记本地表。
  it('把 HTTP 202 + 扁平 body 当成「任务已受理」而非失败', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(
        {
          id: 'cmqjk1h64066wtd32amrdds13',
          task_id: 'cmqjk1h64066wtd32amrdds13',
          status: 'running',
          created_at: 1781790469,
        },
        202,
      ),
    )
    const res = await seedanceClient.createTask({} as never, 'key')
    expect(res.id).toBe('cmqjk1h64066wtd32amrdds13')
  })

  it('扁平 body 只有 task_id（无 id）时回退取 task_id', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ task_id: 'only-task-id', status: 'running' }, 202))
    const res = await seedanceClient.createTask({} as never, 'key')
    expect(res.id).toBe('only-task-id')
  })

  it('真正的 4xx（如账户不支持 480p）仍抛错', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ error: { code: 'forbidden', message: '账户权限不支持480分辨率' } }, 400),
    )
    await expect(seedanceClient.createTask({} as never, 'key')).rejects.toThrow(/400/)
  })

  it('显式 success:false 仍抛错', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, message: 'boom' }, 200))
    await expect(seedanceClient.createTask({} as never, 'key')).rejects.toThrow(/boom/)
  })
})

// 提交是整条链路最靠后的一步：走到这里，素材中转、COS 上传、人像库导入都已经做完，
// 一次抖动废掉的是前面所有功夫。但它同时是个没有幂等键的 POST —— 判据见 submitRetry。
describe('seedanceClient.createTask 的重试边界', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 边推假时钟边等，让退避不真的消耗几秒。 */
  async function runWithTimers<T>(start: () => Promise<T>): Promise<T> {
    let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined
    const settled = start().then(
      (value) => {
        outcome = { ok: true, value }
      },
      (error) => {
        outcome = { ok: false, error }
      },
    )
    for (let i = 0; i < 8 && !outcome; i++) await vi.runAllTimersAsync()
    await settled
    if (!outcome) throw new Error('runWithTimers: 调用始终没有结束')
    if (outcome.ok) return outcome.value
    throw outcome.error
  }

  it('上游 5xx 自动重发，后续成功就当没事发生', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ message: 'bad gateway' }, 502))
      .mockResolvedValueOnce(jsonResponse({ id: 'task-after-retry', status: 'queued' }, 200))

    const res = await runWithTimers(() => seedanceClient.createTask({} as never, 'key'))

    expect(res.id).toBe('task-after-retry')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('4xx 不重发 —— 参数错了重发多少次都是同一个答案', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: '账户权限不支持480分辨率' } }, 400))

    await expect(
      runWithTimers(() => seedanceClient.createTask({} as never, 'key')),
    ).rejects.toThrow(/400/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // 这条是花钱的边界：2xx 说明上游已经受理，只是响应里没给 id。重发会建出第二个
  // 任务，而第一个我们永远认领不回来 —— 宁可失败。
  it('2xx 但缺 task id 时绝不重发', async () => {
    vi.useFakeTimers()
    fetchMock.mockResolvedValue(jsonResponse({ status: 'queued' }, 200))

    await expect(
      runWithTimers(() => seedanceClient.createTask({} as never, 'key')),
    ).rejects.toThrow(/missing task id/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('连接建立失败（DNS/拒连）重发，连上后被掐断则不重发', async () => {
    vi.useFakeTimers()
    fetchMock
      .mockRejectedValueOnce(new Error('net::ERR_NAME_NOT_RESOLVED'))
      .mockResolvedValueOnce(jsonResponse({ id: 'task-dns', status: 'queued' }, 200))
    expect((await runWithTimers(() => seedanceClient.createTask({} as never, 'key'))).id).toBe('task-dns')
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockReset()
    fetchMock.mockRejectedValue(Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }))
    await expect(
      runWithTimers(() => seedanceClient.createTask({} as never, 'key')),
    ).rejects.toThrow(/socket hang up/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})

describe('seedanceClient.queryTask', () => {
  it('解析包裹响应', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ success: true, data: { id: 't1', status: 'succeeded', content: { video_url: 'https://v/1.mp4' } } }),
    )
    const res = await seedanceClient.queryTask('t1', 'key')
    expect(res.status).toBe('succeeded')
    expect(res.content?.video_url).toBe('https://v/1.mp4')
  })

  it('解析扁平响应（无 data 包裹）', async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({ id: 't2', status: 'running' }),
    )
    const res = await seedanceClient.queryTask('t2', 'key')
    expect(res.status).toBe('running')
  })

  it('查询仍走旧任务路径 /api/v3/contents/generations/tasks/{taskId}', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 't3', status: 'succeeded' }))
    await seedanceClient.queryTask('t3', 'key')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://vvdance.ai/api/v3/contents/generations/tasks/t3')
  })

  it('region=cn 时 create/query 打国内 Base', async () => {
    setSeedanceRegionMemory('cn')
    fetchMock.mockResolvedValue(jsonResponse({ id: 'task-cn', status: 'queued' }, 200))
    await seedanceClient.createTask({} as never, 'key')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://vvdance.yongmuai.com/api/v3/contents/generations/ark/tasks')
  })

  it('env SEEDANCE_BASE_URL 覆盖 region', async () => {
    process.env.SEEDANCE_BASE_URL = 'https://override.example'
    setSeedanceRegionMemory('cn')
    fetchMock.mockResolvedValue(jsonResponse({ id: 't-env', status: 'queued' }, 200))
    await seedanceClient.createTask({} as never, 'key')
    const [url] = fetchMock.mock.calls[0] as [string]
    expect(url).toBe('https://override.example/api/v3/contents/generations/ark/tasks')
  })
})

describe('arkRequest 硬超时（防 net.fetch 永久悬挂 → turn 卡满 2000s）', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  /** 模拟半开连接：fetch 永不 settle，只在被 abort 时 reject（真实 net.fetch 行为）。 */
  function hangUntilAborted(): void {
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
          const err = new Error('This operation was aborted')
          err.name = 'AbortError'
          reject(err)
        })
      })
    })
  }

  it('queryTask 用查询超时(30s),到点以人话 reject 而不是裸 AbortError', async () => {
    vi.useFakeTimers()
    hangUntilAborted()

    const pending = seedanceClient.queryTask('t-hang', 'key')
    const assertion = expect(pending).rejects.toThrow(/查询任务状态超过 30 秒/)
    await vi.advanceTimersByTimeAsync(VIDEO_QUERY_TIMEOUT_MS + 1)
    await assertion
  })

  it('createTask 用提交超时(5 分钟):30s 时还挂着,到点后文案点明「可能已计费」', async () => {
    vi.useFakeTimers()
    hangUntilAborted()

    let settled = false
    const pending = seedanceClient.createTask({} as never, 'key').catch((e: Error) => {
      settled = true
      return e
    })
    // 老的 30 秒过去了,提交必须还在等 —— 多图提交真的会超过 30s,掐早了就是把一个
    // 已经在跑的任务判成失败。
    await vi.advanceTimersByTimeAsync(VIDEO_QUERY_TIMEOUT_MS + 1)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(VIDEO_CREATE_TIMEOUT_MS - VIDEO_QUERY_TIMEOUT_MS)
    const err = await pending
    expect(settled).toBe(true)
    expect(String((err as Error).message)).toMatch(
      new RegExp(`提交超过 ${VIDEO_CREATE_TIMEOUT_MS / 60_000} 分钟`),
    )
    expect(String((err as Error).message)).toMatch(/可能已被网关受理并计费/)
    expect(String((err as Error).message)).not.toMatch(/operation was aborted/i)
    // 提交重试有 3 次尝试,但超时不属于「可安全重发」—— 只允许发过一次。
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('未超时的正常响应不受影响', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ id: 't-fast', status: 'running' }))
    const res = await seedanceClient.queryTask('t-fast', 'key')
    expect(res.status).toBe('running')
  })
})

describe('SeedanceApiError：状态码与 Retry-After', () => {
  /** 带响应头的假响应（上面的 jsonResponse 故意不带，用来覆盖 headers 缺失的分支）。 */
  function withHeaders(body: unknown, status: number, headers: Record<string, string>) {
    return {
      ok: status >= 200 && status < 300,
      status,
      statusText: 'Error',
      headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
      text: async () => JSON.stringify(body),
    }
  }

  async function catchError(): Promise<SeedanceApiError> {
    try {
      await seedanceClient.queryTask('t-1', 'key')
      throw new Error('should have thrown')
    } catch (e) {
      expect(e).toBeInstanceOf(SeedanceApiError)
      return e as SeedanceApiError
    }
  }

  it('4xx 带上状态码，且标记为不可重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'invalid api key' } }, 401))
    const err = await catchError()
    expect(err.status).toBe(401)
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('invalid api key')
  })

  it('404（任务不存在）不可重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: { message: 'task not found' } }, 404))
    expect((await catchError()).retryable).toBe(false)
  })

  it('429 / 5xx 可重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'rate limited' }, 429))
    expect((await catchError()).retryable).toBe(true)
    fetchMock.mockResolvedValue(jsonResponse({ message: 'bad gateway' }, 502))
    expect((await catchError()).retryable).toBe(true)
  })

  it('HTTP 200 但 success:false 属于逻辑拒绝，同样不可重试', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ success: false, message: 'quota exhausted' }, 200))
    const err = await catchError()
    expect(err.retryable).toBe(false)
    expect(err.message).toContain('quota exhausted')
  })

  it('Retry-After 秒数写法换算成毫秒', async () => {
    fetchMock.mockResolvedValue(withHeaders({ message: 'slow down' }, 429, { 'retry-after': '30' }))
    expect((await catchError()).retryAfterMs).toBe(30_000)
  })

  it('Retry-After HTTP 日期写法换算成剩余毫秒', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-26T00:00:00Z'))
    fetchMock.mockResolvedValue(
      withHeaders({ message: 'slow down' }, 503, { 'retry-after': 'Sun, 26 Jul 2026 00:00:45 GMT' }),
    )
    expect((await catchError()).retryAfterMs).toBe(45_000)
    vi.useRealTimers()
  })

  it('无 Retry-After 头时为 undefined，不影响退避默认策略', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ message: 'boom' }, 503))
    expect((await catchError()).retryAfterMs).toBeUndefined()
  })
})
