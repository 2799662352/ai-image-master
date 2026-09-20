// qwen 理解工具(视频 / 音频 / 文档 / 联网扒资料)。默认全模态 qwen3.8-omni-flash
// (2026-09-20 生产网关上线,文本 / 图片 / 视频 / 音频输入都收,比 3.7-plus 还便宜);
// 可经 model="plus" / "max" 选 3.7 Plus / Max(与 3.8 并行保留,用户拍板暂不撤),
// model="flagship" 选 qwen3.8-max;渲染层 understand() 还会在 primary 失败时自动用
// 3.7 Max 兜底(音频除外 —— 只有 omni 听得见)。
//
// 与 imageTools/videoTools 同款薄层模式:main 端只做参数透传 + banner 包装,
// 实际模型调用在渲染层 AgentToolExecutor.callUnderstand → ApiService.understand()
// (复用出图同一条 Miau 链路:平台余额或 Miau 令牌计费)。
//
// 设计要点:
// - 媒体最终只接受公网可达 URL(qwen 上游限制),但 main 端会自动兜底:
//   * http(s) URL → 原样透传;
//   * data: URL    → 中转到历史 COS 桶换公网 URL;
//   * 本机 *_path  → 流式分片上传到历史 COS 桶(image-history/media-relay/*,
//     不把整文件读进内存)换公网 URL,再交给渲染层。复用 COS STS 上传链路
//     (mediaRelay.relayFileToCos)。支持到 qwen 上游客观上限 2GB / 2 小时。
// - 音频走 understand_audio(omni 原生 `input_audio`),不再需要 ffmpeg 套 MP4。
// - 联网用 web_research(渲染层置 enable_search:true)。
// - 健壮性:渲染层 understand() 已把 502/非 JSON 映射成 {success:false,error};
//   这里再兜一层 try/catch,任何异常都回成 textResult 而非抛出。

import { promises as fs } from 'node:fs'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import type { ToolRouter } from '../ToolRouter'
import { relayDataUrlToCos, relayFileToCos } from '../../services/tencent/mediaRelay'
import { READ_ONLY_REMOTE, WRITE_ADDITIVE_REMOTE } from './annotations'

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

// 客观上限 = qwen 视觉理解的上游限制(2GB / 2 小时,3.8 omni / max 同档)。
// 不再是「整文件读进内存」逼出来的 200MB 自设闸门 —— 本机文件改走 relayFileToCos
// 流式分片上传(STS 鉴权,不占内存),所以这里可以放到真正的 2GB。
const MAX_RELAY_BYTES = 2 * 1024 * 1024 * 1024 // 2GB:qwen 视频理解上限

type RelayKind = 'video' | 'audio' | 'document'

/** 每类媒体的参数名(`*_url` / `*_path`),三处(校验 / 归一 / 透传)共用一份。 */
const MEDIA_KEYS: Record<RelayKind, { url: string; path: string }> = {
  video: { url: 'video_url', path: 'video_path' },
  audio: { url: 'audio_url', path: 'audio_path' },
  document: { url: 'file_url', path: 'file_path' },
}

const EXT_MIME: Record<string, string> = {
  // video
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  // audio
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/opus',
  flac: 'audio/flac',
  amr: 'audio/amr',
  wma: 'audio/x-ms-wma',
  // document / image
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
}

function mimeFromPath(p: string, kind: RelayKind): string {
  const ext = (p.split('?')[0]?.split('.').pop() ?? '').toLowerCase()
  return EXT_MIME[ext] ?? (kind === 'video' ? 'video/mp4' : kind === 'audio' ? 'audio/mpeg' : 'application/octet-stream')
}

/**
 * http(s)/data: URLs can be relayed to COS (or passed upstream) as-is. Opaque
 * tldraw `asset:<id>` refs (and renderer-scoped `blob:` URLs) CANNOT: the bytes
 * live in the renderer's IndexedDB and the main process can neither fetch them
 * nor stat a file — so a canvas video that only carries such a ref must first be
 * MATERIALIZED to a real on-disk file (via get_canvas_video) before relay.
 */
function isRelayableUrl(u: unknown): u is string {
  return typeof u === 'string' && /^(https?:|data:)/i.test(u)
}

/**
 * 把一个媒体参数(*_url / *_path)归一成公网 URL:
 * - http(s) → 原样;data: → 中转 COS;本机路径 → 读字节后中转 COS。
 * 失败返回结构化 error(不抛)。
 */
async function resolveMediaUrl(
  params: Record<string, unknown>,
  kind: RelayKind,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  const { url: urlKey, path: pathKey } = MEDIA_KEYS[kind]

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
          error: `本机文件过大(${(stat.size / 1024 / 1024 / 1024).toFixed(2)}GB,上限 2GB),请压缩后再试。`,
        }
      }
      // 流式分片上传(不把整文件读进内存),所以可支持到 qwen 上游的 2GB 客观上限。
      const publicUrl = await relayFileToCos(localPath, mimeFromPath(localPath, kind), {
        fileSize: stat.size,
      })
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

/**
 * 把 `file_urls` / `file_paths` 摊成一串可交给 `resolveMediaUrl` 的单条参数。
 *
 * 两个数组拼接而不是二选一:一次看多张时素材来源常常是混的(几张已在 COS 上、
 * 几张刚从本机拖进来),强迫调用方统一成一种反而逼它自己先上传。
 * URL 排在 path 前,与 `resolveMediaUrl` 对单条的优先级一致。
 */
function collectExtraDocumentSources(
  params: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const pick = (v: unknown): string[] =>
    Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : []
  return [
    ...pick(params.file_urls).map((file_url) => ({ file_url })),
    ...pick(params.file_paths).map((file_path) => ({ file_path })),
  ]
}

async function runUnderstand(
  router: ToolRouter,
  tool: string,
  params: Record<string, unknown>,
  ctx: unknown,
): Promise<{ content: Array<{ type: 'text'; text: string }> }> {
  let outParams = params
  const kind: RelayKind | null =
    tool === 'understand_video' ? 'video' : tool === 'understand_audio' ? 'audio' : tool === 'understand_document' ? 'document' : null
  if (kind) {
    const media = await resolveMediaUrl(params, kind)
    if (!media.ok) {
      return textResult(formatResult(tool, { success: false, error: media.error }))
    }
    const { url: urlKey, path: pathKey } = MEDIA_KEYS[kind]
    outParams = { ...params, [urlKey]: media.url }
    delete outParams[pathKey]

    // 追加图:一次看多张(商品对比 / 多页文档 / 跨镜连续性)。上游把同一条
    // message 里并列的多张当成一组看,拆成多次调用就看不到彼此了。
    if (kind === 'document') {
      const extras = collectExtraDocumentSources(params)
      if (extras.length > 0) {
        // 并发中转但**按输入顺序落位**:Promise.all 按入参顺序返回,与谁先传完无关。
        // 顺序即身份 —— 提问里说「第二张」就必须是第二张,按完成顺序 push 会在
        // 网络抖动时随机错位,而且不报错。
        const resolved = await Promise.all(
          extras.map((src) => resolveMediaUrl(src, 'document')),
        )
        const failed = resolved.findIndex((r) => !r.ok)
        if (failed >= 0) {
          // 不静默跳过失败的那张:少一张会让后面所有序号前移,「第三张」指向第四张,
          // 而模型不会察觉。宁可整条报错让调用方处理。
          const err = resolved[failed] as { ok: false; error: string }
          return textResult(formatResult(tool, {
            success: false,
            error: `第 ${failed + 2} 张素材无法使用:${err.error}(共 ${extras.length + 1} 张;顺序会影响提问里的「第 N 张」,所以不跳过)`,
          }))
        }
        outParams.file_urls = resolved.map((r) => (r as { ok: true; url: string }).url)
      }
      delete outParams.file_paths
    }
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

  // 2) 选一个「可中转」的源,再归一成公网 URL:
  //    - 本机 assetPath → 流式上传 COS;
  //    - http/data assetUrl → 透传 / 中转;
  //    - 否则(不透明的 asset:/blob: 引用,典型是把视频从「桌面/OS」直接拖进持久化画布:
  //      字节落在渲染层 IndexedDB,main 端既 fetch 不到也 stat 不到)→ 先让渲染层
  //      把它 materialize 成真实本机文件(get_canvas_video,内部走 tldraw
  //      resolveAssetUrl→blob→落盘,与 ffmpeg 取流同一条已修复链路),再中转那份文件。
  //      不直接对 http 源走 get_canvas_video,避免把公网视频先下载再上传的无谓往返。
  const mediaParams: Record<string, unknown> = {}
  if (typeof sel.assetPath === 'string' && sel.assetPath) {
    mediaParams.video_path = sel.assetPath
  } else if (isRelayableUrl(sel.assetUrl)) {
    mediaParams.video_url = sel.assetUrl
  } else {
    let cv: { ok?: boolean; error?: string; videoPath?: string | null; assetUrl?: string | null }
    try {
      cv = (await router.call('get_canvas_video', {}, threadId)) as typeof cv
    } catch (e) {
      return textResult(formatResult(tool, { success: false, error: `落盘画布视频失败:${e instanceof Error ? e.message : String(e)}` }))
    }
    if (cv?.ok && typeof cv.videoPath === 'string' && cv.videoPath) {
      mediaParams.video_path = cv.videoPath
    } else if (cv?.ok && isRelayableUrl(cv.assetUrl)) {
      mediaParams.video_url = cv.assetUrl
    } else {
      return textResult(formatResult(tool, { success: false, error: cv?.error ?? '无法解析该画布视频的可用源(可能是从桌面拖入、字节尚未就绪)。请重试,或先用 insert_video 放置。' }))
    }
  }
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

/**
 * 模型档位参数,四个工具共用一份。'plus' / 'max' 按字面指 3.7 Plus / Max(两代并行期间
 * 不改老 skill / 老会话里这两个词的意思),'flagship' 指 3.8 旗舰,'omni'(默认)指全模态档。
 */
const MODEL_PARAM = z.enum(['omni', 'plus', 'max', 'flagship']).optional().describe(
  'Model: "omni" (default — qwen3.8-omni-flash, cheapest, the ONLY tier that can HEAR audio) | '
  + '"plus" (qwen3.7-plus-dashscope, the previous default; text + image + video) | '
  + '"max" (qwen3.7-max-dashscope — stronger 3.7, also the automatic fallback) | '
  + '"flagship" (qwen3.8-max — strongest reasoning, 1M context, built-in tools). '
  + 'None of plus / max / flagship hear audio. Same video limits on every tier (2h / 2GB), so a bigger '
  + 'tier is NOT needed just because the input is a video. Omit for omni.',
)

export function registerUnderstandTools(server: McpServer, router: ToolRouter): void {
  server.registerTool(
    'understand_video',
    {
      description:
        'Understand / analyze a VIDEO with qwen (画面/动作/字幕/剧情). Use for ANY ' +
        '"理解/分析这个视频" request. Pass either a public video_url OR a local video_path — a local ' +
        'path is auto-uploaded (streamed) to the history COS bucket to obtain a public URL (≤2GB / 2h, ' +
        'the qwen upstream limit). ' +
        'The model samples frames (see `fps`) and reads what is VISIBLE — burned-in subtitles, action, '
        + 'composition, continuity. The default omni model ALSO hears the soundtrack (verified on the '
        + 'production gateway 2026-09-20: a black-screen clip came back with its dialogue), so it can tell '
        + 'you roughly what was said or played; for a verbatim transcript or a music analysis use '
        + 'understand_audio on the audio track (extract it with the ffmpeg-win skill: '
        + '`ffmpeg -i in.mp4 -vn -c:a libmp3lame out.mp3`). Every other tier (plus / max / flagship) is '
        + 'frame-only and never hears. Never claim you heard something this tool did not return.\n'
        + 'Model defaults to qwen3.8-omni-flash (cheapest); see `model` for the 3.7 tiers and the 3.8 flagship. ' +
        'Returns a Chinese description. Do NOT retry on a clean result.',
      annotations: READ_ONLY_REMOTE,
      inputSchema: z.object({
        video_url: z.string().optional().describe('Public http(s) URL of the video (preferred when you already have one).'),
        video_path: z.string().optional().describe('Local file path — auto-uploaded to COS (image-history/media-relay/*) to get a public URL.'),
        question: z.string().min(1).describe('What you want to know about the video.'),
        fps: z.number().positive().max(10).optional().describe(
          'Frame sampling rate: one frame every 1/fps seconds. Range 0.1–10, upstream default 2. '
          + 'Raise it for fast action you would otherwise miss between frames; lower it for long static '
          + 'footage to save tokens. This is the main lever over what the model actually sees.',
        ),
        model: MODEL_PARAM,
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'understand_video', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'understand_audio',
    {
      description:
        'Understand / listen to an AUDIO file with the omni-modal qwen3.8-omni-flash (语音转写 / 对白 / ' +
        '音乐风格 / 音效 / 语气情绪). Use for ANY "听一下/转写/这段录音说了什么/这首歌是什么风格" request, and ' +
        'for the soundtrack of a video (extract it first with the ffmpeg-win skill: ' +
        '`ffmpeg -i in.mp4 -vn -c:a libmp3lame out.mp3`). Pass either a public audio_url OR a local ' +
        'audio_path — a local path is auto-uploaded (streamed) to the history COS bucket to obtain a public ' +
        'URL. Formats upstream accepts: mp3 / wav / aac / amr / 3gp ONLY — m4a / ogg / opus / flac are rejected, ' +
        'convert them first with the ffmpeg-win skill (`ffmpeg -i in.m4a -vn -acodec libmp3lame out.mp3`). ' +
        'Long recordings: split into ≤20-minute ' +
        'chunks with ffmpeg and ask per chunk (long inputs may be rejected upstream). The model is FIXED to ' +
        'omni — `model` is accepted for symmetry but no other tier can hear. Bills the platform balance / ' +
        'Miau key like every other qwen tool. Returns a Chinese answer. Do NOT retry on a clean result.',
      annotations: READ_ONLY_REMOTE,
      inputSchema: z.object({
        audio_url: z.string().optional().describe('Public http(s) URL of the audio file (preferred when you already have one).'),
        audio_path: z.string().optional().describe('Local file path — auto-uploaded to COS (image-history/media-relay/*) to get a public URL.'),
        question: z.string().min(1).describe('What you want to know: transcribe verbatim, summarize, identify the genre / mood / instruments, etc.'),
        format: z.string().optional().describe('Audio container hint: mp3 | wav | aac | amr | 3gp (the only values upstream accepts). Inferred from the URL extension when omitted.'),
        model: MODEL_PARAM,
      }),
    },
    async (params, ctx?: unknown) => runUnderstand(router, 'understand_audio', params as Record<string, unknown>, ctx),
  )

  server.registerTool(
    'understand_document',
    {
      description:
        'Understand / read a DOCUMENT (PDF/图文页) with qwen. Pass either file_url ' +
        '(public URL) OR a local file_path — a local path is auto-uploaded (streamed) to the history COS ' +
        'bucket to get a public URL (≤2GB). PDFs are parsed natively (text AND images inside the file) — ' +
        'just pass the .pdf, do NOT pre-render pages to images; upstream caps are 150MB / 500 pages per ' +
        'document. Model defaults to qwen3.7-plus (cheaper); pass model="max" for the stronger model. ' +
        'Returns a Chinese answer.',
      annotations: READ_ONLY_REMOTE,
      inputSchema: z.object({
        file_url: z.string().optional().describe('Public http(s) URL of the document/page image (preferred when you already have one).'),
        file_path: z.string().optional().describe('Local file path — auto-uploaded to COS (image-history/media-relay/*) to get a public URL.'),
        file_urls: z.array(z.string()).optional().describe(
          'ADDITIONAL images to look at in the SAME request (public URLs). Use this whenever the question '
          + 'spans more than one image — "是同一个人吗", "这两版哪个更好", a multi-page document, checking a '
          + 'character across shots. The model sees them as one set, so it can compare; splitting into '
          + 'separate calls loses that entirely. Order is preserved and matters: file_url is #1, then these '
          + 'in order, so "第二张" in your question means the first entry here. Duplicates are dropped.',
        ),
        file_paths: z.array(z.string()).optional().describe(
          'Same as file_urls but LOCAL paths (each auto-uploaded to COS). Can be combined with file_urls '
          + '— URLs are ordered first, then paths. If any one of them fails to upload the whole call errors '
          + 'out rather than silently dropping it, because a missing image would shift every later index.',
        ),
        question: z.string().min(1).describe('What you want to know from the document / across the images.'),
        model: MODEL_PARAM,
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
        'incorporates live web results. Model defaults to omni (qwen3.8-omni-flash, cheapest); pass ' +
        'model="max" for the stronger qwen3.7-max or model="flagship" for qwen3.8-max. Prefer this over ' +
        'guessing from stale memory.',
      annotations: READ_ONLY_REMOTE,
      inputSchema: z.object({
        query: z.string().min(1).describe('Natural-language research query.'),
        model: MODEL_PARAM,
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
        'selected canvas video itself (local files AND clips dragged in from the desktop are auto-uploaded to ' +
        'COS — a dragged-in clip is first materialized to a real file). Model defaults to omni ' +
        '(qwen3.8-omni-flash, cheapest); pass model="max" for the stronger qwen3.7-max or model="flagship" for ' +
        'qwen3.8-max. Set annotate=false to only return the text without drawing the note. Requires the Canvas ' +
        'tab open. Returns a Chinese description.',
      annotations: WRITE_ADDITIVE_REMOTE,
      inputSchema: z.object({
        question: z.string().min(1).describe('What you want to know about the selected canvas video.'),
        model: MODEL_PARAM,
        annotate: z.boolean().optional().describe('Write the result onto the canvas as a text note next to the video (default true).'),
      }),
    },
    async (params, ctx?: unknown) => runUnderstandCanvasVideo(router, params as Record<string, unknown>, ctx),
  )
}
