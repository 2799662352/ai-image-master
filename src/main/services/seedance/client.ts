// Seedance Ark 协议 HTTP 客户端（主进程，net.fetch 免 CORS）。
// ⚠️ 鉴权只走 `Authorization: Bearer`（文档 1.3/2.6/3.4 的 Ark 路径）；
// 文档里 Node.js/Python 的 X-API-Key + HMAC 示例属于另一条 /api/open/v1
// 协议，与本客户端无关，勿混用。

import { net } from 'electron'
import type { SeedanceCreateTaskBody, SeedanceTaskStatus } from './types'
import { getSeedanceBaseUrl, SEEDANCE_REGION_BASE_URLS } from './region'

/** @deprecated 使用 getSeedanceBaseUrl()；保留别名以免旧导入断裂。默认海外 GLOBAL。 */
export const SEEDANCE_BASE_URL = SEEDANCE_REGION_BASE_URLS.global
export { getSeedanceBaseUrl, SEEDANCE_REGION_BASE_URLS }

// 创建任务走 Ark 推荐新路径（文档 2.0）：异步受理成功返回 **200 OK**。
// 旧路径 `/api/v3/contents/generations/tasks`（返回 202 Accepted）仍兼容，但官方
// 推荐迁到 /ark/tasks；arkRequest 把所有 2xx 当成功，故 200/202 都正常解析。
const CREATE_TASK_PATH = '/api/v3/contents/generations/ark/tasks'
// 查询沿用 `/api/v3/contents/generations/tasks/{taskId}`（文档 3 查询地址一，仍有效）。
const QUERY_TASK_PATH = '/api/v3/contents/generations/tasks'

export interface SeedanceQueryResult {
  id: string
  status: SeedanceTaskStatus
  content?: { video_url?: string }
  usage?: { completion_tokens?: number; total_tokens?: number }
  /** 上游实际使用的随机种子（文档 3.1;含随机 seed 的最终值,可复现）。 */
  seed?: number
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

/**
 * 单次 Ark HTTP 请求的硬超时。createTask/queryTask 都是轻量 JSON 接口，正常 <2s；
 * 之前完全没超时——代理/上游 TCP 半开时 `net.fetch` 会永远悬挂，generate_video
 * 只能靠 codex 的 2000s 工具超时兜底(用户视角=turn 卡死半小时)。超时后:
 * queryTask 由 pollLoop 的 catch 容忍并在下一轮重试;createTask 抛给 submit →
 * announceFailed,用户立刻看到失败卡片而不是无限转圈。
 */
export const ARK_REQUEST_TIMEOUT_MS = 30_000

async function arkRequest<T>(url: string, apiKey: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ARK_REQUEST_TIMEOUT_MS)
  timer.unref?.()
  let res: Awaited<ReturnType<typeof net.fetch>>
  let text: string
  try {
    res = await net.fetch(url, {
      ...init,
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    text = await res.text()
  } catch (e) {
    if (controller.signal.aborted) {
      throw new Error(`Seedance API request timed out after ${Math.round(ARK_REQUEST_TIMEOUT_MS / 1000)}s`)
    }
    throw e
  } finally {
    clearTimeout(timer)
  }
  let json: (ArkEnvelope<T> & Partial<T>) | null = null
  try {
    json = JSON.parse(text) as ArkEnvelope<T> & Partial<T>
  } catch {
    /* 非 JSON 响应，走下面的统一报错 */
  }
  // VVDance/Ark 的成功响应形状不一致：标准 Ark 路径是 `{ success, data: {...} }`，
  // 但 VVDance 的创建/查询接口（尤其 HTTP 202 Accepted —— 任务已受理、在后台跑）
  // 会直接返回**扁平 body**（任务字段在顶层、无 data 包裹），例如
  // `{ id, task_id, status:"running", created_at }`。
  // 2026-06-18 实测根因：旧逻辑用 `!json.data` 当失败条件，把「202 + 扁平 body」
  // 误判成失败 → createTask 抛 "Seedance API 202" → submit() 在登记任务前就抛错
  // → 本地任务表里没有这个 taskId → check_video_task 返回 unknown → agent 误判
  // 「不可用」并重复提交（堆出多个进行中任务、烧钱）。
  // 修正：HTTP 2xx + 可解析 JSON + 未显式 success:false 即视为成功；payload 优先取
  // `data` 包裹，缺省回退顶层 json，兼容「包裹」与「扁平」两种形状。只有 4xx/5xx
  // 或显式 success:false 才算失败。
  if (!res.ok || !json || json.success === false) {
    const detail =
      json?.error?.message || json?.message || text.slice(0, 300) || res.statusText
    const code = json?.error?.code ? `[${json.error.code}] ` : ''
    throw new Error(`Seedance API ${res.status}: ${code}${detail}`)
  }
  return (json.data ?? (json as unknown as T))
}

export const seedanceClient: SeedanceClient = {
  async createTask(body, apiKey) {
    // 扁平 200/202 body 把任务 id 放在顶层 `id`/`task_id`（二者通常同值）；包裹响应放在
    // `data.id`。arkRequest 已统一回退到顶层 json，这里再兼容 task_id 别名。
    const data = await arkRequest<{ id?: string; task_id?: string; status?: SeedanceTaskStatus }>(
      `${getSeedanceBaseUrl()}${CREATE_TASK_PATH}`,
      apiKey,
      { method: 'POST', body: JSON.stringify(body) },
    )
    const id = data.id ?? data.task_id
    if (!id) throw new Error('Seedance API: create response missing task id')
    return { id }
  },

  async queryTask(taskId, apiKey) {
    return arkRequest<SeedanceQueryResult>(
      `${getSeedanceBaseUrl()}${QUERY_TASK_PATH}/${encodeURIComponent(taskId)}`,
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
