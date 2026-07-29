/**
 * 「一串本地路径 → 按类型分好的素材」。
 *
 * 存在的理由:从**文件树**拖进工作台时我们只拿到路径,没有 `File` 对象 ——
 * 整卡的 `addFiles` 那条路走 `classifyFiles`(按 File.type 的 MIME 分流),对纯路径
 * 无从下手。所以这里按扩展名分,纯函数、可单测。
 *
 * 扩展名表跟 `fsIpc` 的 MIME 表对齐(它决定了缩略图/读取能不能过),但刻意只列
 * Seedance 真正吃得下的那些 —— 多列一个不支持的格式,代价是用户拖进来、看到素材
 * 进了卡、提交时才被上游拒。
 */

import type { VideoWorkbenchMaterial } from '../../../../types/videoWorkbench'
import { toMaterial } from './cardSpec'
import type { MediaTokenKind } from './promptTokens'

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'mov', 'm4v', 'mkv', 'avi'])
const AUDIO_EXT = new Set(['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'])

/** 扩展名(小写、不含点);无扩展名返回空串。 */
export function extensionOf(pathOrUrl: string): string {
  const clean = pathOrUrl.split(/[?#]/)[0]
  const base = clean.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
}

export function kindOfPath(pathOrUrl: string): MediaTokenKind | null {
  const ext = extensionOf(pathOrUrl)
  if (IMAGE_EXT.has(ext)) return 'image'
  if (VIDEO_EXT.has(ext)) return 'video'
  if (AUDIO_EXT.has(ext)) return 'audio'
  return null
}

export type MaterialsByKind = Record<MediaTokenKind, VideoWorkbenchMaterial[]>

/**
 * 按类型分组。认不出类型的路径**直接丢弃**而不是猜成图片 —— 把一个 .txt 塞进
 * 参考图里,错误会推迟到提交时才由上游报出来,那时更难查。
 */
export function materialsFromPaths(paths: readonly string[]): MaterialsByKind {
  const out: MaterialsByKind = { image: [], video: [], audio: [] }
  for (const p of paths) {
    const kind = kindOfPath(p)
    if (!kind) continue
    out[kind].push(toMaterial(p))
  }
  return out
}
