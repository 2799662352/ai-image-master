// 挂进卡片的外链图会被转存,回来后素材换成我们自己的持久地址。
//
// 模块加载顺序在这里是有讲究的:store 在**导入时**就挂上转存结果的处理器,
// 而 cosUploadDispatcher 的事件监听是一次性的(`listenerInstalled`)—— 桥还不
// 存在时那次挂载会静默跳过,之后再也不会补上。生产环境没这个问题(preload 在
// 渲染脚本之前就暴露了 electronAPI),但测试里必须 `vi.resetModules()` + 先装桥
// 再动态 import,否则 emit 永远拿不到。同款写法见 stores/cosUploadHotSwap.test.ts。

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { CosResult } from '../../../utils/cosUploadDispatcher'

const X_URL = 'https://pbs.twimg.com/media/G2ktJBna8AAhgIg?format=jpg&name=orig'
const COS_URL = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/x.jpg'

let enqueueUploadFromUrl: ReturnType<typeof vi.fn>
let enqueueUploadBytes: ReturnType<typeof vi.fn>
let emit: ((result: CosResult) => void) | undefined

function installBridge(): void {
  enqueueUploadFromUrl = vi.fn(async () => ({ queued: true as const }))
  enqueueUploadBytes = vi.fn(async () => ({ queued: true as const }))
  emit = undefined
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    cos: {
      enqueueUploadFromUrl,
      enqueueUploadBytes,
      onUploadResult: (cb: (r: CosResult) => void) => {
        emit = cb
        return () => { emit = undefined }
      },
    },
  }
}

/** 装好桥之后再加载 store,拿到的是同一份模块图里的 store 与转存模块。 */
async function loadStore() {
  const store = await import('../store')
  const db = await import('../WorkbenchDb')
  store.resetWorkbenchStoreForTest()
  db.resetWorkbenchDbForTest()
  return store.useVideoWorkbenchStore
}

beforeEach(() => {
  vi.resetModules()
  installBridge()
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
})

describe('外链素材转存', () => {
  it('挂上第三方图链 → 发起转存;回来后素材换成 COS 地址', async () => {
    const useStore = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: '漫画1', src: X_URL }])
    const imagesOf = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages

    await vi.waitFor(() => expect(enqueueUploadFromUrl).toHaveBeenCalledTimes(1))
    const [requestId, sourceUrl] = enqueueUploadFromUrl.mock.calls[0]
    expect(requestId).toMatch(/^vwmaterial:/)
    expect(sourceUrl).toBe(X_URL)
    // 转存在途中素材照旧可用,不是先清空再等
    expect(imagesOf()[0].src).toBe(X_URL)

    emit?.({ requestId, success: true, url: COS_URL, key: 'k' })

    await vi.waitFor(() => expect(imagesOf()[0].src).toBe(COS_URL))
    expect(imagesOf()[0].name).toBe('漫画1')
  })

  it('转存失败 → 保持外链,不清空也不报错', async () => {
    const useStore = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: '漫画1', src: X_URL }])

    await vi.waitFor(() => expect(enqueueUploadFromUrl).toHaveBeenCalledTimes(1))
    const [requestId] = enqueueUploadFromUrl.mock.calls[0]

    emit?.({ requestId, success: false, error: 'fetch failed' })

    await new Promise((r) => setTimeout(r, 10))
    const images = useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages
    expect(images[0].src).toBe(X_URL)
  })

  it('本地 / data: / 我们自己的 COS 都不触发转存', async () => {
    const useStore = await loadStore()
    for (const src of ['D:\\pics\\cat.png', 'data:image/png;base64,AAA', COS_URL]) {
      const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
      useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'm', src }])
    }

    await new Promise((r) => setTimeout(r, 10))
    expect(enqueueUploadFromUrl).not.toHaveBeenCalled()
  })

  /**
   * 库里残留的内联图(离线粘贴 / 转存曾失败 / 老版本存下的)在水合后补一次转存;
   * 换成 https 后再水合就扫不到,不会重复发。
   */
  it('水合后补转存库里残留的 data:image 素材;成功换地址后重复水合不再发', async () => {
    const useStore = await loadStore()
    const db = (await import('../WorkbenchDb')).getWorkbenchDb()
    const { buildCard } = await import('../cardSpec')
    const inline = buildCard({
      prompt: 'pasted',
      referenceImages: [
        { name: '粘贴图', src: 'data:image/png;base64,iVBORw0KGgo=' },
        { name: '云端图', src: COS_URL },
      ],
    }, 0)
    await db.put(inline)

    await useStore.getState().ensureHydrated()
    await vi.waitFor(() => expect(enqueueUploadBytes).toHaveBeenCalledTimes(1))
    const [requestId, , mime, meta] = enqueueUploadBytes.mock.calls[0]
    expect(requestId).toMatch(/^vwmaterial:/)
    expect(mime).toBe('image/png')
    expect(meta).toMatchObject({ name: '粘贴图' })
    // https 的那张不碰
    expect(enqueueUploadFromUrl).not.toHaveBeenCalled()

    emit?.({ requestId, success: true, url: 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/p.png', key: 'k' })
    const imagesOf = () => useStore.getState().cards.find((c) => c.id === inline.id)!.referenceImages
    await vi.waitFor(() => expect(imagesOf()[0].src).toMatch(/^https:/))

    // 再水合一次:素材已是 https,不再发
    const { sweepInlineMaterials } = await import('../store')
    expect(sweepInlineMaterials(useStore.getState().cards)).toBe(0)
    expect(enqueueUploadBytes).toHaveBeenCalledTimes(1)
  })

  it('结果迟到时按原地址匹配 —— 期间用户又加了图也不会错位', async () => {
    const useStore = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: '漫画1', src: X_URL }])
    const imagesOf = () => useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages

    await vi.waitFor(() => expect(enqueueUploadFromUrl).toHaveBeenCalledTimes(1))
    const [requestId] = enqueueUploadFromUrl.mock.calls[0]

    // 转存还在路上时,用户往同一张卡又加了一张本地图
    useStore.getState().addMaterials(cardId, 'referenceImages', [
      { name: '本地', src: 'D:\\pics\\b.png' },
    ])

    emit?.({ requestId, success: true, url: COS_URL, key: 'k' })

    await vi.waitFor(() => expect(imagesOf().map((m) => m.src)).toContain(COS_URL))
    // 另一张不能被误改
    expect(imagesOf().some((m) => m.src === 'D:\\pics\\b.png')).toBe(true)
  })
})
