// `ensureAsset` —— 「这张图在当前计费池里有没有一个可用的 asset id」。
//
// 被测的是三条**没有任何本地信号会提示你做错了**的语义:
//   1. 跨池的旧 id 要判无效并重登记(串号:另一个池的 id 发出去,上游拒或静默用错素材)
//   2. 复用旧 id 时仍然等就绪(首次 wait 超时的 asset 会永久毒化后续每一次生成)
//   3. 等不到就抛,绝不降级成图片 URL(降级产出「同一套衣服换了张脸」)
//
// 三条都会在单元测试里「看起来能跑」,只在真机上、往往只在用户那边才出问题。
// 三条各自都有变异测试标注(🧬),把实现改坏必须能变红。

import { describe, expect, it, vi, beforeEach } from 'vitest'
import path from 'node:path'

// ── 夹具:内存文件系统 ──────────────────────────────────────────────────────
const files = new Map<string, string>()
const writeFailure = { current: null as Error | null }

const readFileSync = vi.fn((p: unknown) => {
  const v = files.get(String(p))
  if (v === undefined) throw Object.assign(new Error(`ENOENT: ${String(p)}`), { code: 'ENOENT' })
  return v
})
const writeFileSync = vi.fn((p: unknown, data: unknown) => {
  if (writeFailure.current) throw writeFailure.current
  files.set(String(p), String(data))
})
vi.mock('node:fs', () => ({
  default: { readFileSync, writeFileSync },
  readFileSync,
  writeFileSync,
}))

vi.mock('electron', () => ({
  app: { getPath: () => '/ud' },
  net: { fetch: vi.fn() },
  safeStorage: { isEncryptionAvailable: () => false },
}))

// 客户端整层 mock 掉:它的契约(组头 / 大小写 / 截断)已经在 platformAssets.test.ts
// 逐条钉过,这里要测的是**本模块自己的**决策,不是再验一遍 HTTP 形状。
const registerAsset = vi.fn()
const pollAsset = vi.fn()
const getAsset = vi.fn()
vi.mock('../platformAssets', () => ({ registerAsset, pollAsset, getAsset }))

const FILE = path.join('/ud', 'portrait-asset-bindings.json')

const URL_A = 'https://cos.example.com/portraits/a.png'
const URL_B = 'https://cos.example.com/portraits/b.png'

const POOL = { projectId: 42 }
const POOL_OTHER_PROJECT = { projectId: 43 }
/** 同一个 projectId,但带 producer 池 —— **另一个池**,不是同一个。 */
const POOL_PP = { projectId: 42, producerProjectId: 7 }
const POOL_PP_OTHER = { projectId: 42, producerProjectId: 8 }

const active = (Id: string) => ({ Id, Status: 'Active' })
const registered = (Id: string) => ({ Id, URL: URL_A, PreviewUrl: URL_A, cosUrl: URL_A })

/** 直接写夹具文件 —— 顺带把读路径也测了。 */
function seed(bindings: Record<string, unknown>): void {
  files.set(FILE, JSON.stringify({ bindings }))
}

function storedFile(): { bindings: Record<string, unknown[]> } {
  return JSON.parse(files.get(FILE) ?? '{"bindings":{}}') as { bindings: Record<string, unknown[]> }
}

describe('ensureAsset', () => {
  beforeEach(() => {
    vi.resetModules()
    files.clear()
    writeFailure.current = null
    readFileSync.mockClear()
    writeFileSync.mockClear()
    registerAsset.mockReset()
    pollAsset.mockReset()
    getAsset.mockReset()
    registerAsset.mockResolvedValue(registered('asset-new'))
    pollAsset.mockResolvedValue(active('asset-new'))
  })

  // ── 首次登记 ─────────────────────────────────────────────────────────────

  it('没有绑定时登记一次、落库、等就绪,返回 id', async () => {
    const m = await import('../ensureAsset')

    const id = await m.ensureAsset({ url: URL_A, name: '主角' }, POOL)

    expect(id).toBe('asset-new')
    expect(registerAsset).toHaveBeenCalledTimes(1)
    expect(registerAsset).toHaveBeenCalledWith(
      { url: URL_A, assetType: 'Image', name: '主角' },
      POOL,
    )
    expect(pollAsset).toHaveBeenCalledWith('asset-new', POOL)
    expect(storedFile().bindings[URL_A]).toEqual([{ projectId: 42, assetId: 'asset-new' }])
  })

  it('池的两半都原样传给客户端,不在这一层丢掉 producerProjectId', async () => {
    const m = await import('../ensureAsset')

    await m.ensureAsset({ url: URL_A }, POOL_PP)

    expect(registerAsset).toHaveBeenCalledWith(expect.anything(), POOL_PP)
    expect(pollAsset).toHaveBeenCalledWith('asset-new', POOL_PP)
    expect(storedFile().bindings[URL_A]).toEqual([
      { projectId: 42, producerProjectId: 7, assetId: 'asset-new' },
    ])
  })

  it('同一张图同一个池,第二次直接复用,不再登记', async () => {
    const m = await import('../ensureAsset')

    await m.ensureAsset({ url: URL_A }, POOL)
    await m.ensureAsset({ url: URL_A }, POOL)

    expect(registerAsset).toHaveBeenCalledTimes(1)
  })

  // ── 语义 ①:跨池的旧 id 判无效并重登记 ────────────────────────────────────

  /**
   * 🧬 变异点:把 `sameScope` 改成只比 `projectId`,或干脆 `return true`,这几条必红。
   *
   * 上游把 group 按 `project-<id>` / `project-<id>-pp-<ppId>` 懒创建,一个 pool 下登记的
   * asset 在另一个 pool 下**读不出来** —— 不是陈旧,是不存在。复用另一个池的 id 会把
   * 别人的素材 id 发出去:上游拒是走运,静默用错素材是更糟的那一半。
   */
  it.each([
    ['projectId 不同', POOL_OTHER_PROJECT],
    ['producerProjectId 从无到有(同 projectId)', POOL_PP],
  ])('已存 42 号池的 id,换到「%s」的池要判无效并重登记', async (_label, otherPool) => {
    seed({ [URL_A]: [{ projectId: 42, assetId: 'asset-in-42' }] })
    const m = await import('../ensureAsset')
    registerAsset.mockResolvedValue(registered('asset-fresh'))
    pollAsset.mockResolvedValue(active('asset-fresh'))

    const id = await m.ensureAsset({ url: URL_A }, otherPool)

    expect(id).toBe('asset-fresh')
    expect(registerAsset).toHaveBeenCalledTimes(1)
    // 旧池的绑定不能被顶掉 —— 用户切回去时它仍然有效。
    expect(storedFile().bindings[URL_A]).toContainEqual({ projectId: 42, assetId: 'asset-in-42' })
  })

  /**
   * 🧬 池键是**两半**。两个不同的 producer project 可以共用一个 projectId
   * (`auth/session.ts:170-175` 同一条教训),只按 projectId 认会把两个池悄悄合并。
   * 上一条 `it.each` 的两个夹具在「只比 projectId」的变异下都还能红,但这条是唯一
   * 覆盖「pp 有值 vs pp 有另一个值」的 —— 少了它,变异成「比 projectId + 比 pp 是否存在」
   * 一条断言都不会红。
   */
  it('producerProjectId 不同(7 vs 8)也是两个池,不能复用', async () => {
    seed({ [URL_A]: [{ projectId: 42, producerProjectId: 7, assetId: 'asset-in-pp7' }] })
    const m = await import('../ensureAsset')
    registerAsset.mockResolvedValue(registered('asset-in-pp8'))
    pollAsset.mockResolvedValue(active('asset-in-pp8'))

    const id = await m.ensureAsset({ url: URL_A }, POOL_PP_OTHER)

    expect(id).toBe('asset-in-pp8')
    expect(registerAsset).toHaveBeenCalledTimes(1)
  })

  /**
   * 🚨 `producerProjectId: 0` 必须与「没给」同义 —— 这是 `platformAssets.scopeHeaders`
   * 的既定口径(`ppId > 0` 才发头)。两边口径不一致的后果是**缓存与线路对不上**:
   * 请求打的是 42 号池,绑定却记在「42 + pp0」这个不存在的池上,于是每次都重新登记。
   */
  it('producerProjectId 为 0 与没给同义,命中同一条绑定', async () => {
    seed({ [URL_A]: [{ projectId: 42, assetId: 'asset-stored' }] })
    const m = await import('../ensureAsset')
    pollAsset.mockResolvedValue(active('asset-stored'))

    expect(await m.ensureAsset({ url: URL_A }, { projectId: 42, producerProjectId: 0 })).toBe(
      'asset-stored',
    )
    expect(registerAsset).not.toHaveBeenCalled()
  })

  it('一张图在多个池里各有一条绑定,互不覆盖、各自命中', async () => {
    const m = await import('../ensureAsset')
    registerAsset.mockResolvedValueOnce(registered('a-42'))
    pollAsset.mockResolvedValueOnce(active('a-42'))
    await m.ensureAsset({ url: URL_A }, POOL)
    registerAsset.mockResolvedValueOnce(registered('a-42-pp7'))
    pollAsset.mockResolvedValueOnce(active('a-42-pp7'))
    await m.ensureAsset({ url: URL_A }, POOL_PP)

    expect(storedFile().bindings[URL_A]).toHaveLength(2)
    expect(registerAsset).toHaveBeenCalledTimes(2)

    registerAsset.mockClear()
    pollAsset.mockResolvedValue(active('x'))
    expect(await m.ensureAsset({ url: URL_A }, POOL)).toBe('a-42')
    expect(await m.ensureAsset({ url: URL_A }, POOL_PP)).toBe('a-42-pp7')
    expect(registerAsset).not.toHaveBeenCalled()
  })

  it('同一个池里不同的图各自一条绑定', async () => {
    const m = await import('../ensureAsset')
    registerAsset.mockResolvedValueOnce(registered('a')).mockResolvedValueOnce(registered('b'))
    pollAsset.mockResolvedValueOnce(active('a')).mockResolvedValueOnce(active('b'))

    expect(await m.ensureAsset({ url: URL_A }, POOL)).toBe('a')
    expect(await m.ensureAsset({ url: URL_B }, POOL)).toBe('b')
  })

  // ── 语义 ②:每次都等就绪(包括复用旧 id) ─────────────────────────────────

  /**
   * 🧬 变异点:把 `pollAsset` 挪进 `if (!assetId)` 分支里(只在新登记时等),这条必红。
   *
   * 首次 wait 超时的 asset 否则会**永久毒化**后续每一次生成:id 存下来了,但上游还没
   * 处理完,而我们再也不会去问一次。
   *
   * 这条不贵:后端 `pollAsset` 在 `Status` 已是 `Active`/`Failed` 时直接返回、不进长轮询
   * 循环(controller:401),复用旧 id 时那一次「等」是一个快往返。
   */
  it('复用已存的 id 时仍然等就绪', async () => {
    seed({ [URL_A]: [{ projectId: 42, assetId: 'asset-stored' }] })
    const m = await import('../ensureAsset')
    pollAsset.mockResolvedValue(active('asset-stored'))

    const id = await m.ensureAsset({ url: URL_A }, POOL)

    expect(id).toBe('asset-stored')
    expect(registerAsset).not.toHaveBeenCalled()
    expect(pollAsset).toHaveBeenCalledWith('asset-stored', POOL)
  })

  it('复用已存的 id 但它还在处理中时,照样抛,不因为「有 id」就放行', async () => {
    seed({ [URL_A]: [{ projectId: 42, assetId: 'asset-stored' }] })
    const m = await import('../ensureAsset')
    pollAsset.mockResolvedValue({ Id: 'asset-stored', Status: 'Processing' })

    await expect(m.ensureAsset({ url: URL_A }, POOL)).rejects.toMatchObject({
      code: 'ASSET_NOT_READY',
    })
  })

  // ── 语义 ③:等不到就抛,绝不降级成图片 URL ────────────────────────────────

  /**
   * 🧬 变异点:把 `throw` 换成 `return input.url`(或 `return assetId` 而不校验
   * `Status`),这两条必红。
   *
   * 降级会产出「同一套衣服换了张脸」—— 人像库正是跨镜锁脸的那条通道,悄悄换成弱通道
   * 的渲染回来是**微妙地错**的,比等待贵得多
   * (`shortdrama-mvp/src/app/api/segments/[id]/video/route.ts:256-264`)。
   */
  it('还在处理中时抛 ASSET_NOT_READY,且抛出物里不含图片 URL', async () => {
    const m = await import('../ensureAsset')
    pollAsset.mockResolvedValue({ Id: 'asset-new', Status: 'Processing' })

    const err = await m.ensureAsset({ url: URL_A }, POOL).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(Error)
    expect((err as { code?: string }).code).toBe('ASSET_NOT_READY')
    expect((err as Error).message).toMatch(/重试/)
    // 拿到 URL 的唯一途径不能是「读错误信息」。
    expect((err as Error).message).not.toContain(URL_A)
  })

  it('上游终态失败时用另一个码,不说「稍等重试」', async () => {
    const m = await import('../ensureAsset')
    pollAsset.mockResolvedValue({ Id: 'asset-new', Status: 'Failed' })

    await expect(m.ensureAsset({ url: URL_A }, POOL)).rejects.toMatchObject({
      code: 'ASSET_FAILED',
    })
  })

  it('返回值永远是 asset id,类型上不给「回落成 URL」留位置', async () => {
    const m = await import('../ensureAsset')
    const id = await m.ensureAsset({ url: URL_A }, POOL)
    expect(id).toBe('asset-new')
    expect(id).not.toBe(URL_A)
  })

  // ── 立刻落库 ─────────────────────────────────────────────────────────────

  /**
   * id 签发那一刻就有效,只是早。等就绪失败就丢掉它,意味着每次重试都重新登记同一张图
   * —— 上游多一份副本、多占一份配额,而配额只有显式 purge 才回收
   * (`shortdrama-mvp/src/lib/portrait/ensure.ts:58-64`)。
   */
  it('登记成功后立刻落库,即使随后等就绪失败', async () => {
    const m = await import('../ensureAsset')
    pollAsset.mockRejectedValue(new Error('boom'))

    await expect(m.ensureAsset({ url: URL_A }, POOL)).rejects.toThrow()
    expect(storedFile().bindings[URL_A]).toEqual([{ projectId: 42, assetId: 'asset-new' }])
  })

  it('落库之后重试不再重复登记,只重新等一次', async () => {
    const m = await import('../ensureAsset')
    pollAsset.mockRejectedValueOnce(new Error('boom'))

    await expect(m.ensureAsset({ url: URL_A }, POOL)).rejects.toThrow()
    pollAsset.mockResolvedValue(active('asset-new'))
    expect(await m.ensureAsset({ url: URL_A }, POOL)).toBe('asset-new')
    expect(registerAsset).toHaveBeenCalledTimes(1)
  })

  // ── 并发 ─────────────────────────────────────────────────────────────────

  it('并发 ensure 同一张图同一个池,只登记一次', async () => {
    const m = await import('../ensureAsset')

    const [a, b, c] = await Promise.all([
      m.ensureAsset({ url: URL_A }, POOL),
      m.ensureAsset({ url: URL_A }, POOL),
      m.ensureAsset({ url: URL_A }, POOL),
    ])

    expect([a, b, c]).toEqual(['asset-new', 'asset-new', 'asset-new'])
    expect(registerAsset).toHaveBeenCalledTimes(1)
  })

  it('并发 ensure 不同的池,各登记各的', async () => {
    const m = await import('../ensureAsset')

    await Promise.all([m.ensureAsset({ url: URL_A }, POOL), m.ensureAsset({ url: URL_A }, POOL_PP)])

    expect(registerAsset).toHaveBeenCalledTimes(2)
  })

  // ── 已被上游删掉的旧 id ──────────────────────────────────────────────────

  /**
   * 「彻底删除」是不可逆的,而它就在人像库 UI 上。删掉之后这条绑定指向一个不存在的
   * asset:不驱逐的话,这张图在这个池里**永远**用不了,而用户没有任何可操作的补救。
   * 驱逐后下一次调用会重新登记 —— 所以错误话术仍然是「稍等重试」,而重试这次真的有用。
   */
  it('复用的 id 在上游已不存在(404)时驱逐绑定并抛,下次重新登记', async () => {
    seed({ [URL_A]: [{ projectId: 42, assetId: 'asset-gone' }] })
    const m = await import('../ensureAsset')
    pollAsset.mockRejectedValueOnce(Object.assign(new Error('not found'), { status: 404 }))

    await expect(m.ensureAsset({ url: URL_A }, POOL)).rejects.toThrow()
    expect(storedFile().bindings[URL_A] ?? []).toHaveLength(0)

    pollAsset.mockResolvedValue(active('asset-new'))
    expect(await m.ensureAsset({ url: URL_A }, POOL)).toBe('asset-new')
    expect(registerAsset).toHaveBeenCalledTimes(1)
  })

  it('刚登记的 id 就 404 时不驱逐重登记(会无限造孤儿),直接抛', async () => {
    const m = await import('../ensureAsset')
    pollAsset.mockRejectedValue(Object.assign(new Error('not found'), { status: 404 }))

    await expect(m.ensureAsset({ url: URL_A }, POOL)).rejects.toThrow()
    expect(registerAsset).toHaveBeenCalledTimes(1)
  })

  // ── 持久化的边角 ─────────────────────────────────────────────────────────

  it('写盘失败只 warn,不抛,本次会话内仍然命中', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const m = await import('../ensureAsset')
    writeFailure.current = Object.assign(new Error('EACCES'), { code: 'EACCES' })

    const id = await m.ensureAsset({ url: URL_A }, POOL)
    expect(id).toBe('asset-new')
    expect(warn).toHaveBeenCalled()

    await m.ensureAsset({ url: URL_A }, POOL)
    expect(registerAsset).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })

  it('文件是坏 JSON 时当空状态起步,不崩', async () => {
    files.set(FILE, '{ not json')
    const m = await import('../ensureAsset')
    expect(await m.ensureAsset({ url: URL_A }, POOL)).toBe('asset-new')
  })

  /**
   * 整体丢弃的代价不是「少一条缓存」,而是**每一张图在每一个池里都重新登记一遍**,
   * 上游多出等量的副本、等量的配额占用。所以坏条目按条丢。
   */
  it('单条绑定畸形时只丢那一条,同文件里的好条目仍然命中', async () => {
    files.set(
      FILE,
      JSON.stringify({
        bindings: {
          [URL_A]: [{ projectId: 'forty-two', assetId: 'bad' }, 'not-an-object'],
          [URL_B]: [{ projectId: 42, assetId: 'good' }],
        },
      }),
    )
    const m = await import('../ensureAsset')
    pollAsset.mockResolvedValue(active('good'))

    expect(await m.ensureAsset({ url: URL_B }, POOL)).toBe('good')
    expect(registerAsset).not.toHaveBeenCalled()
  })

  it('lookupAssetBinding 是只读的,不发任何请求', async () => {
    seed({ [URL_A]: [{ projectId: 42, assetId: 'asset-stored' }] })
    const m = await import('../ensureAsset')

    expect(m.lookupAssetBinding(URL_A, POOL)).toBe('asset-stored')
    expect(m.lookupAssetBinding(URL_A, POOL_PP)).toBeNull()
    expect(m.lookupAssetBinding(URL_B, POOL)).toBeNull()
    expect(pollAsset).not.toHaveBeenCalled()
    expect(registerAsset).not.toHaveBeenCalled()
  })
})

// ── resolveAsset:从 Task 1 挪过来的两件缓存 ────────────────────────────────

describe('resolveAsset 缓存', () => {
  beforeEach(() => {
    vi.resetModules()
    files.clear()
    writeFailure.current = null
    registerAsset.mockReset()
    pollAsset.mockReset()
    getAsset.mockReset()
    vi.useRealTimers()
  })

  it('并发同一个 id 只打一次 getAsset', async () => {
    const m = await import('../ensureAsset')
    let release = (): void => {}
    getAsset.mockImplementation(
      () => new Promise((r) => (release = () => r({ Id: 'a1', Status: 'Active' }))),
    )

    const all = Promise.all([
      m.resolveAsset('a1', POOL),
      m.resolveAsset('a1', POOL),
      m.resolveAsset('a1', POOL),
    ])
    await Promise.resolve()
    release()

    expect(await all).toEqual([
      { Id: 'a1', Status: 'Active' },
      { Id: 'a1', Status: 'Active' },
      { Id: 'a1', Status: 'Active' },
    ])
    expect(getAsset).toHaveBeenCalledTimes(1)
  })

  it('in-flight 结束后不再挂着,后续查询会重新打', async () => {
    const m = await import('../ensureAsset')
    getAsset.mockResolvedValue({ Id: 'a1', Status: 'Active' })

    await m.resolveAsset('a1', POOL)
    await m.resolveAsset('a1', POOL)

    expect(getAsset).toHaveBeenCalledTimes(2)
  })

  it.each([404, 403])('%s 之后进负缓存,第二次不再打接口', async (status) => {
    const m = await import('../ensureAsset')
    getAsset.mockRejectedValue(Object.assign(new Error('nope'), { status }))

    expect(await m.resolveAsset('gone', POOL)).toBeNull()
    expect(await m.resolveAsset('gone', POOL)).toBeNull()
    expect(getAsset).toHaveBeenCalledTimes(1)
  })

  it('网络失败(无 status)也进负缓存', async () => {
    const m = await import('../ensureAsset')
    getAsset.mockRejectedValue(new Error('ECONNRESET'))

    expect(await m.resolveAsset('x', POOL)).toBeNull()
    expect(await m.resolveAsset('x', POOL)).toBeNull()
    expect(getAsset).toHaveBeenCalledTimes(1)
  })

  /**
   * 🚨 负缓存必须**按池分开**。同一个 id 在 A 池 404 完全不能推出它在 B 池也不存在
   * —— 恰恰相反,「不属于当前池」正是 404/403 最常见的成因。
   *
   * 网页版的 `missingIds` 是个裸 `Set<string>`,靠 store 在切项目时调
   * `clearAssetResolutionCache()` 兜住。主进程这一层是叶子:`scope` 每次调用现传,
   * 它**永远不会知道**池换了。所以不能照抄那个形状,只能把池编进键里。
   */
  it('负缓存按池隔离,A 池 404 不影响 B 池', async () => {
    const m = await import('../ensureAsset')
    getAsset.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }))

    expect(await m.resolveAsset('a1', POOL)).toBeNull()
    getAsset.mockResolvedValue({ Id: 'a1', Status: 'Active' })
    expect(await m.resolveAsset('a1', POOL_PP)).toEqual({ Id: 'a1', Status: 'Active' })
    expect(getAsset).toHaveBeenCalledTimes(2)
  })

  it('负缓存有 TTL,过期后自愈', async () => {
    vi.useFakeTimers()
    const m = await import('../ensureAsset')
    getAsset.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 403 }))

    expect(await m.resolveAsset('a1', POOL)).toBeNull()
    vi.advanceTimersByTime(m.MISSING_TTL_MS + 1)
    getAsset.mockResolvedValue({ Id: 'a1', Status: 'Active' })

    expect(await m.resolveAsset('a1', POOL)).toEqual({ Id: 'a1', Status: 'Active' })
    vi.useRealTimers()
  })

  it('clearAssetResolutionCache 之后立刻重查', async () => {
    const m = await import('../ensureAsset')
    getAsset.mockRejectedValueOnce(Object.assign(new Error('nope'), { status: 404 }))

    expect(await m.resolveAsset('a1', POOL)).toBeNull()
    m.clearAssetResolutionCache()
    getAsset.mockResolvedValue({ Id: 'a1', Status: 'Active' })

    expect(await m.resolveAsset('a1', POOL)).toEqual({ Id: 'a1', Status: 'Active' })
    expect(getAsset).toHaveBeenCalledTimes(2)
  })

  /**
   * 5xx / 超时是**上游此刻不舒服**,不是「这个 id 不存在」。负缓存它等于把一次
   * 抖动放大成 TTL 那么久的假性缺失 —— 而缺失在展示层就是一张裂图。
   */
  it('5xx 不进负缓存,下次仍然重试', async () => {
    const m = await import('../ensureAsset')
    getAsset.mockRejectedValueOnce(Object.assign(new Error('boom'), { status: 500 }))

    expect(await m.resolveAsset('a1', POOL)).toBeNull()
    getAsset.mockResolvedValue({ Id: 'a1', Status: 'Active' })
    expect(await m.resolveAsset('a1', POOL)).toEqual({ Id: 'a1', Status: 'Active' })
    expect(getAsset).toHaveBeenCalledTimes(2)
  })
})
