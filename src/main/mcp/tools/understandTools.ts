// qwen3.7-max-dashscope 理解工具（视频 / 文档 / 联网扒资料）。
//
// 与 imageTools/videoTools 同款薄层模式:main 端只做参数透传 + banner 包装,
// 实际模型调用在渲染层 AgentToolExecutor.callUnderstand → ApiService.understand()
// （复用出图同一条 new-api 链路 + 同一 Miau 令牌）。
//
// 设计要点:
// - 媒体只接受公网可达 URL(qwen 上游限制);本机 *_path 由渲染层回结构化错误。
// - 音频不原生支持:skill「catimation-understand」指导先 ffmpeg 转 MP4 再走
//   understand_video。
// - 联网用 web_research(渲染层置 enable_search:true)。
// - 健壮性:渲染层 understand() 已把 502/非 JSON 映射成 {success:false,error};
//   这里再兜一层 try/catch,任何异常都回成 textResult 而非抛出。

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

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

async function runUnderstand(
  router: ToolRouter,
  tool: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  const threadId = extractCodexThreadId(ctx)
  try {
    const r = (await router.call(tool, params, threadId)) as UnderstandResult
    return textResult(formatResult(tool, r))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    return textResult(formatResult(tool, { success: false, error: msg }))
  }
}

export function registerUnderstandTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'understand_video',
    {
      description:
        'Understand / analyze a VIDEO with qwen3.7-max-dashscope (画面/动作/字幕/剧情). Use for ANY ' +
        '"理解/分析这个视频" request. Pass a PUBLIC video URL via video_url (qwen only accepts ' +
        'publicly reachable URLs — local file paths are rejected with a hint to upload first). ' +
        'AUDIO is NOT natively supported: to "understand" an audio file, first convert it to MP4 ' +
        '(ffmpeg-win skill: audio track + placeholder/​waveform video) and pass that MP4 here. ' +
        'Returns a Chinese description. Do NOT retry on a clean result.',
      inputSchema: z.object({
        video_url: z.string().optional().describe('Public http(s) URL of the video (preferred).'),
        video_path: z.string().optional().describe('Local file path — currently NOT accepted (qwen needs a public URL); will return a hint to use video_url.'),
        question: z.string().min(1).describe('What you want to know about the video.'),
        fps: z.number().int().positive().optional().describe('Optional sampling fps hint (reserved; not yet sent upstream).'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'understand_video', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'understand_document',
    {
      description:
        'Understand / read a DOCUMENT (PDF/图文页) with qwen3.7-max-dashscope. Pass a PUBLIC URL via ' +
        'file_url. NOTE: native document understanding is only PARTIAL upstream — for best results ' +
        'render the page(s) to image(s) and pass an image URL, or extract text and ask normally. ' +
        'Local file_path is not accepted (needs a public URL). Returns a Chinese answer.',
      inputSchema: z.object({
        file_url: z.string().optional().describe('Public http(s) URL of the document/page image (preferred).'),
        file_path: z.string().optional().describe('Local file path — currently NOT accepted; will return a hint to use file_url.'),
        question: z.string().min(1).describe('What you want to know from the document.'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'understand_document', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'web_research',
    {
      description:
        'Search the web / 上网扒资料 with qwen3.7-max-dashscope (enable_search). Use for "上网查/查一下/' +
        '搜一下/最新消息" requests. Pass a natural-language query; returns a synthesized answer that ' +
        'incorporates live web results. Prefer this over guessing from stale memory.',
      inputSchema: z.object({
        query: z.string().min(1).describe('Natural-language research query.'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'web_research', params as Record<string, unknown>, ctx),
  )
}
