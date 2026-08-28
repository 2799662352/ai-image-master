// 平台人像库客户端(火山资产)。被测的是「契约对齐」而不是「代码跑通」——
// 这批端点的失败模式几乎全是**静默**的:排序丢了、视频当图片渲染、名字被截、
// 上传传完 50MB 才被拒。每一条都只在真机上、且往往只在用户那边才暴露。
//
// 契约来源:`sora-ui-backend/src/controllers/volcengineAssetController.ts` +
// `routes/volcengineAsset.ts` 逐条对过(前端 `api/volcengineAsset.ts` 的类型
// **与后端不符**,不作为依据)。

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

const fetchMock = vi.fn()
vi.mock('electron', () => ({ net: { fetch: (...a: unknown[]) => fetchMock(...a) } }))

const cred = { current: null as null | Record<string, unknown> }
vi.mock('../../auth/credentials', () => ({
  getCredential: () => cred.current,
}))

const BASE = 'https://13797248455.xyz'
const SCOPE = { projectId: 42 }
const SCOPE_PP = { projectId: 42, producerProjectId: 7 }

/** 后端成功信封:`{success:true,data}`。 */
const ok = (data: unknown, status = 200) =>
  ({ ok: status < 400, status, json: async () => ({ success: true, data }) }) as unknown as Response

/** 删除路由的成功信封 —— `purged` 在**顶层**,不在 `data` 下(controller:462)。 */
const okDelete = (purged: boolean) =>
  ({ ok: true, status: 200, json: async () => ({ success: true, purged }) }) as unknown as Response

/**
 * 🚨 volcengine-asset controller 的错误信封是**第三种**形状:`error` 是**字符串**,
 * 不是 `{code,message}` 对象(controller:24,163,201,…)。套 `session.ts` 的
 * `toAuthError` 会把它当成配对路由那套、去读 `error.code` 拿到 undefined。
 */
const errText = (status: number, text: string) =>
  ({ ok: false, status, json: async () => ({ success: false, error: text }) }) as unknown as Response

/** 上游 502:`error` 仍是字符串,但**另有**平级的 `code` / `requestId`(controller:69-74)。 */
const errUpstream = (code: string, requestId: string) =>
  ({
    ok: false,
    status: 502,
    json: async () => ({ success: false, error: '火山接口失败', code, requestId }),
  }) as unknown as Response

const lastCall = () => fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit]
const lastUrl = () => new URL(lastCall()[0])
const lastHeaders = () => lastCall()[1].headers as Record<string, string>
const lastBody = () => JSON.parse(lastCall()[1].body as string) as Record<string, unknown>

const bytes = (n: number): Uint8Array => new Uint8Array(n)

describe('platformAssets', () => {
  beforeEach(() => {
    vi.resetModules()
    fetchMock.mockReset()
    cred.current = { token: 'jwt.tok.en', userId: 'u1' }
    delete process.env.CATIMATION_AUTH_BASE_URL
    vi.useRealTimers()
  })
  afterEach(() => vi.useRealTimers())

  // ── 组头 ────────────────────────────────────────────────────────────────

  it('三个头每次都带,producerProjectId 有才带', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Items: [], TotalCount: 0 }))

    await m.listAssets(SCOPE)
    expect(lastHeaders().Authorization).toBe('Bearer jwt.tok.en')
    expect(lastHeaders()['X-Project-Id']).toBe('42')
    expect(lastHeaders()['X-Producer-Project-Id']).toBeUndefined()

    await m.listAssets(SCOPE_PP)
    expect(lastHeaders()['X-Producer-Project-Id']).toBe('7')
  })

  // `X-Project-Id` 缺失或 ≤0 时后端一律 400(controller:21-27)。本地就拒,省一个 RTT,
  // 而且错误话术比后端那句「缺少有效的 X-Project-Id」更能指向「没选计费池」。
  it('projectId 非正数在本地就拒,一个请求都不发', async () => {
    const m = await import('../platformAssets')
    await expect(m.listAssets({ projectId: 0 })).rejects.toThrow(/X-Project-Id|计费池/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('未登录时抛 NOT_AUTHENTICATED,一个请求都不发', async () => {
    cred.current = null
    const m = await import('../platformAssets')
    await expect(m.listAssets(SCOPE)).rejects.toMatchObject({ code: 'NOT_AUTHENTICATED' })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── registerAsset ───────────────────────────────────────────────────────

  it('registerAsset 打 POST /assets,取大写 Id', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(
      ok({ Id: 'asset-1', URL: 'https://cos/x.png', PreviewUrl: 'https://cos/x.png', cosUrl: 'https://cos/x.png' }),
    )

    const r = await m.registerAsset({ url: 'https://cos/x.png', assetType: 'Image', name: '主角' }, SCOPE)

    expect(lastUrl().pathname).toBe('/api/volcengine-asset/assets')
    expect(lastCall()[1].method).toBe('POST')
    expect(lastBody()).toEqual({ url: 'https://cos/x.png', assetType: 'Image', name: '主角' })
    expect(r.Id).toBe('asset-1')
  })

  /**
   * 🚨 `POST /assets` 的返回**只有** `{Id, URL, PreviewUrl, cosUrl}`(controller:189,
   * 而 `result` 的类型是 `{Id:string}`)。网页版的 `VolcAsset` 类型声明它返回 `Status`/
   * `Name`/`CreateTime`,那是**假的**。类型如实反映,免得下游拿着 `Status` 去分支。
   */
  it('registerAsset 的返回体不含 Status/Name/CreateTime,不臆造', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Id: 'a1', URL: 'u', PreviewUrl: 'p', cosUrl: 'c' }))
    const r = await m.registerAsset({ url: 'https://cos/x.png', assetType: 'Image' }, SCOPE)
    expect(r).toEqual({ Id: 'a1', URL: 'u', PreviewUrl: 'p', cosUrl: 'c' })
  })

  // 后端 `name.slice(0,64)`(controller:177)是**静默**的:用户看到的名字被砍了一截,
  // 没有任何报错。客户端自己先截,好让 UI 能在输入时就显示真实长度。
  it('registerAsset 客户端自己把 name 截到 64', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Id: 'a1', URL: 'u', PreviewUrl: 'p', cosUrl: 'c' }))
    await m.registerAsset({ url: 'https://cos/x.png', assetType: 'Image', name: '字'.repeat(100) }, SCOPE)
    expect(lastBody().name).toBe('字'.repeat(64))
  })

  /**
   * 🚨 `assetType` 大小写敏感:`ALLOWED_ASSET_TYPES.has(assetType) ? assetType : 'Image'`
   * (controller:171)。传 `'video'` 不会报错 —— 它被**静默降级成 `Image`**,于是一段
   * 视频素材在库里、在画布上、在提交时全被当成图片。必须在客户端拒掉。
   */
  it.each(['image', 'video', 'VIDEO', 'Movie'])('registerAsset 拒绝大小写不对的 assetType %s', async (bad) => {
    const m = await import('../platformAssets')
    await expect(
      m.registerAsset({ url: 'https://cos/x.png', assetType: bad as 'Image' }, SCOPE),
    ).rejects.toThrow(/assetType/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── listAssets ──────────────────────────────────────────────────────────

  /**
   * 🚨 `sortOrder` 必须是大写 `Desc`:`ALLOWED_SORT_ORDER = new Set(['Asc','Desc'])`
   * (controller:47),不在白名单的值被换成 `undefined`(controller:284)—— 排序**静默丢失**,
   * 列表变成上游的天然顺序,而用户以为看到的是最新的在最前。
   */
  it('listAssets 固定 pageSize=2000 / sortBy=CreateTime / sortOrder=Desc(大写)', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Items: [], TotalCount: 0 }))
    await m.listAssets(SCOPE)

    const q = lastUrl().searchParams
    expect(lastUrl().pathname).toBe('/api/volcengine-asset/assets')
    expect(q.get('pageSize')).toBe('2000')
    expect(q.get('sortBy')).toBe('CreateTime')
    expect(q.get('sortOrder')).toBe('Desc')
    expect(q.get('hidden')).toBeNull()
  })

  it('listAssets 透出 Items / TotalCount / HiddenCount / Truncated', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(
      ok({ Items: [{ Id: 'a1', Status: 'Active' }], TotalCount: 1, HiddenCount: 3, Truncated: true }),
    )
    const r = await m.listAssets(SCOPE)
    expect(r).toEqual({
      Items: [{ Id: 'a1', Status: 'Active' }],
      TotalCount: 1,
      HiddenCount: 3,
      Truncated: true,
    })
  })

  // 后端缺省不回 HiddenCount/Truncated 时要有确定的回落值,否则 UI 的「回收站 (N)」
  // 会渲染成 "回收站 (undefined)"。
  it('listAssets 缺省字段回落成 0 / false', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Items: [], TotalCount: 0 }))
    const r = await m.listAssets(SCOPE)
    expect(r.HiddenCount).toBe(0)
    expect(r.Truncated).toBe(false)
  })

  it('listAssets 回收站视图带 hidden=1', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Items: [], TotalCount: 0 }))
    await m.listAssets(SCOPE, { hidden: true })
    expect(lastUrl().searchParams.get('hidden')).toBe('1')
  })

  // ── getAsset ────────────────────────────────────────────────────────────

  it('getAsset 打 GET /assets/:id,id 经过 URL 编码', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Id: 'a/1', Status: 'Active' }))
    const r = await m.getAsset('a/1', SCOPE)
    expect(lastUrl().pathname).toBe('/api/volcengine-asset/assets/a%2F1')
    expect(lastCall()[1].method).toBe('GET')
    expect(r.Id).toBe('a/1')
  })

  // ── pollAsset ───────────────────────────────────────────────────────────

  it('pollAsset 打 /assets/:id/poll,带 interval=3000 与 timeout=90000', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Id: 'a1', Status: 'Active' }))
    await m.pollAsset('a1', SCOPE)

    expect(lastUrl().pathname).toBe('/api/volcengine-asset/assets/a1/poll')
    expect(lastUrl().searchParams.get('interval')).toBe('3000')
    expect(lastUrl().searchParams.get('timeout')).toBe('90000')
  })

  /**
   * 🚨 poll 是**服务端长轮询**:一次 HTTP 请求,后端内部循环最长 90 秒
   * (`POLL_TIMEOUT_MAX = 90_000`,volcengineAssetService.ts:11)。HTTP 层超时若不
   * 大于它,客户端会在服务端还没答完时自己 abort —— 表现成「等就绪永远失败」,
   * 而服务端日志里一切正常。`sendJson` 的默认 15s 远远不够。
   */
  it('pollAsset 的 HTTP 超时必须大于服务端 90s 上限', async () => {
    const m = await import('../platformAssets')
    vi.useFakeTimers()
    let init: RequestInit | undefined
    fetchMock.mockImplementation((_u: string, i: RequestInit) => {
      init = i
      return new Promise(() => {})
    })

    const pending = m.pollAsset('a1', SCOPE)
    pending.catch(() => {}) // 这条请求刻意永不 settle,挂个 catch 免得污染整轮
    await Promise.resolve()

    vi.advanceTimersByTime(90_000)
    expect(init?.signal?.aborted).toBe(false)
    vi.advanceTimersByTime(5_000)
    expect(init?.signal?.aborted).toBe(true)
  })

  // ── hide / purge ────────────────────────────────────────────────────────

  // 「移出素材库」= 软删,只在后端隐藏表打标(controller:450-459)。**不动火山、
  // 不释放配额**,画布上已引用它的 asset:// 继续解析得到。
  it('hideAsset 打 DELETE /assets/:id 且不带 purge', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(okDelete(false))
    const r = await m.hideAsset('a1', SCOPE)

    expect(lastCall()[1].method).toBe('DELETE')
    expect(lastUrl().pathname).toBe('/api/volcengine-asset/assets/a1')
    expect(lastUrl().searchParams.get('purge')).toBeNull()
    expect(r).toEqual({ purged: false })
  })

  // 真删上游,不可逆 —— 唯一能回收火山配额与列表分页预算的操作。
  it('purgeAsset 打 DELETE /assets/:id?purge=1', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(okDelete(true))
    const r = await m.purgeAsset('a1', SCOPE)

    expect(lastCall()[1].method).toBe('DELETE')
    expect(lastUrl().searchParams.get('purge')).toBe('1')
    expect(r).toEqual({ purged: true })
  })

  // ── patchAsset ──────────────────────────────────────────────────────────

  it('patchAsset 重命名走 PATCH {name},并同样截到 64', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Id: 'a1' }))
    const r = await m.patchAsset('a1', { name: '字'.repeat(100) }, SCOPE)

    expect(lastCall()[1].method).toBe('PATCH')
    expect(lastUrl().pathname).toBe('/api/volcengine-asset/assets/a1')
    expect(lastBody()).toEqual({ name: '字'.repeat(64) })
    expect(r).toEqual({ Id: 'a1' })
  })

  it('patchAsset 从回收站恢复走 PATCH {hidden:false}', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Id: 'a1' }))
    await m.patchAsset('a1', { hidden: false }, SCOPE)
    expect(lastBody()).toEqual({ hidden: false })
  })

  // 后端对「name 与 hidden 都没给」回 400(controller:486-489)。本地就拒。
  it('patchAsset 两个字段都没给时本地就拒', async () => {
    const m = await import('../platformAssets')
    await expect(m.patchAsset('a1', {}, SCOPE)).rejects.toThrow(/name|hidden/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  // ── uploadMedia ─────────────────────────────────────────────────────────

  it('uploadMedia 打 POST /upload-media,字段名 file,返回 url/cosKey/fileSize/assetType', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(
      ok({ url: 'https://cos/a.mp4', cosKey: 'k/a.mp4', fileSize: 1234, assetType: 'Video' }),
    )
    const r = await m.uploadMedia({ data: bytes(1234), filename: 'a.mp4', mimeType: 'video/mp4' }, SCOPE)

    expect(lastUrl().pathname).toBe('/api/volcengine-asset/upload-media')
    expect(lastCall()[1].method).toBe('POST')
    const form = lastCall()[1].body as FormData
    expect(form).toBeInstanceOf(FormData)
    expect((form.get('file') as File).name).toBe('a.mp4')
    expect(r).toEqual({ url: 'https://cos/a.mp4', cosKey: 'k/a.mp4', fileSize: 1234, assetType: 'Video' })
  })

  /**
   * 🚨 multipart 的 `Content-Type` 必须交给 fetch 自己生成 —— 手写一个就丢了 boundary,
   * 后端 multer 解不出 `file` 字段,回「未收到文件」400。
   * (同一个坑的实证:CherryHQ/cherry-studio#18021 —— 给 `net.fetch` 传 npm `form-data`
   * 并手设 boundary,Electron 把它序列化成字符串 `[object FormData]`,上游 400。)
   */
  it('uploadMedia 绝不手动设 Content-Type(会丢 boundary)', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ url: 'u', cosKey: 'k', fileSize: 1, assetType: 'Image' }))
    await m.uploadMedia({ data: bytes(1), filename: 'a.png', mimeType: 'image/png' }, SCOPE)

    const headerNames = Object.keys(lastHeaders()).map((h) => h.toLowerCase())
    expect(headerNames).not.toContain('content-type')
    // 鉴权头仍然要在
    expect(lastHeaders().Authorization).toBe('Bearer jwt.tok.en')
    expect(lastHeaders()['X-Project-Id']).toBe('42')
  })

  /**
   * 🚨 大小限制以**后端**为准:图片 50MB / 视频 50MB / 音频 15MB
   * (`MEDIA_SIZE_LIMITS`,controller:610-615;multer 另有 50MB 硬闸,routes:36-40)。
   * 网页版前端 `mediaLimits.ts` 写的 200MB 视频是错的 —— 用户传完 50~200MB 才拿到 400。
   */
  const MB = 1024 * 1024
  it.each([
    ['image/png', 'a.png', 50 * MB],
    ['video/mp4', 'a.mp4', 50 * MB],
    ['audio/mpeg', 'a.mp3', 15 * MB],
  ])('uploadMedia 在 %s 超过后端限额时本地就拒,不白传一遍', async (mime, name, limit) => {
    const m = await import('../platformAssets')
    await expect(
      m.uploadMedia({ data: bytes(limit + 1), filename: name, mimeType: mime }, SCOPE),
    ).rejects.toThrow(/MB/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uploadMedia 恰好等于限额时放行', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ url: 'u', cosKey: 'k', fileSize: 15 * MB, assetType: 'Audio' }))
    await m.uploadMedia({ data: bytes(15 * MB), filename: 'a.mp3', mimeType: 'audio/mpeg' }, SCOPE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  /**
   * 🚨 MIME 白名单只有 13 种(controller:592-596)。网页版的后缀正则却放行
   * `video/webm` / `audio/ogg` / `audio/aac` —— 用户选完文件、传完字节,才在服务端
   * 被 multer 的 fileFilter 拒掉。客户端就该拒。
   */
  it.each(['video/webm', 'audio/ogg', 'audio/aac', 'image/svg+xml', 'application/pdf'])(
    'uploadMedia 拒绝白名单外的 %s',
    async (mime) => {
      const m = await import('../platformAssets')
      await expect(
        m.uploadMedia({ data: bytes(10), filename: 'x', mimeType: mime }, SCOPE),
      ).rejects.toThrow(/不支持|类型/)
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it.each([
    'image/jpeg',
    'image/png',
    'image/webp',
    'image/bmp',
    'image/tiff',
    'image/gif',
    'image/heic',
    'image/heif',
    'video/mp4',
    'video/quicktime',
    'audio/mpeg',
    'audio/wav',
    'audio/mp3',
  ])('uploadMedia 放行白名单内的 %s', async (mime) => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ url: 'u', cosKey: 'k', fileSize: 10, assetType: 'Image' }))
    await m.uploadMedia({ data: bytes(10), filename: 'x', mimeType: mime }, SCOPE)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  // ── 错误映射(第三种信封) ──────────────────────────────────────────────

  /**
   * 🚨 这是本文件最重要的一条。volcengine-asset controller 的错误信封里 `error` 是
   * **字符串**,而 `session.ts` 的 `toAuthError` 认的是 `{error:{code,message}}`。
   * 直接复用它:`error.code` → undefined,`error.message` → undefined,于是错误码
   * 落到 `HTTP_400` 还算走运,**错误正文整条丢失** —— 用户看到「请求失败(HTTP 400)」,
   * 而后端明明说了「缺少 url 参数」。
   */
  it('把 error 是字符串的信封映射成带正文的错误', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(errText(400, '缺少 url 参数'))
    await expect(m.getAsset('a1', SCOPE)).rejects.toMatchObject({
      code: 'HTTP_400',
      status: 400,
      message: '缺少 url 参数',
    })
  })

  // 502 时 `code` 是上游火山的错误码,它比合成的 `HTTP_502` 有信息量得多。
  it('上游 502 用后端平级的 code 而不是合成码', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(errUpstream('AssetNotFound', 'req-9'))
    await expect(m.getAsset('a1', SCOPE)).rejects.toMatchObject({
      code: 'AssetNotFound',
      status: 502,
      message: expect.stringContaining('火山接口失败'),
    })
  })

  // code 永远是非空字符串 —— IPC 层的 switch 落到 undefined 分支就成了「未知错误」。
  it('后端一个可用字段都没给时,code 仍按状态码合成', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as unknown as Response)
    const err = await m.getAsset('a1', SCOPE).catch((e: unknown) => e)
    expect((err as { code: string }).code).toBe('HTTP_503')
    expect((err as { message: string }).message).toBeTruthy()
  })

  // nginx 502 页 / 网关超时页都不是 JSON。解析失败不能把状态码也一起吞掉。
  it('响应不是 JSON 时仍抛出带状态码的错误', async () => {
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue({
      ok: false,
      status: 504,
      json: async () => {
        throw new Error('Unexpected token <')
      },
    } as unknown as Response)
    await expect(m.getAsset('a1', SCOPE)).rejects.toMatchObject({ code: 'HTTP_504', status: 504 })
  })

  it('基址跟随 CATIMATION_AUTH_BASE_URL', async () => {
    process.env.CATIMATION_AUTH_BASE_URL = 'https://staging.example.com/'
    const m = await import('../platformAssets')
    fetchMock.mockResolvedValue(ok({ Items: [], TotalCount: 0 }))
    await m.listAssets(SCOPE)
    expect(lastCall()[0].startsWith('https://staging.example.com/api/volcengine-asset/assets')).toBe(true)
    expect(lastUrl().origin).not.toBe(BASE)
  })
})
