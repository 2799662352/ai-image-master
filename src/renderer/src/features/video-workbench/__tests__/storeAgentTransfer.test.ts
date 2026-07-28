// agent 经 MCP 写进来的外链素材,也要走转存。
//
// 人手加素材(addMaterials)早就会把第三方图片复制到我们自己的存储,但 agent 的
// 两条写入路径不经过它 —— add_tasks 走 addCards,apply 走 IR 提交 —— 于是同一张
// 外链图,人贴进去会被接管,agent 挂进去就一直指着别人的服务器。缩略图当下都能
// 显示,差别要等对方挂掉或换地址才暴露,所以更该由测试钉住。
//
// 模块加载顺序:store 在导入时挂转存结果处理器,而 dispatcher 的事件监听是一次性
// 的 —— 必须先装桥再动态 import(同 storeMaterialTransfer.test.ts)。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CosResult } from '../../../utils/cosUploadDispatcher'

const X_URL = 'https://pbs.twimg.com/media/G2ktJBna8AAhgIg?format=jpg&name=orig'
const COS_URL = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/x.jpg'

let enqueueUploadFromUrl: ReturnType<typeof vi.fn>
let emit: ((result: CosResult) => void) | undefined

function installBridge(): void {
  enqueueUploadFromUrl = vi.fn(async () => ({ queued: true as const }))
  emit = undefined
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    cos: {
      enqueueUploadFromUrl,
      onUploadResult: (cb: (r: CosResult) => void) => {
        emit = cb
        return () => { emit = undefined }
      },
    },
  }
}

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

describe('agent 写入路径的外链转存', () => {
  it('addCards(agent 加卡)带外链图 → 发起转存,回来后换成我们的地址', async () => {
    const useStore = await loadStore()
    const [cardId] = useStore.getState().addCards([
      { prompt: '第一镜', referenceImages: [{ name: '参考', src: X_URL }] },
    ])

    await vi.waitFor(() => expect(enqueueUploadFromUrl).toHaveBeenCalledTimes(1))
    const [requestId, sourceUrl] = enqueueUploadFromUrl.mock.calls[0]
    expect(sourceUrl).toBe(X_URL)

    emit?.({ requestId, success: true, url: COS_URL, key: 'k' })

    await vi.waitFor(() => {
      const card = useStore.getState().cards.find((c) => c.id === cardId)!
      expect(card.referenceImages[0].src).toBe(COS_URL)
    })
  })

  it('updateCard 换上新的外链图 → 同样转存', async () => {
    const useStore = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: '待补素材' }])
    expect(enqueueUploadFromUrl).not.toHaveBeenCalled()

    useStore.getState().updateCard(cardId, { referenceImages: [{ name: '参考', src: X_URL }] })

    await vi.waitFor(() => expect(enqueueUploadFromUrl).toHaveBeenCalledTimes(1))
    expect(enqueueUploadFromUrl.mock.calls[0][1]).toBe(X_URL)
  })

  it('本地路径 / data: / 我们自己的 COS 不触发', async () => {
    const useStore = await loadStore()
    useStore.getState().addCards([
      {
        prompt: '混合素材',
        referenceImages: [
          { name: '本地', src: 'D:\\pics\\cat.png' },
          { name: '内联', src: 'data:image/png;base64,AAA' },
          { name: '已是我们的', src: COS_URL },
        ],
      },
    ])

    await new Promise((r) => setTimeout(r, 10))
    expect(enqueueUploadFromUrl).not.toHaveBeenCalled()
  })

  it('一次加多张卡时每张的外链各自转存', async () => {
    const useStore = await loadStore()
    const second = 'https://cdn.example.com/b.jpg'
    useStore.getState().addCards([
      { prompt: 'A', referenceImages: [{ name: 'a', src: X_URL }] },
      { prompt: 'B', referenceImages: [{ name: 'b', src: second }] },
    ])

    await vi.waitFor(() => expect(enqueueUploadFromUrl).toHaveBeenCalledTimes(2))
    const urls = enqueueUploadFromUrl.mock.calls.map((c) => c[1])
    expect(urls).toEqual(expect.arrayContaining([X_URL, second]))
  })
})
