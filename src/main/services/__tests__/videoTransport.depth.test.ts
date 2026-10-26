// 深度捕捉(depth)传输层 —— `generate_video` 的变体,经 Miau 网关腾讯云点播深度估计渠道。
//
// 钉住四件事:
//   1. 分派:alias 是 depth 就走 depth 通道,**没注册绝不回落**(回落到 Seedance 会把源视频
//      当 Ark 的 content[] 发出去,而且扣的可能是用户自己的 vvdance key);
//   2. 组包:模型 id 随分辨率变(分辨率只由模型名决定)、源视频取自 content[] 的 video_url,
//      提示词(text 条目)不上行;
//   3. 凭据:平台余额必须用 `gatewayPlatformHeaders` 整份组头,自填 Key 只带 Authorization;
//   4. 错误:MediaKit 的 HTTP 错误转成 `SeedanceApiError`,让 pollLoop 能按状态码区分
//      「重试能自愈」与「重试只是浪费时间」。

import { describe, expect, it, vi } from 'vitest'
import {
  createDepthTransport,
  createSeedanceTransport,
  transportFor,
  type VideoSubmitContext,
} from '../videoTransport'
import { MediaKitApiError, type MediaKitClient } from '../mediaKit/client'
import { SeedanceApiError } from '../seedance/apiError'
import type { SeedanceContentItem } from '../seedance/types'

// 与 videoTransport.test.ts 同款替身:真函数要读 safeStorage,这个文件钉的是接线。
vi.mock('../auth/gatewayToken', () => ({
  gatewayPlatformHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    'X-Platform-User-Id': 'u-1',
    'X-Project-Id': '345',
  }),
}))

const SOURCE = 'https://cos.example/relay/src.mp4'

function ctx(over: Partial<VideoSubmitContext> = {}): VideoSubmitContext {
  const content: SeedanceContentItem[] = [
    { type: 'text', text: '深度捕捉' },
    { type: 'video_url', role: 'reference_video', video_url: { url: SOURCE } },
  ]
  return {
    input: { prompt: '深度捕捉', model: 'depth', referenceVideos: [SOURCE] },
    content,
    model: 'depth',
    resolution: '480p',
    ratio: 'adaptive',
    duration: -1,
    ...over,
  }
}

function mediaKit(): MediaKitClient & {
  submit: ReturnType<typeof vi.fn>
  query: ReturnType<typeof vi.fn>
} {
  return {
    submit: vi.fn(async () => ({ id: 'task_depth_1' })),
    query: vi.fn(async () => ({ id: 'task_depth_1', status: 'running' as const })),
  }
}

const platform = (token = 'shadow-tok') => () => ({ billing: 'platform' as const, token })
const ownKey = (token = 'miau-key') => () => ({ billing: 'own-key' as const, token })

function seedanceTransport() {
  return createSeedanceTransport(
    {
      createTask: vi.fn(async () => ({ id: 'ark' })),
      queryTask: vi.fn(async () => ({ id: 'ark', status: 'running' as const })),
      downloadVideo: vi.fn(async () => 'x.mp4'),
      deleteTask: vi.fn(async () => {}),
    },
    () => 'ark-key',
  )
}

describe('transportFor(depth)', () => {
  it('depth 走 depth 通道,与计费模式无关', () => {
    const seedance = seedanceTransport()
    const depth = createDepthTransport(mediaKit(), platform())
    const registry = { seedance, depth }

    expect(transportFor(registry, 'depth')).toBe(depth)
    // 平台余额也不能被「Seedance 平台通道」劫走:请求体形状完全不同。
    expect(transportFor(registry, 'depth', { billing: 'platform' })).toBe(depth)
    expect(transportFor(registry, 'depth', { billing: 'own-key' })).toBe(depth)
  })

  /**
   * 🧬 变异点:改成 `registry.depth ?? registry.seedance`(照抄万相那条回落),必红。
   *
   * 万相回落是良性的(同一个钱包、只换组包器);这里不是 —— 回落到 Seedance 意味着把源视频
   * 当 Ark 的 content[] 发给 vvdance,而且扣的是另一把钥匙。通道没注册是配置问题,要响亮。
   */
  it('depth 通道没注册时抛错,绝不回落到 Seedance', () => {
    const seedance = seedanceTransport()
    expect(() => transportFor({ seedance }, 'depth')).toThrow(/深度捕捉/)
    expect(() => transportFor({ seedance }, 'depth', { billing: 'platform' })).toThrow(/深度捕捉/)
  })

  it('不影响其它别名的分派', () => {
    const seedance = seedanceTransport()
    const depth = createDepthTransport(mediaKit(), platform())
    expect(transportFor({ seedance, depth }, '2.0')).toBe(seedance)
    expect(transportFor({ seedance, depth }, undefined)).toBe(seedance)
  })
})

describe('createDepthTransport.createTask', () => {
  it('模型 id 随分辨率:rh-video-depth-<res>,源视频取自 content[]', async () => {
    for (const res of ['480p', '720p', '1080p'] as const) {
      const client = mediaKit()
      await createDepthTransport(client, platform()).createTask(ctx({ resolution: res }))
      expect(client.submit).toHaveBeenCalledTimes(1)
      const [model, url, options] = client.submit.mock.calls[0]
      expect(model).toBe(`rh-video-depth-${res}`)
      expect(url).toBe(SOURCE)
      // 深度捕捉没有可调参数 —— 分辨率在模型名里,别再往 metadata 里塞一份。
      expect(options).toEqual({})
    }
  })

  it('返回网关签发的任务号', async () => {
    const client = mediaKit()
    await expect(createDepthTransport(client, platform()).createTask(ctx())).resolves.toEqual({
      id: 'task_depth_1',
    })
  })

  it('平台余额:整份组头(含归属头),缺了流水查不到', async () => {
    const client = mediaKit()
    await createDepthTransport(client, platform('shadow-tok')).createTask(ctx())
    const auth = client.submit.mock.calls[0][3]
    expect(auth).toMatchObject({
      Authorization: 'Bearer shadow-tok',
      'X-Platform-User-Id': 'u-1',
      'X-Project-Id': '345',
    })
  })

  it('自填 Miau Key:只带 Authorization,不带平台归属头', async () => {
    const client = mediaKit()
    await createDepthTransport(client, ownKey('miau-key')).createTask(ctx())
    expect(client.submit.mock.calls[0][3]).toEqual({ Authorization: 'Bearer miau-key' })
  })

  it('不认识的分辨率抛错,不静默兜底成某一档(档位就是价格)', async () => {
    const client = mediaKit()
    await expect(
      createDepthTransport(client, platform()).createTask(ctx({ resolution: '4k' })),
    ).rejects.toThrow(/4k/)
    expect(client.submit).not.toHaveBeenCalled()
  })

  it('源视频不是恰好一段就在提交前抛错,不打上游', async () => {
    const client = mediaKit()
    const transport = createDepthTransport(client, platform())

    await expect(
      transport.createTask(ctx({ content: [{ type: 'text', text: 'x' }] })),
    ).rejects.toThrow(/恰好一段/)
    await expect(
      transport.createTask(
        ctx({
          content: [
            { type: 'video_url', video_url: { url: SOURCE } },
            { type: 'video_url', video_url: { url: `${SOURCE}?2` } },
          ],
        }),
      ),
    ).rejects.toThrow(/恰好一段/)
    expect(client.submit).not.toHaveBeenCalled()
  })

  it('源视频不是公网 https(中转被绕开)就拒绝,别让上游去拉 data: / asset://', async () => {
    const client = mediaKit()
    const transport = createDepthTransport(client, platform())
    for (const bad of ['asset://asset-123', 'data:video/mp4;base64,AAAA', 'D:/clips/a.mp4']) {
      await expect(
        transport.createTask(ctx({ content: [{ type: 'video_url', video_url: { url: bad } }] })),
      ).rejects.toThrow(/公网/)
    }
    expect(client.submit).not.toHaveBeenCalled()
  })

  it('提示词(text 条目)不上行', async () => {
    const client = mediaKit()
    await createDepthTransport(client, platform()).createTask(
      ctx({
        content: [
          { type: 'text', text: 'SECRET-PROMPT' },
          { type: 'video_url', role: 'reference_video', video_url: { url: SOURCE } },
        ],
      }),
    )
    expect(JSON.stringify(client.submit.mock.calls[0])).not.toContain('SECRET-PROMPT')
  })
})

describe('createDepthTransport.queryTask', () => {
  it('把 MediaKit 的结果翻成 Seedance 形状:成功 → content.video_url', async () => {
    const client = mediaKit()
    client.query.mockResolvedValueOnce({
      id: 'task_depth_1',
      status: 'succeeded',
      videoUrl: 'https://rh.example/out/depth.mp4',
    })
    const r = await createDepthTransport(client, platform()).queryTask('task_depth_1')
    expect(r).toMatchObject({
      id: 'task_depth_1',
      status: 'succeeded',
      content: { video_url: 'https://rh.example/out/depth.mp4' },
    })
  })

  it('进行中不带 content;状态原样透传', async () => {
    const client = mediaKit()
    for (const status of ['queued', 'running'] as const) {
      client.query.mockResolvedValueOnce({ id: 't', status })
      const r = await createDepthTransport(client, platform()).queryTask('t')
      expect(r.status).toBe(status)
      expect(r.content).toBeUndefined()
    }
  })

  it('失败带上游的错误码与原因', async () => {
    const client = mediaKit()
    client.query.mockResolvedValueOnce({
      id: 't',
      status: 'failed',
      error: { code: 'upstream_error', message: 'video too long' },
    })
    const r = await createDepthTransport(client, platform()).queryTask('t')
    expect(r.status).toBe('failed')
    expect(r.error).toEqual({ code: 'upstream_error', message: 'video too long' })
  })

  it('上游没回 id 时用我们手里的任务号,别让状态对象丢了身份', async () => {
    const client = mediaKit()
    client.query.mockResolvedValueOnce({ id: '', status: 'running' })
    const r = await createDepthTransport(client, platform()).queryTask('task-we-hold')
    expect(r.id).toBe('task-we-hold')
  })

  it('每次轮询现取凭据:用户中途切计费,下一次就该记到新的归属上', async () => {
    const client = mediaKit()
    let billing: 'platform' | 'own-key' = 'platform'
    const transport = createDepthTransport(client, () =>
      billing === 'platform'
        ? { billing, token: 'shadow' }
        : { billing, token: 'own' },
    )
    await transport.queryTask('t')
    billing = 'own-key'
    await transport.queryTask('t')
    expect(client.query.mock.calls[0][1]).toHaveProperty('X-Platform-User-Id')
    expect(client.query.mock.calls[1][1]).toEqual({ Authorization: 'Bearer own' })
  })
})

describe('createDepthTransport 错误形态', () => {
  it('提交的 HTTP 错误变成 SeedanceApiError,状态码保留', async () => {
    const client = mediaKit()
    client.submit.mockRejectedValueOnce(new MediaKitApiError('MediaKit API 401: Invalid token', 401))
    const err = await createDepthTransport(client, platform())
      .createTask(ctx())
      .catch((e) => e)
    expect(err).toBeInstanceOf(SeedanceApiError)
    expect((err as SeedanceApiError).status).toBe(401)
    expect((err as SeedanceApiError).retryable).toBe(false)
    expect((err as SeedanceApiError).message).toMatch(/Invalid token/)
  })

  it('轮询遇到 5xx 是可重试的,4xx 不是 —— pollLoop 据此决定要不要继续等', async () => {
    const client = mediaKit()
    client.query.mockRejectedValueOnce(new MediaKitApiError('MediaKit API 503', 503))
    client.query.mockRejectedValueOnce(new MediaKitApiError('MediaKit API 404', 404))
    const transport = createDepthTransport(client, platform())
    const e503 = await transport.queryTask('t').catch((e) => e)
    const e404 = await transport.queryTask('t').catch((e) => e)
    expect(e503).toBeInstanceOf(SeedanceApiError)
    expect((e503 as SeedanceApiError).retryable).toBe(true)
    expect((e404 as SeedanceApiError).retryable).toBe(false)
  })

  it('非 HTTP 错误(超时 / 断网)原样抛出,不假装成 API 错误', async () => {
    const client = mediaKit()
    const boom = new Error('请求超时')
    client.query.mockRejectedValueOnce(boom)
    await expect(createDepthTransport(client, platform()).queryTask('t')).rejects.toBe(boom)
  })
})

describe('createDepthTransport 凭据与取消', () => {
  it('requireApiKey:没凭据就抛,由 describeMissingGatewayToken 按计费模式说话', () => {
    expect(() => createDepthTransport(mediaKit(), platform('')).requireApiKey()).toThrow()
    expect(() => createDepthTransport(mediaKit(), ownKey('   ')).requireApiKey()).toThrow()
    expect(() => createDepthTransport(mediaKit(), platform('ok')).requireApiKey()).not.toThrow()
  })

  it('没有 deleteTask —— 取消接口未经证实,如实告诉用户仍会计费', () => {
    expect(createDepthTransport(mediaKit(), platform()).deleteTask).toBeUndefined()
  })
})
