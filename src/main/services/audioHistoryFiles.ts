// src/main/services/audioHistoryFiles.ts
/**
 * 音频作品库的本地文件存储(方案 A,2026-07-20)。
 *
 * 音频 base64 存 IndexedDB 又胖(+33%)又占结构化克隆开销,改为:字节落
 * `userData/audio-history/`,IndexedDB 只存元数据(路径/prompt/峰值)。
 * 播放走 `local-file://`(协议门放行 Sec-Fetch-Dest=audio 的流式加载);
 * 波形解码/下载走 read IPC(renderer fetch(local-file://) 会被协议门 403)。
 *
 * 所有函数接显式 baseDir 以便单测;IPC 注册处传 app.getPath('userData')。
 * read/delete 做目录包含校验 —— 渲染进程只能碰 audio-history 目录内的文件。
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'

export const AUDIO_HISTORY_DIRNAME = 'audio-history'

/** 扩展名白名单(与 seed-audio response_format 对齐)。 */
const SAFE_EXTENSIONS = new Set(['mp3', 'wav', 'ogg', 'pcm'])

export function audioHistoryDir(userDataDir: string): string {
  return path.join(userDataDir, AUDIO_HISTORY_DIRNAME)
}

/** ogg_opus / 未知值 → 安全扩展名。 */
export function extensionForFormat(format: string): string {
  const f = (format || '').toLowerCase()
  if (f.includes('opus') || f.includes('ogg')) return 'ogg'
  if (f.includes('wav')) return 'wav'
  if (f.includes('pcm')) return 'pcm'
  return 'mp3'
}

/** 路径必须位于 audio-history 目录内(realpath 前的词法校验足够:输入是我们自己返回的路径)。 */
export function isInsideAudioHistoryDir(userDataDir: string, filePath: string): boolean {
  const dir = path.resolve(audioHistoryDir(userDataDir))
  const resolved = path.resolve(filePath)
  return resolved.startsWith(dir + path.sep)
}

export async function saveAudioHistoryFile(
  userDataDir: string,
  base64: string,
  format: string,
): Promise<{ success: true; filePath: string } | { success: false; error: string }> {
  try {
    if (typeof base64 !== 'string' || base64.length === 0) {
      return { success: false, error: 'empty audio data' }
    }
    const ext = extensionForFormat(format)
    if (!SAFE_EXTENSIONS.has(ext)) return { success: false, error: `unsupported format: ${format}` }
    const dir = audioHistoryDir(userDataDir)
    await fs.promises.mkdir(dir, { recursive: true })
    const filename = `${Date.now()}-${randomBytes(4).toString('hex')}.${ext}`
    const filePath = path.join(dir, filename)
    await fs.promises.writeFile(filePath, Buffer.from(base64, 'base64'))
    return { success: true, filePath }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function readAudioHistoryFile(
  userDataDir: string,
  filePath: string,
): Promise<{ success: true; base64: string } | { success: false; error: string }> {
  try {
    if (typeof filePath !== 'string' || !isInsideAudioHistoryDir(userDataDir, filePath)) {
      return { success: false, error: 'path outside audio-history dir' }
    }
    const bytes = await fs.promises.readFile(filePath)
    return { success: true, base64: bytes.toString('base64') }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export async function deleteAudioHistoryFile(
  userDataDir: string,
  filePath: string,
): Promise<{ success: true } | { success: false; error: string }> {
  try {
    if (typeof filePath !== 'string' || !isInsideAudioHistoryDir(userDataDir, filePath)) {
      return { success: false, error: 'path outside audio-history dir' }
    }
    await fs.promises.rm(filePath, { force: true })
    return { success: true }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
