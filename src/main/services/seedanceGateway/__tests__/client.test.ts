// 网关 Seedance 的 HTTP 客户端。fetch 注入,所以请求塑形(URL / 头 / 体)与响应
// 解析都能在没有 Electron、不打网络的情况下断言。

import { describe, expect, it, vi } from 'vitest'
import {
  SEEDANCE_GATEWAY_CREATE_PATH,
  SEEDANCE_GATEWAY_QUERY_PATH,
  createSeedanceGatewayClient,
} from '../client'
import { MIAU_BASE_URL } from '../../../../shared/miau'
import type { SeedanceGatewayCreateTaskBody } from '../request'

const BODY: SeedanceGatewayCreateTaskBody = {
  model: 'doubao-seedance-2-0-260128',
  prompt: '一只猫',
  metadata: {
    content: [{ type: 'text', text: '一只猫' }],
    duration: 5,
    ratio: '16:9',
    resolution: '720p',
    generate_audio: true,
  },
}

function okResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonFetch(body: unknown, status = 200) {
  return vi.fn(async () => okResponse(body, status))
}

/** 去掉真实等待,否则重试用例要跑好几秒。 */
const noWait = { sleep: async () => {} }

describe('createTask', () => {
  it('POST 到 {base}/video/generations', async () => {
    const fetchImpl = jsonFetch({ task_id: 't-1' })
    await createSeedanceGatewayClient({ fetchImpl }).createTask(BODY, 'k')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL}${SEEDANCE_GATEWAY_CREATE_PATH}`)
    expect(url).toBe('https://miauapi.13797248455.xyz/v1/video/generations')
    expect(init.method).toBe('POST')
  })

  it('Bearer + JSON 头', async () => {
    const fetchImpl = jsonFetch({ task_id: 't-1' })
    await createSeedanceGatewayClient({ fetchImpl }).createTask(BODY, 'shadow-token')

    const headers = (fetchImpl.mock.calls[0] as [string, RequestInit])[1].headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer shadow-token')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('请求体原样序列化 —— 组包结果不能在这一层被改写', async () => {
    const fetchImpl = jsonFetch({ task_id: 't-1' })
    await createSeedanceGatewayClient({ fetchImpl }).createTask(BODY, 'k')

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual(BODY)
  })

  it('任务号取 task_id,其次 id', async () => {
    for (const [body, expected] of [
      [{ task_id: 'a', id: 'z' }, 'a'],
      [{ id: 'b' }, 'b'],
      [{ data: { task_id: 'c' } }, 'c'],
    ] as const) {
      const client = createSeedanceGatewayClient({ fetchImpl: jsonFetch(body) })
      expect((await client.createTask(BODY, 'k')).id).toBe(expected)
    }
  })

  it('没有任务号就抛 —— 而且抛的是普通 Error,不能被当成「可安全重发」', async () => {
    const fetchImpl = jsonFetch({ ok: true })
    const client = createSeedanceGatewayClient({ fetchImpl, retryOptions: noWait })
    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/没有任务号/)
    // 重发只会再建一个同样认领不到、照样计费的任务。
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('空密钥在发请求之前就拦下', async () => {
    const fetchImpl = jsonFetch({ task_id: 't' })
    const client = createSeedanceGatewayClient({ fetchImpl })
    await expect(client.createTask(BODY, '   ')).rejects.toThrow()
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('5xx 会重发（上游明确回了错就说明任务没建成）', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ error: { message: 'boom' } }, 503))
      .mockResolvedValueOnce(okResponse({ task_id: 't-2' }))
    const client = createSeedanceGatewayClient({ fetchImpl, retryOptions: noWait })

    expect((await client.createTask(BODY, 'k')).id).toBe('t-2')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('永久性网关错误码不重发', async () => {
    const fetchImpl = jsonFetch({ error: { code: 'model_not_found', message: '通道里没有这个模型' } }, 500)
    const client = createSeedanceGatewayClient({ fetchImpl, retryOptions: noWait })

    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/model_not_found/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('4xx 不重发', async () => {
    const fetchImpl = jsonFetch({ error: { message: '参数不对' } }, 400)
    const client = createSeedanceGatewayClient({ fetchImpl, retryOptions: noWait })

    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('body 不是 JSON 时也要把状态码报出来', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502</html>', { status: 502 }))
    const client = createSeedanceGatewayClient({ fetchImpl, retryOptions: { attempts: 1 } })
    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/502/)
  })

  it('带 AbortSignal（30s 硬超时,不设的话代理半开会让卡片永远转圈）', async () => {
    const fetchImpl = jsonFetch({ task_id: 't' })
    await createSeedanceGatewayClient({ fetchImpl }).createTask(BODY, 'k')

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1]
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })
})

describe('queryTask', () => {
  it('GET 到 {base}/videos/{id} —— 与 wan3 的 /video/generations/{id} 不同', async () => {
    const fetchImpl = jsonFetch({ task_id: 't-1', status: 'running' })
    await createSeedanceGatewayClient({ fetchImpl }).queryTask('t-1', 'k')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL}${SEEDANCE_GATEWAY_QUERY_PATH}/t-1`)
    expect(url).toBe('https://miauapi.13797248455.xyz/v1/videos/t-1')
    expect(init.method).toBe('GET')
  })

  it('轮询路径可覆盖 —— 它还没被真网关证实,烟测要能两条都试', async () => {
    const fetchImpl = jsonFetch({ task_id: 't-1' })
    const client = createSeedanceGatewayClient({ fetchImpl, queryPath: '/video/generations' })
    await client.queryTask('t-1', 'k')

    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      `${MIAU_BASE_URL}/video/generations/t-1`,
    )
  })

  it('taskId 做 URL 编码', async () => {
    const fetchImpl = jsonFetch({ task_id: 'a/b' })
    await createSeedanceGatewayClient({ fetchImpl }).queryTask('a/b', 'k')

    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(`${MIAU_BASE_URL}/videos/a%2Fb`)
  })

  it('结果经 response.ts 解析 —— 有 URL 即成功', async () => {
    const fetchImpl = jsonFetch({ task_id: 't-1', status: 'whatever', video_url: 'https://x/o.mp4' })
    const r = await createSeedanceGatewayClient({ fetchImpl }).queryTask('t-1', 'k')

    expect(r.status).toBe('succeeded')
    expect(r.content?.video_url).toBe('https://x/o.mp4')
  })

  it('查询不重发（重试只留给提交）', async () => {
    const fetchImpl = jsonFetch({ error: { message: 'boom' } }, 503)
    await expect(createSeedanceGatewayClient({ fetchImpl }).queryTask('t', 'k')).rejects.toThrow(/503/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('baseUrl', () => {
  it('默认 MIAU_BASE_URL（已含 /v1）', () => {
    expect(MIAU_BASE_URL.endsWith('/v1')).toBe(true)
  })

  it('可覆盖,且末尾斜杠不会拼出 //', async () => {
    const fetchImpl = jsonFetch({ task_id: 't' })
    const client = createSeedanceGatewayClient({ fetchImpl, baseUrl: 'https://gw.test/v1/' })
    await client.createTask(BODY, 'k')

    expect((fetchImpl.mock.calls[0] as [string, RequestInit])[0]).toBe(
      'https://gw.test/v1/video/generations',
    )
  })
})
