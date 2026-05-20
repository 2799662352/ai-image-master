import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { handleImportExternal, setFsAllowedRoots } from '../fsIpc'

let workspace: string
let outside: string

beforeEach(() => {
  workspace = mkdtempSync(path.join(tmpdir(), 'fsipc-ws-'))
  outside = mkdtempSync(path.join(tmpdir(), 'fsipc-ext-'))
  setFsAllowedRoots([workspace])
})

afterEach(() => {
  rmSync(workspace, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
  setFsAllowedRoots([])
})

describe('handleImportExternal', () => {
  it('copies an external file into a workspace dir', async () => {
    const src = path.join(outside, 'photo.png')
    writeFileSync(src, Buffer.from([1, 2, 3]))

    const res = await handleImportExternal({ sources: [src], destDir: workspace })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.written).toHaveLength(1)
    expect(path.basename(res.written[0])).toBe('photo.png')
    expect(existsSync(res.written[0])).toBe(true)
  })

  it('uses uniquePath copy-suffix for name conflicts (VSCode style)', async () => {
    writeFileSync(path.join(workspace, 'photo.png'), 'pre-existing')
    const src = path.join(outside, 'photo.png')
    writeFileSync(src, 'new-content')

    const res = await handleImportExternal({ sources: [src], destDir: workspace })

    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(path.basename(res.written[0])).toBe('photo copy.png')
  })

  it('rejects directory sources with reason "is_dir"', async () => {
    const srcDir = path.join(outside, 'folder')
    mkdirSync(srcDir)
    writeFileSync(path.join(srcDir, 'inner.txt'), 'x')

    const res = await handleImportExternal({ sources: [srcDir], destDir: workspace })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('is_dir')
  })

  it('rejects files larger than 200MB with reason "oversize"', async () => {
    // We use a sparse file via fs.truncate: tiny disk footprint, but stat
    // reports the truncated size, which is what the size guard reads.
    const src = path.join(outside, 'huge.bin')
    writeFileSync(src, Buffer.alloc(1))
    const fd = await import('node:fs/promises').then((m) => m.open(src, 'r+'))
    await fd.truncate(201 * 1024 * 1024)
    await fd.close()

    const res = await handleImportExternal({ sources: [src], destDir: workspace })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('oversize')
  })

  it('rejects destDir outside allowed roots with reason matching "outside allowed roots"', async () => {
    const src = path.join(outside, 'x.txt')
    writeFileSync(src, 'x')

    const res = await handleImportExternal({ sources: [src], destDir: outside })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toMatch(/outside allowed roots/i)
  })

  it('fails fast on first directory source; written lists successes before failure', async () => {
    const okSrc = path.join(outside, 'ok.txt')
    const dirSrc = path.join(outside, 'subdir')
    writeFileSync(okSrc, 'good')
    mkdirSync(dirSrc)

    const res = await handleImportExternal({ sources: [okSrc, dirSrc], destDir: workspace })

    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.reason).toBe('is_dir')
    // The first source copied OK before the dir was reached:
    expect(res.written ?? []).toHaveLength(1)
    expect(path.basename(res.written![0])).toBe('ok.txt')
  })
})
