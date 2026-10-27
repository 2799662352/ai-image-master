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

/**
 * 自填 Key 那一支的鉴权头。
 *
 * 客户端现在收**整份头**而不是裸 key —— 平台余额那一支传的是
 * `gatewayPlatformHeaders(影子 token)`,除了 Authorization 还带三个计费归属头。
 * 两者只有头表不同,组包与解析这一层一行都不用变(下面的用例就是在钉这件事)。
 */
function bearer(key: string): Record<string, string> {
  return { Authorization: `Bearer ${key}` }
}

const BODY = {
  model: 'wan3.0-video',
  prompt: '一只猫',
  metadata: { input: { media: [] }, media: [], parameters: { prompt_extend: true, audio: true } },
}

describe('createTask', () => {
  it('POST 到 Miau 的视频生成端点', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1', task_status: 'PENDING' } })
    await createWan3Client({ fetchImpl }).createTask(BODY, bearer('miau-key'))

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL}/video/generations`)
    expect(init.method).toBe('POST')
  })

  it('带 Bearer 认证与 JSON 头', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1' } })
    await createWan3Client({ fetchImpl }).createTask(BODY, bearer('miau-key'))

    const init = (fetchImpl.mock.calls[0] as [string, RequestInit])[1]
    const headers = init.headers as Record<string, string>
    expect(headers.Authorization).toBe('Bearer miau-key')
    expect(headers['Content-Type']).toBe('application/json')
  })

  it('请求体原样序列化 —— 组包结果不能在这一层被改写', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1' } })
    await createWan3Client({ fetchImpl }).createTask(BODY, bearer('miau-key'))

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
      expect((await client.createTask(BODY, bearer('k'))).id).toBe(expected)
    }
  })

  it('拿不到任务号就报错 —— 否则后面轮询一个空 id,任务在上游跑着没人认领', async () => {
    const client = createWan3Client({ fetchImpl: jsonFetch({ output: {} }) })
    await expect(client.createTask(BODY, bearer('k'))).rejects.toThrow(/任务号/)
  })

  /**
   * 🧬 变异点:把 `requireAuth` 里剥 scheme 那一步去掉(只判整串非空),第二条必红。
   *
   * `Bearer ` 加一个空 token 是非空字符串,却是一个注定 401 的请求 —— 而 401 看起来
   * 像密钥填错了,用户会去反复检查一个其实压根没填的值。
   */
  it.each([
    ['整个头都没有', {} as Record<string, string>],
    ['有 Bearer 但 token 是空的', bearer('  ')],
  ])('没有可用凭据时不发请求,直接给人话(%s)', async (_name, auth) => {
    const fetchImpl = jsonFetch({ output: { task_id: 't' } })
    await expect(createWan3Client({ fetchImpl }).createTask(BODY, auth)).rejects.toThrow(/Miau/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('queryTask', () => {
  it('GET 到带任务号的端点', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1', task_status: 'RUNNING' } })
    await createWan3Client({ fetchImpl }).queryTask('t-1', bearer('miau-key'))

    const [url, init] = fetchImpl.mock.calls[0] as [string, RequestInit]
    expect(url).toBe(`${MIAU_BASE_URL}/video/generations/t-1`)
    expect(init.method).toBe('GET')
  })

  it('成功时解析出视频地址', async () => {
    const fetchImpl = jsonFetch({
      output: { task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' },
    })
    const result = await createWan3Client({ fetchImpl }).queryTask('t-1', bearer('k'))
    expect(result.status).toBe('succeeded')
    expect(result.content?.video_url).toBe('https://x/v.mp4')
  })

  it('认 Miau 查询信封 —— 视频地址在 data.data.output,任务号用网关 id', async () => {
    const fetchImpl = jsonFetch({
      code: 'success',
      data: {
        task_id: 'task_gw',
        status: 'SUCCESS',
        result_url: 'https://oss.example/v.mp4',
        data: {
          output: {
            task_id: 'uuid-dashscope',
            task_status: 'SUCCEEDED',
            video_url: 'https://oss.example/v.mp4',
          },
        },
      },
    })
    const result = await createWan3Client({ fetchImpl }).queryTask('task_gw', bearer('k'))
    expect(result.status).toBe('succeeded')
    expect(result.id).toBe('task_gw')
    expect(result.content?.video_url).toBe('https://oss.example/v.mp4')
  })

  it('任务号做过 URL 编码,不让奇怪的 id 拼坏路径', async () => {
    const fetchImpl = jsonFetch({ output: { task_status: 'RUNNING' } })
    await createWan3Client({ fetchImpl }).queryTask('a/b c', bearer('k'))
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
    expect((await client.createTask(BODY, bearer('k'))).id).toBe('t-1')
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('4xx 不重发 —— 参数错了发一百次也一样', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }))
    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    await expect(client.createTask(BODY, bearer('k'))).rejects.toThrow(/400/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('拿不到任务号时不重发 —— 任务可能已经建成了,再发就是第二笔钱', async () => {
    const fetchImpl = jsonFetch({ output: {} })
    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    await expect(client.createTask(BODY, bearer('k'))).rejects.toThrow(/任务号/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('查询不走提交重试 —— 轮询本身就是在重试', async () => {
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 503 }))
    const client = createWan3Client({ fetchImpl, retryOptions: noWait })
    await expect(client.queryTask('t', bearer('k'))).rejects.toThrow(/503/)
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
    await expect(createWan3Client({ fetchImpl }).createTask(BODY, bearer('k'))).rejects.toThrow(
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
    await expect(createWan3Client({ fetchImpl }).queryTask('t', bearer('k'))).rejects.toThrow(
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
    await expect(client.createTask(BODY, bearer('k'))).rejects.toThrow(/model_not_found/)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('4xx 带上状态码与上游 message', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ code: 'InvalidApiKey', message: 'No API-key provided.' }), {
          status: 401,
        }),
    )
    await expect(createWan3Client({ fetchImpl }).createTask(BODY, bearer('k'))).rejects.toThrow(
      /401.*InvalidApiKey|InvalidApiKey.*401/s,
    )
  })

  it('响应不是 JSON 时也给出可读错误,不抛解析异常', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    await expect(createWan3Client({ fetchImpl }).queryTask('t', bearer('k'))).rejects.toThrow(/502/)
  })
})

/**
 * 「这次往返动了钱」的回调,用来触发余额刷新。与 `seedanceGateway/client.ts`
 * 那批对称 —— 少了它,万相走平台余额扣完钱余额还停在旧值。
 */
describe('onBilledExchange', () => {
  it('提交成功后报一次(上游此时已预扣)', async () => {
    const onBilledExchange = vi.fn()
    const fetchImpl = jsonFetch({ output: { task_id: 't-1' } })
    await createWan3Client({ fetchImpl, onBilledExchange }).createTask(BODY, bearer('k'))

    expect(onBilledExchange).toHaveBeenCalledTimes(1)
  })

  it('提交失败不报 —— 失败的往返不动钱', async () => {
    const onBilledExchange = vi.fn()
    const fetchImpl = vi.fn(async () => new Response('{}', { status: 400 }))
    await expect(
      createWan3Client({
        fetchImpl,
        onBilledExchange,
        // 去掉真实退避,否则这条要跑好几秒。`noWait` 住在另一个 describe 里,
        // 内联一份比把它提到模块顶层改动小。
        retryOptions: { sleep: async () => {} },
      }).createTask(BODY, bearer('k')),
    ).rejects.toThrow()

    expect(onBilledExchange).not.toHaveBeenCalled()
  })

  it('轮询到终态时报一次', async () => {
    const onBilledExchange = vi.fn()
    const fetchImpl = jsonFetch({
      output: { task_id: 't-1', task_status: 'SUCCEEDED', video_url: 'https://x/v.mp4' },
    })
    await createWan3Client({ fetchImpl, onBilledExchange }).queryTask('t-1', bearer('k'))

    expect(onBilledExchange).toHaveBeenCalledTimes(1)
  })

  /**
   * 🧬 变异点:去掉 `TERMINAL_STATUSES` 判断、让 `queryTask` 无条件报,这条必红。
   *
   * 一条视频要轮询十几次,每次都报就是十几次白查余额 —— 而中间那些 running
   * 一分钱不动。
   */
  it('轮询到中间态不报', async () => {
    const onBilledExchange = vi.fn()
    const fetchImpl = jsonFetch({ output: { task_id: 't-1', task_status: 'RUNNING' } })
    await createWan3Client({ fetchImpl, onBilledExchange }).queryTask('t-1', bearer('k'))

    expect(onBilledExchange).not.toHaveBeenCalled()
  })

  it('不传这个回调时行为与上线前逐字节相同', async () => {
    const fetchImpl = jsonFetch({ output: { task_id: 't-1' } })
    await expect(
      createWan3Client({ fetchImpl }).createTask(BODY, bearer('k')),
    ).resolves.toEqual({ id: 't-1' })
  })
})
