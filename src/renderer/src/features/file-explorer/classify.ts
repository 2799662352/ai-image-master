import type { FileTabKind } from './types'

export const TEXT_EDIT_LIMIT = 10 * 1024 * 1024

export const TEXT_EXT = new Set([
  'js',
  'jsx',
  'ts',
  'tsx',
  'json',
  'html',
  'css',
  'md',
  'py',
  'yaml',
  'yml',
  'sh',
  'txt',
  'log',
  '',
])

const IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif', 'ico'])
const VIDEO_EXT = new Set(['mp4', 'webm', 'ogg', 'ogv', 'mov', 'm4v'])
/**
 * `ogg` 刻意不在这里 —— 它同时是音频和视频容器,而上面 VIDEO_EXT 已经占了它。
 * 判不准的时候按视频走:`<video>` 放纯音频轨能出声(只是画面全黑),反过来
 * `<audio>` 放带画面的 ogv 就只剩声音,后者的损失更大。
 */
const AUDIO_EXT = new Set(['mp3', 'wav', 'flac', 'aac', 'm4a', 'oga', 'opus', 'weba', 'wma', 'aiff', 'aif'])

export function classify(name: string, size: number, mime?: string): FileTabKind {
  const ext = name.includes('.') ? (name.toLowerCase().split('.').pop() ?? '') : ''
  if (mime?.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image'
  if (mime?.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video'
  if (mime?.startsWith('audio/') || AUDIO_EXT.has(ext)) return 'audio'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (size > TEXT_EDIT_LIMIT) return 'binary'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'binary'
}
