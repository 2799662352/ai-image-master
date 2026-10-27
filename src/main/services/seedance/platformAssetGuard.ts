// 平台余额提交前的 `asset://` 核验。
//
// 素材库按「账户 + 计费池」隔离:在 vvdance 自填 Key 的人像库里登记的素材、或登记在
// 另一个计费池里的素材,拿到当前池去提交,上游不会在创建时拒绝,而是先建任务、跑到
// 取素材那一步才回 `The specified asset asset-… is not found`(2026-09-24 用户实机)。
// 那时已经排过一次队,用户看到的还是一段英文 JSON。
//
// 这里在提交前逐个按 id 单查,**只在能确认取不到时拦**:
//   - 404 / 403 = 这个 id 不属于当前池或已被彻底删除 → 拦;
//   - Status === 'Failed' = 上游对这条素材的终态判决 → 拦;
//   - 其余(网络断、5xx、还在处理中)→ 放行交给上游,核验是防线不是闸门。

import type { PlatformAsset, PlatformAssetScope } from '../portraitLibrary/platformAssets'
import { extractAssetReferenceIds } from './assets'
import type { SeedanceContentItem } from './types'

export type GetPlatformAsset = (assetId: string, scope: PlatformAssetScope) => Promise<PlatformAsset>

function isGone(e: unknown): boolean {
  const status = (e as { status?: unknown })?.status
  return status === 404 || status === 403
}

export function missingPlatformAssetsMessage(missing: string[], failed: string[]): string {
  const parts: string[] = []
  if (missing.length > 0) {
    parts.push(
      `当前计费池的素材库里找不到:${missing.map((id) => `asset://${id}`).join('、')}。` +
        '素材库按账户和计费池隔离 —— 这些素材多半登记在自填 Key 的人像库或另一个计费池里,也可能已被彻底删除。',
    )
  }
  if (failed.length > 0) {
    parts.push(`这些素材在上游处理失败,不能引用:${failed.map((id) => `asset://${id}`).join('、')}。`)
  }
  parts.push('请在卡片上删掉它们,再从「人像库」按钮重新选择或重新上传后生成。本次未提交,没有扣费。')
  return parts.join('')
}

export async function verifyPlatformAssetReferences(
  content: SeedanceContentItem[],
  scope: PlatformAssetScope,
  getAsset: GetPlatformAsset,
): Promise<void> {
  const ids = extractAssetReferenceIds(content)
  if (ids.length === 0) return
  const missing: string[] = []
  const failed: string[] = []
  await Promise.all(
    ids.map(async (id) => {
      try {
        const asset = await getAsset(id, scope)
        if (asset.Status === 'Failed') failed.push(id)
      } catch (e) {
        if (isGone(e)) missing.push(id)
        else console.warn('[seedance] platform asset check skipped (left to upstream):', id, e)
      }
    }),
  )
  if (missing.length > 0 || failed.length > 0) {
    // 按卡上出现的顺序报,用户对照卡片好找。
    const order = (list: string[]) => ids.filter((id) => list.includes(id))
    throw new Error(missingPlatformAssetsMessage(order(missing), order(failed)))
  }
}
