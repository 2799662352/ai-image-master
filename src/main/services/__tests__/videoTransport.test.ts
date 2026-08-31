// 传输层 —— provider 分派的唯一一处。
//
// 这些用例守的是同一件事:taskManager 不该知道 provider 的存在。组包、密钥、
// 取消能力的差异全部收敛在这里,加第三家 provider 时 taskManager 一行不用改。

import { describe, expect, it, vi } from 'vitest'
import {
  createSeedanceTransport,
  createWan3Transport,
  transportFor,
  type VideoSubmitContext,
} from '../videoTransport'
/**
 * 组头函数用替身。
 *
 * 真函数还要读 `getCredential()?.userId`(safeStorage),在这个不起 Electron 的
 * 文件里必然取不到,于是它只回一个 Authorization —— 那样断言会以「写错了」的样子
 * 挂掉,而真实接线其实没问题。
 *
 * 而且这个文件要钉的本来就是**接线**:平台支委托给它、自有 Key 支不委托。
 * 归属头里到底有哪几个键归 `gatewayToken` 自己的测试管,在这儿复述一遍
 * 只会多一份会漂的副本。
 */
vi.mock('../auth/gatewayToken', () => ({
  gatewayPlatformHeaders: (token: string) => ({
    Authorization: `Bearer ${token}`,
    'X-Platform-User-Id': 'u-1',
    'X-Project-Id': '345',
  }),
}))
import type { SeedanceContentItem } from '../seedance/types'
import { translateVideoTaskError } from '../videoTaskError'

const IMG = 'https://cos.example/a.png'

function ctx(over: Partial<VideoSubmitContext> = {}): VideoSubmitContext {
  const content: SeedanceContentItem[] = [{ type: 'text', text: '一只橘猫' }]
  return {
    input: { prompt: '一只橘猫' },
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

/**
 * 自填 Key 那一支的凭据解析器。
 *
 * 万相**同一条 transport 服务两种计费**（理由见 `createWan3Transport` 的注释），
 * 所以它收的是 `{ billing, token }` 而不是一枚裸 key —— 平台那一支要据此换成
 * 带计费归属头的整份组头。
 */
function ownKey(token: string) {
  return () => ({ billing: 'own-key' as const, token })
}

describe('transportFor', () => {
  it('按模型的 provider 选路', () => {
    const seedance = createSeedanceTransport(seedanceClient(), () => 'ark-key')
    const wan3 = createWan3Transport(wan3Client(), ownKey('miau-key'))
    const registry = { seedance, wan3 }

    expect(transportFor(registry, '2.0')).toBe(seedance)
    expect(transportFor(registry, '2.5')).toBe(seedance)
    expect(transportFor(registry, 'wan3')).toBe(wan3)
  })

  it('没注册万相时回落 Seedance —— 老调用方按老路走,不抛错', () => {
    const seedance = createSeedanceTransport(seedanceClient(), () => 'k')
    expect(transportFor({ seedance }, 'wan3')).toBe(seedance)
  })

  it('模型缺省按 2.0', () => {
    const seedance = createSeedanceTransport(seedanceClient(), () => 'k')
    expect(transportFor({ seedance }, undefined)).toBe(seedance)
  })

  it('认不出的别名按 Seedance 走,不抛错', () => {
    // 持久化里的旧别名、手改过的载荷都可能落到这里。抛错会让一条已经在上游
    // 跑着的任务彻底失去跟踪 —— 按老路问一次至少还有救。
    const seedance = createSeedanceTransport(seedanceClient(), () => 'k')
    const wan3 = createWan3Transport(wan3Client(), ownKey('k'))
    expect(transportFor({ seedance, wan3 }, 'bogus-model')).toBe(seedance)
  })

  /**
   * 🧬 变异点:把这条改回 `&& registry.seedanceGateway` 的静默回落,必红。
   *
   * 这是**不能回落**的那一类。同一个提交里的 `seedanceGateway/credentials.ts` 已经
   * 立过规矩:「刻意不回落到自填 Key:静默回落 = 用户以为在花平台余额、实际在花自己的钱」。
   * 而分派这一侧原先做的正是那件事 —— 平台通道没注册就把人送去 vvdance 直连,
   * 用户的 vvdance key 被扣,而他以为花的是平台余额。
   *
   * 今天还够不着(registry 尚未接线,那条回落是给「只注入 seedance 的老测试」用的),
   * 但接线的那一刻它就活了。抛错是对的:平台通道没就绪是**配置问题**,
   * 不是「换一条计费路继续跑」的理由。
   */
  it('要平台余额但通道没注册时抛错,绝不悄悄改走自填 Key 那条路', () => {
    const seedance = createSeedanceTransport(seedanceClient(), () => 'k')

    expect(() => transportFor({ seedance }, '2.0', { billing: 'platform' })).toThrow(/平台余额/)
    // 反面:没要平台余额的照常回落,老调用方不受影响。
    expect(transportFor({ seedance }, '2.0')).toBe(seedance)
    expect(transportFor({ seedance }, '2.0', { billing: 'own-key' })).toBe(seedance)
  })

  it('平台通道注册了就走它', () => {
    const seedance = createSeedanceTransport(seedanceClient(), () => 'k')
    const seedanceGateway = createSeedanceTransport(seedanceClient(), () => 'gw')

    expect(transportFor({ seedance, seedanceGateway }, '2.0', { billing: 'platform' })).toBe(
      seedanceGateway,
    )
    // 万相不受计费模式影响:它是另一套请求体,劫走只会换来一句没头没脑的 400。
    const wan3 = createWan3Transport(wan3Client(), ownKey('k'))
    expect(transportFor({ seedance, seedanceGateway, wan3 }, 'wan3', { billing: 'platform' })).toBe(
      wan3,
    )
  })
})

describe('translateVideoTaskError（两家翻译表汇合）', () => {
  it('万相的码走万相表', () => {
    expect(translateVideoTaskError('DataInspectionFailed: bad')).toMatch(/内容审核/)
  })

  it('Seedance 的码走 Seedance 表', () => {
    expect(translateVideoTaskError('LOCAL_ASSET_NOT_FOUND asset://abc')).toMatch(/素材/)
  })

  it('两家都不认的原样返回 —— 串联不能把原文吃掉', () => {
    // 两个翻译器都遵守「认不出原样返回」,所以顺序串联是安全的。
    const raw = 'SomeUnknownUpstreamCode: 上游新加的'
    expect(translateVideoTaskError(raw)).toBe(raw)
  })
})

describe('Seedance transport', () => {
  it('组 Ark 请求体并带 Ark 密钥', async () => {
    const client = seedanceClient()
    await createSeedanceTransport(client, () => 'ark-key').createTask(ctx())

    const [body, key] = client.createTask.mock.calls[0] as [Record<string, unknown>, string]
    expect(key).toBe('ark-key')
    expect(body).toMatchObject({ ratio: '16:9', resolution: '720p', duration: 5, generate_audio: true })
    expect(body.content).toEqual(ctx().content)
  })

  it('seed / 联网 / taskMode 不给就完全不出现', async () => {
    const client = seedanceClient()
    await createSeedanceTransport(client, () => 'k').createTask(ctx())
    const body = client.createTask.mock.calls[0][0] as Record<string, unknown>
    for (const key of ['seed', 'tools', 'taskMode']) {
      expect(Object.hasOwn(body, key)).toBe(false)
    }
  })

  it('给了就带上', async () => {
    const client = seedanceClient()
    await createSeedanceTransport(client, () => 'k').createTask(
      ctx({ input: { prompt: 'p', seed: 7.4, webSearch: true }, model: '2.5', taskMode: 'extend' }),
    )
    const body = client.createTask.mock.calls[0][0] as Record<string, unknown>
    expect(body.seed).toBe(7)
    expect(body.tools).toEqual([{ type: 'web_search' }])
    expect(body.taskMode).toBe('extend')
  })

  it('取消走上游 DELETE', async () => {
    const client = seedanceClient()
    await createSeedanceTransport(client, () => 'k').deleteTask?.('t-1')
    expect(client.deleteTask).toHaveBeenCalledWith('t-1', 'k')
  })
})

describe('万相 transport', () => {
  it('组万相请求体并带 Miau 密钥 —— 两套密钥不能串', async () => {
    const client = wan3Client()
    await createWan3Transport(client, ownKey('miau-key')).createTask(ctx({ model: 'wan3' }))

    const [body, auth] = client.createTask.mock.calls[0] as [
      Record<string, unknown>,
      Record<string, string>,
    ]
    expect(auth.Authorization).toBe('Bearer miau-key')
    expect(body.model).toBe('wan3.0-video')
    expect(body).toHaveProperty('metadata')
  })

  it('提示词取 content 里的 text —— 那才是最终会发出去的那份(已过引用归一化)', async () => {
    const client = wan3Client()
    await createWan3Transport(client, ownKey('k')).createTask(
      ctx({
        model: 'wan3',
        input: { prompt: '原始提示词' },
        content: [{ type: 'text', text: '归一化后的提示词' }],
      }),
    )
    expect((client.createTask.mock.calls[0][0] as { prompt: string }).prompt).toBe('归一化后的提示词')
  })

  it('素材从 content 取,按模式落进对应的槽', async () => {
    const client = wan3Client()
    await createWan3Transport(client, ownKey('k')).createTask(
      ctx({
        model: 'wan3',
        input: { prompt: 'p', mode: 'first_frame' },
        content: [
          { type: 'text', text: 'p' },
          { type: 'image_url', role: 'first_frame', image_url: { url: IMG } },
        ],
      }),
    )
    const body = client.createTask.mock.calls[0][0] as { metadata: { input: { media: unknown[] } } }
    expect(body.metadata.input.media).toEqual([{ type: 'first_frame', url: IMG }])
  })

  it('文档/链接槽从卡片一路走到 media[] 末尾', async () => {
    // 追加到末尾而不是插入:提示词里的「图片1」指的是 media[] 的位置,
    // 文档不该把图的序号挤位。
    const client = wan3Client()
    await createWan3Transport(client, ownKey('k')).createTask(
      ctx({
        model: 'wan3',
        input: {
          prompt: 'p',
          mode: 'multimodal_ref',
          documentOrLink: JSON.stringify({ type: 'file', url: 'https://x/shots.pdf', displayName: 'shots.pdf' }),
        },
        content: [
          { type: 'text', text: 'p' },
          { type: 'image_url', role: 'reference_image', image_url: { url: IMG } },
        ],
      }),
    )
    const body = client.createTask.mock.calls[0][0] as { metadata: { input: { media: unknown[] } } }
    expect(body.metadata.input.media).toEqual([
      { type: 'reference_image', url: IMG },
      { type: 'file', url: 'https://x/shots.pdf' },
    ])
  })

  it('文档槽也认裸 URL —— MCP 工具收的就是这个形状', async () => {
    // 不认的话:agent 写进去一个裸 URL,parse 返回 null,槽位被当成「没设置」
    // 直接丢掉,而 agent 收到的是一次成功回执。
    const client = wan3Client()
    await createWan3Transport(client, ownKey('k')).createTask(
      ctx({
        model: 'wan3',
        input: { prompt: 'p', mode: 'text2video', documentOrLink: 'https://x/spec.pdf' },
      }),
    )
    const body = client.createTask.mock.calls[0][0] as { metadata: { input: { media: unknown[] } } }
    expect(body.metadata.input.media).toEqual([{ type: 'file', url: 'https://x/spec.pdf' }])
  })

  it('裸 URL 的类型由后缀判定,不是文档就是链接', async () => {
    const client = wan3Client()
    await createWan3Transport(client, ownKey('k')).createTask(
      ctx({
        model: 'wan3',
        input: { prompt: 'p', mode: 'text2video', documentOrLink: 'https://news.example/article/42' },
      }),
    )
    const body = client.createTask.mock.calls[0][0] as { metadata: { input: { media: unknown[] } } }
    expect(body.metadata.input.media).toEqual([{ type: 'link', url: 'https://news.example/article/42' }])
  })

  it('槽位是坏数据时当没设置,不让整张卡提交不了', async () => {
    const client = wan3Client()
    await createWan3Transport(client, ownKey('k')).createTask(
      ctx({ model: 'wan3', input: { prompt: 'p', mode: 'text2video', documentOrLink: '{坏 JSON' } }),
    )
    const body = client.createTask.mock.calls[0][0] as { metadata: { input: { media: unknown[] } } }
    expect(body.metadata.input.media).toEqual([])
  })

  it('不提供 deleteTask —— 取消接口没验证过,宁可让上层说实话', async () => {
    // 发一个没验证过的请求、再把它的失败报成「取消失败」,会让用户以为钱本来能省。
    expect(createWan3Transport(wan3Client(), ownKey('k')).deleteTask).toBeUndefined()
  })

  it('查询直接透传给万相客户端', async () => {
    const client = wan3Client()
    const r = await createWan3Transport(client, ownKey('k')).queryTask('task_gw')
    expect(client.queryTask).toHaveBeenCalledWith('task_gw', { Authorization: 'Bearer k' })
    expect(r.status).toBe('running')
  })

  it('没配密钥时报万相自己的话,不提火山', async () => {
    // 原先 submit 硬查 Seedance 密钥,只配了 Miau 的用户会被要求去配一个这条路
    // 根本用不到的火山密钥。
    const t = createWan3Transport(wan3Client(), ownKey('   '))
    expect(() => t.requireApiKey()).toThrow(/Miau/)
    expect(() => t.requireApiKey()).not.toThrow(/SEEDANCE/)
  })

  // 两种缺席的补救动作完全不同:平台模式该说「去选计费池」,而不是让一个压根
  // 没打算填 Key 的用户去填 Key。
  it('平台模式下凭据缺席,说的是「选计费池」而不是「填 Key」', () => {
    const t = createWan3Transport(wan3Client(), () => ({ billing: 'platform' as const, token: '' }))
    expect(() => t.requireApiKey()).toThrow(/计费池/)
  })

  it('密钥现取,不在建 transport 时固化 —— 用户改完密钥下一次提交就该生效', async () => {
    const client = wan3Client()
    let key = 'old'
    const transport = createWan3Transport(client, () => ({ billing: 'own-key' as const, token: key }))
    key = 'new'
    await transport.createTask(ctx({ model: 'wan3' }))
    expect((client.createTask.mock.calls[0][1] as Record<string, string>).Authorization).toBe(
      'Bearer new',
    )
  })
})

/**
 * 万相走平台余额。
 *
 * 此前它**无论哪种计费都用自填 Key** —— `transportFor` 里万相那条 `if` 排在计费
 * 判断之前(那是对的,万相请求体形状不同,劫到网关 transport 只会换来一句 400),
 * 但凭据也跟着一并写死了。结果:用户开着平台余额出万相,扣的是自己的 Miau Key,
 * 平台用量明细里还查不到。
 */
describe('万相 × 平台余额', () => {
  /**
   * 🧬 变异点:把 `wan3AuthHeaders` 里平台那一支改成只贴 Authorization
   * (不走 `gatewayPlatformHeaders`),这条必红。
   *
   * 少了那三个归属头,钱扣对了但流水一条都查不到,而且一个错都不报 ——
   * 与 2026-08-29 那次「余额准确减少、后台显示共 0 条」逐字同形。
   */
  it('平台模式带上计费归属头,不只是 Authorization', async () => {
    const client = wan3Client()
    await createWan3Transport(client, () => ({
      billing: 'platform' as const,
      token: 'sk-shadow',
    })).createTask(ctx({ model: 'wan3' }))

    const auth = client.createTask.mock.calls[0][1] as Record<string, string>
    expect(auth.Authorization).toBe('Bearer sk-shadow')
    // 归属头由 `gatewayPlatformHeaders` 整份给出。这里只断言「不止 Authorization
    // 一项」,具体键名归那个函数管 —— 在这里复述一遍就是第二份会漂的副本。
    expect(Object.keys(auth).length).toBeGreaterThan(1)
  })

  /**
   * 🧬 变异点:让自填 Key 那一支也走 `gatewayPlatformHeaders`,这条必红。
   *
   * 用自己的 Key 出片却带着平台归属头,会把这笔消费记到组织账上 —— 方向相反、
   * 同样是记错账。
   */
  it('自有 Key 模式只贴 Authorization,不带归属头', async () => {
    const client = wan3Client()
    await createWan3Transport(client, ownKey('user-key')).createTask(ctx({ model: 'wan3' }))

    expect(client.createTask.mock.calls[0][1]).toEqual({ Authorization: 'Bearer user-key' })
  })

  it('轮询也带同一份头 —— 差额结算那条日志同样需要归属', async () => {
    const client = wan3Client()
    await createWan3Transport(client, () => ({
      billing: 'platform' as const,
      token: 'sk-shadow',
    })).queryTask('t-1')

    const auth = client.queryTask.mock.calls[0][1] as Record<string, string>
    expect(auth.Authorization).toBe('Bearer sk-shadow')
    expect(Object.keys(auth).length).toBeGreaterThan(1)
  })
})
