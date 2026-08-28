// 平台人像库的数据源适配层:读列表、两步上传、以及**三个语义完全不同的删除动作**。
//
// 这一层的每个函数都**不抛**:调用点全是组件里的 `void handleX()`,逃出去的异常
// 会成为 unhandled rejection —— vitest 因此判整轮失败(哪怕每条断言都过),
// 而生产里用户什么提示都看不到。判失败一律**同时看 rejected 与 `ok === false`**。

import { afterEach, describe, expect, it, vi } from 'vitest'
import type { PortraitScopeRef } from '../../../../../types/portraitApi'
import {
  deleteForever,
  loadPortraitCards,
  removeFromLibrary,
  renamePortraitAsset,
  restoreFromTrash,
  uploadAndRegister,
} from '../platformPortraitSource'

const SCOPE: PortraitScopeRef = { projectId: 42, producerProjectId: 7 }
const COS = 'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/portrait/a.png'

const okEnvelope = <T,>(data: T) => ({ ok: true as const, data })
const errEnvelope = (code: string, message: string) => ({
  ok: false as const,
  error: { code, message },
})

function mockBridge(over: Record<string, unknown> = {}) {
  const bridge = {
    list: vi.fn(async () =>
      okEnvelope({ Items: [], TotalCount: 0, HiddenCount: 0, Truncated: false }),
    ),
    poll: vi.fn(async () => okEnvelope({ Id: 'x', Status: 'Active' })),
    upload: vi.fn(async () =>
      okEnvelope({ url: COS, cosKey: 'k', fileSize: 10, assetType: 'Image' }),
    ),
    register: vi.fn(async () =>
      okEnvelope({ Id: 'new-1', URL: COS, PreviewUrl: COS, cosUrl: COS }),
    ),
    hide: vi.fn(async () => okEnvelope({ purged: false })),
    purge: vi.fn(async () => okEnvelope({ purged: true })),
    patch: vi.fn(async () => okEnvelope({ Id: 'a1' })),
    ...over,
  }
  ;(window as unknown as { electronAPI?: unknown }).electronAPI = { portraitLibrary: bridge }
  return bridge
}

/** `File` 在 jsdom 里没有 `arrayBuffer()` 的完整实现,而这条测试的重点正是它。 */
function fakeFile(name: string, type: string, size: number): File {
  const bytes = new Uint8Array(Math.min(size, 8))
  const file = {
    name,
    type,
    size,
    arrayBuffer: vi.fn(async () => bytes.buffer),
  }
  return file as unknown as File
}

afterEach(() => {
  delete (window as unknown as { electronAPI?: unknown }).electronAPI
  vi.restoreAllMocks()
})

describe('loadPortraitCards', () => {
  it('正常视图不传 hidden;回收站视图传 hidden: true', async () => {
    const bridge = mockBridge()
    await loadPortraitCards(SCOPE, { trash: false })
    expect(bridge.list).toHaveBeenLastCalledWith(SCOPE, undefined)

    await loadPortraitCards(SCOPE, { trash: true })
    expect(bridge.list).toHaveBeenLastCalledWith(SCOPE, { hidden: true })
  })

  // ── 硬约束 1(数据源侧)────────────────────────────────────────────────────
  //
  // 变异:在 loadPortraitCards 里 `.filter((c) => !c.hidden)`。这条会红。
  // 后端只打标不过滤,而这个数组同时用于解析画布上已有引用的 `asset://`。
  it('原样带回 Hidden 条目 —— 数据源不做展示层的活', async () => {
    mockBridge({
      list: vi.fn(async () =>
        okEnvelope({
          Items: [
            { Id: 'a', Status: 'Active' },
            { Id: 'b', Status: 'Active', Hidden: true },
          ],
          TotalCount: 2,
          HiddenCount: 1,
          Truncated: false,
        }),
      ),
    })
    const r = await loadPortraitCards(SCOPE, { trash: false })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data.cards.map((c) => c.assetId)).toEqual(['a', 'b'])
    expect(r.data.hiddenCount).toBe(1)
  })

  it('TotalCount / Truncated 原样带出 —— 列表被截断时 UI 要说得出来', async () => {
    mockBridge({
      list: vi.fn(async () =>
        okEnvelope({ Items: [], TotalCount: 2000, HiddenCount: 3, Truncated: true }),
      ),
    })
    const r = await loadPortraitCards(SCOPE, { trash: false })
    expect(r.ok && r.data.truncated).toBe(true)
    expect(r.ok && r.data.totalCount).toBe(2000)
  })

  it('信封失败 → 按 code 给动作文案,不抛', async () => {
    mockBridge({ list: vi.fn(async () => errEnvelope('NOT_AUTHENTICATED', '未登录')) })
    const r = await loadPortraitCards(SCOPE, { trash: false })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('NOT_AUTHENTICATED')
    expect(r.message).toMatch(/登录/)
  })

  it('桥 reject → 同样收成失败结果,绝不让异常逃出去', async () => {
    mockBridge({
      list: vi.fn(async () => {
        throw new Error('IPC 断了')
      }),
    })
    const r = await loadPortraitCards(SCOPE, { trash: false })
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('IPC 断了')
  })

  it('preload 没挂上人像库桥 → 失败结果而不是同步 TypeError', async () => {
    ;(window as unknown as { electronAPI?: unknown }).electronAPI = {}
    const r = await loadPortraitCards(SCOPE, { trash: false })
    expect(r.ok).toBe(false)
  })
})

describe('uploadAndRegister 两步走', () => {
  // 🚨 File/Blob 过不了结构化克隆,到主进程是个 `{}`,上传照发但 0 字节,
  // 隔一整个网络往返才换回一句 400。
  it('第一步递的是 ArrayBuffer,不是 File', async () => {
    const bridge = mockBridge()
    const file = fakeFile('a.png', 'image/png', 1024)
    await uploadAndRegister(SCOPE, file)

    expect(bridge.upload).toHaveBeenCalledTimes(1)
    const payload = bridge.upload.mock.calls[0]![1] as { data: unknown; filename: string; mimeType: string }
    expect(payload.data).toBeInstanceOf(ArrayBuffer)
    expect(payload).toMatchObject({ filename: 'a.png', mimeType: 'image/png' })
  })

  it('第二步用第一步回的 url 与 assetType', async () => {
    const bridge = mockBridge({
      upload: vi.fn(async () =>
        okEnvelope({ url: 'https://cos/v.mp4', cosKey: 'k', fileSize: 1, assetType: 'Video' }),
      ),
    })
    await uploadAndRegister(SCOPE, fakeFile('v.mp4', 'video/mp4', 1024))
    expect(bridge.register).toHaveBeenCalledWith(SCOPE, {
      url: 'https://cos/v.mp4',
      assetType: 'Video',
      name: 'v.mp4',
    })
  })

  // 主进程也会拦,但那时 IPC 的整份拷贝已经发生了。
  it('超限在读字节之前就拒:既不调 upload,也不读文件', async () => {
    const bridge = mockBridge()
    const file = fakeFile('big.mp4', 'video/mp4', 60 * 1024 * 1024)
    const r = await uploadAndRegister(SCOPE, file)

    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('50MB')
    expect(bridge.upload).not.toHaveBeenCalled()
    expect(file.arrayBuffer).not.toHaveBeenCalled()
  })

  it('视频上限是 50MB 而不是网页版写的 200MB', async () => {
    mockBridge()
    const r = await uploadAndRegister(SCOPE, fakeFile('v.mp4', 'video/mp4', 120 * 1024 * 1024))
    expect(r.ok).toBe(false)
  })

  it('第一步失败就不打第二步 —— 没有 url 可登记', async () => {
    const bridge = mockBridge({
      upload: vi.fn(async () => errEnvelope('FILE_TOO_LARGE', 'Image 文件不能超过 50MB')),
    })
    const r = await uploadAndRegister(SCOPE, fakeFile('a.png', 'image/png', 1024))
    expect(r.ok).toBe(false)
    expect(bridge.register).not.toHaveBeenCalled()
  })

  // register 回的三个 URL 就是永久 COS 链,不必等 poll 就能出缩略图。
  it('成功后立刻给一张能显示的卡片,状态是处理中', async () => {
    mockBridge()
    const r = await uploadAndRegister(SCOPE, fakeFile('刚传的.png', 'image/png', 1024))
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.data).toMatchObject({
      assetId: 'new-1',
      name: '刚传的.png',
      status: 'Processing',
      assetUrl: 'asset://new-1',
    })
    expect(r.data.thumbUrl).toContain('imageMogr2/thumbnail/400x')
  })
})

// ── 硬约束 3 ─────────────────────────────────────────────────────────────────
//
// 三个动作语义完全不同:软删不释放配额、恢复要重拉、彻底删除不可逆且是唯一
// 能回收配额的。互换任意两个都是数据事故,所以每条都同时断言「没打别的通道」。
describe('三个删除动作各走各的通道', () => {
  it('移出素材库 = hide,绝不碰 purge / patch', async () => {
    const bridge = mockBridge()
    const r = await removeFromLibrary(SCOPE, 'a1')
    expect(r.ok).toBe(true)
    expect(bridge.hide).toHaveBeenCalledWith(SCOPE, 'a1')
    expect(bridge.purge).not.toHaveBeenCalled()
    expect(bridge.patch).not.toHaveBeenCalled()
  })

  // `hidden: false` 是最容易被 falsy 判断吞掉的取值,而它恰好就是「恢复」那个动作。
  it('从回收站恢复 = patch(hidden: false),绝不碰 hide / purge', async () => {
    const bridge = mockBridge()
    const r = await restoreFromTrash(SCOPE, 'a1')
    expect(r.ok).toBe(true)
    expect(bridge.patch).toHaveBeenCalledWith(SCOPE, 'a1', { hidden: false })
    expect(bridge.hide).not.toHaveBeenCalled()
    expect(bridge.purge).not.toHaveBeenCalled()
  })

  it('彻底删除 = purge,绝不碰 hide', async () => {
    const bridge = mockBridge()
    const r = await deleteForever(SCOPE, 'a1')
    expect(r.ok).toBe(true)
    expect(bridge.purge).toHaveBeenCalledWith(SCOPE, 'a1')
    expect(bridge.hide).not.toHaveBeenCalled()
  })

  it('重命名走 patch(name),不带 hidden —— 别顺手把素材恢复了', async () => {
    const bridge = mockBridge()
    await renamePortraitAsset(SCOPE, 'a1', '新名字')
    expect(bridge.patch).toHaveBeenCalledWith(SCOPE, 'a1', { name: '新名字' })
  })

  // 名字超 64 字后端 PATCH 直接 400(POST 是静默截断)。客户端先截,
  // 免得用户改了个长名字只收到一句看不懂的 400。
  it('重命名先把名字截到 64 字', async () => {
    const bridge = mockBridge()
    await renamePortraitAsset(SCOPE, 'a1', '字'.repeat(100))
    expect(bridge.patch).toHaveBeenCalledWith(SCOPE, 'a1', { name: '字'.repeat(64) })
  })
})

// 这一组撑住「不要做乐观删除」:调用点必须能从返回值分辨成败,
// 而软删失败会返 500 —— 乐观移除会让用户以为删了、刷新后素材复活。
describe('删除失败必须被认出来', () => {
  it('信封 ok:false 算失败,不是「没抛就算成功」', async () => {
    mockBridge({ hide: vi.fn(async () => errEnvelope('HTTP_500', '后端炸了')) })
    const r = await removeFromLibrary(SCOPE, 'a1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toContain('后端炸了')
  })

  it('桥 reject 也算失败', async () => {
    mockBridge({
      purge: vi.fn(async () => {
        throw new Error('网络断了')
      }),
    })
    const r = await deleteForever(SCOPE, 'a1')
    expect(r.ok).toBe(false)
  })

  it('恢复失败同样被认出来 —— 之后必须重拉列表,拿不准就别改本地状态', async () => {
    mockBridge({ patch: vi.fn(async () => errEnvelope('ASSET_NOT_READY', '还没好')) })
    const r = await restoreFromTrash(SCOPE, 'a1')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.message).toMatch(/稍等/)
  })
})
