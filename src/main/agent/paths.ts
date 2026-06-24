import { existsSync } from 'node:fs'
import path from 'node:path'

export function getCodexBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'codex.exe' : 'codex'
}

export function getFfmpegBinaryName(platform = process.platform): string {
  return platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
}

/**
 * Directory that holds the bundled gyan.dev ffmpeg/ffprobe (+ shared DLLs) for
 * a given target. Mirrors the `resources/codex/<platform>-<arch>` layout and
 * the `extraResources` mapping in electron-builder.yml.
 */
export function getFfmpegResourceDir(resourcesPath: string, platform = process.platform, arch = process.arch): string {
  return path.join(resourcesPath, 'ffmpeg', `${platform}-${arch}`)
}

/**
 * Resolve the bundled ffmpeg directory for PATH injection. Returns `null` when
 * the binary is absent (e.g. a dev checkout that never ran `ffmpeg:fetch`, or a
 * non-Windows target where gyan ships nothing) so callers degrade gracefully to
 * the system PATH / Docker ffmpeg instead of pointing Codex at a missing exe.
 */
export function resolveBundledFfmpegDir(
  resourcesPath: string,
  platform = process.platform,
  arch = process.arch,
): string | null {
  const dir = getFfmpegResourceDir(resourcesPath, platform, arch)
  const binary = path.join(dir, getFfmpegBinaryName(platform))
  return existsSync(binary) ? dir : null
}

export function getCodexResourceDir(resourcesPath: string, platform = process.platform, arch = process.arch): string {
  return path.join(resourcesPath, 'codex', `${platform}-${arch}`)
}

export function resolveCodexBinary(resourcesPath: string): string {
  return path.join(getCodexResourceDir(resourcesPath), getCodexBinaryName())
}

export function getCodexResourceRoot(options: {
  appPath: string
  isPackaged: boolean
  resourcesPath?: string
}): string {
  return options.isPackaged && options.resourcesPath
    ? options.resourcesPath
    : path.join(options.appPath, 'resources')
}
