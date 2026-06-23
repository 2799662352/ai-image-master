// qwen 理解工具（视频 / 文档 / 联网扒资料）。默认 qwen3.7-max(更强)、
// 可经 model="plus" 切到更便宜的 qwen3.7-plus;渲染层 understand() 还会在 max 失败时
// 自动用 plus 兜底。
//
// 与 imageTools/videoTools 同款薄层模式:main 端只做参数透传 + banner 包装,
// 实际模型调用在渲染层 AgentToolExecutor.callUnderstand → ApiService.understand()
// （复用出图同一条 new-api 链路 + 同一 Miau 令牌）。
//
// 设计要点:
// - 媒体最终只接受公网可达 URL(qwen 上游限制),但 main 端会自动兜底:
//   * http(s) URL → 原样透传;
//   * data: URL    → 中转到历史 COS 桶换公网 URL;
//   * 本机 *_path  → 读取字节后中转到历史 COS 桶(image-history/media-relay/*)
//     换公网 URL,再交给渲染层。复用出图历史同一条 COS 上传链路(mediaRelay)。
// - 音频不原生支持:skill「catimation-understand」指导先 ffmpeg 转 MP4 再走
//   understand_video。
// - 联网用 web_research(渲染层置 enable_search:true)。
// - 健壮性:渲染层 understand() 已把 502/非 JSON 映射成 {success:false,error};
//   这里再兜一层 try/catch,任何异常都回成 textResult 而非抛出。

import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { relayBufferToCos, relayDataUrlToCos } from '../../services/tencent/mediaRelay'

/** 与 imageTools/videoTools 一致的 codex threadId 提取。 */
function extractCodexThreadId(ctx: unknown): string | undefined {
  const meta = (ctx as { mcpReq?: { _meta?: unknown } } | undefined)?.mcpReq?._meta as
    | { threadId?: unknown; ['x-codex-turn-metadata']?: { thread_id?: unknown; session_id?: unknown } }
    | undefined
  if (!meta) return undefined
  const direct = typeof meta.threadId === 'string' && meta.threadId.length > 0 ? meta.threadId : undefined
  const turn = meta['x-codex-turn-metadata']
  const fromTurn =
    typeof turn?.thread_id === 'string' && turn.thread_id.length > 0
      ? turn.thread_id
      : typeof turn?.session_id === 'string' && turn.session_id.length > 0
        ? turn.session_id
        : undefined
  return direct ?? fromTurn
}

type UnderstandResult = { success: true; text: string } | { success: false; error: string }

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

/** 把渲染层 understand() 的结构体包成模型可读的 banner。 */
function formatResult(tool: string, r: UnderstandResult): string {
  if (r.success) {
    return [`✅ ${tool} DONE.`, r.text, JSON.stringify({ ok: true })].join('\n')
  }
  return [`❌ ${tool} failed: ${r.error}`, JSON.stringify({ ok: false, error: r.error })].join('\n')
}

// ─── 本机文件 → 公网 URL(走历史 COS 桶)──────────────────────────────
// qwen 上游只接受公网可达 URL。我们不再让用户手动改传 URL,而是在 main 端
// (有文件系统访问)读取本机 *_path → 中转到历史 COS 桶 → 拿 https URL。

const MAX_RELAY_BYTES = 200 * 1024 * 1024 // 200MB:超过则提示压缩,避免一次性读爆内存

const EXT_MIME: Record<string, string> = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  // document / image
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
}

function mimeFromPath(p: string, kind: 'video' | 'document'): string {
  const ext = (p.split('?')[0]?.split('.').pop() ?? '').toLowerCase()
  return EXT_MIME[ext] ?? (kind === 'video' ? 'video/mp4' : 'application/octet-stream')
}

/**
 * 把一个媒体参数(*_url / *_path)归一成公网 URL:
 * - http(s) → 原样;data: → 中转 COS;本机路径 → 读字节后中转 COS。
 * 失败返回结构化 error(不抛)。
 */
async function resolveMediaUrl(
  params: Record<string, unknown>,
  kind: 'video' | 'document',
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const urlKey = kind === 'video' ? 'video_url' : 'file_url'
  const pathKey = kind === 'video' ? 'video_path' : 'file_path'

  const url = params[urlKey]
  if (typeof url === 'string' && /^https?:/i.test(url)) {
    return { ok: true, url }
  }
  if (typeof url === 'string' && url.startsWith('data:')) {
    try {
      return { ok: true, url: await relayDataUrlToCos(url) }
    } catch (e) {
      return { ok: false, error: `data: URL 中转 COS 失败:${e instanceof Error ? e.message : String(e)}` }
    }
  }

  const localPath = params[pathKey]
  if (typeof localPath === 'string' && localPath.length > 0) {
    try {
      const stat = await fs.stat(localPath)
      if (!stat.size) return { ok: false, error: `本机文件为空:${localPath}` }
      if (stat.size > MAX_RELAY_BYTES) {
        return {
          ok: false,
          error: `本机文件过大(${(stat.size / 1024 / 1024).toFixed(0)}MB,上限 200MB),请压缩后再试。`,
        }
      }
      const buf = await fs.readFile(localPath)
      const publicUrl = await relayBufferToCos(buf, mimeFromPath(localPath, kind))
      return { ok: true, url: publicUrl }
    } catch (e) {
      return {
        ok: false,
        error: `读取/上传本机文件失败(${localPath}):${e instanceof Error ? e.message : String(e)}`,
      }
    }
  }

  return { ok: false, error: `缺少 ${urlKey} 或 ${pathKey}。` }
}

async function runUnderstand(
  router: ToolRouter,
  tool: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let outParams = params
  if (tool === 'understand_video' || tool === 'understand_document') {
    const kind = tool === 'understand_video' ? 'video' : 'document'
    const media = await resolveMediaUrl(params, kind)
    if (!media.ok) {
      return textResult(formatResult(tool, { success: false, error: media.error }))
    }
    const urlKey = kind === 'video' ? 'video_url' : 'file_url'
    const pathKey = kind === 'video' ? 'video_path' : 'file_path'
    outParams = { ...params, [urlKey]: media.url }
    delete outParams[pathKey]
  }

  const threadId = extractCodexThreadId(ctx)
  try {
    const r = (await router.call(tool, outParams, threadId)) as UnderstandResult
    return textResult(formatResult(tool, r))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return textResult(formatResult(tool, { success: false, error: msg }))
  }
}

/**
 * 「理解画布上选中的视频」编排器:
 *  1) 问渲染层画布要选中(或唯一)的视频源 → get_selected_canvas_video;
 *  2) 把它的本机 assetPath / data: / http 归一成公网 URL(复用 resolveMediaUrl,
 *     本机路径自动中转历史 COS 桶);
 *  3) 走与 understand_video 同一条理解链路(max 默认、plus 兜底);
 *  4) 默认把理解结果以文字卡片写回画布(贴在该视频旁)→ add_canvas_note。
 * 全程不抛:任何一步失败都回成 textResult 错误。
 */
async function runUnderstandCanvasVideo(
  router: ToolRouter,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const tool = 'understand_canvas_video'
  const question = typeof params.question === 'string' ? params.question : ''
  if (!question) return textResult(formatResult(tool, { success: false, error: '缺少 question(你想了解画布视频的什么)。' }))
  const threadId = extractCodexThreadId(ctx)

  // 1) 画布侧暴露要理解的视频源(选中优先,否则唯一视频)。
  let sel: { ok?: boolean; error?: string; shapeId?: string; assetPath?: string | null; assetUrl?: string | null }
  try {
    sel = (await router.call('get_selected_canvas_video', {}, threadId)) as typeof sel
  } catch (e) {
    return textResult(formatResult(tool, { success: false, error: `读取画布选中视频失败:${e instanceof Error ? e.message : String(e)}` }))
  }
  if (!sel || sel.ok !== true || !sel.shapeId) {
    return textResult(formatResult(tool, { success: false, error: sel?.error ?? '没有可理解的画布视频。请先在画布上选中一个视频。' }))
  }

  // 2) 归一成公网 URL(本机路径 → COS;data: → COS;http → 透传)。
  const mediaParams: Record<string, unknown> = {}
  if (typeof sel.assetPath === 'string' && sel.assetPath) mediaParams.video_path = sel.assetPath
  else if (typeof sel.assetUrl === 'string' && sel.assetUrl) mediaParams.video_url = sel.assetUrl
  const media = await resolveMediaUrl(mediaParams, 'video')
  if (!media.ok) return textResult(formatResult(tool, { success: false, error: media.error }))

  // 3) 走 understand_video 同款理解链路。
  let r: UnderstandResult
  try {
    r = (await router.call('understand_video', { video_url: media.url, question, model: params.model }, threadId)) as UnderstandResult
  } catch (e) {
    return textResult(formatResult(tool, { success: false, error: e instanceof Error ? e.message : String(e) }))
  }

  // 4) 把结果以文字卡片写回画布(默认开;annotate=false 跳过)。
  let noteShapeId: string | undefined
  if (r.success && params.annotate !== false) {
    try {
      const note = (await router.call(
        'add_canvas_note',
        { text: r.text, nearShapeId: sel.shapeId, title: '视频理解', role: 'video_understanding' },
        threadId,
      )) as { ok?: boolean; shapeId?: string }
      if (note?.ok && typeof note.shapeId === 'string') noteShapeId = note.shapeId
    } catch {
      // 尽力而为:理解文本已返回给 agent,写画布失败不影响结果。
    }
  }

  const banner = formatResult(tool, r)
  return textResult(noteShapeId ? `${banner}\n(已写入画布文字卡片 ${noteShapeId})` : banner)
}

export function registerUnderstandTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'understand_video',
    {
      description:
        'Understand / analyze a VIDEO with qwen (画面/动作/字幕/剧情). Use for ANY ' +
        '"理解/分析这个视频" request. Pass either a public video_url OR a local video_path — a local ' +
        'path is auto-uploaded to the history COS bucket to obtain a public URL (≤200MB). ' +
        'AUDIO is NOT natively supported: to "understand" an audio file, first convert it to MP4 ' +
        '(ffmpeg-win skill: audio track + placeholder/​waveform video) and pass that MP4 here. ' +
        'Model defaults to qwen3.7-max (stronger); pass model="plus" for the cheaper qwen3.7-plus. ' +
        'Returns a Chinese description. Do NOT retry on a clean result.',
      inputSchema: z.object({
        video_url: z.string().optional().describe('Public http(s) URL of the video (preferred when you already have one).'),
        video_path: z.string().optional().describe('Local file path — auto-uploaded to COS (image-history/media-relay/*) to get a public URL.'),
        question: z.string().min(1).describe('What you want to know about the video.'),
        fps: z.number().int().positive().optional().describe('Optional sampling fps hint (reserved; not yet sent upstream).'),
        model: z.enum(['max', 'plus']).optional().describe('Model: "max" (default, stronger) or "plus" (cheaper). Omit for max.'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'understand_video', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'understand_document',
    {
      description:
        'Understand / read a DOCUMENT (PDF/图文页) with qwen. Pass either file_url ' +
        '(public URL) OR a local file_path — a local path is auto-uploaded to the history COS bucket ' +
        'to get a public URL (≤200MB). NOTE: native document understanding is only PARTIAL upstream — ' +
        'for best results render the page(s) to image(s) and pass an image, or extract text and ask ' +
        'normally. Model defaults to qwen3.7-max (stronger); pass model="plus" for the cheaper model. ' +
        'Returns a Chinese answer.',
      inputSchema: z.object({
        file_url: z.string().optional().describe('Public http(s) URL of the document/page image (preferred when you already have one).'),
        file_path: z.string().optional().describe('Local file path — auto-uploaded to COS (image-history/media-relay/*) to get a public URL.'),
        question: z.string().min(1).describe('What you want to know from the document.'),
        model: z.enum(['max', 'plus']).optional().describe('Model: "max" (default, stronger) or "plus" (cheaper). Omit for max.'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'understand_document', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'web_research',
    {
      description:
        'Search the web / 上网扒资料 with qwen (enable_search). Use for "上网查/查一下/' +
        '搜一下/最新消息" requests. Pass a natural-language query; returns a synthesized answer that ' +
        'incorporates live web results. Model defaults to qwen3.7-max (stronger); pass model="plus" ' +
        'for the cheaper model. Prefer this over guessing from stale memory.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Natural-language research query.'),
        model: z.enum(['max', 'plus']).optional().describe('Model: "max" (default, stronger) or "plus" (cheaper). Omit for max.'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'web_research', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'understand_canvas_video',
    {
      description:
        'Understand / analyze the VIDEO currently SELECTED on the canvas (or the only video on the canvas if ' +
        'nothing is selected) with qwen, and by default write the result back ONTO the canvas as a text note ' +
        'next to that video. Use for "理解/分析画布上(选中)的这段视频". NO url/path needed — it reads the ' +
        'selected canvas video itself (local sources are auto-uploaded to COS). Model defaults to qwen3.7-max ' +
        '(stronger); pass model="plus" for the cheaper qwen3.7-plus. Set annotate=false to only return the text ' +
        'without drawing the note. Requires the Canvas tab open. Returns a Chinese description.',
      inputSchema: z.object({
        question: z.string().min(1).describe('What you want to know about the selected canvas video.'),
        model: z.enum(['max', 'plus']).optional().describe('Model: "max" (default, stronger) or "plus" (cheaper). Omit for max.'),
        annotate: z.boolean().optional().describe('Write the result onto the canvas as a text note next to the video (default true).'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstandCanvasVideo(router, params as Record<string, unknown>, ctx),
  )
}
