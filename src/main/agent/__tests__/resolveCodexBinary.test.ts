import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { getCodexResourceDir, getCodexBinaryName } from '../paths'

describe('codex binary paths', () => {
  it('uses codex.exe on Windows', () => {
    expect(getCodexBinaryName('win32')).toBe('codex.exe')
  })

  it('uses codex on POSIX platforms', () => {
    expect(getCodexBinaryName('linux')).toBe('codex')
    expect(getCodexBinaryName('darwin')).toBe('codex')
  })

  it('builds a platform-arch resource directory', () => {
    expect(getCodexResourceDir('/app/resources', 'win32', 'x64')).toBe(
      path.join('/app/resources', 'codex', 'win32-x64'),
    )
  })
})
