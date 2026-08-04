// 本地参考图「拖入即传」—— 把上传从「点了生成之后」挪到「用户还在写提示词」那段时间。
//
// 与隔壁 storeMaterialTransfer 的区别要说清楚,两者很容易混:
// - 转存(transfer)针对**第三方外链**,目的是别依赖对方的服务器,做法是**换掉 src**;
// - 预传(preupload)针对**本地路径**,目的是省掉提交时的等待,做法是**另挂 uploadedUrl**,
//   src 原样留着当兜底 —— 预传没跑完、跑挂了、或重启后缓存没了,提交照旧走主进程那条路。
//
// 模块加载顺序沿用转存那份的写法:先装桥再动态 import store,否则 store 导入时拿不到 API。

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'

const LOCAL_A = 'D:\\pics\\a.png'
const LOCAL_B = 'D:\\pics\\b.png'
const COS_A = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a.png'
const COS_A2 = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a2.png'
const COS_B = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/b.png'
const COS_VIDEO = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a.mp4'
const COS_AUDIO = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a.mp3'

type RefResult = { ok: true; url: string } | { ok: false; reason: string }

let resolveRefMedia: ReturnType<typeof vi.fn>
/** 每次调用挂起的 resolver,测试自己决定谁先回来。 */
let deferred: Array<(r: RefResult) => void>

function installBridge(): void {
  deferred = []
  resolveRefMedia = vi.fn(
    (_p: string) => new Promise<RefResult>((resolve) => { deferred.push(resolve) }),
  )
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: { resolveRefMedia },
    // 转存那条路要用的桥,装上免得本地路径测试受它干扰。
    cos: {
      enqueueUploadFromUrl: vi.fn(async () => ({ queued: true as const })),
      onUploadResult: () => () => {},
    },
  }
}

async function loadStore() {
  const store = await import('../store')
  const db = await import('../WorkbenchDb')
  store.resetWorkbenchStoreForTest()
  db.resetWorkbenchDbForTest()
  return store
}

beforeEach(() => {
  vi.resetModules()
  installBridge()
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('本地参考图拖入即传', () => {
  it('拖入本地图 → 发起预传;回来后挂上 uploadedUrl,src 原样不动', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    const imagesOf = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages

    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledWith(LOCAL_A))
    // 预传在途中素材照旧可用,不是先清空再等
    expect(imagesOf()[0].src).toBe(LOCAL_A)
    expect(imagesOf()[0].uploadedUrl).toBeUndefined()

    deferred[0]({ ok: true, url: COS_A })

    await vi.waitFor(() => expect(imagesOf()[0].uploadedUrl).toBe(COS_A))
    expect(imagesOf()[0].src).toBe(LOCAL_A)
    expect(imagesOf()[0].name).toBe('a')
  })

  it('提交时优先用预传好的 URL', async () => {
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    deferred[0]({ ok: true, url: COS_A })

    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      expect(buildModeMedia(card).referenceImages).toEqual([COS_A])
    })
  })

  it('预传失败 → 不挂 uploadedUrl,提交回落本地路径(即今天的行为)', async () => {
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    deferred[0]({ ok: false, reason: 'COS down' })

    await new Promise((r) => setTimeout(r, 10))
    const card = useStore.getState().cards.find((c) => c.id === cardId)!
    expect(card.referenceImages[0].uploadedUrl).toBeUndefined()
    expect(buildModeMedia(card).referenceImages).toEqual([LOCAL_A])
  })

  it('同一张图拖两次 → 两次独立上传、两个不同 URL,编号不塌', async () => {
    // 上游按下标解析 @参考N(Seedance OpenAPI §2.3)。复用同一个 URL 会让两个下标
    // 指向同一个地址,上游可能据此折叠成一个参考 —— 后面的编号全体前移,而且不报错。
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [
      { name: 'a', src: LOCAL_A },
      { name: 'a 又一次', src: LOCAL_A },
    ])

    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledTimes(2))
    deferred[0]({ ok: true, url: COS_A })
    deferred[1]({ ok: true, url: COS_A2 })

    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      expect(buildModeMedia(card).referenceImages).toEqual([COS_A, COS_A2])
    })
  })

  it('两张图乱序返回时各归各位,不按完成顺序错配', async () => {
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [
      { name: 'a', src: LOCAL_A },
      { name: 'b', src: LOCAL_B },
    ])

    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledTimes(2))
    // 第二张(b)先传完
    deferred[1]({ ok: true, url: COS_B })
    deferred[0]({ ok: true, url: COS_A })

    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      expect(buildModeMedia(card).referenceImages).toEqual([COS_A, COS_B])
    })
  })

  it('agent 经 MCP 加卡也预传 —— 素材随卡一起来,不走 addMaterials', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    useStore.getState().addCards([{ prompt: 'x', referenceImages: [LOCAL_A, LOCAL_B] }])

    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledTimes(2))
    expect(resolveRefMedia.mock.calls.map((c) => c[0])).toEqual([LOCAL_A, LOCAL_B])
  })

  it('agent 换素材(updateCard)预传;只改提示词不预传 —— 那是逐字符调的', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])

    // 逐字符改提示词:一次都不能发
    for (const prompt of ['a', 'ab', 'abc']) {
      useStore.getState().updateCard(cardId, { prompt })
    }
    await new Promise((r) => setTimeout(r, 10))
    expect(resolveRefMedia).not.toHaveBeenCalled()

    // 换素材:该发
    useStore.getState().updateCard(cardId, { referenceImages: [LOCAL_A] })
    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledTimes(1))
    expect(resolveRefMedia).toHaveBeenCalledWith(LOCAL_A)
  })

  it('视频 / 音频素材同样预传,提交时也用预传好的 URL', async () => {
    // 视频是三类里体积最大的,省下的等待也最多。
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'multimodal_ref' }])
    useStore.getState().addMaterials(cardId, 'referenceVideos', [{ name: 'v', src: 'D:\\v\\a.mp4' }])
    useStore.getState().addMaterials(cardId, 'referenceAudios', [{ name: 'a', src: 'D:\\v\\a.mp3' }])

    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledTimes(2))
    expect(resolveRefMedia.mock.calls.map((c) => c[0])).toEqual(['D:\\v\\a.mp4', 'D:\\v\\a.mp3'])
    deferred[0]({ ok: true, url: COS_VIDEO })
    deferred[1]({ ok: true, url: COS_AUDIO })

    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      const media = buildModeMedia(card)
      expect(media.referenceVideos).toEqual([COS_VIDEO])
      expect(media.referenceAudios).toEqual([COS_AUDIO])
    })
  })

  // uploadState 只为界面存在:光看 uploadedUrl 有没有,「在传」「传失败」
  // 「根本不用传」是同一个样子,照那个画转圈会永远转下去。
  it('发起时就落 uploading,成功后转 uploaded —— 界面才画得出转圈到打勾', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    const matOf = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages[0]

    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    await vi.waitFor(() => expect(matOf().uploadState).toBe('uploading'))
    expect(matOf().uploadedUrl).toBeUndefined()

    deferred[0]({ ok: true, url: COS_A })
    await vi.waitFor(() => expect(matOf().uploadState).toBe('uploaded'))
    expect(matOf().uploadedUrl).toBe(COS_A)
  })

  it('传失败落 failed 而不是停在 uploading —— 否则转圈永远不停', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    const matOf = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages[0]

    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    await vi.waitFor(() => expect(matOf().uploadState).toBe('uploading'))

    deferred[0]({ ok: false, reason: 'COS down' })
    await vi.waitFor(() => expect(matOf().uploadState).toBe('failed'))
    expect(matOf().uploadedUrl).toBeUndefined()
  })

  it('不用传的源(https/data/asset)压根不落 uploadState —— 别给它们画角标', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [
      { name: 'u', src: 'https://example.com/x.png' },
      { name: 'd', src: 'data:image/png;base64,AAA' },
      { name: 'a', src: 'asset://abc123' },
    ])

    await new Promise((r) => setTimeout(r, 10))
    const imgs = useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages
    expect(imgs.map((m) => m.uploadState)).toEqual([undefined, undefined, undefined])
  })

  it('同一张图拖两次:两条各自走完 uploading → uploaded,不会把结论都堆在第一条', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [
      { name: 'a', src: LOCAL_A },
      { name: 'a 又一次', src: LOCAL_A },
    ])
    const imgs = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages

    await vi.waitFor(() => expect(imgs().map((m) => m.uploadState)).toEqual(['uploading', 'uploading']))
    deferred[0]({ ok: true, url: COS_A })
    deferred[1]({ ok: true, url: COS_A2 })

    await vi.waitFor(() => expect(imgs().map((m) => m.uploadedUrl)).toEqual([COS_A, COS_A2]))
    expect(imgs().map((m) => m.uploadState)).toEqual(['uploaded', 'uploaded'])
  })

  it('主进程降级成 data URL 时当作没传成 —— 不把 base64 塞进卡片状态', async () => {
    // COS 不可达时 resolveMediaUrl 会对小文件内联(relayOrInline)。那对生图那条路
    // 是有用的兜底,对预传是净亏:什么都没上传,却往每次都要浅拷贝的卡片对象里塞
    // 了一坨 base64。
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    deferred[0]({ ok: true, url: 'data:image/png;base64,AAAA' })

    await new Promise((r) => setTimeout(r, 10))
    const card = useStore.getState().cards.find((c) => c.id === cardId)!
    expect(card.referenceImages[0].uploadedUrl).toBeUndefined()
    expect(buildModeMedia(card).referenceImages).toEqual([LOCAL_A])
  })

  it('applyIR 只为新建的卡预传 —— 挪一张卡不该把整板重传一遍', async () => {
    // write.persist.cards 里含「仅位置变了」的卡(merge 模式下每张因下标偏移的都在),
    // 整份扫一遍就是挪一次卡重传整板,而它们的字节一个都没变。
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    useStore.getState().addCards([{ prompt: 'A', referenceImages: [LOCAL_A] }])
    await vi.waitFor(() => expect(resolveRefMedia).toHaveBeenCalledTimes(1))
    resolveRefMedia.mockClear()
    deferred.length = 0

    const ir = useStore.getState().exportIR()
    // 在既有卡前面插一张新卡 → 新卡是 created,既有卡只是下标后移
    const applied = await useStore.getState().applyIR({
      ...ir,
      boards: [{
        ...ir.boards[0],
        cards: [
          { prompt: '新镜', referenceImages: [{ name: 'b', src: LOCAL_B }] },
          ...ir.boards[0].cards,
        ],
      }],
    })

    expect(applied.ok).toBe(true)
    expect(applied.cards.created).toHaveLength(1)
    await new Promise((r) => setTimeout(r, 10))
    expect(resolveRefMedia).toHaveBeenCalledTimes(1)
    expect(resolveRefMedia).toHaveBeenCalledWith(LOCAL_B)
  })

  it('https / data: / asset:// 都不触发预传', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    for (const src of ['https://example.com/x.png', 'data:image/png;base64,AAA', 'asset://abc123']) {
      const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
      useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'm', src }])
    }

    await new Promise((r) => setTimeout(r, 10))
    expect(resolveRefMedia).not.toHaveBeenCalled()
  })

  it('结果迟到时按原路径匹配 —— 期间用户又加了图也不错位', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    const imagesOf = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    // 预传还在路上时,用户往同一张卡又加了一张
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'b', src: LOCAL_B }])

    deferred[0]({ ok: true, url: COS_A })

    await vi.waitFor(() => expect(imagesOf()[0].uploadedUrl).toBe(COS_A))
    expect(imagesOf()[1].src).toBe(LOCAL_B)
    expect(imagesOf()[1].uploadedUrl).toBeUndefined()
  })

  it('素材在预传返回前被删掉 → 静默丢弃,不报错也不误改别的卡', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    useStore.getState().removeMaterial(cardId, 'referenceImages', 0)
    deferred[0]({ ok: true, url: COS_A })

    await new Promise((r) => setTimeout(r, 10))
    expect(useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages).toHaveLength(0)
  })

  it('回填不 bump rev —— 它是缓存不是规格改动,不该让 agent 的整板回写撞冲突', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    const revBefore = useStore.getState().cards.find((c) => c.id === cardId)!.rev

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    deferred[0]({ ok: true, url: COS_A })

    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      expect(card.referenceImages[0].uploadedUrl).toBe(COS_A)
    })
    expect(useStore.getState().cards.find((c) => c.id === cardId)!.rev).toBe(revBefore)
  })

  it('地址和时间戳落库,uploadState 不落 —— 转圈是会话内的,重启后没有上传在飞', async () => {
    const { useVideoWorkbenchStore: useStore } = await loadStore()
    const db = await import('../WorkbenchDb')
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])

    await vi.waitFor(() => expect(deferred.length).toBe(1))
    deferred[0]({ ok: true, url: COS_A })
    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      expect(card.referenceImages[0].uploadedUrl).toBe(COS_A)
    })

    const card = useStore.getState().cards.find((c) => c.id === cardId)!
    const store = db.getWorkbenchDb()
    await store.put(card)
    const persisted = (await store.list()).find((c) => c.id === cardId)!
    // src 永远留着:地址是加速,本地路径才是真源。
    expect(persisted.referenceImages[0].src).toBe(LOCAL_A)
    expect(persisted.referenceImages[0].uploadedUrl).toBe(COS_A)
    expect(persisted.referenceImages[0].uploadedAt).toBeGreaterThan(0)
    // uploadState 是会话内的:存下来重启会显示一个没有上传在跑的转圈。
    expect(persisted.referenceImages[0].uploadState).toBeUndefined()
  })
})

// 重启后复用预传地址,是这条链路省下的那次上传的全部意义 —— 否则每天开一次应用
// 就要把整板素材重传一遍。
//
// 敢存的依据:COS **公读**对象地址本身不带有效期(只有预签名 URL 才有 Expires),
// 自动删除要靠显式配的桶生命周期规则(没配就是 NoSuchLifecycleConfiguration),
// 而仓库里从没配过。但那份配置在控制台侧、不在仓库里,拿不到它当保证,所以另配
// 两道兜底:这里的保鲜期(挡「地址还在但本地文件被覆盖了」),和下一组的失败即清
// (挡「地址真死了」)。
describe('重启后复用预传地址', () => {
  /** 摆一张上次退出时留在库里的卡,素材带指定的预传字段。 */
  async function seedStored(fields: Record<string, unknown>): Promise<string> {
    const { buildCard } = await import('../store')
    const db = await import('../WorkbenchDb')
    await db.getWorkbenchDb().put({
      ...buildCard({ prompt: '上次的卡', mode: 'reference_images' }, 0),
      id: 'c-stored',
      referenceImages: [{ name: 'a', src: LOCAL_A, ...fields }],
    } as never)
    return 'c-stored'
  }

  it('新鲜地址直接复用,角标回到打勾 —— 不再白传一遍', async () => {
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const id = await seedStored({ uploadedUrl: COS_A, uploadedAt: Date.now() - 60_000 })

    await useStore.getState().ensureHydrated()

    const card = useStore.getState().cards.find((c) => c.id === id)!
    expect(card.referenceImages[0].uploadedUrl).toBe(COS_A)
    expect(card.referenceImages[0].uploadState).toBe('uploaded')
    expect(buildModeMedia(card).referenceImages).toEqual([COS_A])
    expect(resolveRefMedia).not.toHaveBeenCalled()
  })

  it('过了保鲜期就丢弃 —— 本地文件可能早被覆盖,拿旧地址会安静地生成旧内容', async () => {
    const { MATERIAL_UPLOAD_URL_TTL_MS } = await import('../../../../../types/videoWorkbench')
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const id = await seedStored({
      uploadedUrl: COS_A,
      uploadedAt: Date.now() - MATERIAL_UPLOAD_URL_TTL_MS - 1,
    })

    await useStore.getState().ensureHydrated()

    const card = useStore.getState().cards.find((c) => c.id === id)!
    expect(card.referenceImages[0].uploadedUrl).toBeUndefined()
    expect(card.referenceImages[0].uploadState).toBeUndefined()
    expect(buildModeMedia(card).referenceImages).toEqual([LOCAL_A])
  })

  it('只有地址没有时间戳的记录一律丢弃 —— 判不出新鲜度就不能信', async () => {
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const id = await seedStored({ uploadedUrl: COS_A })

    await useStore.getState().ensureHydrated()

    const card = useStore.getState().cards.find((c) => c.id === id)!
    expect(card.referenceImages[0].uploadedUrl).toBeUndefined()
    expect(buildModeMedia(card).referenceImages).toEqual([LOCAL_A])
  })
})

// 存地址就有拿到死链的可能(桶被配了生命周期规则、对象被人清了)。没有这一组的话
// 失败重试会拿同一个死链再撞一次,这张卡就永久废了 —— 这正是当初不敢落库的理由。
// 失败即清之后,死链最多值一次失败:重试回落本地路径,和从没预传过一模一样。
describe('任务失败清掉预传缓存', () => {
  it('提交失败后地址清空,重试从本地重传 —— 死链不会把卡片钉死', async () => {
    const { useVideoWorkbenchStore: useStore, buildModeMedia } = await loadStore()
    const submit = vi.fn(async () => ({ success: false, error: '上游拉不到素材' }))
    ;(window as unknown as { electronAPI: Record<string, unknown> }).electronAPI.videoWorkbench = { submit }

    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    await vi.waitFor(() => expect(deferred.length).toBe(1))
    deferred[0]({ ok: true, url: COS_A })
    await vi.waitFor(() => {
      expect(useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages[0].uploadedUrl).toBe(COS_A)
    })

    await useStore.getState().startCards()

    const card = useStore.getState().cards.find((c) => c.id === cardId)!
    expect(card.status).toBe('failed')
    // 提交那一次确实用了预传地址 —— 清缓存是失败之后的事,不是从来没用过。
    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([COS_A])
    expect(card.referenceImages[0].uploadedUrl).toBeUndefined()
    expect(card.referenceImages[0].uploadState).toBeUndefined()
    expect(buildModeMedia(card).referenceImages).toEqual([LOCAL_A])
  })
})
