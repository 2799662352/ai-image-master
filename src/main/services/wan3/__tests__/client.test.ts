// 万相的 HTTP 客户端。fetch 由外部注入,所以整条请求塑形(URL / 头 / 体)与响应
// 解析都能在没有 Electron、不打网络的情况下测。

import { describe, expect, it, vi } from 'vitest'
import { createWan3Client } from '../client'
import { MIAU_BASE_URL } from '../../../../shared/miau'

function okResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function jsonFetch(body: unknown) {
  return vi.fn(async () => okResponse(body))
}

const BODY = {
  model: 'wan3.0-video',
  prompt: '一只猫',
  metadata: { input: { media: [] }, media: [], parameters: { prompt_extend: true, audio: true } },
}

describe('createTask', () => {
  it('POST 到 Miau 的视频生成端点', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1', task_status: 'PENDING' } })
    await createWan3Client({ fetchImpl }).createTask(BODY, 'miau-key')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL}/video/generations`)
    expect(init.method).toBe('POST')
  })

  it('带 Bearer 认证与 JSON 头', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1' } })
    await createWan3Client({ fetchImpl }).createTask(BODY, 'miau-key')

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer miau-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('请求体原样序列化 —— 组包结果不能在这一层被改写', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1' } })
    await createWan3Client({ fetchImpl }).createTask(BODY, 'miau-key')

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1]
    expect(JSON.parse(init.body as string)).toEqual(BODY)
  })

  it('任务号认 output.task_id / task_id / id 三种回形', async () => {
    for (const [body, expected] of [
      [{ output: { task_id: 'a' } }, 'a'],
      [{ task_id: 'b' }, 'b'],
      [{ id: 'c' }, 'c'],
    ] as const) {
      const client = createWan3Client({ fetchImpl: jsonFetch(body) })
      expect((await client.createTask(BODY, 'k')).id).toBe(expected)
    }
  })

  it('拿不到任务号就报错 —— 否则后面轮询一个空 id,任务在上游跑着没人认领', async () => {
    const client = createWan3Client({ fetchImpl: jsonFetch({ output: {} }) })
    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/任务号/)
  })

  it('没有密钥时不发请求,直接给人话', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't' } })
    await expect(createWan3Client({ fetchImpl }).createTask(BODY, '  ')).rejects.toThrow(/Miau/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('queryTask', () => {
  it('GET 到带任务号的端点', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1', task_status: 'RUNNING' } })
    await createWan3Client({ fetchImpl }).queryTask('t-1', 'miau-key')

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL}/video/generations/t-1`)
    expect(init.method).toBe('GET')
  })

  it('成功时解析出视频地址', async () => {
    const fetchImpl = jsonFetch({
      output: { task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' },
    })
    const result = await createWan3Client({ fetchImpl }).queryTask('t-1', 'k')
    expect(result.status).toBe('succeeded')
    expect(result.content?.video_url).toBe('https://x/v.mp4')
  })

  it('任务号做过 URL 编码,不让奇怪的 id 拼坏路径', async () => {
    const fetchImpl = jsonFetch({ output: { task_status: 'RUNNING' } })
    await createWan3Client({ fetchImpl }).queryTask('a/b c', 'k')
    expect((fetchImpl.mock.calls[0] as [string])[0]).toBe(
      `${MIAU_BASE_URL}/video/generations/a%2Fb%20c`,
    )
  })
})

describe('提交重试', () => {
  // 复用 Seedance 的 submitRetry:万相按秒计费,重复建任务的代价与那边同性质
  // ——一笔没人认领、跑到完的花费。判据("确定上游没受理才重发")完全通用。
  const noWait = { sleep: async () => {}, random: () => 0.5 }

  it('上游 5xx 会重发', async () => {
    const fetchImpl = vi
      .fn<[], Promise<Response>>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(okResponse({ output: { task_id: 't-1' } }))

    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    expect((await client.createTask(BODY, 'k')).id).toBe('t-1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('4xx 不重发 —— 参数错了发一百次也一样', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }))
    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('拿不到任务号时不重发 —— 任务可能已经建成了,再发就是第二笔钱', async () => {
    const fetchImpl = jsonFetch({ output: {} })
    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/任务号/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('查询不走提交重试 —— 轮询本身就是在重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }))
    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    await expect(client.queryTask('t', 'k')).rejects.toThrow(/503/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })
})

describe('错误处理', () => {
  // 下面两种信封都是对着真网关探出来的,不是猜的:
  //   网关自己的错误  → {"error":{"code":"model_not_found","message":"...","type":"new_api_error"}}
  //   上游透传的错误  → {"code":"task_not_exist","message":"task_not_exist","data":null}
  // 只认其中一种,另一种就会退化成一句没有信息量的「万相 API 5xx」。
  it('认网关信封 {error:{code,message}}', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            error: { code: 'model_not_found', message: 'No available channel', type: 'new_api_error' },
          }),
          { status: 503 },
        ),
    )
    await expect(createWan3Client({ fetchImpl }).createTask(BODY, 'k')).rejects.toThrow(
      /model_not_found.*No available channel/s,
    )
  })

  it('认上游透传信封 {code,message}', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'task_not_exist', message: 'task_not_exist' }), {
          status: 400,
        }),
    )
    await expect(createWan3Client({ fetchImpl }).queryTask('t', 'k')).rejects.toThrow(
      /task_not_exist/,
    )
  })

  it('model_not_found 不重试 —— 网关拿它当 503,但「这个 key 没有该模型通道」不会自愈', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { code: 'model_not_found', message: 'x' } }), {
          status: 503,
        }),
    )
    const client = createWan3Client({
      fetchImpl,
      retryOptions: { sleep: async () => {}, random: () => 0.5 },
    })
    await expect(client.createTask(BODY, 'k')).rejects.toThrow(/model_not_found/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('4xx 带上状态码与上游 message', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'No API-key provided.' }), {
          status: 401,
        }),
    )
    await expect(createWan3Client({ fetchImpl }).createTask(BODY, 'k')).rejects.toThrow(
      /401.*InvalidApiKey|InvalidApiKey.*401/s,
    )
  })

  it('响应不是 JSON 时也给出可读错误,不抛解析异常', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(createWan3Client({ fetchImpl }).queryTask('t', 'k')).rejects.toThrow(/502/)
  })
})
