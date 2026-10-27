// asset:// 素材的预览地址会话级解析缓存(素材库 / 人像库)。
//
// 背景:agent 经 MCP(video_workbench_add_tasks/update_task)往卡片挂
// `asset://<assetId>` 素材时,渲染端无法直连该协议出缩略图 —— 必须从素材所在
// 的库里查回 https 预览地址展示。
//
// **查哪个库跟着计费走**,与主进程提交时用的库一致:
//   - 平台余额 → 「素材库」(portraitLibrary.list / resolve,按当前计费池);
//   - 自填 Key → vvdance 人像库(seedance.listAssets)。
// 以前只查后者,平台用户的素材库素材永远查不到,预览弹窗只能说「没有可预览地址」。
//
// 两个消费方:
//   1. MCP 写入侧(AgentToolExecutor):写卡前 `enrichAssetReferences` 把
//      asset:// 字符串升级成带 previewUrl 的 Material(治本,新素材直接有图);
//   2. 渲染兜底(MaterialThumb / useMaterialThumbSrcs):对已有数据里缺
//      previewUrl 的 asset:// 素材惰性解析(治已落库的旧卡片)。
//
// 缓存纪律:
//   - 按「库 + 计费池」分区:同一个 id 在别的池里本来就取不到,不能串;
//   - 命中长期有效;**查不到只记 MISS_TTL_MS**。agent 刚登记的素材常常还在处理、
//     列表里暂时没有,以前记一次 null 就整个会话不再查,那张卡就再也不出图;
//   - 全量 list 共享单个 in-flight promise —— 一屏 N 个素材同时挂载只发一轮;
//     素材库列表里没有的再按 id 单查(有并发与数量上限)。

import type { PortraitAsset, PortraitLibraryApi, PortraitScopeRef } from '../../../../types/portraitApi'
import type { SeedanceAssetListResult } from '../../../../types/seedance'
import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { useQuotaStore } from '../../stores/useQuotaStore'
import { portraitCardsFromPlatform } from '../portrait-library/platformPortraitCard'

export interface AssetPreviewEntry {
  /** 缩略图(卡片 / chip 用)。 */
  previewUrl?: string
  name?: string
  /** 原始媒体地址(预览弹窗看大图用);缩略图可能是压过的小图。 */
  sourceUrl?: string
}

const SCAN_PAGE_SIZE = 50
const SCAN_MAX_PAGES = 10
/** 查不到的 id 多久后允许重查。 */
export const MISS_TTL_MS = 60_000
/** 素材库列表里没有的 id,单查的并发与总数上限(一张卡最多 50 个素材)。 */
const RESOLVE_CONCURRENCY = 4
const RESOLVE_MAX_IDS = 60

type CacheSlot = { entry: AssetPreviewEntry } | { missAt: number }

const cache = new Map<string, CacheSlot>()
/** 每个库一个全量扫描 in-flight(并发调用合流成一轮)。 */
const scanInflight = new Map<string, Promise<Map<string, AssetPreviewEntry>>>()

interface SeedanceListApi {
  listAssets?: (query: {
    page?: number
    pageSize?: number
    kind?: string
  }) => Promise<SeedanceAssetListResult>
}

interface ElectronApis {
  seedance?: SeedanceListApi
  portraitLibrary?: Pick<PortraitLibraryApi, 'list' | 'resolve'>
}

function electronApis(): ElectronApis | undefined {
  return (globalThis as unknown as { electronAPI?: ElectronApis }).electronAPI
}

type Library = { key: string; kind: 'vvdance' } | { key: string; kind: 'platform'; scope: PortraitScopeRef }

/** 当前计费对应的库。平台余额但还没选池时退回 vvdance(与主进程分派一致)。 */
function currentLibrary(): Library {
  const { billingSource, selectedPool } = useQuotaStore.getState()
  if (billingSource === 'platform' && selectedPool) {
    const pp = selectedPool.producerProjectId
    return {
      key: `platform:${selectedPool.projectId}:${pp ?? ''}`,
      kind: 'platform',
      scope: { projectId: selectedPool.projectId, producerProjectId: pp },
    }
  }
  return { key: 'vvdance', kind: 'vvdance' }
}

function slotKey(lib: Library, assetId: string): string {
  return `${lib.key}|${assetId}`
}

/** `asset://<assetId>` → assetId;其他形态返回 null。 */
export function extractAssetId(src: string): string | null {
  if (!src.startsWith('asset://')) return null
  const id = src.slice('asset://'.length)
  return id.length > 0 ? id : null
}

async function scanVvdance(): Promise<Map<string, AssetPreviewEntry>> {
  const out = new Map<string, AssetPreviewEntry>()
  const api = electronApis()?.seedance
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
        ...(item.sourceUrl ? { sourceUrl: item.sourceUrl } : {}),
      })
    }
    const totalPages = Math.min(res.totalPages ?? 1, SCAN_MAX_PAGES)
    if (items.length === 0 || page >= totalPages) break
    page += 1
  }
  return out
}

/**
 * 素材库条目 → 预览项。视频 / 音频的 `thumbUrl` 就是媒体本身,塞进 `<img>` 只会裂,
 * 所以只有图片才给 previewUrl;媒体地址统一放 sourceUrl。
 */
function entryFromPlatform(asset: PortraitAsset): AssetPreviewEntry {
  const [card] = portraitCardsFromPlatform([asset])
  if (!card) return {}
  return {
    ...(card.kind === 'image' && card.thumbUrl ? { previewUrl: card.thumbUrl } : {}),
    ...(asset.Name ? { name: asset.Name } : {}),
    ...(card.mediaUrl ? { sourceUrl: card.mediaUrl } : {}),
  }
}

async function scanPlatform(scope: PortraitScopeRef): Promise<Map<string, AssetPreviewEntry>> {
  const out = new Map<string, AssetPreviewEntry>()
  const api = electronApis()?.portraitLibrary
  if (!api?.list) return out
  try {
    const r = await api.list(scope)
    if (r?.ok !== true) return out
    for (const asset of r.data.Items ?? []) {
      if (asset.Id) out.set(asset.Id, entryFromPlatform(asset))
    }
  } catch {
    /* 列表失败:下面按 id 单查兜底 */
  }
  return out
}

async function resolvePlatformIds(
  scope: PortraitScopeRef,
  ids: string[],
): Promise<Map<string, AssetPreviewEntry>> {
  const out = new Map<string, AssetPreviewEntry>()
  const api = electronApis()?.portraitLibrary
  if (!api?.resolve || ids.length === 0) return out
  const queue = ids.slice(0, RESOLVE_MAX_IDS)
  const worker = async (): Promise<void> => {
    for (let id = queue.shift(); id !== undefined; id = queue.shift()) {
      try {
        const r = await api.resolve(scope, id)
        if (r?.ok === true && r.data) out.set(id, entryFromPlatform(r.data))
      } catch {
        /* 单条失败只影响这一张的缩略图 */
      }
    }
  }
  await Promise.all(Array.from({ length: RESOLVE_CONCURRENCY }, worker))
  return out
}

function scanLibrary(lib: Library): Promise<Map<string, AssetPreviewEntry>> {
  const running = scanInflight.get(lib.key)
  if (running) return running
  const task = (lib.kind === 'platform' ? scanPlatform(lib.scope) : scanVvdance())
    .catch(() => new Map<string, AssetPreviewEntry>())
    .finally(() => scanInflight.delete(lib.key))
  scanInflight.set(lib.key, task)
  return task
}

function readSlot(lib: Library, assetId: string, now = Date.now()): AssetPreviewEntry | null | undefined {
  const slot = cache.get(slotKey(lib, assetId))
  if (!slot) return undefined
  if ('entry' in slot) return slot.entry
  return now - slot.missAt < MISS_TTL_MS ? null : undefined
}

/**
 * 同步读缓存:undefined = 尚未解析 / 上次没查到且已过重查间隔(可触发解析);
 * null = 刚查过没有(先保持占位);entry = 命中。
 */
export function getCachedAssetPreview(assetId: string): AssetPreviewEntry | null | undefined {
  return readSlot(currentLibrary(), assetId)
}

/**
 * 批量解析 assetId 的预览项。未知 id 先走一轮共享的全量扫描;平台素材库里仍没有
 * 的再按 id 单查;都没有的记一次短期 miss。返回命中项。
 */
export async function resolveAssetPreviews(
  assetIds: string[],
): Promise<Map<string, AssetPreviewEntry>> {
  const lib = currentLibrary()
  const unique = [...new Set(assetIds)]
  const unknown = unique.filter((id) => readSlot(lib, id) === undefined)
  if (unknown.length > 0) {
    const found = new Map(await scanLibrary(lib))
    if (lib.kind === 'platform') {
      const rest = unknown.filter((id) => !found.has(id))
      for (const [id, entry] of await resolvePlatformIds(lib.scope, rest)) found.set(id, entry)
    }
    for (const [id, entry] of found) cache.set(slotKey(lib, id), { entry })
    const now = Date.now()
    for (const id of unknown) {
      if (!found.has(id)) cache.set(slotKey(lib, id), { missAt: now })
    }
  }
  const out = new Map<string, AssetPreviewEntry>()
  for (const id of unique) {
    const entry = readSlot(lib, id)
    if (entry) out.set(id, entry)
  }
  return out
}

/** 素材缺 previewUrl 且 src 是 asset:// 时,用缓存命中项补上(同步,不发请求)。 */
export function withCachedAssetPreview(m: VideoWorkbenchMaterial): VideoWorkbenchMaterial {
  if (m.previewUrl) return m
  const assetId = extractAssetId(m.src)
  if (!assetId) return m
  const entry = getCachedAssetPreview(assetId)
  if (!entry?.previewUrl) return m
  return { ...m, previewUrl: entry.previewUrl }
}

/** asset:// 素材的原始媒体地址(预览弹窗看大图 / 放视频用);没有就回 undefined。 */
export function cachedAssetSourceUrl(m: VideoWorkbenchMaterial): string | undefined {
  const assetId = extractAssetId(m.src)
  if (!assetId) return undefined
  return getCachedAssetPreview(assetId)?.sourceUrl
}

const REF_KEYS = ['referenceImages', 'referenceVideos', 'referenceAudios'] as const

/**
 * 取一条素材条目里待解析的 assetId。字符串形态直接看协议;对象形态只在
 * **缺 previewUrl** 时才需要解析 —— 导出 IR 的素材是 `{name, src}`(previewUrl
 * 是展示层数据,刻意不进 IR),apply 回来时得在这里补上,否则缩略图又一片空。
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
 * Material(字符串与 `{name, src}` 对象两种形态都收,store.toMaterial 也认)。
 * 全部任务的 asset id 收集后只走一次批量解析;查不到/接口失败保持原样
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
        if (!id || !asset) return entry
        const existing = typeof entry === 'object' && entry ? (entry as VideoWorkbenchMaterial) : null
        // 视频 / 音频的素材库条目没有图片缩略图,但名字仍值得补上 —— 否则卡上只剩
        // 「素材库 asset-2026…」这种占位名,用户分不清谁是谁。
        if (!asset.previewUrl && !asset.name) return entry
        keyChanged = true
        const material: VideoWorkbenchMaterial = {
          name: existing?.name || asset.name || `素材库 ${id.slice(0, 12)}…`,
          src: existing ? existing.src : (entry as string),
          ...(asset.previewUrl ? { previewUrl: asset.previewUrl } : {}),
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
  scanInflight.clear()
}
