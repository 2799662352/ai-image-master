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

  it('uploadedUrl 不进 IndexedDB —— 重启后没有可能已失效的地址,回落本地路径重传', async () => {
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
    expect(persisted.referenceImages[0].src).toBe(LOCAL_A)
    expect(persisted.referenceImages[0].uploadedUrl).toBeUndefined()
    // uploadState 同样是会话内的:重启后不该显示一个上次会话的打勾。
    expect(persisted.referenceImages[0].uploadState).toBeUndefined()
  })
})
