// 素材「预传地址」落库后的重启 / 提交行为(P1:素材 URL 持久化)。
//
// 要钉住的用户可见结论:
// 1. 重启后素材不再退回「只剩本地路径」—— 缓存的云端地址还在,提交用它,**不再重传**;
// 2. 但这个地址**用之前必须验过**:启动时验本地文件指纹(便宜),提交前再探云端;
// 3. 验不过 / 验不了就丢缓存,回到「提交时主进程从本地路径现传」—— 慢一点但一定对;
// 4. 无论哪条路,`src`(本地路径)都不动。
//
// 「重启」的模拟:同一个 WorkbenchDb 实例里先把卡写进库,重置 store 的内存状态,
// 再 `ensureHydrated()`。写法沿用 storeMaterialTransfer。
//
// 模块加载顺序沿用预传那份的写法:先装桥再动态 import store。

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import type { VideoWorkbenchMaterial } from '../../../../../types/videoWorkbench'

const LOCAL_A = 'D:\\pics\\a.png'
const LOCAL_B = 'D:\\pics\\b.png'
const COS_A = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/a.png'
const COS_B = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/b.png'

type Verdict = {
  keep: boolean
  local: 'same' | 'changed' | 'missing' | 'unverifiable'
  remote: 'alive' | 'dead' | 'unknown' | 'skipped'
}
type VerifyArgs = {
  items: Array<{ src: string; uploadedUrl: string; uploadedFrom?: unknown }>
  checkRemote: boolean
}

const ALIVE_LOCAL_SAME: Verdict = { keep: true, local: 'same', remote: 'alive' }

let resolveRefMedia: ReturnType<typeof vi.fn>
let submit: ReturnType<typeof vi.fn>
/** 体检桥的默认实现:每条都通过。各用例按需覆盖。 */
let verifyImpl: (args: VerifyArgs) => Promise<Verdict[]>
let verifyUploadedMaterials: ReturnType<typeof vi.fn>

function installBridge(opts: { withVerify?: boolean } = {}): void {
  const withVerify = opts.withVerify ?? true
  resolveRefMedia = vi.fn(async (_p: string) => ({ ok: true as const, url: COS_A }))
  submit = vi.fn(async (_payload: Record<string, unknown>) => ({ success: true, taskId: 'task-1' }))
  verifyImpl = async (args) => args.items.map(() => ALIVE_LOCAL_SAME)
  verifyUploadedMaterials = vi.fn((args: VerifyArgs) => verifyImpl(args))
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = {
    attachments: {
      resolveRefMedia,
      ...(withVerify ? { verifyUploadedMaterials } : {}),
    },
    videoWorkbench: { submit },
    cos: {
      enqueueUploadFromUrl: vi.fn(async () => ({ queued: true as const })),
      onUploadResult: () => () => {},
    },
  }
}

const FROM_A = { src: LOCAL_A, size: 10, mtimeMs: 1000, at: 1 }
const FROM_B = { src: LOCAL_B, size: 20, mtimeMs: 2000, at: 1 }

function persistedMaterial(over: Partial<VideoWorkbenchMaterial> & { src: string }): VideoWorkbenchMaterial {
  return { name: over.src.split('\\').pop()!, ...over }
}

async function loadStore() {
  const store = await import('../store')
  const db = await import('../WorkbenchDb')
  store.resetWorkbenchStoreForTest()
  db.resetWorkbenchDbForTest()
  return { store, db: db.getWorkbenchDb(), useStore: store.useVideoWorkbenchStore }
}

/** 写进库里一张带缓存地址的卡,再「重启」:重置 store 内存、重新水合。 */
async function restartWithCard(
  materials: VideoWorkbenchMaterial[],
  extra: Record<string, unknown> = {},
) {
  const ctx = await loadStore()
  const { buildCard } = await import('../cardSpec')
  const card = buildCard(
    { prompt: '一只猫', mode: 'reference_images', referenceImages: materials as never, ...extra } as never,
    0,
  )
  await ctx.db.put(card)
  ctx.store.resetWorkbenchStoreForTest() // 只清内存,库实例保留 = 重启
  await ctx.useStore.getState().ensureHydrated()
  const cardOf = () => ctx.useStore.getState().cards.find((c) => c.id === card.id)!
  return { ...ctx, cardId: card.id, cardOf }
}

beforeEach(() => {
  vi.resetModules()
  installBridge()
})

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.useRealTimers()
})

describe('重启后(水合)', () => {
  it('缓存地址还在,src 仍是本地路径;本地指纹验过后打勾;不重传、不探云端', async () => {
    const { cardOf, store } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])

    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    const m = cardOf().referenceImages[0]
    expect(m.src).toBe(LOCAL_A)
    expect(m.uploadedUrl).toBe(COS_A)
    expect(store.buildModeMedia(cardOf()).referenceImages).toEqual([COS_A])

    // 启动只验本地(便宜,整板几百条也无妨);云端留到提交前。
    expect(verifyUploadedMaterials).toHaveBeenCalledTimes(1)
    expect(verifyUploadedMaterials.mock.calls[0][0].checkRemote).toBe(false)
    expect(resolveRefMedia).not.toHaveBeenCalled()
  })

  it('本地文件被改过(体检说 changed)→ 丢掉缓存地址和指纹,回到本地路径,并把结论落库', async () => {
    verifyImpl = async (args) => args.items.map(() => ({ keep: false, local: 'changed', remote: 'skipped' }))
    const { cardOf, db, cardId, store } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])

    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadedUrl).toBeUndefined())
    const m = cardOf().referenceImages[0]
    expect(m.src).toBe(LOCAL_A)
    expect(m.uploadedFrom).toBeUndefined()
    expect(m.uploadState).toBeUndefined()
    expect(store.buildModeMedia(cardOf()).referenceImages).toEqual([LOCAL_A])

    // 落库:否则每次重启都要重新判一遍同一个已知作废的地址。
    await vi.waitFor(
      async () => {
        const persisted = (await db.list()).find((c) => c.id === cardId)!
        expect(persisted.referenceImages[0].uploadedUrl).toBeUndefined()
        expect(persisted.referenceImages[0].uploadedFrom).toBeUndefined()
      },
      { timeout: 4000 },
    )
  })

  it('逐条判定:一条作废不连累同卡其它素材', async () => {
    verifyImpl = async (args) =>
      args.items.map((it) =>
        it.src === LOCAL_A
          ? { keep: false, local: 'changed', remote: 'skipped' }
          : { keep: true, local: 'same', remote: 'skipped' },
      )
    const { cardOf } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
      persistedMaterial({ src: LOCAL_B, uploadedUrl: COS_B, uploadedFrom: FROM_B }),
    ])

    await vi.waitFor(() => expect(cardOf().referenceImages[1].uploadState).toBe('uploaded'))
    expect(cardOf().referenceImages[0].uploadedUrl).toBeUndefined()
    expect(cardOf().referenceImages[1].uploadedUrl).toBe(COS_B)
  })

  it('本地文件已不在(missing)但云端地址没问题 → 保留 —— 它此时是唯一来源', async () => {
    verifyImpl = async (args) => args.items.map(() => ({ keep: true, local: 'missing', remote: 'skipped' }))
    const { cardOf } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])

    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    expect(cardOf().referenceImages[0].uploadedUrl).toBe(COS_A)
  })

  it('没有体检桥(旧版 preload / 非 Electron)→ 验证不了,保守丢掉缓存', async () => {
    installBridge({ withVerify: false })
    const { cardOf } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])

    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadedUrl).toBeUndefined())
    expect(cardOf().referenceImages[0].src).toBe(LOCAL_A)
  })

  it('没带缓存地址的素材(绝大多数)不触发任何体检', async () => {
    const { cardOf } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A }),
      persistedMaterial({ src: 'https://example.com/x.png' }),
    ])
    await new Promise((r) => setTimeout(r, 20))
    expect(verifyUploadedMaterials).not.toHaveBeenCalled()
    expect(cardOf().referenceImages.map((m) => m.uploadState)).toEqual([undefined, undefined])
  })

  it('水合不改 rev / revision —— 体检结论是缓存状态,不是编排意图', async () => {
    verifyImpl = async (args) => args.items.map(() => ({ keep: false, local: 'changed', remote: 'skipped' }))
    const { cardOf, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    const revBefore = cardOf().rev
    const revisionBefore = useStore.getState().revision

    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadedUrl).toBeUndefined())
    expect(cardOf().rev).toBe(revBefore)
    expect(useStore.getState().revision).toBe(revisionBefore)
  })
})

describe('提交前', () => {
  it('重启后第一次提交:先探云端,活着就用缓存地址,不重传', async () => {
    const { cardOf, cardId, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    verifyUploadedMaterials.mockClear()

    await useStore.getState().startCards([cardId])

    const remoteCalls = verifyUploadedMaterials.mock.calls.filter((c) => c[0].checkRemote)
    expect(remoteCalls).toHaveLength(1)
    expect(remoteCalls[0][0].items.map((i: { uploadedUrl: string }) => i.uploadedUrl)).toEqual([COS_A])
    expect(submit).toHaveBeenCalledTimes(1)
    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([COS_A])
    expect(resolveRefMedia).not.toHaveBeenCalled()
  })

  it('云端对象没了(dead)→ 这次提交回落本地路径(由主进程现传),缓存被清掉', async () => {
    const { cardOf, cardId, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    verifyImpl = async (args) =>
      args.items.map(() =>
        args.checkRemote
          ? { keep: false, local: 'same', remote: 'dead' }
          : { keep: true, local: 'same', remote: 'skipped' },
      )

    await useStore.getState().startCards([cardId])

    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([LOCAL_A])
    expect(cardOf().referenceImages[0].uploadedUrl).toBeUndefined()
    expect(cardOf().referenceImages[0].src).toBe(LOCAL_A)
  })

  it('云端暂时探不通(unknown)但本地没变 → 仍用缓存地址,别为一次抖动重传', async () => {
    const { cardOf, cardId, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    verifyImpl = async (args) => args.items.map(() => ({ keep: true, local: 'same', remote: 'unknown' }))

    await useStore.getState().startCards([cardId])

    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([COS_A])
  })

  it('探到活着的地址本会话内记住:第二次提交不再探云端(只复核本地)', async () => {
    const { cardOf, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    const id = cardOf().id
    verifyUploadedMaterials.mockClear()

    await useStore.getState().startCards([id])
    expect(verifyUploadedMaterials.mock.calls.filter((c) => c[0].checkRemote)).toHaveLength(1)

    // 让这张卡回到可启动(模拟生成失败后重试)
    useStore.setState((s) => ({
      cards: s.cards.map((c) => (c.id === id ? { ...c, status: 'failed' as const } : c)),
    }))
    verifyUploadedMaterials.mockClear()
    await useStore.getState().startCards([id])

    expect(verifyUploadedMaterials.mock.calls.filter((c) => c[0].checkRemote)).toHaveLength(0)
    expect(submit).toHaveBeenCalledTimes(2)
  })

  it('本会话刚预传好的地址:提交前不探云端,但仍复核本地(预传后用户可能又改了文件)', async () => {
    const { useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    await vi.waitFor(() => {
      expect(useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages[0].uploadedUrl).toBe(COS_A)
    })

    await useStore.getState().startCards([cardId])

    expect(verifyUploadedMaterials).toHaveBeenCalledTimes(1)
    expect(verifyUploadedMaterials.mock.calls[0][0].checkRemote).toBe(false)
    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([COS_A])
  })

  it('预传后用户又改了文件(本地 changed)→ 丢掉缓存,提交走本地路径,拿到的是新内容', async () => {
    const { useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', mode: 'reference_images' }])
    useStore.getState().addMaterials(cardId, 'referenceImages', [{ name: 'a', src: LOCAL_A }])
    await vi.waitFor(() => {
      expect(useStore.getState().cards.find((c) => c.id === cardId)!.referenceImages[0].uploadedUrl).toBe(COS_A)
    })
    verifyImpl = async (args) => args.items.map(() => ({ keep: false, local: 'changed', remote: 'skipped' }))

    await useStore.getState().startCards([cardId])

    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([LOCAL_A])
  })

  it('没有任何缓存地址的卡:不发体检,而且提交仍是同步落 preparing(不引入额外等待)', async () => {
    const { useStore } = await loadStore()
    const [cardId] = useStore.getState().addCards([{ prompt: 'x', referenceImages: ['https://example.com/a.png'] }])

    const pending = useStore.getState().startCards([cardId])
    // 没 await:卡片必须已经是 preparing —— 与引入体检之前的时序一致。
    expect(useStore.getState().cards.find((c) => c.id === cardId)!.status).toBe('preparing')
    await pending

    expect(verifyUploadedMaterials).not.toHaveBeenCalled()
  })

  it('体检桥抛错 → 绝不拦提交:未确认的缓存丢掉,走本地路径', async () => {
    const { cardOf, cardId, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    verifyImpl = async () => {
      throw new Error('IPC gone')
    }

    await useStore.getState().startCards([cardId])

    expect(submit).toHaveBeenCalledTimes(1)
    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([LOCAL_A])
  })

  it('体检超时 → 同样不拦提交', async () => {
    const { cardOf, cardId, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    verifyImpl = () => new Promise<Verdict[]>(() => {}) // 永不返回

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const started = useStore.getState().startCards([cardId])
    await vi.advanceTimersByTimeAsync(20_000)
    await started

    expect(submit).toHaveBeenCalledTimes(1)
    expect((submit.mock.calls[0][0] as { referenceImages: string[] }).referenceImages).toEqual([LOCAL_A])
  })

  it('体检期间连点两次生成:只提交一次(卡片在体检后才落 preparing,第二次重新判门)', async () => {
    const { cardOf, cardId, useStore } = await restartWithCard([
      persistedMaterial({ src: LOCAL_A, uploadedUrl: COS_A, uploadedFrom: FROM_A }),
    ])
    await vi.waitFor(() => expect(cardOf().referenceImages[0].uploadState).toBe('uploaded'))
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    verifyImpl = async (args) => {
      await gate
      return args.items.map(() => ALIVE_LOCAL_SAME)
    }

    const first = useStore.getState().startCards([cardId])
    const second = useStore.getState().startCards([cardId])
    release()
    const [r1, r2] = await Promise.all([first, second])

    expect(submit).toHaveBeenCalledTimes(1)
    expect([r1.started.length, r2.started.length].sort()).toEqual([0, 1])
  })
})
