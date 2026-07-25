import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({
  net: {
    fetch: (...args: unknown[]) => fetchMock(...args),
    request: vi.fn(),
  },
}))

import { seedanceClient, ARK_REQUEST_TIMEOUT_MS, SeedanceApiError } from '../client'
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

  it('createTask/queryTask 都带 AbortSignal，超时后以明确错误 reject', async () => {
    vi.useFakeTimers()
    // 模拟半开连接：fetch 永不 settle，只在被 abort 时 reject（真实 net.fetch 行为）。
    fetchMock.mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      expect(init.signal).toBeInstanceOf(AbortSignal)
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => reject(new Error('aborted')))
      })
    })

    const pending = seedanceClient.queryTask('t-hang', 'key')
    const assertion = expect(pending).rejects.toThrow(/timed out after 30s/)
    await vi.advanceTimersByTimeAsync(ARK_REQUEST_TIMEOUT_MS + 1)
    await assertion
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
