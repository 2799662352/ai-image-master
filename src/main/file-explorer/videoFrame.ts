import { execFile } from 'node:child_process'
import path from 'node:path'
import { app } from 'electron'
import { getCodexResourceRoot, getFfmpegBinaryName, resolveBundledFfmpegDir } from '../agent/paths'

/**
 * 用安装包自带的 ffmpeg 从本地视频截一帧 JPEG(缩略图用)。
 *
 * 只读开头一小段:`-ss` 放在 `-i` 前面是按关键帧快速定位,不解码整段;几百 MB 的
 * 成片也是毫秒到一两秒。截 0.5s 而不是 0s,是因为不少片子第一帧是黑场。片长不足
 * 0.5s 时那一刀落空、没有输出,再从 0s 截一次。
 *
 * 拿不到(dev 检出没跑过 `ffmpeg:fetch`、文件坏了、超时)一律回 null,调用方退回图标。
 */

const FRAME_TIMEOUT_MS = 15_000
const MAX_FRAME_BYTES = 8 * 1024 * 1024

function bundledFfmpegPath(): string | null {
  try {
    const root = getCodexResourceRoot({
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
    })
    const dir = resolveBundledFfmpegDir(root)
    return dir ? path.join(dir, getFfmpegBinaryName()) : null
  } catch {
    return null
  }
}

function grabAt(bin: string, videoPath: string, size: number, seekSeconds: number): Promise<Buffer | null> {
  const args = [
    '-hide_banner',
    '-loglevel',
    'error',
    ...(seekSeconds > 0 ? ['-ss', String(seekSeconds)] : []),
    '-i',
    videoPath,
    '-frames:v',
    '1',
    '-vf',
    `scale=${size}:${size}:force_original_aspect_ratio=decrease`,
    '-f',
    'image2pipe',
    '-vcodec',
    'mjpeg',
    '-q:v',
    '5',
    'pipe:1',
  ]
  return new Promise((resolve) => {
    execFile(
      bin,
      args,
      { encoding: 'buffer', maxBuffer: MAX_FRAME_BYTES, timeout: FRAME_TIMEOUT_MS, windowsHide: true },
      (err, stdout) => resolve(!err && stdout.length > 0 ? stdout : null),
    )
  })
}

export async function grabVideoFrame(videoPath: string, size: number): Promise<Buffer | null> {
  const bin = bundledFfmpegPath()
  if (!bin) return null
  return (await grabAt(bin, videoPath, size, 0.5)) ?? (await grabAt(bin, videoPath, size, 0))
}
