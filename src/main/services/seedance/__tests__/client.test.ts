import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchMock = vi.fn()

vi.mock('electron', () => ({
  net: {
    fetch: (...args: unknown[]) => fetchMock(...args),
    request: vi.fn(),
  },
}))

import { seedanceClient } from '../client'

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
    expect(url).toBe('https://vvdance.yongmuai.com/api/v3/contents/generations/ark/tasks')
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
    expect(url).toBe('https://vvdance.yongmuai.com/api/v3/contents/generations/tasks/t3')
  })
})
