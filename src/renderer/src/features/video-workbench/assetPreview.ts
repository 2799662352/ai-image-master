// 人像库 asset:// 素材的 previewUrl 会话级解析缓存。
//
// 背景:agent 经 MCP(video_workbench_add_tasks/update_task)往卡片挂
// `asset://<assetId>` 素材时,渲染端无法直连该协议出缩略图 —— 必须用上游
// 列表接口(seedance.listAssets)回带的 previewUrl(https)展示。
//
// 两个消费方:
//   1. MCP 写入侧(AgentToolExecutor):写卡前 `enrichAssetReferences` 把
//      asset:// 字符串升级成带 previewUrl 的 Material(治本,新素材直接有图);
//   2. 渲染兜底(MaterialThumb / useMaterialThumbSrcs):对已有数据里缺
//      previewUrl 的 asset:// 素材惰性解析(治已落库的旧卡片)。
//
// 缓存纪律:
//   - 会话级 Map,同一 assetId 只解析一次;扫描后仍找不到 → 记 null,
//     永不重查(消费方保持文件名占位);
//   - 全量 list 拉取共享单个 in-flight promise —— 一屏 N 个素材同时挂载
//     只会发一轮分页扫描,绝不按素材各发一次;
//   - 扫描分页参数与主进程提交前引用校验同款(pageSize 50,页数设上限
//     防大库拖死)。

import type { SeedanceAssetListResult } from '../../../../types/seedance'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'

export interface AssetPreviewEntry {
  previewUrl?: string
  name?: string
}

const SCAN_PAGE_SIZE = 50
const SCAN_MAX_PAGES = 10

/** assetId → 解析结果;null = 已扫描过但库里没有(不再重查)。 */
const cache = new Map<string, AssetPreviewEntry | null>()

/** 共享的全量扫描 in-flight(并发调用合流成一轮分页拉取)。 */
let scanInflight: Promise<Map<string, AssetPreviewEntry>> | null = null

interface SeedanceListApi {
  listAssets?: (query: {
    page?: number
    pageSize?: number
    kind?: string
  }) => Promise<SeedanceAssetListResult>
}

function getSeedanceApi(): SeedanceListApi | undefined {
  return (globalThis as unknown as { electronAPI?: { seedance?: SeedanceListApi } }).electronAPI
    ?.seedance
}

/** `asset://<assetId>` → assetId;其他形态返回 null。 */
export function extractAssetId(src: string): string | null {
  if (!src.startsWith('asset://')) return null
  const id = src.slice('asset://'.length)
  return id.length > 0 ? id : null
}

/** 分页拉全库(kind: all),汇成 assetId → entry。失败/缺桥返回已收集部分。 */
async function scanAllAssets(): Promise<Map<string, AssetPreviewEntry>> {
  const out = new Map<string, AssetPreviewEntry>()
  const api = getSeedanceApi()
  if (!api?.listAssets) return out
  let page = 1
  for (;;) {
    let res: SeedanceAssetListResult
    try {
      res = await api.listAssets({ page, pageSize: SCAN_PAGE_SIZE, kind: 'all' })
    } catch {
      break
    }
    const items = res.items ?? []
    for (const item of items) {
      if (!item.assetId) continue
      out.set(item.assetId, {
        ...(item.previewUrl ? { previewUrl: item.previewUrl } : {}),
        ...(item.name ? { name: item.name } : {}),
      })
    }
    const totalPages = Math.min(res.totalPages ?? 1, SCAN_MAX_PAGES)
    if (items.length === 0 || page >= totalPages) break
    page += 1
  }
  return out
}

/**
 * 同步读缓存:undefined = 从未解析(可触发解析);null = 解析过但没有
 * (保持占位,别再查);entry = 命中。
 */
export function getCachedAssetPreview(assetId: string): AssetPreviewEntry | null | undefined {
  return cache.get(assetId)
}

/**
 * 批量解析 assetId → previewUrl/name。未知 id 触发一轮共享的全量扫描
 * (并发调用合流);扫描后仍未知的 id 记 null 永不重查。返回仅含命中项。
 */
export async function resolveAssetPreviews(
  assetIds: string[],
): Promise<Map<string, AssetPreviewEntry>> {
  const unique = [...new Set(assetIds)]
  const unknown = unique.filter((id) => !cache.has(id))
  if (unknown.length > 0) {
    scanInflight ??= scanAllAssets().finally(() => {
      scanInflight = null
    })
    const found = await scanInflight.catch(() => new Map<string, AssetPreviewEntry>())
    for (const [id, entry] of found) {
      if (!cache.has(id)) cache.set(id, entry)
    }
    for (const id of unknown) {
      if (!cache.has(id)) cache.set(id, null)
    }
  }
  const out = new Map<string, AssetPreviewEntry>()
  for (const id of unique) {
    const entry = cache.get(id)
    if (entry) out.set(id, entry)
  }
  return out
}

/** 素材缺 previewUrl 且 src 是 asset:// 时,用缓存命中项补上(同步,不触发解析)。 */
export function withCachedAssetPreview(m: VideoWorkbenchMaterial): VideoWorkbenchMaterial {
  if (m.previewUrl) return m
  const assetId = extractAssetId(m.src)
  if (!assetId) return m
  const entry = cache.get(assetId)
  if (!entry?.previewUrl) return m
  return { ...m, previewUrl: entry.previewUrl }
}

const REF_KEYS = ['referenceImages', 'referenceVideos', 'referenceAudios'] as const

/**
 * 取一条素材条目待解析的 assetId。字符串形态直接看内容;对象形态只在
 * **缺 previewUrl** 时才需要解析 —— 看板 IR 的素材是 `{name, src}`(previewUrl
 * 是展示派生物,刻意不进 IR),apply 回来时得在这里补上,否则缩略图空一片。
 */
function pendingAssetId(entry: unknown): string | null {
  if (typeof entry === 'string') return extractAssetId(entry)
  if (!entry || typeof entry !== 'object') return null
  const m = entry as Partial<VideoWorkbenchMaterial>
  if (typeof m.src !== 'string' || m.previewUrl) return null
  return extractAssetId(m.src)
}

/**
 * MCP 写入侧(治本):把 CardInput 里的 `asset://` 引用升级为带 previewUrl 的
 * Material(字符串与 `{name, src}` 对象两种形态都收,store.toMaterial 也都收)。
 * 全部任务的 asset id 收集完只发一次批量解析;查不到/接口失败保持原样
 * (缩略图回落文件名占位,提交链路不受影响)。
 */
export async function enrichAssetReferences<T extends Record<string, unknown>>(
  inputs: T[],
): Promise<T[]> {
  const ids: string[] = []
  for (const input of inputs) {
    for (const key of REF_KEYS) {
      const list = input[key]
      if (!Array.isArray(list)) continue
      for (const entry of list) {
        const id = pendingAssetId(entry)
        if (id) ids.push(id)
      }
    }
  }
  if (ids.length === 0) return inputs
  const found = await resolveAssetPreviews(ids)
  return inputs.map((input) => {
    const next: Record<string, unknown> = { ...input }
    let anyChanged = false
    for (const key of REF_KEYS) {
      const list = input[key]
      if (!Array.isArray(list)) continue
      let keyChanged = false
      const mapped = list.map((entry) => {
        const id = pendingAssetId(entry)
        const asset = id ? found.get(id) : undefined
        if (!id || !asset?.previewUrl) return entry
        keyChanged = true
        const existing = typeof entry === 'object' && entry ? (entry as VideoWorkbenchMaterial) : null
        const material: VideoWorkbenchMaterial = {
          name: existing?.name || asset.name || `素材库 ${id.slice(0, 12)}…`,
          src: existing ? existing.src : (entry as string),
          previewUrl: asset.previewUrl,
        }
        return material
      })
      if (keyChanged) {
        next[key] = mapped
        anyChanged = true
      }
    }
    return anyChanged ? (next as T) : input
  })
}

/** 测试用:清空会话缓存与 in-flight。 */
export function resetAssetPreviewCacheForTest(): void {
  cache.clear()
  scanInflight = null
}
