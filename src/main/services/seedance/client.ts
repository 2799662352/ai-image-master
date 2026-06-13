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
    // ⚠️ 必须用 net.request 而非 net.fetch:上游视频代理会在响应头里塞
    // prompt 派生的中文文件名(如 Content-Disposition: filename="做自然回归…mp4"),
    // net.fetch 用 undici 的 Headers(Web 标准,要求 Latin1 ByteString)重建响应头,
    // 遇到 >255 的中文字节直接抛 TypeError;该异常发生在 Electron 内部的 response
    // 回调里 → 变 uncaughtException 被全局吞掉,而 fetch 的 Promise 永不 settle,
    // persistence 卡死在「文件仍在后台保存中…」(2026-06-13 实测,字符 '自'=33258)。
    // net.request 的 response.headers 是 Chromium 侧普通对象,不过 undici 校验,绕开此坑。
    // 单次 120s 超时 + 重试一次;两次都失败抛错 → persistence=failed。
    let lastError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        return await downloadViaNetRequest(videoUrl, 120_000)
      } catch (e) {
        lastError = e
        console.warn(`[seedance] downloadVideo attempt ${attempt + 1} failed:`, e)
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  },
}

/**
 * 用 net.request 流式下载二进制,带主动超时(到时 abort 请求)。
 * 不读取/不重建响应头,彻底规避 net.fetch 的 undici ByteString 兼容问题。
 */
function downloadViaNetRequest(url: string, timeoutMs: number): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const request = net.request(url)
    const chunks: Buffer[] = []
    let settled = false
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        request.abort()
      } catch {
        /* noop */
      }
      reject(new Error(`video download timed out after ${Math.round(timeoutMs / 1000)}s`))
    }, timeoutMs)
    timer.unref?.()
    const done = (run: () => void): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      run()
    }
    request.on('response', (response) => {
      const status = response.statusCode ?? 0
      if (status < 200 || status >= 300) {
        response.on('data', () => {})
        response.on('end', () => done(() => reject(new Error(`video download failed: HTTP ${status}`))))
        response.on('error', (e: Error) => done(() => reject(e)))
        return
      }
      response.on('data', (chunk: Buffer) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => done(() => resolve(Buffer.concat(chunks))))
      response.on('error', (e: Error) => done(() => reject(e)))
    })
    request.on('error', (e: Error) => done(() => reject(e)))
    request.on('abort', () => done(() => reject(new Error('video download aborted'))))
    request.end()
  })
}
