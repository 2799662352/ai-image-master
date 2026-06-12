// Seedance Ark 协议 HTTP 客户端（主进程，net.fetch 免 CORS）。
// ⚠️ 鉴权只走 `Authorization: Bearer`（文档 1.3/2.6/3.4 的 Ark 路径）；
// 文档里 Node.js/Python 的 X-API-Key + HMAC 示例属于另一条 /api/open/v1
// 协议，与本客户端无关，勿混用。

import { net } from 'electron'
import type { SeedanceCreateTaskBody, SeedanceTaskStatus } from './types'

export const SEEDANCE_BASE_URL = 'https://vvdance.yongmuai.com'
const TASKS_PATH = '/api/v3/contents/generations/tasks'

export interface SeedanceQueryResult {
  id: string
  status: SeedanceTaskStatus
  content?: { video_url?: string }
  usage?: { completion_tokens?: number; total_tokens?: number }
  error?: { code?: string; message?: string }
}

export interface SeedanceClient {
  createTask: (body: SeedanceCreateTaskBody, apiKey: string) => Promise<{ id: string }>
  queryTask: (taskId: string, apiKey: string) => Promise<SeedanceQueryResult>
  downloadVideo: (videoUrl: string) => Promise<Buffer>
}

interface ArkEnvelope<T> {
  success?: boolean
  data?: T
  error?: { code?: string; message?: string }
  message?: string
}

async function arkRequest<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  const res = await net.fetch(url, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      ...(init?.headers as Record<string, string> | undefined),
    },
  })
  const text = await res.text()
  let json: ArkEnvelope<T> | null = null
  try {
    json = JSON.parse(text) as ArkEnvelope<T>
  } catch {
    /* 非 JSON 响应，走下面的统一报错 */
  }
  if (!res.ok || !json || json.success === false || !json.data) {
    const detail =
      json?.error?.message || json?.message || text.slice(0, 300) || res.statusText
    const code = json?.error?.code ? `[${json.error.code}] ` : ''
    throw new Error(`Seedance API ${res.status}: ${code}${detail}`)
  }
  return json.data
}

export const seedanceClient: SeedanceClient = {
  async createTask(body, apiKey) {
    const data = await arkRequest<{ id: string; status?: SeedanceTaskStatus }>(
      `${SEEDANCE_BASE_URL}${TASKS_PATH}`,
      apiKey,
      { method: 'POST', body: JSON.stringify(body) },
    )
    if (!data.id) throw new Error('Seedance API: create response missing task id')
    return { id: data.id }
  },

  async queryTask(taskId, apiKey) {
    return arkRequest<SeedanceQueryResult>(
      `${SEEDANCE_BASE_URL}${TASKS_PATH}/${encodeURIComponent(taskId)}`,
      apiKey,
      { method: 'GET' },
    )
  },

  async downloadVideo(videoUrl) {
    const res = await net.fetch(videoUrl)
    if (!res.ok) throw new Error(`video download failed: HTTP ${res.status}`)
    return Buffer.from(await res.arrayBuffer())
  },
}
