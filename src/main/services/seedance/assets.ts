// Seedance 素材库（人像库）客户端 —— /api/open/v1/local-assets 协议。
// ⚠️ 这组接口与 Ark 任务协议鉴权不同：用 `X-API-Key + X-Timestamp + X-Signature`
// HMAC-SHA256 签名（需要 API Secret），不是 Bearer。
// 签名规则（文档 2.2 Node.js 示例 / 4.2.2）：
//   canonical = [method, path, timestamp, sha256(bodyText)].join('\n')
//   signature = hmacSha256(apiSecret, canonical)
// GET 请求 bodyText 为空串；带 query 时仍只签路径本身。

import { net } from 'electron'
import crypto from 'node:crypto'
import type {
  SeedanceAssetCapacity,
  SeedanceAssetDeleteResult,
  SeedanceAssetImportInput,
  SeedanceAssetImportResult,
  SeedanceAssetItem,
  SeedanceAssetKindFilter,
  SeedanceAssetListQuery,
  SeedanceAssetListResult,
  SeedanceOfficialMaterialsQuery,
  SeedanceOfficialMaterialsResult,
} from '../../../types/seedance'
import type { SeedanceContentItem } from './types'
import { getSeedanceBaseUrl } from './client'
import { getSeedanceRegion } from './region'

const ASSETS_PATH = '/api/open/v1/local-assets'
const OFFICIAL_MATERIALS_PATH = '/api/open/v1/official-materials'

export interface SeedanceAssetCredentials {
  apiKey: string
  apiSecret: string
}

export function signAssetRequest(
  method: string,
  requestPath: string,
  bodyText: string,
  apiSecret: string,
  timestamp = String(Date.now()),
): { timestamp: string; signature: string } {
  const bodySha = crypto.createHash('sha256').update(bodyText).digest('hex')
  const canonical = [method, requestPath, timestamp, bodySha].join('\n')
  const signature = crypto.createHmac('sha256', apiSecret).update(canonical).digest('hex')
  return { timestamp, signature }
}

async function openApiRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  requestPath: string,
  query: string,
  body: unknown,
  creds: SeedanceAssetCredentials,
): Promise<T> {
  if (!creds.apiKey) throw new Error('Seedance assets: API Key 未配置')
  if (!creds.apiSecret) throw new Error('Seedance assets: API Secret 未配置（素材库接口需要签名）')
  // 签名只签**路径**（含 /capacity 这类子路径），永远不含 query string（文档 4.2.2/5.1）。
  // GET 签空 body；POST/DELETE 签 JSON body（批量删除把 assetIds 放在 DELETE 的 body 里）。
  const bodyText = method === 'GET' ? '' : JSON.stringify(body ?? {})
  const { timestamp, signature } = signAssetRequest(method, requestPath, bodyText, creds.apiSecret)
  const res = await net.fetch(`${getSeedanceBaseUrl()}${requestPath}${query}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': creds.apiKey,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    body: method === 'GET' ? undefined : bodyText,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应走统一报错 */
  }
  // 部分部署把 data 字段再 JSON.stringify 了一层（`{"success":true,"data":"{...}"}`），
  // 导致下游 extractAsset 解不出 assetId、明明导入成功却报失败。这里统一解开。
  if (json && typeof json === 'object') {
    const obj = json as Record<string, unknown>
    if (typeof obj.data === 'string') {
      try {
        const inner: unknown = JSON.parse(obj.data)
        if (inner && typeof inner === 'object') obj.data = inner
      } catch {
        /* data 不是 JSON 字符串则保留原样 */
      }
    }
  }
  if (!res.ok || json == null) {
    const detail =
      (json as { error?: { message?: string }; message?: string } | null)?.error?.message ||
      (json as { message?: string } | null)?.message ||
      text.slice(0, 300) ||
      res.statusText
    throw new Error(`Seedance assets API ${res.status}: ${detail}`)
  }
  return json as T
}

/** local-assets 请求（旧调用面:subPath 相对 ASSETS_PATH）。 */
function assetRequest<T>(
  method: 'GET' | 'POST' | 'DELETE',
  subPath: string,
  query: string,
  body: unknown,
  creds: SeedanceAssetCredentials,
): Promise<T> {
  return openApiRequest<T>(method, `${ASSETS_PATH}${subPath}`, query, body, creds)
}

/**
 * 从导入/列表响应里提取 asset 记录。
 * 上游文档口径是 `{ duplicated, asset: {...} }`，但实际部署可能包一层
 * `data`，或把字段平铺在顶层，这里做宽容解析；assetUrl 缺失时由 assetId 拼出。
 * `viaIdFallback=true` 表示响应里没有真 assetId/assetUrl，用内部行 `id`
 * (dla-xxx 形态)兜底 —— 这种 id **不可直接引用**（提交任务会被上游
 * 400 LOCAL_ASSET_NOT_FOUND 拒掉），调用方需再走 list 二次解析。
 */
function extractAsset(raw: unknown): { asset: SeedanceAssetItem; viaIdFallback: boolean } | null {
  const root = raw as Record<string, unknown> | null
  if (!root) return null
  const candidates = [
    root.asset,
    (root.data as Record<string, unknown> | undefined)?.asset,
    root.data,
    root,
  ]
  for (const candidate of candidates) {
    const a = candidate as Record<string, unknown> | undefined
    if (!a || typeof a !== 'object') continue
    // 线上导入接口实测只回 `id`（如 dla-xxx），没有 assetId/assetUrl 字段，
    // 依次兜底:assetId → asset_id → 从 assetUrl 反推 → id（必须像素材记录,有 kind/name 才认）。
    const rawUrl = (a.assetUrl ?? a.asset_url) as string | undefined
    const directId =
      ((a.assetId ?? a.asset_id) as string | undefined) ||
      (rawUrl?.startsWith('asset://') ? rawUrl.slice('asset://'.length) : undefined)
    const fallbackId = typeof a.id === 'string' && (a.kind || a.name) ? a.id : undefined
    const assetId = directId || fallbackId
    if (!assetId) continue
    const assetUrl = rawUrl || `asset://${assetId}`
    return {
      asset: { ...(a as unknown as SeedanceAssetItem), assetId, assetUrl },
      viaIdFallback: !directId,
    }
  }
  return null
}

/**
 * 导入响应只回内部行 id 时，追加一次 list 匹配出真实 assetId/assetUrl。
 * 匹配优先级:内部 `id` 相同 → `name` 相同(导入名含时间戳基本唯一)。
 * 找不到/list 失败时返回 null，调用方保留 id 兜底（不阻断导入）。
 */
async function resolveAssetViaList(
  rowId: string,
  input: SeedanceAssetImportInput,
  creds: SeedanceAssetCredentials,
): Promise<SeedanceAssetItem | null> {
  // list 的 kind 过滤项没有裸 'image'——图片按 imageCategory 过滤,缺省不过滤。
  const kind: SeedanceAssetKindFilter | undefined =
    input.kind === 'image' ? input.imageCategory : input.kind
  try {
    const { items } = await listSeedanceAssets(
      { page: 1, pageSize: 50, ...(kind ? { kind } : {}) },
      creds,
    )
    const usable = (it: SeedanceAssetItem): boolean =>
      typeof it.assetId === 'string' && !!it.assetId && it.assetId !== rowId
    const hit =
      items.find((it) => it.id === rowId && usable(it)) ??
      (input.name ? items.find((it) => it.name === input.name && usable(it)) : undefined)
    if (hit) {
      return { ...hit, assetUrl: hit.assetUrl || `asset://${hit.assetId}` }
    }
  } catch (e) {
    console.warn('[seedance/assets] import 后 list 二次解析 assetId 失败(保留 id 兜底):', e)
  }
  return null
}

/** 导入素材（图片默认走人像分类由调用方决定）。内容重复时上游直接返回已有记录。 */
export async function importSeedanceAsset(
  input: SeedanceAssetImportInput,
  creds: SeedanceAssetCredentials,
): Promise<SeedanceAssetImportResult> {
  const result = await assetRequest<{ duplicated?: boolean; data?: { duplicated?: boolean } }>(
    'POST',
    '',
    '',
    input,
    creds,
  )
  const extracted = extractAsset(result)
  if (!extracted) {
    const snippet = JSON.stringify(result).slice(0, 400)
    throw new Error(`Seedance assets: import response missing assetId/assetUrl, got: ${snippet}`)
  }
  let asset = extracted.asset
  let referenceable = !extracted.viaIdFallback
  // 兜底出的 dla-xxx 行 id 不是可引用的 assetId(直接引用会 400
  // LOCAL_ASSET_NOT_FOUND)——追加 list 找同 id/同 name 条目换成真 assetId/assetUrl。
  if (extracted.viaIdFallback) {
    const resolved = await resolveAssetViaList(asset.assetId, input, creds)
    if (resolved) {
      asset = resolved
      referenceable = true
    }
  }
  return { duplicated: !!(result.duplicated ?? result.data?.duplicated), asset, referenceable }
}

/** 拉取素材列表（默认人像分类由调用方传 kind）。 */
export async function listSeedanceAssets(
  query: SeedanceAssetListQuery,
  creds: SeedanceAssetCredentials,
): Promise<SeedanceAssetListResult> {
  const params = new URLSearchParams()
  if (query.page) params.set('page', String(query.page))
  if (query.pageSize) params.set('pageSize', String(query.pageSize))
  if (query.q) params.set('q', query.q)
  if (query.kind) params.set('kind', query.kind)
  const qs = params.size > 0 ? `?${params.toString()}` : ''
  const raw = await assetRequest<Partial<SeedanceAssetListResult> & { data?: Partial<SeedanceAssetListResult> }>(
    'GET',
    '',
    qs,
    undefined,
    creds,
  )
  // 兼容 `data` 包裹一层的部署
  const result = !Array.isArray(raw.items) && Array.isArray(raw.data?.items) ? raw.data! : raw
  return {
    items: Array.isArray(result.items) ? result.items : [],
    total: result.total ?? 0,
    page: result.page ?? query.page ?? 1,
    pageSize: result.pageSize ?? query.pageSize ?? 12,
    totalPages: result.totalPages ?? 1,
    summary: result.summary,
  }
}

// ==================== 提交前 asset:// 引用校验 ====================

/** 引用校验的分页扫描参数:pageSize 取上游允许的大页,页数设上限防大库拖死提交。 */
const ASSET_REF_SCAN_PAGE_SIZE = 50
const ASSET_REF_SCAN_MAX_PAGES = 10

function seedanceRegionLabel(): string {
  return getSeedanceRegion() === 'cn' ? '国内' : '海外 GLOBAL'
}

/** 从 content[] 里收集 asset:// 引用的 id（去重）。 */
export function extractAssetReferenceIds(content: SeedanceContentItem[]): string[] {
  const ids = new Set<string>()
  for (const item of content) {
    const url =
      item.type === 'image_url'
        ? item.image_url.url
        : item.type === 'video_url'
          ? item.video_url.url
          : item.type === 'audio_url'
            ? item.audio_url.url
            : null
    if (url?.startsWith('asset://')) ids.add(url.slice('asset://'.length))
  }
  return [...ids]
}

function missingAssetReferencesMessage(ids: string[]): string {
  const refs = ids.map((id) => `asset://${id}`).join('、')
  return (
    `引用的素材在当前站点(${seedanceRegionLabel()})不存在:${refs}。` +
    '素材是按「海外/国内」站点隔离的,可能是导入素材后切换了站点 —— ' +
    '请切回原站点,或重新从人像库选择素材后再生成。'
  )
}

/**
 * 提交生成任务前的防线:核对 content 里的 asset:// 引用在**当前站点**的
 * 素材列表里真实存在,不存在则以清晰中文报错拦下(而非把上游裸 400
 * LOCAL_ASSET_NOT_FOUND 抛给用户)。校验只在能**确认**缺失时才拦:
 * - list 调用失败 → 放行(fail-open,校验是防线不是闸门);
 * - 库太大扫描页数达到上限仍未扫完 → 放行(无法确认);
 * - 全库扫完仍未命中 → 抛中文错误。
 */
export async function verifyContentAssetReferences(
  content: SeedanceContentItem[],
  creds: SeedanceAssetCredentials,
): Promise<void> {
  const pending = new Set(extractAssetReferenceIds(content))
  if (pending.size === 0) return
  if (!creds.apiKey || !creds.apiSecret) return
  for (let page = 1; page <= ASSET_REF_SCAN_MAX_PAGES; page++) {
    let res: SeedanceAssetListResult
    try {
      res = await listSeedanceAssets({ page, pageSize: ASSET_REF_SCAN_PAGE_SIZE }, creds)
    } catch (e) {
      console.warn('[seedance/assets] 提交前引用校验 list 失败,放行交由上游判定:', e)
      return
    }
    for (const it of res.items) {
      // assetId / 内部行 id / assetUrl 反推形态都认——校验宁松勿紧,误拦比漏拦更伤。
      if (typeof it.assetId === 'string') pending.delete(it.assetId)
      if (typeof it.id === 'string') pending.delete(it.id)
      if (typeof it.assetUrl === 'string' && it.assetUrl.startsWith('asset://')) {
        pending.delete(it.assetUrl.slice('asset://'.length))
      }
    }
    if (pending.size === 0) return
    if (page >= (res.totalPages || 1)) {
      throw new Error(missingAssetReferencesMessage([...pending]))
    }
  }
  // 扫描页数达上限仍没扫完全库:无法确认缺失,放行。
}

/**
 * 把上游创建任务的裸错误翻译成人话(目前只映射 LOCAL_ASSET_NOT_FOUND ——
 * 典型场景是导入素材后切换「海外/国内」站点,素材按站点隔离必然找不到)。
 * 未识别的错误原样返回。
 */
export function translateSeedanceTaskError(message: string): string {
  if (message.includes('LOCAL_ASSET_NOT_FOUND')) {
    const refs = message.match(/asset:\/\/[\w-]+/g) ?? []
    const refText = refs.length > 0 ? `:${refs.join('、')}` : ''
    return (
      `引用的素材在当前站点(${seedanceRegionLabel()})不存在${refText}。` +
      '素材是按「海外/国内」站点隔离的,可能是导入素材后切换了站点 —— ' +
      '请切回原站点,或重新从人像库选择素材后再生成。'
    )
  }
  return message
}

/**
 * 查询素材额度（文档 4.2.3）。GET /api/open/v1/local-assets/capacity，
 * 返回 `{ used, limit, remaining }`。导入前可先查剩余额度。
 * 兼容 `data` 包裹一层的部署，字段缺省回退 0。
 */
export async function getSeedanceAssetCapacity(
  creds: SeedanceAssetCredentials,
): Promise<SeedanceAssetCapacity> {
  const raw = await assetRequest<Partial<SeedanceAssetCapacity> & { data?: Partial<SeedanceAssetCapacity> }>(
    'GET',
    '/capacity',
    '',
    undefined,
    creds,
  )
  const hasNum = (o?: Partial<SeedanceAssetCapacity>): boolean =>
    !!o && (typeof o.used === 'number' || typeof o.limit === 'number' || typeof o.remaining === 'number')
  const c = !hasNum(raw) && hasNum(raw.data) ? raw.data! : raw
  return {
    used: c.used ?? 0,
    limit: c.limit ?? 0,
    remaining: c.remaining ?? 0,
  }
}

/**
 * 按 assetId 批量删除素材（文档 4.2.4）。DELETE /api/open/v1/local-assets，
 * body 直接传 `{ assetIds: [...] }`。单次最多 100 个；上游只删属于当前
 * 开发者的素材。兼容 `data` 包裹一层；缺 deletedCount 时按 items 长度兜底。
 */
export async function deleteSeedanceAssets(
  assetIds: string[],
  creds: SeedanceAssetCredentials,
): Promise<SeedanceAssetDeleteResult> {
  const ids = Array.isArray(assetIds) ? assetIds.filter((id) => typeof id === 'string' && id.trim()) : []
  if (ids.length === 0) throw new Error('Seedance assets: deleteSeedanceAssets 需要至少一个 assetId')
  if (ids.length > 100) throw new Error('Seedance assets: 单次最多删除 100 个素材')
  const raw = await assetRequest<Partial<SeedanceAssetDeleteResult> & { data?: Partial<SeedanceAssetDeleteResult> }>(
    'DELETE',
    '',
    '',
    { assetIds: ids },
    creds,
  )
  const r =
    raw.data && (typeof raw.data.deletedCount === 'number' || Array.isArray(raw.data.items)) ? raw.data : raw
  const items = Array.isArray(r.items) ? r.items : []
  return {
    deletedCount: typeof r.deletedCount === 'number' ? r.deletedCount : items.length,
    items,
    summary: r.summary,
  }
}

/**
 * 查询平台官方素材/虚拟人像（文档 5）。只读列表,不写入开发者素材库;
 * 引用时直接用返回条目的 assetUrl（https 地址,非 asset://）。
 * 兼容 `data` 包裹一层的部署。
 */
export async function listSeedanceOfficialMaterials(
  query: SeedanceOfficialMaterialsQuery,
  creds: SeedanceAssetCredentials,
): Promise<SeedanceOfficialMaterialsResult> {
  const params = new URLSearchParams()
  params.set('library', query.library ?? 'materials')
  if (query.page) params.set('page', String(query.page))
  if (query.pageSize) params.set('pageSize', String(query.pageSize))
  if (query.q) params.set('q', query.q)
  if (query.kind) params.set('kind', query.kind)
  if (query.gender) params.set('gender', query.gender)
  if (query.country) params.set('country', query.country)
  const raw = await openApiRequest<
    Partial<SeedanceOfficialMaterialsResult> & { data?: Partial<SeedanceOfficialMaterialsResult> }
  >('GET', OFFICIAL_MATERIALS_PATH, `?${params.toString()}`, undefined, creds)
  const result = !Array.isArray(raw.items) && Array.isArray(raw.data?.items) ? raw.data! : raw
  return {
    items: Array.isArray(result.items) ? result.items : [],
    total: result.total ?? 0,
    page: result.page ?? query.page ?? 1,
    pageSize: result.pageSize ?? query.pageSize ?? 12,
    totalPages: result.totalPages ?? 1,
  }
}
