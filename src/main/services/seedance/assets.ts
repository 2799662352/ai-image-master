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
  SeedanceAssetImportInput,
  SeedanceAssetImportResult,
  SeedanceAssetItem,
  SeedanceAssetListQuery,
  SeedanceAssetListResult,
} from '../../../types/seedance'
import { SEEDANCE_BASE_URL } from './client'

const ASSETS_PATH = '/api/open/v1/local-assets'

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

async function assetRequest<T>(
  method: 'GET' | 'POST',
  query: string,
  body: unknown,
  creds: SeedanceAssetCredentials,
): Promise<T> {
  if (!creds.apiKey) throw new Error('Seedance assets: API Key 未配置')
  if (!creds.apiSecret) throw new Error('Seedance assets: API Secret 未配置（素材库接口需要签名）')
  const bodyText = method === 'POST' ? JSON.stringify(body) : ''
  const { timestamp, signature } = signAssetRequest(method, ASSETS_PATH, bodyText, creds.apiSecret)
  const res = await net.fetch(`${SEEDANCE_BASE_URL}${ASSETS_PATH}${query}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      'X-API-Key': creds.apiKey,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    body: method === 'POST' ? bodyText : undefined,
  })
  const text = await res.text()
  let json: unknown = null
  try {
    json = JSON.parse(text)
  } catch {
    /* 非 JSON 响应走统一报错 */
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

/** 导入素材（图片默认走人像分类由调用方决定）。内容重复时上游直接返回已有记录。 */
export async function importSeedanceAsset(
  input: SeedanceAssetImportInput,
  creds: SeedanceAssetCredentials,
): Promise<SeedanceAssetImportResult> {
  const result = await assetRequest<{ duplicated?: boolean; asset?: SeedanceAssetItem }>(
    'POST',
    '',
    input,
    creds,
  )
  if (!result.asset?.assetId || !result.asset.assetUrl) {
    throw new Error('Seedance assets: import response missing assetId/assetUrl')
  }
  return { duplicated: !!result.duplicated, asset: result.asset }
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
  const result = await assetRequest<Partial<SeedanceAssetListResult>>('GET', qs, undefined, creds)
  return {
    items: Array.isArray(result.items) ? result.items : [],
    total: result.total ?? 0,
    page: result.page ?? query.page ?? 1,
    pageSize: result.pageSize ?? query.pageSize ?? 12,
    totalPages: result.totalPages ?? 1,
    summary: result.summary,
  }
}
