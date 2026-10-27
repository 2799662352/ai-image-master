// 人像库 IPC 编排层。这一层**只做编排与信封**,业务判断在 platformAssets / ensureAsset,
// 所以被测的不是「能不能列出素材」,而是四件只在边界上才暴露的事:
//
//   1. 通道注册/卸载**对称**(漏加卸载清单 → 热重载后 `ipcMain.handle` 抛 second handler)
//   2. 错误信封保住 code(裸抛经 IPC 会被包成 "Error invoking remote method",code 全丢,
//      而 UI 至少有四种动作不同的分支:NOT_READY 等一等 / FAILED 换一张 / 未登录 / 换组织)
//   3. scope 两半的窄化(错一半 = 素材登记进错的组,而跨池的 asset 读不出来)
//   4. 上传字节的形状(渲染层塞 `File` 过来会被序列化成 `{}` —— 0 字节静默上传)
//
// 这四条在真机上全都表现成「看着接好了、就是不对」,没有任何本地信号。

import { describe, expect, it, vi, beforeEach } from 'vitest'

// ── electron ────────────────────────────────────────────────────────────────
const handlers = new Map<string, (...a: unknown[]) => unknown>()
vi.mock('electron', () => ({
  ipcMain: {
    // 真 `ipcMain` 对同一通道二次 handle 会抛「Attempted to register a second handler」。
    // fake 里照抛 —— 用 Map 静默覆盖的话,「漏加卸载清单」这个真实症状在测试里根本看不见。
    handle: (ch: string, fn: (...a: unknown[]) => unknown) => {
      if (handlers.has(ch)) {
        throw new Error(`Attempted to register a second handler for '${ch}'`)
      }
      handlers.set(ch, fn)
    },
    removeHandler: (ch: string) => void handlers.delete(ch),
  },
}))

// ── AuthError:与 httpJson 的真类同形(code 在前、带 status) ────────────────
class AuthError extends Error {
  constructor(
    public code: string,
    public status: number,
    msg: string,
  ) {
    super(msg)
    this.name = 'AuthError'
  }
}

/**
 * 长得像真凭据的假 token。
 *
 * 形状必须能被下面那条安全正则逮住 —— 否则「没有任何通道会回传凭据」那条断言永远绿,
 * 连一个真把 token 塞进返回值的实现都杀不掉(同款教训见 `auth/__tests__/ipc.test.ts`)。
 */
const PLATFORM_TOKEN = 'sk-platform-test-Aa1Bb2Cc3Dd4'
const requireToken = vi.fn(() => PLATFORM_TOKEN)
vi.mock('../../auth/httpJson', () => ({ AuthError, requireToken }))

// ── 被编排的两层整层 mock ───────────────────────────────────────────────────
// 它们各自的契约(组头 / 大小写 / 截断 / 池键成对)已在 platformAssets.test.ts 与
// ensureAsset.test.ts 逐条钉过。这里只验「编排层有没有把参数原样递对、有没有包信封」。
const listAssets = vi.fn()
const pollAsset = vi.fn()
const registerAsset = vi.fn()
const uploadMedia = vi.fn()
const hideAsset = vi.fn()
const purgeAsset = vi.fn()
const patchAsset = vi.fn()
const getAsset = vi.fn()
vi.mock('../platformAssets', () => ({
  listAssets,
  pollAsset,
  registerAsset,
  uploadMedia,
  hideAsset,
  purgeAsset,
  patchAsset,
  getAsset,
}))

const ensureAsset = vi.fn()
const lookupAssetBinding = vi.fn()
const resolveAsset = vi.fn()
const clearAssetResolutionCache = vi.fn()
vi.mock('../ensureAsset', () => ({
  ensureAsset,
  lookupAssetBinding,
  resolveAsset,
  clearAssetResolutionCache,
}))

// ── 夹具 ────────────────────────────────────────────────────────────────────
const CHANNELS = [
  'portrait:list',
  'portrait:resolve',
  'portrait:poll',
  'portrait:register',
  'portrait:upload',
  'portrait:hide',
  'portrait:purge',
  'portrait:patch',
  'portrait:ensure',
  'portrait:lookup-binding',
  'portrait:clear-resolution-cache',
]

const SCOPE = { projectId: 42 }
const SCOPE_PP = { projectId: 42, producerProjectId: 7 }
const URL_A = 'https://cos.example.com/portraits/a.png'
const ASSET = { Id: 'asset-1', Status: 'Active', URL: URL_A }
const LIST = { Items: [ASSET], TotalCount: 1, HiddenCount: 0, Truncated: false }

async function register() {
  const m = await import('../ipc')
  return m.registerPortraitLibraryIpc()
}
const call = (ch: string, ...a: unknown[]) => handlers.get(ch)!({} as never, ...a)

type Envelope = { ok: boolean; data?: unknown; error?: { code: string; message: string } }

describe('人像库 IPC 编排', () => {
  beforeEach(() => {
    vi.resetModules()
    handlers.clear()
    for (const fn of [
      listAssets,
      pollAsset,
      registerAsset,
      uploadMedia,
      hideAsset,
      purgeAsset,
      patchAsset,
      getAsset,
      ensureAsset,
      lookupAssetBinding,
      resolveAsset,
      clearAssetResolutionCache,
      requireToken,
    ]) {
      fn.mockReset()
    }
    requireToken.mockReturnValue(PLATFORM_TOKEN)
    listAssets.mockResolvedValue(LIST)
    pollAsset.mockResolvedValue(ASSET)
    registerAsset.mockResolvedValue({
      Id: 'asset-1',
      URL: URL_A,
      PreviewUrl: URL_A,
      cosUrl: URL_A,
    })
    uploadMedia.mockResolvedValue({
      url: URL_A,
      cosKey: 'k/1',
      fileSize: 3,
      assetType: 'Image',
    })
    hideAsset.mockResolvedValue({ purged: false })
    purgeAsset.mockResolvedValue({ purged: true })
    patchAsset.mockResolvedValue({ Id: 'asset-1' })
    ensureAsset.mockResolvedValue('asset-1')
    lookupAssetBinding.mockReturnValue('asset-1')
    resolveAsset.mockResolvedValue(ASSET)
  })

  // ───────────────────────────────────────────────────────────────────────
  // 注册 / 卸载对称
  // ───────────────────────────────────────────────────────────────────────

  // 通道清单按字面锁住而不是只断言个数 —— 加通道时会在这里显式失败,提醒同时把它
  // 加进卸载清单(卸载依赖那个数组,漏加会让 handler 在热重载后泄漏)。
  it('注册全部十一个通道', async () => {
    await register()
    expect([...handlers.keys()].sort()).toEqual([...CHANNELS].sort())
  })

  // 漏加进卸载清单的症状不是「某个功能不工作」,而是 dispose 后 handler 还挂着,
  // 热重载再注册时 `ipcMain.handle` 对同一通道抛「second handler」—— 很难归因。
  it('dispose 后每一条 handler 都不在了', async () => {
    const dispose = await register()
    for (const ch of CHANNELS) expect(handlers.has(ch), `${ch} 未注册`).toBe(true)
    dispose()
    for (const ch of CHANNELS) expect(handlers.has(ch), `${ch} 卸载后仍挂着`).toBe(false)
    expect(handlers.size).toBe(0)
  })

  // 重复注册不该把同一通道挂两次 —— 真 `ipcMain` 会抛,而我们的 fake Map 会静默覆盖。
  // 所以盯的是「注册前先 removeHandler 了一遍」这个行为(与 auth/ipc.ts 同一做法)。
  it('重复注册不残留旧 handler', async () => {
    const disposeFirst = await register()
    const m = await import('../ipc')
    const disposeSecond = m.registerPortraitLibraryIpc()
    expect(handlers.size).toBe(CHANNELS.length)
    disposeSecond()
    expect(handlers.size).toBe(0)
    disposeFirst()
  })

  it('模块加载期不注册任何通道', async () => {
    await import('../ipc')
    expect(handlers.size).toBe(0)
  })

  // ───────────────────────────────────────────────────────────────────────
  // 错误信封
  // ───────────────────────────────────────────────────────────────────────

  // UI 至少有四种动作完全不同的分支,全靠这个 code 分流:
  //   ASSET_NOT_READY → 稍等几秒;ASSET_FAILED → 换一张(**不是**稍等);
  //   NOT_AUTHENTICATED → 引导登录;403 / 池不匹配 → 引导换组织。
  // 压成同一个 code 等于把信封退化回「出错了」—— 那正是不裸抛的全部理由。
  it('AuthError 的 code 与 message 被原样带出信封', async () => {
    const cases: Array<[string, number, string]> = [
      ['ASSET_NOT_READY', 409, '素材还在处理中,请稍等几秒后重试'],
      ['ASSET_FAILED', 409, '这张素材在上游处理失败了,请换一张或重新导入'],
      ['NOT_AUTHENTICATED', 401, '未登录'],
      ['HTTP_403', 403, '无权访问该项目'],
    ]
    await register()
    for (const [code, status, message] of cases) {
      ensureAsset.mockRejectedValue(new AuthError(code, status, message))
      const r = (await call('portrait:ensure', SCOPE, { url: URL_A })) as Envelope
      expect(r.ok, `${code} 没回信封`).toBe(false)
      expect(r.error?.code, `${code} 被压成了别的 code`).toBe(code)
      expect(r.error?.message).toBe(message)
    }
  })

  // 非 AuthError(断网、DNS 失败、超时)也要合成一个**非空**的 code,
  // 否则渲染层的 switch 落到 undefined 分支,表现成「什么提示都没有」。
  it('非 AuthError 也合成非空字符串 code', async () => {
    await register()
    for (const boom of [new Error('ECONNREFUSED'), 'plain string', null, undefined, 42]) {
      listAssets.mockRejectedValue(boom)
      const r = (await call('portrait:list', SCOPE)) as Envelope
      expect(r.ok, `${String(boom)} 被放行了`).toBe(false)
      expect(typeof r.error?.code).toBe('string')
      expect(r.error?.code).toBeTruthy()
      expect(r.error?.message).toBeTruthy()
    }
  })

  // 每一条通道都要包信封。少包一条,这里就在那一条上变红。
  it('十一条通道全部回信封而不是裸抛', async () => {
    const boom = new AuthError('NOT_AUTHENTICATED', 401, '未登录')
    for (const fn of [
      listAssets,
      pollAsset,
      registerAsset,
      uploadMedia,
      hideAsset,
      purgeAsset,
      patchAsset,
      ensureAsset,
      resolveAsset,
    ]) {
      fn.mockRejectedValue(boom)
    }
    lookupAssetBinding.mockImplementation(() => {
      throw boom
    })
    clearAssetResolutionCache.mockImplementation(() => {
      throw boom
    })
    await register()

    const invocations: Array<[string, unknown[]]> = [
      ['portrait:list', [SCOPE]],
      ['portrait:resolve', [SCOPE, 'asset-1']],
      ['portrait:poll', [SCOPE, 'asset-1']],
      ['portrait:register', [SCOPE, { url: URL_A, assetType: 'Image' }]],
      ['portrait:upload', [SCOPE, { data: new ArrayBuffer(3), filename: 'a.png', mimeType: 'image/png' }]],
      ['portrait:hide', [SCOPE, 'asset-1']],
      ['portrait:purge', [SCOPE, 'asset-1']],
      ['portrait:patch', [SCOPE, 'asset-1', { name: 'x' }]],
      ['portrait:ensure', [SCOPE, { url: URL_A }]],
      ['portrait:lookup-binding', [SCOPE, URL_A]],
      ['portrait:clear-resolution-cache', []],
    ]
    for (const [ch, args] of invocations) {
      const r = (await Promise.resolve(call(ch, ...args))) as Envelope
      expect(r?.ok, `${ch} 没回信封`).toBe(false)
      expect(r?.error?.code, `${ch} 丢了 code`).toBe('NOT_AUTHENTICATED')
    }
  })

  // 凭据只活在 platformAssets 那一层(它自己调 requireToken)。这一层碰都不该碰。
  //
  // `Promise.resolve()` 那层不是装饰:任何一条同步 handler 直接 `.catch` 都会抛
  // TypeError,那样这条断言连一个通道都验不到就死了,而失败信息看着像「实现有问题」。
  it('没有任何通道会把凭据回给渲染层,这一层也不取凭据', async () => {
    await register()
    for (const [ch, handler] of handlers) {
      const out = await Promise.resolve(
        handler({}, SCOPE, 'asset-1', { name: 'x' }),
      ).catch(() => null)
      expect(JSON.stringify(out ?? ''), `${ch} 回传了凭据`).not.toMatch(/sk-[A-Za-z0-9_-]{8,}/)
    }
    expect(requireToken).not.toHaveBeenCalled()
  })

  // ───────────────────────────────────────────────────────────────────────
  // scope 窄化 —— 这一层最贵的约束
  // ───────────────────────────────────────────────────────────────────────

  it('scope 两半都原样递给下游', async () => {
    await register()
    await call('portrait:list', SCOPE_PP)
    expect(listAssets).toHaveBeenCalledWith({ projectId: 42, producerProjectId: 7 }, {})
  })

  it('projectId 不合法时回 INVALID_POOL,一次下游都不打', async () => {
    await register()
    for (const bad of [undefined, null, 0, -1, 'abc', {}, Number.NaN]) {
      listAssets.mockClear()
      const r = (await call('portrait:list', { projectId: bad })) as Envelope
      expect(r.ok, `projectId=${JSON.stringify(bad)} 被放行了`).toBe(false)
      expect(r.error?.code).toBe('INVALID_POOL')
      expect(r.error?.message).toBeTruthy()
      expect(listAssets).not.toHaveBeenCalled()
    }
  })

  it('scope 不是对象时也回 INVALID_POOL 而不是 TypeError', async () => {
    await register()
    for (const bad of [null, undefined, 'x', 42, []]) {
      listAssets.mockClear()
      const r = (await call('portrait:list', bad)) as Envelope
      expect(r.ok, `scope=${JSON.stringify(bad)} 被放行了`).toBe(false)
      expect(r.error?.code).toBe('INVALID_POOL')
      expect(listAssets).not.toHaveBeenCalled()
    }
  })

  // 「没有 producer 池」有三种合法拼法:渲染层的 `BillingPoolRef` 用 `null`、
  // `PlatformAssetScope` 用缺省、而 `scopeHeaders`/`normalizePool` 都把 `0` 当没有。
  // 三者必须归一成**同一个** `undefined`:留着 `null` 会让盘上的绑定过不了
  // `ensureAsset.isBinding`,留着 `0` 会造出一个线上不存在的池键。
  it('producerProjectId 的三种「没有」都归一成缺省', async () => {
    await register()
    for (const absent of [undefined, null, 0]) {
      listAssets.mockClear()
      await call('portrait:list', { projectId: 42, producerProjectId: absent })
      const [scope] = listAssets.mock.calls[0] as [Record<string, unknown>]
      expect(scope, `producerProjectId=${JSON.stringify(absent)}`).toEqual({ projectId: 42 })
      expect('producerProjectId' in scope).toBe(false)
    }
  })

  // 刻意**不**照抄 `auth/ipc.ts:toBillingPool` 的「garbage 一律归一成 null」:
  // 那边算错了只是钱记到别的池,这边算错了是**素材登记进错的组**,而跨池的 asset
  // 根本读不出来(不是陈旧,是不存在)。把 `'7'` 静默变成「个人池」等于把一次渲染层
  // 的类型手滑变成一批查不出来的素材。
  it('producerProjectId 是无法归一的垃圾时拒绝,不静默降级成「没有」', async () => {
    await register()
    for (const bad of ['7', 'abc', {}, [], Number.NaN, -1, 1.5]) {
      listAssets.mockClear()
      const r = (await call('portrait:list', { projectId: 42, producerProjectId: bad })) as Envelope
      expect(r.ok, `producerProjectId=${JSON.stringify(bad)} 被放行了`).toBe(false)
      expect(r.error?.code).toBe('INVALID_POOL')
      expect(listAssets).not.toHaveBeenCalled()
    }
  })

  // 每条通道都要走同一个窄化,漏一条就是那条通道上的一个洞。
  it('每一条带 scope 的通道都做了窄化', async () => {
    await register()
    const withScope: Array<[string, unknown[]]> = [
      ['portrait:list', []],
      ['portrait:resolve', ['asset-1']],
      ['portrait:poll', ['asset-1']],
      ['portrait:register', [{ url: URL_A, assetType: 'Image' }]],
      ['portrait:upload', [{ data: new ArrayBuffer(3), filename: 'a.png', mimeType: 'image/png' }]],
      ['portrait:hide', ['asset-1']],
      ['portrait:purge', ['asset-1']],
      ['portrait:patch', ['asset-1', { name: 'x' }]],
      ['portrait:ensure', [{ url: URL_A }]],
      ['portrait:lookup-binding', [URL_A]],
    ]
    for (const [ch, rest] of withScope) {
      const r = (await Promise.resolve(call(ch, { projectId: 0 }, ...rest))) as Envelope
      expect(r?.ok, `${ch} 放行了 projectId=0`).toBe(false)
      expect(r?.error?.code, `${ch} 没走 scope 窄化`).toBe('INVALID_POOL')
    }
  })

  // ───────────────────────────────────────────────────────────────────────
  // 上传字节
  // ───────────────────────────────────────────────────────────────────────

  // `ArrayBuffer` 在结构化克隆里是一等公民,`File`/`Blob` 不是 —— 后者经 Electron IPC
  // 会变成 `{}`。所以字节由渲染层读、以 ArrayBuffer 递过来,主进程这边只做包装。
  it('ArrayBuffer 被包成 Uint8Array 且字节一致', async () => {
    await register()
    const bytes = Uint8Array.from([1, 2, 250, 0, 7])
    await call('portrait:upload', SCOPE, {
      data: bytes.buffer,
      filename: 'a.png',
      mimeType: 'image/png',
    })

    const [file] = uploadMedia.mock.calls[0] as [{ data: Uint8Array; filename: string; mimeType: string }]
    expect(file.data).toBeInstanceOf(Uint8Array)
    expect([...file.data]).toEqual([1, 2, 250, 0, 7])
    expect(file.filename).toBe('a.png')
    expect(file.mimeType).toBe('image/png')
  })

  // 渲染层也可能直接递一个 TypedArray(两者都过得了结构化克隆)。带 byteOffset 的
  // 视图必须只取视图那一段 —— 取整个 backing buffer 会把邻居的字节一起传上去。
  it('TypedArray 视图只取自己那一段', async () => {
    await register()
    const backing = Uint8Array.from([9, 9, 1, 2, 3, 9])
    await call('portrait:upload', SCOPE, {
      data: backing.subarray(2, 5),
      filename: 'a.png',
      mimeType: 'image/png',
    })

    const [file] = uploadMedia.mock.calls[0] as [{ data: Uint8Array }]
    expect([...file.data]).toEqual([1, 2, 3])
  })

  // 渲染层把 `File` 直接塞进 IPC 是**最容易犯**的那个错:它序列化成 `{}`,
  // 而 `new Uint8Array({})` 是 0 字节 —— 后端隔一整个网络往返回一句「未收到文件」400,
  // 报错点离病灶隔了 50MB 的上传。在这里就拒。
  it('data 不是字节时回 INVALID_UPLOAD,一次都不上传', async () => {
    await register()
    for (const bad of [{}, null, undefined, 'base64...', 42, []]) {
      uploadMedia.mockClear()
      const r = (await call('portrait:upload', SCOPE, {
        data: bad,
        filename: 'a.png',
        mimeType: 'image/png',
      })) as Envelope
      expect(r.ok, `data=${JSON.stringify(bad)} 被放行了`).toBe(false)
      expect(r.error?.code).toBe('INVALID_UPLOAD')
      expect(uploadMedia).not.toHaveBeenCalled()
    }
  })

  it('缺 filename 或 mimeType 时回 INVALID_UPLOAD', async () => {
    await register()
    const base = { data: new ArrayBuffer(3), filename: 'a.png', mimeType: 'image/png' }
    for (const patch of [{ filename: '' }, { filename: 42 }, { mimeType: '' }, { mimeType: null }]) {
      uploadMedia.mockClear()
      const r = (await call('portrait:upload', SCOPE, { ...base, ...patch })) as Envelope
      expect(r.ok, `${JSON.stringify(patch)} 被放行了`).toBe(false)
      expect(r.error?.code).toBe('INVALID_UPLOAD')
      expect(uploadMedia).not.toHaveBeenCalled()
    }
  })

  // 大小限制**只在 platformAssets 拦一道**,这一层不复制常量。理由:字节到这里时
  // IPC 那次拷贝已经发生了,再拦省不下任何东西;而两处各写一个 50MB 必然漂移。
  // 真正省事的那道闸在渲染层(Task 5),它要在 `arrayBuffer()` 之前拦。
  it('超限交给 platformAssets 判,这一层原样上报它的 code', async () => {
    uploadMedia.mockRejectedValue(new AuthError('FILE_TOO_LARGE', 400, 'Image 文件不能超过 50MB'))
    await register()

    const r = (await call('portrait:upload', SCOPE, {
      data: new ArrayBuffer(8),
      filename: 'a.png',
      mimeType: 'image/png',
    })) as Envelope
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('FILE_TOO_LARGE')
  })

  // ───────────────────────────────────────────────────────────────────────
  // 编排:参数原样递、结果原样回
  // ───────────────────────────────────────────────────────────────────────

  it('list 透传 hidden 选项', async () => {
    await register()
    const r = (await call('portrait:list', SCOPE, { hidden: true })) as Envelope
    expect(listAssets).toHaveBeenCalledWith({ projectId: 42 }, { hidden: true })
    expect(r).toEqual({ ok: true, data: LIST })
  })

  it('list 不给选项时不凭空造字段', async () => {
    await register()
    await call('portrait:list', SCOPE)
    expect(listAssets).toHaveBeenCalledWith({ projectId: 42 }, {})
  })

  // 渲染层拿到的是**带缓存的** resolveAsset,而不是裸 getAsset。
  //
  // 裸 getAsset 刻意不含缓存(Task 1 的决定),把它暴露给渲染层就是把
  // 「列表里没有的 id」交给一个会重渲染的循环去打 —— in-flight 去重与 404 负缓存
  // 正是为这条路存在的。所以没有 `portrait:get` 这条通道。
  it('resolve 走的是带缓存的 resolveAsset,不是裸 getAsset', async () => {
    await register()
    const r = (await call('portrait:resolve', SCOPE, 'asset-1')) as Envelope
    expect(resolveAsset).toHaveBeenCalledWith('asset-1', { projectId: 42 })
    expect(getAsset).not.toHaveBeenCalled()
    expect(r).toEqual({ ok: true, data: ASSET })
  })

  it('没有暴露裸 get 通道', async () => {
    await register()
    expect(handlers.has('portrait:get')).toBe(false)
  })

  // resolveAsset 取不到时回 `null` 而不是错 —— 那是它的契约(展示层拿不到就是占位图)。
  // 包成 `{ok:true,data:null}` 而不是 `{ok:false}`:后者会让 UI 弹一条错误提示。
  it('resolve 取不到时是 ok:true + null,不是错误信封', async () => {
    resolveAsset.mockResolvedValue(null)
    await register()
    expect(await call('portrait:resolve', SCOPE, 'asset-1')).toEqual({ ok: true, data: null })
  })

  it('poll 透传 assetId', async () => {
    await register()
    const r = (await call('portrait:poll', SCOPE, 'asset-1')) as Envelope
    expect(pollAsset).toHaveBeenCalledWith('asset-1', { projectId: 42 })
    expect(r).toEqual({ ok: true, data: ASSET })
  })

  it('assetId 为空或非字符串时回 INVALID_ASSET_ID,不打下游', async () => {
    await register()
    for (const ch of ['portrait:resolve', 'portrait:poll', 'portrait:hide', 'portrait:purge']) {
      for (const bad of ['', null, undefined, 42, {}]) {
        const r = (await call(ch, SCOPE, bad)) as Envelope
        expect(r.ok, `${ch} 放行了 assetId=${JSON.stringify(bad)}`).toBe(false)
        expect(r.error?.code).toBe('INVALID_ASSET_ID')
      }
    }
    expect(resolveAsset).not.toHaveBeenCalled()
    expect(pollAsset).not.toHaveBeenCalled()
    expect(hideAsset).not.toHaveBeenCalled()
    expect(purgeAsset).not.toHaveBeenCalled()
  })

  it('register 透传 url / assetType / name', async () => {
    await register()
    await call('portrait:register', SCOPE, { url: URL_A, assetType: 'Video', name: '主角' })
    expect(registerAsset).toHaveBeenCalledWith(
      { url: URL_A, assetType: 'Video', name: '主角' },
      { projectId: 42 },
    )
  })

  // 不给 name 时**不能**造一个 `name: undefined` 出来:platformAssets 判的是
  // `input.name === undefined`,造了也无害,但下面 patch 那条同款写法就有害了。
  // 两处保持同一个写法,免得只有一处对。
  it('register 不给 name 时不凭空造字段', async () => {
    await register()
    await call('portrait:register', SCOPE, { url: URL_A, assetType: 'Image' })
    const [input] = registerAsset.mock.calls[0] as [Record<string, unknown>]
    expect('name' in input).toBe(false)
  })

  // assetType 的白名单校验归 platformAssets(`INVALID_ASSET_TYPE`)—— 这一层不复制
  // 那张表,只保证它是个字符串递过去。两处各写一份白名单必然漂移。
  it('assetType 的白名单由 platformAssets 判,这一层原样上报它的 code', async () => {
    registerAsset.mockRejectedValue(new AuthError('INVALID_ASSET_TYPE', 400, '大小写敏感'))
    await register()
    const r = (await call('portrait:register', SCOPE, { url: URL_A, assetType: 'video' })) as Envelope
    expect(r.error?.code).toBe('INVALID_ASSET_TYPE')
  })

  it('register 缺 url 时回 INVALID_ASSET_URL,不打下游', async () => {
    await register()
    for (const bad of ['', null, undefined, 42]) {
      registerAsset.mockClear()
      const r = (await call('portrait:register', SCOPE, { url: bad, assetType: 'Image' })) as Envelope
      expect(r.ok, `url=${JSON.stringify(bad)} 被放行了`).toBe(false)
      expect(r.error?.code).toBe('INVALID_ASSET_URL')
      expect(registerAsset).not.toHaveBeenCalled()
    }
  })

  it('hide 与 purge 是两条不同的通道,各打各的下游', async () => {
    await register()
    await call('portrait:hide', SCOPE, 'asset-1')
    expect(hideAsset).toHaveBeenCalledWith('asset-1', { projectId: 42 })
    expect(purgeAsset).not.toHaveBeenCalled()

    await call('portrait:purge', SCOPE, 'asset-2')
    expect(purgeAsset).toHaveBeenCalledWith('asset-2', { projectId: 42 })
    expect(hideAsset).toHaveBeenCalledTimes(1)
  })

  // 「从回收站恢复」是 `hidden: false`。`false` 是最容易被 falsy 判断吞掉的那个值,
  // 吞掉之后 platformAssets 会因为「name 与 hidden 都没给」回 INVALID_PATCH ——
  // 而用户看到的是「恢复失败」,完全指不到这里。
  it('patch 的 hidden:false 不被吞掉', async () => {
    await register()
    await call('portrait:patch', SCOPE, 'asset-1', { hidden: false })
    expect(patchAsset).toHaveBeenCalledWith('asset-1', { hidden: false }, { projectId: 42 })
  })

  it('patch 透传 name,且不凭空造没给的字段', async () => {
    await register()
    await call('portrait:patch', SCOPE, 'asset-1', { name: '新名字' })
    const [, patch] = patchAsset.mock.calls[0] as [string, Record<string, unknown>]
    expect(patch).toEqual({ name: '新名字' })
    expect('hidden' in patch).toBe(false)
  })

  it('ensure 透传整份输入并回 assetId', async () => {
    await register()
    const r = (await call('portrait:ensure', SCOPE_PP, {
      url: URL_A,
      name: '主角',
      assetType: 'Image',
    })) as Envelope
    expect(ensureAsset).toHaveBeenCalledWith(
      { url: URL_A, name: '主角', assetType: 'Image' },
      { projectId: 42, producerProjectId: 7 },
    )
    expect(r).toEqual({ ok: true, data: 'asset-1' })
  })

  it('ensure 缺 url 时回 INVALID_ASSET_URL,不打下游', async () => {
    await register()
    const r = (await call('portrait:ensure', SCOPE, { name: '主角' })) as Envelope
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_ASSET_URL')
    expect(ensureAsset).not.toHaveBeenCalled()
  })

  // 同步的下游也要包成信封 —— 渲染层不该为了一条通道换一种返回形状。
  it('lookup-binding 回 assetId,同样是信封', async () => {
    await register()
    const r = (await Promise.resolve(call('portrait:lookup-binding', SCOPE, URL_A))) as Envelope
    expect(lookupAssetBinding).toHaveBeenCalledWith(URL_A, { projectId: 42 })
    expect(r).toEqual({ ok: true, data: 'asset-1' })
  })

  it('lookup-binding 没有绑定时是 ok:true + null', async () => {
    lookupAssetBinding.mockReturnValue(null)
    await register()
    expect(await Promise.resolve(call('portrait:lookup-binding', SCOPE, URL_A))).toEqual({
      ok: true,
      data: null,
    })
  })

  it('lookup-binding 的 url 为空时回 INVALID_ASSET_URL', async () => {
    await register()
    const r = (await Promise.resolve(call('portrait:lookup-binding', SCOPE, ''))) as Envelope
    expect(r.ok).toBe(false)
    expect(r.error?.code).toBe('INVALID_ASSET_URL')
    expect(lookupAssetBinding).not.toHaveBeenCalled()
  })

  // 清缓存是全局的(切池 / 登出 / 手动刷新),不带 scope —— 按池清反而会把
  // 「刚切走的那个池」的负缓存留下,而那恰恰是最该重查的那个。
  it('clear-resolution-cache 不要 scope,直接清空', async () => {
    await register()
    const r = (await Promise.resolve(call('portrait:clear-resolution-cache'))) as Envelope
    expect(clearAssetResolutionCache).toHaveBeenCalledTimes(1)
    expect(r).toEqual({ ok: true, data: null })
  })
})
