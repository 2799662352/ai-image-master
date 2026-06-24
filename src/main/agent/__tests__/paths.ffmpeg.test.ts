import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  getFfmpegBinaryName,
  getFfmpegResourceDir,
  resolveBundledFfmpegDir,
} from '../paths'

describe('ffmpeg paths', () => {
  const cleanup: string[] = []
  afterEach(() => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()
      if (dir) rmSync(dir, { recursive: true, force: true })
    }
  })

  it('getFfmpegBinaryName is ffmpeg.exe on win32, ffmpeg elsewhere', () => {
    expect(getFfmpegBinaryName('win32')).toBe('ffmpeg.exe')
    expect(getFfmpegBinaryName('linux')).toBe('ffmpeg')
    expect(getFfmpegBinaryName('darwin')).toBe('ffmpeg')
  })

  it('getFfmpegResourceDir mirrors the resources/ffmpeg/<platform>-<arch> layout', () => {
    expect(getFfmpegResourceDir('/res', 'win32', 'x64')).toBe(path.join('/res', 'ffmpeg', 'win32-x64'))
  })

  it('resolveBundledFfmpegDir returns the dir when the binary is present', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ffmpeg-paths-'))
    cleanup.push(root)
    const dir = getFfmpegResourceDir(root, 'win32', 'x64')
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'ffmpeg.exe'), 'stub')
    expect(resolveBundledFfmpegDir(root, 'win32', 'x64')).toBe(dir)
  })

  it('resolveBundledFfmpegDir returns null when the binary is absent (dev checkout / non-win)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'ffmpeg-paths-'))
    cleanup.push(root)
    // Directory exists but no ffmpeg.exe inside → must degrade to null.
    mkdirSync(getFfmpegResourceDir(root, 'win32', 'x64'), { recursive: true })
    expect(resolveBundledFfmpegDir(root, 'win32', 'x64')).toBeNull()
  })
})
