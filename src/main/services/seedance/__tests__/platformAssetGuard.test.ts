// 平台余额提交前的 asset:// 核验。
//
// 2026-09-24 用户实机:agent 从自填 Key 的人像库挑的素材,拿去平台余额提交,上游先建任务、
// 跑到取素材才回 `The specified asset asset-… is not found` —— 排过一次队,看到的是一段
// 英文 JSON。这里钉死「能确认取不到就在提交前拦下,确认不了就放行」。

import { describe, expect, it, vi } from 'vitest'
import { verifyPlatformAssetReferences } from '../platformAssetGuard'
import type { SeedanceContentItem } from '../types'

const scope = { projectId: 42 }

function content(...urls: string[]): SeedanceContentItem[] {
  return [
    { type: 'text', text: '【@图片1】走进来' },
    ...urls.map((url) => ({ type: 'image_url' as const, role: 'reference_image' as const, image_url: { url } })),
  ]
}

function httpError(status: number): Error {
  return Object.assign(new Error(`HTTP ${status}`), { status })
}

describe('verifyPlatformAssetReferences', () => {
  it('没有 asset:// 引用时零请求', async () => {
    const getAsset = vi.fn()
    await verifyPlatformAssetReferences(content('https://cos/a.png'), scope, getAsset)
    expect(getAsset).not.toHaveBeenCalled()
  })

  it('全部在当前池里且可用 → 放行', async () => {
    const getAsset = vi.fn(async (id: string) => ({ Id: id, Status: 'Active' }))
    await expect(
      verifyPlatformAssetReferences(content('asset://a1', 'asset://a2'), scope, getAsset),
    ).resolves.toBeUndefined()
    expect(getAsset).toHaveBeenCalledWith('a1', scope)
  })

  it('404 / 403(不属于当前池或已彻底删除)→ 提交前拦下,点名是哪几个', async () => {
    const getAsset = vi.fn(async (id: string) => {
      if (id === 'gone') throw httpError(404)
      if (id === 'other-pool') throw httpError(403)
      return { Id: id, Status: 'Active' }
    })
    await expect(
      verifyPlatformAssetReferences(content('asset://ok', 'asset://gone', 'asset://other-pool'), scope, getAsset),
    ).rejects.toThrow(/asset:\/\/gone、asset:\/\/other-pool[\s\S]*本次未提交,没有扣费/)
  })

  it('上游判 Failed 的素材同样拦下', async () => {
    const getAsset = vi.fn(async (id: string) => ({ Id: id, Status: 'Failed' }))
    await expect(verifyPlatformAssetReferences(content('asset://bad'), scope, getAsset)).rejects.toThrow(
      /处理失败[\s\S]*asset:\/\/bad/,
    )
  })

  it('网络断 / 5xx / 还在处理中 → 放行交给上游(核验是防线不是闸门)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const getAsset = vi.fn(async (id: string) => {
      if (id === 'flaky') throw httpError(502)
      if (id === 'offline') throw new Error('net::ERR_CONNECTION_RESET')
      return { Id: id, Status: 'Processing' }
    })
    await expect(
      verifyPlatformAssetReferences(content('asset://flaky', 'asset://offline', 'asset://busy'), scope, getAsset),
    ).resolves.toBeUndefined()
    warn.mockRestore()
  })
})
