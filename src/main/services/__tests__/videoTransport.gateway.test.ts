// 第三条路（经 Miau 网关提交 Seedance）接进传输层之后的分派与组包。
//
// 分派这一组是**变异测试**：`wan3` 与「平台余额下的 Seedance」都打同一个网关、
// 都是 miau,原来那句 `provider === 'miau' && registry.wan3` 无法把它们分开。
// 分错的症状是提交体形状完全不对（万相要 metadata.input.media[]，这条要
// metadata.content[]），上游 400,而错误信息里不会有一个字提到「路由错了」。

import { describe, expect, it, vi } from 'vitest'
import {
  createSeedanceTransport,
  createSeedanceGatewayTransport,
  createWan3Transport,
  transportFor,
  type VideoSubmitContext,
} from '../videoTransport'
import type { SeedanceContentItem } from '../seedance/types'
import type { ResolvedGatewayToken } from '../seedanceGateway/credentials'

const IMG = 'https://cos.example/a.png'

function ctx(over: Partial<VideoSubmitContext> = {}): VideoSubmitContext {
  const content: SeedanceContentItem[] = [
    { type: 'text', text: '一只橘猫' },
    { type: 'image_url', role: 'first_frame', image_url: { url: IMG } },
  ]
  return {
    input: { prompt: '一只橘猫（归一化之前）' },
    content,
    model: '2.0',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    ...over,
  }
}

function seedanceClient() {
  return {
    createTask: vi.fn(async () => ({ id: 'ark-1' })),
    queryTask: vi.fn(async () => ({ id: 'ark-1', status: 'running' as const })),
    downloadVideo: vi.fn(async () => 'x.mp4'),
    deleteTask: vi.fn(async () => {}),
  }
}

function wan3Client() {
  return {
    createTask: vi.fn(async () => ({ id: 'task_gw' })),
    queryTask: vi.fn(async () => ({ id: 'task_gw', status: 'running' as const })),
  }
}

function gatewayClient() {
  return {
    createTask: vi.fn(async () => ({ id: 'gw-1' })),
    queryTask: vi.fn(async () => ({ id: 'gw-1', status: 'running' as const })),
  }
}

const platformToken = (): ResolvedGatewayToken => ({ billing: 'platform', token: 'shadow-1' })

function registry() {
  return {
    seedance: createSeedanceTransport(seedanceClient(), () => 'ark-key'),
    wan3: createWan3Transport(wan3Client(), () => 'miau-key'),
    seedanceGateway: createSeedanceGatewayTransport(gatewayClient(), platformToken),
  }
}

describe('分派：三条路不再有歧义', () => {
  it('自填 Key（缺省）下 Seedance 家族仍走 vvdance 直连 —— 线上行为一个字节不变', () => {
    const r = registry()
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(transportFor(r, alias), alias).toBe(r.seedance)
      expect(transportFor(r, alias, { billing: 'own-key' }), alias).toBe(r.seedance)
    }
  })

  it('平台余额下 Seedance 家族改走网关', () => {
    const r = registry()
    for (const alias of ['2.0', '2.0-fast', '2.0-mini', '2.5'] as const) {
      expect(transportFor(r, alias, { billing: 'platform' }), alias).toBe(r.seedanceGateway)
    }
  })

  // ⚠️ 这一条是分派变异测试的靶心。
  it('wan3 永远走 wan3 —— 平台余额不能把它劫到 Seedance 网关那条路上', () => {
    // 两者都是 miau、同一个 host、同一枚 token,只有请求体形状不同。写成
    // 「platform → seedanceGateway」而忘了先看别名的话,万相会带着
    // metadata.content[] 提交,上游 400 且错误里不提路由。
    const r = registry()
    expect(transportFor(r, 'wan3')).toBe(r.wan3)
    expect(transportFor(r, 'wan3', { billing: 'platform' })).toBe(r.wan3)
    expect(transportFor(r, 'wan3', { billing: 'own-key' })).toBe(r.wan3)
  })

  // 这条曾经断言「回落 vvdance 直连」,是接线之前的口径。`11351683` 把它改成抛错:
  // 回落意味着扣用户自己的 vvdance key,而他以为花的是平台余额 —— 与
  // `seedanceGateway/credentials.ts` 立的「绝不跨模式回落」是同一条规矩。
  // 完整的变异说明在 videoTransport.test.ts「要平台余额但通道没注册时抛错」。
  it('网关 transport 没注册时抛错 —— 平台余额绝不悄悄改走自填 Key', () => {
    const seedance = createSeedanceTransport(seedanceClient(), () => 'k')
    expect(() => transportFor({ seedance }, '2.0', { billing: 'platform' })).toThrow(/平台余额/)
    // 反面:没要平台余额的照常走老路,老调用方不受影响。
    expect(transportFor({ seedance }, '2.0')).toBe(seedance)
  })

  it('认不出的别名即便在平台余额下也按 Seedance 直连走', () => {
    const r = registry()
    expect(transportFor(r, 'bogus-model', { billing: 'platform' })).toBe(r.seedance)
    expect(transportFor(r, undefined, { billing: 'platform' })).toBe(r.seedance)
  })
})

describe('createSeedanceGatewayTransport 组包', () => {
  it('提交的是网关信封（metadata 包裹 + 重复的顶层 prompt）', async () => {
    const client = gatewayClient()
    await createSeedanceGatewayTransport(client, platformToken).createTask(ctx())

    const [body, key] = client.createTask.mock.calls[0] as [Record<string, any>, string]
    expect(key).toBe('shadow-1')
    expect(body.prompt).toBe('一只橘猫')
    expect(body.metadata.content).toEqual(ctx().content)
    expect(body.metadata).toMatchObject({
      duration: 5,
      ratio: '16:9',
      resolution: '720p',
      generate_audio: true,
    })
  })

  it('顶层 prompt 取的是 content 里那份（已归一化）,不是 input.prompt 原文', async () => {
    // 两份漂移的话顶层与 content[0] 说着两句不同的话,上游按哪句走全看它心情。
    const client = gatewayClient()
    await createSeedanceGatewayTransport(client, platformToken).createTask(ctx())

    const body = (client.createTask.mock.calls[0] as [Record<string, any>, string])[0]
    expect(body.prompt).toBe('一只橘猫')
    expect(body.prompt).toBe(body.metadata.content[0].text)
    expect(body.prompt).not.toBe('一只橘猫（归一化之前）')
  })

  it('模型 id 钉死 doubao-*,不跟 vvdance 的 region 设置走', async () => {
    // 平台模式没有 region 概念(网关目录里根本没有 dreamina-*)。跟着 global
    // region 走会提交 dreamina-seedance-2-0-260128 然后拿一句 model_not_found。
    const client = gatewayClient()
    await createSeedanceGatewayTransport(client, platformToken).createTask(ctx({ model: '2.0' }))
    expect((client.createTask.mock.calls[0] as [Record<string, any>, string])[0].model).toBe(
      'doubao-seedance-2-0-260128',
    )

    const c25 = gatewayClient()
    await createSeedanceGatewayTransport(c25, platformToken).createTask(ctx({ model: '2.5' }))
    expect((c25.createTask.mock.calls[0] as [Record<string, any>, string])[0].model).toBe(
      'doubao-seedance-2-5-260628',
    )
  })

  it('asset:// 原样发出 —— 平台人像库引用是这条路存在的理由', async () => {
    const client = gatewayClient()
    const content: SeedanceContentItem[] = [
      { type: 'text', text: '主角出场' },
      { type: 'image_url', role: 'reference_image', image_url: { url: 'asset://portrait-7' } },
    ]
    await createSeedanceGatewayTransport(client, platformToken).createTask(ctx({ content }))

    const body = (client.createTask.mock.calls[0] as [Record<string, any>, string])[0]
    expect(JSON.stringify(body)).toContain('asset://portrait-7')
  })

  it('vvdance 专属能力不外泄（seed / web_search / taskMode 网关侧没有对等物）', async () => {
    const client = gatewayClient()
    await createSeedanceGatewayTransport(client, platformToken).createTask(
      ctx({
        input: { prompt: 'p', seed: 42, webSearch: true },
        taskMode: 'extend',
      }),
    )

    // 按键名查而不是按子串查：模型 id 本身就含 "seed"（doubao-**seed**ance-…）。
    const body = (client.createTask.mock.calls[0] as [Record<string, any>, string])[0]
    expect(Object.keys(body).sort()).toEqual(['metadata', 'model', 'prompt'])
    expect(Object.keys(body.metadata).sort()).toEqual([
      'content',
      'duration',
      'generate_audio',
      'ratio',
      'resolution',
    ])
  })

  it('generateAudio 显式 false 透传', async () => {
    const client = gatewayClient()
    await createSeedanceGatewayTransport(client, platformToken).createTask(
      ctx({ input: { prompt: 'p', generateAudio: false } }),
    )
    expect(
      (client.createTask.mock.calls[0] as [Record<string, any>, string])[0].metadata.generate_audio,
    ).toBe(false)
  })
})

describe('createSeedanceGatewayTransport 凭据', () => {
  it('平台模式缺凭据时报的是「选计费池」,不是「填 Miau Key」', () => {
    const t = createSeedanceGatewayTransport(gatewayClient(), () => ({
      billing: 'platform',
      token: '',
    }))
    expect(() => t.requireApiKey()).toThrow(/计费池/)
  })

  it('自填模式缺凭据时报的是「填 Miau Key」', () => {
    const t = createSeedanceGatewayTransport(gatewayClient(), () => ({
      billing: 'own-key',
      token: '',
    }))
    expect(() => t.requireApiKey()).toThrow(/Miau/)
  })

  it('有凭据时不抛', () => {
    expect(() => createSeedanceGatewayTransport(gatewayClient(), platformToken).requireApiKey()).not.toThrow()
  })

  it('token 每次提交现取 —— 中途切了计费池,下一次提交就该换', async () => {
    let token = 'shadow-a'
    const client = gatewayClient()
    const t = createSeedanceGatewayTransport(client, () => ({ billing: 'platform', token }))

    await t.createTask(ctx())
    token = 'shadow-b'
    await t.createTask(ctx())

    expect((client.createTask.mock.calls[0] as [unknown, string])[1]).toBe('shadow-a')
    expect((client.createTask.mock.calls[1] as [unknown, string])[1]).toBe('shadow-b')
  })
})

describe('createSeedanceGatewayTransport 轮询与取消', () => {
  it('轮询带同一枚凭据 —— 一个 shadow 账号建的任务,换别的 token 查会说不存在', async () => {
    const client = gatewayClient()
    await createSeedanceGatewayTransport(client, platformToken).queryTask('gw-1')
    expect(client.queryTask).toHaveBeenCalledWith('gw-1', 'shadow-1')
  })

  it('没有 deleteTask —— 网关侧取消接口未经证实,不发我们没验证过的请求', () => {
    expect(createSeedanceGatewayTransport(gatewayClient(), platformToken).deleteTask).toBeUndefined()
  })
})
