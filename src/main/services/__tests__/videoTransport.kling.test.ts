// 可灵 4.0 / 4.0 Omni 传输层 —— 经 Miau 网关的腾讯云 VOD 可灵渠道(new-api #183)。
//
// 钉住四件事:
//   1. 分派:alias 是 kling4 / kling4-omni 就走可灵通道,与计费模式无关;**没注册绝不回落**
//      (回落到 Seedance 会把可灵的 `kling-v4-*` 当 Ark 模型发给 vvdance,或被平台版 Seedance
//      网关路劫走 —— 后者扣的是平台余额,而且请求体里的模型名对不上);
//   2. 组包:模型 id 随档位走、素材原样透传、本地先拦网关必拒的组合;
//   3. 凭据:同一条 transport 服务两种钱包,每次调用现取;平台余额整份组头,自填 Key 只带 Authorization;
//   4. 不虚构能力:没有 deleteTask(取消接口未经证实)。

import { describe, expect, it, vi } from 'vitest'
import {
  createKlingTransport,
  createSeedanceGatewayTransport,
  createSeedanceTransport,
  transportFor,
  type VideoSubmitContext,
} from '../videoTransport'
import { KlingRequestError } from '../kling/request'
import type { SeedanceGatewayClient } from '../seedanceGateway/client'
import type { SeedanceContentItem } from '../seedance/types'

vi.mock('../auth/gatewayToken', () => ({
  gatewayPlatformHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    'X-Platform-User-Id': 'u-1',
    'X-Project-Id': '345',
  }),
}))

const IMG = 'https://cos.example/relay/a.png'

function ctx(over: Partial<VideoSubmitContext> = {}): VideoSubmitContext {
  const content: SeedanceContentItem[] = [
    { type: 'text', text: '一只橘猫在窗台上伸懒腰' },
    { type: 'image_url', role: 'first_frame', image_url: { url: IMG } },
  ]
  return {
    input: { prompt: '一只橘猫在窗台上伸懒腰', model: 'kling4', generateAudio: false },
    content,
    model: 'kling4',
    resolution: '1080p',
    ratio: '16:9',
    duration: 8,
    ...over,
  }
}

function gatewayClient(): SeedanceGatewayClient & {
  createTask: ReturnType<typeof vi.fn>
  queryTask: ReturnType<typeof vi.fn>
} {
  return {
    createTask: vi.fn(async () => ({ id: 'task_kling_1' })),
    queryTask: vi.fn(async () => ({ id: 'task_kling_1', status: 'running' as const })),
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

describe('transportFor(kling)', () => {
  it('两档都走可灵通道,与计费模式无关', () => {
    const seedance = seedanceTransport()
    const kling = createKlingTransport(gatewayClient(), platform())
    const seedanceGateway = createSeedanceGatewayTransport(gatewayClient(), platform())
    const registry = { seedance, kling, seedanceGateway }

    for (const alias of ['kling4', 'kling4-omni']) {
      expect(transportFor(registry, alias)).toBe(kling)
      // 🚨 平台余额不能把它劫去「平台版 Seedance」那条:同一个 host,请求体与模型目录都不同。
      expect(transportFor(registry, alias, { billing: 'platform' })).toBe(kling)
      expect(transportFor(registry, alias, { billing: 'own-key' })).toBe(kling)
    }
  })

  /** 🧬 变异点:改成 `registry.kling ?? registry.seedance`(照抄万相那条回落),必红。 */
  it('可灵通道没注册时抛错,绝不回落到 Seedance', () => {
    const seedance = seedanceTransport()
    expect(() => transportFor({ seedance }, 'kling4')).toThrow(/可灵/)
    expect(() => transportFor({ seedance }, 'kling4-omni', { billing: 'platform' })).toThrow(/可灵/)
  })

  it('不影响其它别名的分派', () => {
    const seedance = seedanceTransport()
    const kling = createKlingTransport(gatewayClient(), platform())
    expect(transportFor({ seedance, kling }, '2.5')).toBe(seedance)
    expect(transportFor({ seedance, kling }, undefined)).toBe(seedance)
  })
})

describe('createKlingTransport.createTask', () => {
  it('网关信封 + 上游模型 id;素材与角色原样透传', async () => {
    const client = gatewayClient()
    await expect(createKlingTransport(client, ownKey()).createTask(ctx())).resolves.toEqual({
      id: 'task_kling_1',
    })
    const [body] = client.createTask.mock.calls[0]
    expect(body).toEqual({
      model: 'kling-v4-vod',
      prompt: '一只橘猫在窗台上伸懒腰',
      metadata: {
        content: ctx().content,
        duration: 8,
        ratio: '16:9',
        resolution: '1080p',
        generate_audio: false,
      },
    })
  })

  it('Omni 用 kling-v4-omni-vod,参考图 / 参考视频照常放行', async () => {
    const client = gatewayClient()
    const content: SeedanceContentItem[] = [
      { type: 'text', text: '参考 @图片1 的服饰' },
      { type: 'image_url', role: 'reference_image', image_url: { url: IMG } },
      { type: 'video_url', role: 'reference_video', video_url: { url: 'https://cos.example/relay/v.mp4' } },
    ]
    await createKlingTransport(client, ownKey()).createTask(
      ctx({ model: 'kling4-omni', content, input: { prompt: 'p', model: 'kling4-omni' } }),
    )
    const [body] = client.createTask.mock.calls[0]
    expect(body.model).toBe('kling-v4-omni-vod')
    expect(body.metadata.content).toEqual(content)
  })

  it('非可灵别名抛错,不兜底成 kling4(兜底 = 跑着别人的模型按可灵价扣费)', async () => {
    const client = gatewayClient()
    await expect(createKlingTransport(client, ownKey()).createTask(ctx({ model: 'wan3' }))).rejects.toThrow(
      /非可灵/,
    )
    expect(client.createTask).not.toHaveBeenCalled()
  })

  it('本地就拦下网关必拒的组合,不打上游、不花钱', async () => {
    const client = gatewayClient()
    const transport = createKlingTransport(client, ownKey())
    // 智能时长:可灵没有
    await expect(transport.createTask(ctx({ duration: -1 }))).rejects.toBeInstanceOf(KlingRequestError)
    // 4.0 + 参考图
    await expect(
      transport.createTask(
        ctx({
          content: [
            { type: 'text', text: 'x' },
            { type: 'image_url', role: 'reference_image', image_url: { url: IMG } },
          ],
        }),
      ),
    ).rejects.toThrow(/Omni/)
    expect(client.createTask).not.toHaveBeenCalled()
  })

  it('平台余额:整份组头(含归属头),缺了流水查不到', async () => {
    const client = gatewayClient()
    await createKlingTransport(client, platform('shadow-tok')).createTask(ctx())
    const [, key, auth] = client.createTask.mock.calls[0]
    expect(key).toBe('shadow-tok')
    expect(auth).toMatchObject({
      Authorization: 'Bearer shadow-tok',
      'X-Platform-User-Id': 'u-1',
      'X-Project-Id': '345',
    })
  })

  it('自填 Miau Key:只带 Authorization,不带平台归属头', async () => {
    const client = gatewayClient()
    await createKlingTransport(client, ownKey('miau-key')).createTask(ctx())
    expect(client.createTask.mock.calls[0][2]).toEqual({ Authorization: 'Bearer miau-key' })
  })
})

describe('createKlingTransport.queryTask', () => {
  it('每次轮询现取凭据:用户中途切计费,下一次就该记到新的归属上', async () => {
    const client = gatewayClient()
    let billing: 'platform' | 'own-key' = 'platform'
    const transport = createKlingTransport(client, () =>
      billing === 'platform' ? { billing, token: 'shadow' } : { billing, token: 'own' },
    )
    await transport.queryTask('t')
    billing = 'own-key'
    await transport.queryTask('t')
    expect(client.queryTask.mock.calls[0][2]).toHaveProperty('X-Platform-User-Id')
    expect(client.queryTask.mock.calls[1][2]).toEqual({ Authorization: 'Bearer own' })
  })

  it('结果原样回给任务管理器(网关客户端已把 metadata.url 归一成 content.video_url)', async () => {
    const client = gatewayClient()
    client.queryTask.mockResolvedValueOnce({
      id: 't',
      status: 'succeeded',
      content: { video_url: 'https://o/k.mp4' },
    })
    await expect(createKlingTransport(client, ownKey()).queryTask('t')).resolves.toMatchObject({
      status: 'succeeded',
      content: { video_url: 'https://o/k.mp4' },
    })
  })
})

describe('createKlingTransport 凭据与取消', () => {
  it('requireApiKey:没凭据就抛,由 describeMissingGatewayToken 按计费模式说话', () => {
    expect(() => createKlingTransport(gatewayClient(), platform('')).requireApiKey()).toThrow()
    expect(() => createKlingTransport(gatewayClient(), ownKey('   ')).requireApiKey()).toThrow()
    expect(() => createKlingTransport(gatewayClient(), platform('ok')).requireApiKey()).not.toThrow()
  })

  it('没有 deleteTask —— 取消接口未经证实,如实告诉用户仍会计费', () => {
    expect(createKlingTransport(gatewayClient(), platform()).deleteTask).toBeUndefined()
  })
})
