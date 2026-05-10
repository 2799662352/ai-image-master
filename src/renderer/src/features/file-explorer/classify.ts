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

export function classify(name: string, size: number, mime?: string): FileTabKind {
  const ext = name.includes('.') ? (name.toLowerCase().split('.').pop() ?? '') : ''
  if (mime?.startsWith('image/') || IMAGE_EXT.has(ext)) return 'image'
  if (mime?.startsWith('video/') || VIDEO_EXT.has(ext)) return 'video'
  if (mime === 'application/pdf' || ext === 'pdf') return 'pdf'
  if (size > TEXT_EDIT_LIMIT) return 'binary'
  if (TEXT_EXT.has(ext)) return 'text'
  return 'binary'
}
