/**
 * Native audio / video input for omni-modal main-agent models (qwen3.8-omni-flash).
 *
 * Why this exists — two blockers on the codex side (rust-v0.154.0, verified in source):
 *
 * 1. codex gates audio on the model's `input_modalities`. A slug it does not know
 *    (every Miau / DashScope model) falls back to `model_info_from_slug`, whose
 *    modalities are `[text, image]`, and `strip_audio_when_unsupported`
 *    (core/src/context_manager/normalize.rs) replaces every `InputAudio` with a
 *    text placeholder BEFORE the request leaves the process. There is no config
 *    override (`with_config_overrides` only touches context window / truncation /
 *    instructions), so the native `localAudio` / `audio` UserInput can never reach
 *    an omni model through codex.
 * 2. codex has no video UserInput at all, and its audio serialization
 *    (`{type:"input_audio", audio_url}`) lacks the `format` field that the
 *    DashScope Responses API requires (gateway answers 400 `Invalid format 'None'`,
 *    verified against the production Miau gateway 2026-09-20).
 *
 * So the media travels as a **text sentinel** that codex treats as ordinary text:
 *
 *   <catimation_media kind="video" name="开场-1.mp4" url="https://…" />
 *   <catimation_media kind="audio" name="talk.mp3" format="mp3" url="https://…" />
 *
 * The main process relays local files to the COS media-relay prefix (public https,
 * the same path the understand_* tools use) and emits one sentinel per file as its
 * own `text` input item. The Responses compatibility bridge every qwen channel already
 * runs behind (`responses-namespace-bridge`) rewrites those items into the DashScope
 * Responses shapes documented at
 * https://docs.bailian.console.aliyun.com/zh/model-studio/qwen-omni (Responses：音频和视频输入):
 *
 *   { type: "input_audio", audio_url, format }   |   { type: "input_video", video_url }
 *
 * Only user messages are rewritten (audio / video are only allowed in user messages
 * upstream) and only when `body.model` is an omni model. Anywhere else the sentinel
 * stays text, which still tells the model exactly which file was attached and where
 * it lives, so it can fall back to `understand_video` / `understand_audio`.
 *
 * History: codex replays the whole `input` on every turn, so media is re-sent every
 * turn exactly like `input_image` is — ~31k input tokens per turn for a two-minute
 * 1080p clip (measured). Start a fresh thread to drop it.
 *
 * Kept free of `electron` imports on purpose: the bridge module is loadable outside
 * Electron and its tests must stay that way.
 */
import path from 'node:path'
import type { AgentInput } from './types'

/** Main-agent models whose Responses requests accept `input_audio` / `input_video`. */
export const OMNI_NATIVE_MEDIA_MODELS: ReadonlySet<string> = new Set(['qwen3.8-omni-flash'])

export function modelAcceptsNativeMedia(model: string | null | undefined): boolean {
  return typeof model === 'string' && OMNI_NATIVE_MEDIA_MODELS.has(model.trim())
}

/**
 * The only `format` values the DashScope Responses `input_audio` part accepts —
 * the production gateway 400s with "Supported values are: 'mp3', 'wav', 'amr',
 * '3gp', '3gpp', 'aac'" for anything else (m4a / ogg / opus / flac included).
 */
export const NATIVE_AUDIO_FORMATS = ['mp3', 'wav', 'amr', '3gp', '3gpp', 'aac'] as const
export type NativeAudioFormat = (typeof NATIVE_AUDIO_FORMATS)[number]

const NATIVE_AUDIO_FORMAT_SET: ReadonlySet<string> = new Set(NATIVE_AUDIO_FORMATS)

const AUDIO_FORMAT_BY_MIME: Readonly<Record<string, NativeAudioFormat>> = {
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
  'audio/wave': 'wav',
  'audio/vnd.wave': 'wav',
  'audio/amr': 'amr',
  'audio/3gpp': '3gp',
  'audio/aac': 'aac',
  'audio/x-aac': 'aac',
}

/** Video containers the DashScope video pipeline decodes (mp4 verified live; the rest per upstream docs). */
export const NATIVE_VIDEO_EXTENSIONS: ReadonlySet<string> = new Set([
  'mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'flv', 'wmv', 'mpeg', 'mpg',
])

const VIDEO_MIME_BY_EXT: Readonly<Record<string, string>> = {
  mp4: 'video/mp4',
  m4v: 'video/x-m4v',
  mov: 'video/quicktime',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  flv: 'video/x-flv',
  wmv: 'video/x-ms-wmv',
  mpeg: 'video/mpeg',
  mpg: 'video/mpeg',
}

const AUDIO_MIME_BY_FORMAT: Readonly<Record<NativeAudioFormat, string>> = {
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  amr: 'audio/amr',
  '3gp': 'audio/3gpp',
  '3gpp': 'audio/3gpp',
  aac: 'audio/aac',
}

function extensionOf(pathOrUrl: string): string | null {
  const clean = pathOrUrl.split(/[?#]/, 1)[0]
  const match = /\.([A-Za-z0-9]{1,5})$/.exec(clean)
  return match ? match[1].toLowerCase() : null
}

/** `talk.MP3?sig=1` → `mp3`; falls back to the mime; `null` when upstream would reject it. */
export function nativeAudioFormat(pathOrUrl: string, mime?: string): NativeAudioFormat | null {
  const ext = extensionOf(pathOrUrl)
  if (ext && NATIVE_AUDIO_FORMAT_SET.has(ext)) return ext as NativeAudioFormat
  const normalizedMime = mime?.toLowerCase().split(';', 1)[0].trim()
  if (normalizedMime && AUDIO_FORMAT_BY_MIME[normalizedMime]) return AUDIO_FORMAT_BY_MIME[normalizedMime]
  return null
}

export function isNativeVideo(pathOrUrl: string, mime?: string): boolean {
  if (mime?.toLowerCase().startsWith('video/')) return true
  const ext = extensionOf(pathOrUrl)
  return ext !== null && NATIVE_VIDEO_EXTENSIONS.has(ext)
}

export type OmniMediaKind = 'audio' | 'video'

export interface OmniMediaRef {
  kind: OmniMediaKind
  /** Public https URL (COS relay or the user's own remote URL). */
  url: string
  /** Required for audio (DashScope decodes the bytes by this field); absent for video. */
  format?: NativeAudioFormat
  /** Original file name, kept so the model (and a non-omni fallback) can name the file. */
  name?: string
}

const SENTINEL_TAG = 'catimation_media'

function escapeAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeAttr(value: string): string {
  return value.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

export function buildOmniMediaSentinel(ref: OmniMediaRef): string {
  const attrs = [`kind="${ref.kind}"`]
  if (ref.name) attrs.push(`name="${escapeAttr(ref.name)}"`)
  if (ref.kind === 'audio' && ref.format) attrs.push(`format="${ref.format}"`)
  attrs.push(`url="${escapeAttr(ref.url)}"`)
  return `<${SENTINEL_TAG} ${attrs.join(' ')} />`
}

const SENTINEL_RE = new RegExp(`^<${SENTINEL_TAG}\\s+([^<>]*?)\\s*/>$`)
const ATTR_RE = /([a-z]+)="([^"]*)"/g

/**
 * Strict whole-text match: the sentinel is always its own input item, so anything
 * with surrounding prose is left alone (a user quoting the tag stays text).
 */
export function parseOmniMediaSentinel(text: string): OmniMediaRef | null {
  const match = SENTINEL_RE.exec(text.trim())
  if (!match) return null
  const attrs = new Map<string, string>()
  for (const attr of match[1].matchAll(ATTR_RE)) attrs.set(attr[1], unescapeAttr(attr[2]))
  const kind = attrs.get('kind')
  const url = attrs.get('url')
  if ((kind !== 'audio' && kind !== 'video') || !url || !/^https:\/\//i.test(url)) return null
  const name = attrs.get('name') || undefined
  if (kind === 'video') return { kind, url, ...(name ? { name } : {}) }
  const format = attrs.get('format')
  if (!format || !NATIVE_AUDIO_FORMAT_SET.has(format)) return null
  return { kind, url, format: format as NativeAudioFormat, ...(name ? { name } : {}) }
}

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Bridge-side rewrite: turn sentinel `input_text` parts of user messages into the
 * DashScope Responses media parts. Mutates `body` in place; returns how many parts
 * were rewritten. No-op unless `body.model` is an omni model.
 */
export function rewriteOmniMediaInput(body: JsonObject): number {
  if (!modelAcceptsNativeMedia(typeof body.model === 'string' ? body.model : undefined)) return 0
  if (!Array.isArray(body.input)) return 0
  let rewritten = 0
  for (const item of body.input) {
    if (!isJsonObject(item) || item.role !== 'user' || !Array.isArray(item.content)) continue
    if (item.type !== undefined && item.type !== 'message') continue
    item.content = item.content.map((part) => {
      if (!isJsonObject(part) || part.type !== 'input_text' || typeof part.text !== 'string') return part
      const ref = parseOmniMediaSentinel(part.text)
      if (!ref) return part
      rewritten += 1
      return ref.kind === 'audio'
        ? { type: 'input_audio', audio_url: ref.url, format: ref.format }
        : { type: 'input_video', video_url: ref.url }
    })
  }
  return rewritten
}

/** A video reference the reference mapper set aside instead of flattening to a path mention. */
export interface VideoReference {
  label: string
  path?: string
  url?: string
}

export interface NativeMediaPlanInput {
  /** Items produced by the reference mapper; `localAudio` / `audio` entries are consumed here. */
  referenceItems: AgentInput['items']
  videoReferences: readonly VideoReference[]
  /** Freshly ingested composer attachments (AttachmentService.SavedAttachment shape). */
  attachments: ReadonlyArray<{ originalName: string; mime: string; localPath: string; size?: number }>
  /** Uploads a local file to the public relay prefix and returns its https URL. */
  relay: (filePath: string, mime: string, size?: number) => Promise<string>
}

export interface NativeMediaPlan {
  /** `referenceItems` minus the audio items that became sentinels. */
  referenceItems: AgentInput['items']
  /** One sentinel `text` item per media file, in input order. */
  mediaItems: AgentInput['items']
  /** Attachment localPaths already covered by a sentinel (skip the `localAudio` emission). */
  consumedAttachmentPaths: ReadonlySet<string>
  /** `name: path` mentions for media that could not go native (unsupported format / relay failure). */
  fallbackMentions: string[]
}

/**
 * Decide, for an omni turn, which attachments and references travel natively and
 * relay the local ones. Never throws: a failed relay degrades that one file to a
 * path mention (the agent can still `understand_*` it) and the turn proceeds.
 */
export async function planOmniNativeMedia(input: NativeMediaPlanInput): Promise<NativeMediaPlan> {
  const mediaItems: AgentInput['items'] = []
  const fallbackMentions: string[] = []
  const consumedAttachmentPaths = new Set<string>()
  const seenUrls = new Set<string>()
  const seenPaths = new Set<string>()

  const pushSentinel = (ref: OmniMediaRef): void => {
    if (seenUrls.has(ref.url)) return
    seenUrls.add(ref.url)
    mediaItems.push({ type: 'text', text: buildOmniMediaSentinel(ref) })
  }

  const relayLocal = async (
    filePath: string,
    mime: string,
    size: number | undefined,
    onUrl: (url: string) => void,
    label: string,
  ): Promise<void> => {
    const resolved = path.resolve(filePath)
    if (seenPaths.has(resolved)) return
    seenPaths.add(resolved)
    try {
      onUrl(await input.relay(filePath, mime, size))
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      console.warn(`[omniMedia] relay failed for ${label}, falling back to a path mention: ${detail}`)
      fallbackMentions.push(`${label}: ${filePath}`)
    }
  }

  const referenceItems: AgentInput['items'] = []
  for (const item of input.referenceItems) {
    if (item.type === 'localAudio') {
      const format = nativeAudioFormat(item.path)
      const name = path.basename(item.path)
      if (!format) {
        fallbackMentions.push(`${name}: ${item.path}`)
        continue
      }
      await relayLocal(item.path, AUDIO_MIME_BY_FORMAT[format], undefined, (url) => {
        pushSentinel({ kind: 'audio', url, format, name })
      }, name)
      continue
    }
    if (item.type === 'audio') {
      const format = nativeAudioFormat(item.url)
      if (!format) {
        fallbackMentions.push(`audio: ${item.url}`)
        continue
      }
      pushSentinel({ kind: 'audio', url: item.url, format, name: urlBasename(item.url) })
      continue
    }
    referenceItems.push(item)
  }

  for (const ref of input.videoReferences) {
    if (ref.url) {
      if (isNativeVideo(ref.url)) pushSentinel({ kind: 'video', url: ref.url, name: ref.label })
      else fallbackMentions.push(`${ref.label}: ${ref.url}`)
      continue
    }
    if (!ref.path) continue
    const ext = extensionOf(ref.path)
    const mime = (ext && VIDEO_MIME_BY_EXT[ext]) || 'video/mp4'
    await relayLocal(ref.path, mime, undefined, (url) => {
      pushSentinel({ kind: 'video', url, name: ref.label })
    }, ref.label)
  }

  for (const attachment of input.attachments) {
    const resolved = path.resolve(attachment.localPath)
    const name = attachment.originalName
    if (isNativeVideo(attachment.localPath, attachment.mime)) {
      consumedAttachmentPaths.add(resolved)
      await relayLocal(attachment.localPath, attachment.mime || 'video/mp4', attachment.size, (url) => {
        pushSentinel({ kind: 'video', url, name })
      }, name)
      continue
    }
    const looksLikeAudio = attachment.mime.toLowerCase().startsWith('audio/')
      || nativeAudioFormat(attachment.localPath) !== null
    if (!looksLikeAudio) continue
    consumedAttachmentPaths.add(resolved)
    const format = nativeAudioFormat(attachment.localPath, attachment.mime)
    if (!format) {
      // Upstream would 400 on this container; leave the path so the agent can transcode
      // (ffmpeg-win) or hand it to understand_audio instead of losing the file entirely.
      fallbackMentions.push(`${name}: ${attachment.localPath}`)
      continue
    }
    await relayLocal(attachment.localPath, AUDIO_MIME_BY_FORMAT[format], attachment.size, (url) => {
      pushSentinel({ kind: 'audio', url, format, name })
    }, name)
  }

  return { referenceItems, mediaItems, consumedAttachmentPaths, fallbackMentions }
}

function urlBasename(url: string): string | undefined {
  try {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop() ?? '')
    return name || undefined
  } catch {
    return undefined
  }
}
