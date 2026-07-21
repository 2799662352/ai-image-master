// src/main/mcp/tools/audioTools.ts
/**
 * generate_audio MCP 工具(seed-audio-1.0,火山豆包音频生成)。
 *
 * 与 understandTools 同款「薄层」模式:main 端只做参数透传 + banner 包装,
 * 真正的生成 + 三级持久化(COS 桶 / 本地文件 / base64 兜底)在渲染层
 * AgentToolExecutor.generateAudio → features/audio/audioGeneration。音频出得
 * 快(通常十几秒),所以走同步 router.call 直接等结果,不套 image 那种
 * 异步 task+轮询;RENDERER_TOOL_TIMEOUT_MS(~2000s)足够兜底。
 *
 * 生成的音频会落进音频页作品库(AudioLibraryStore),用户在「音频生成」tab
 * 能看到、播放、下载 —— agent 出的音频和手动出的音频进同一个库。
 */

import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'

/** 与 imageTools/understandTools 一致的 codex threadId 提取。 */
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

/** 渲染层 generateAudio 的回包形状(见 AgentToolExecutor.generateAudio)。 */
type AudioToolResult =
  | {
      success: true
      prompt: string
      format: string
      duration: number
      billedSeconds: number
      filePath?: string
      remoteUrl?: string
    }
  | { success: false; error: string }

function textResult(text: string): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text }] }
}

function formatBanner(r: AudioToolResult): string {
  if (!r.success) {
    return [`❌ generate_audio failed: ${r.error}`, JSON.stringify({ ok: false, error: r.error })].join('\n')
  }
  const lines = [
    `✅ generate_audio DONE — ${r.duration > 0 ? `${r.duration.toFixed(1)}s ` : ''}audio generated and added to the app's 音频生成 library (the user can play/download it there).`,
  ]
  if (r.remoteUrl) lines.push(`🔗 URL: ${r.remoteUrl}`)
  if (r.filePath) lines.push(`📁 LOCAL: ${r.filePath}`)
  lines.push(
    'The audio is already saved — do NOT regenerate. Just confirm briefly to the user (mention duration).',
  )
  lines.push(
    JSON.stringify({
      ok: true,
      format: r.format,
      duration: r.duration,
      billedSeconds: r.billedSeconds,
      ...(r.remoteUrl ? { url: r.remoteUrl } : {}),
      ...(r.filePath ? { path: r.filePath } : {}),
    }),
  )
  return lines.join('\n')
}

export function registerAudioTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'generate_audio',
    {
      description:
        'Generate SPEECH / AUDIO with 火山豆包 seed-audio-1.0 inside the CATIMATION app. Use for ANY ' +
        '"生成音频/配音/语音/朗读/念一段/旁白/tts/text to speech/read this aloud" request. Describe the ' +
        'scene in natural language via `input` — it supports multiple speakers, accents, ambient sound, ' +
        'and background music all from one prompt (e.g. "一位中年男性用沉稳语气说:项目已上线,背景有轻微键盘声"). ' +
        'Do NOT pass a fixed voice/speaker id — seed-audio prefers natural-language description or reference ' +
        'audio. Single output ≤ ~120s; split long dialogue into multiple calls. The audio is generated, ' +
        'uploaded to cloud storage (COS) AND saved locally, then added to the app\'s 音频生成 (Audio) tab ' +
        'library where the user can play and download it — so just confirm briefly, never re-describe the ' +
        'waveform. Billed by output seconds (~¥1/min).',
      inputSchema: z.object({
        input: z.string().min(1).describe(
          'Natural-language description of the audio: what is said, by whom (voice/tone/age), plus any ' +
          'ambient sound or music. Chinese or English.',
        ),
        format: z.enum(['mp3', 'wav', 'opus']).optional().describe('Output format. Default mp3.'),
        speed: z.number().min(0.25).max(4).optional().describe('Speech speed 0.25–4.0 (default 1.0).'),
        referenceAudios: z.array(z.string()).max(2).optional().describe(
          'Optional reference audio for style fusion: public http(s) URLs or data:audio;base64 (≤2). ' +
          'Mutually exclusive with a fixed speaker (do not use both).',
        ),
      }),
    },
    async (params, ctx?: unknown) => {
      const threadId = extractCodexThreadId(ctx)
      try {
        const r = (await router.call('generate_audio', params as Record<string, unknown>, threadId)) as AudioToolResult
        return textResult(formatBanner(r))
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error)
        return textResult(formatBanner({ success: false, error: msg }))
      }
    },
  )
}
