import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { handleReadText, handleWriteText, handleListDir, handleStat, TEXT_READ_LIMIT } from '../fsIpc'

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsipc-'))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('handleReadText', () => {
  it('reads UTF-8 content and mtime', async () => {
    const f = path.join(dir, 'a.txt')
    await fs.writeFile(f, 'hello', 'utf-8')
    const r = await handleReadText(f)
    expect(r.content).toBe('hello')
    expect(r.mtime).toBeGreaterThan(0)
  })

  it('rejects files larger than TEXT_READ_LIMIT', async () => {
    const f = path.join(dir, 'big.bin')
    await fs.writeFile(f, Buffer.alloc(TEXT_READ_LIMIT + 1, 0))
    await expect(handleReadText(f)).rejects.toThrow(/too large/i)
  })

  it('rejects directories', async () => {
    await expect(handleReadText(dir)).rejects.toThrow(/not a file/i)
  })
})

describe('handleWriteText', () => {
  it('writes content and returns new mtime', async () => {
    const f = path.join(dir, 'b.txt')
    const r = await handleWriteText({ path: f, content: 'world' })
    expect(r.mtime).toBeGreaterThan(0)
    expect(await fs.readFile(f, 'utf-8')).toBe('world')
  })
})

describe('handleListDir', () => {
  it('returns dirs first then files, alphabetical', async () => {
    await fs.writeFile(path.join(dir, 'b.txt'), '')
    await fs.writeFile(path.join(dir, 'a.txt'), '')
    await fs.mkdir(path.join(dir, 'zfolder'))
    const r = await handleListDir(dir)
    expect(r.map((n) => n.name)).toEqual(['zfolder', 'a.txt', 'b.txt'])
    expect(r[0].kind).toBe('dir')
    expect(r[1].kind).toBe('file')
  })

  it('skips .git', async () => {
    await fs.mkdir(path.join(dir, '.git'))
    await fs.writeFile(path.join(dir, 'visible.txt'), '')
    const r = await handleListDir(dir)
    expect(r.find((n) => n.name === '.git')).toBeUndefined()
    expect(r.find((n) => n.name === 'visible.txt')).toBeDefined()
  })

  it('does NOT skip dotfiles other than .git', async () => {
    await fs.writeFile(path.join(dir, '.env'), 'X=1')
    const r = await handleListDir(dir)
    expect(r.find((n) => n.name === '.env')).toBeDefined()
  })
})

describe('handleStat', () => {
  it('returns size + mime guess', async () => {
    const f = path.join(dir, 'pic.png')
    await fs.writeFile(f, Buffer.alloc(100))
    const r = await handleStat(f)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.size).toBe(100)
      expect(r.mime).toBe('image/png')
    }
  })

  it('returns ok:false for missing files', async () => {
    const r = await handleStat(path.join(dir, 'missing.png'))
    expect(r.ok).toBe(false)
  })
})
