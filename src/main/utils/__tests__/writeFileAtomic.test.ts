// @vitest-environment node
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ATOMIC_TMP_SUFFIX, writeFileAtomic } from '../writeFileAtomic'

// 用真文件系统:rename 覆盖已存在文件的语义是平台行为,mock 掉就测不到了。
// 只把 rename 注入成可控的,用来制造「被杀毒软件短暂锁住」。
let dir: string
let target: string

function errWithCode(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`simulated ${code}`), { code })
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'write-atomic-'))
  target = path.join(dir, 'cred.bin')
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('writes the content and leaves no temp file behind', async () => {
    await writeFileAtomic(target, Buffer.from('new'))
    expect((await fs.readFile(target)).toString()).toBe('new')
    expect(await fs.readdir(dir)).toEqual(['cred.bin'])
  })

  it('replaces an existing file', async () => {
    await fs.writeFile(target, 'old')
    await writeFileAtomic(target, Buffer.from('new'))
    expect((await fs.readFile(target)).toString()).toBe('new')
  })

  it('retries a transiently locked rename and then succeeds', async () => {
    await fs.writeFile(target, 'old')
    let calls = 0
    await writeFileAtomic(target, Buffer.from('new'), {
      delayMs: 0,
      rename: async (from, to) => {
        calls += 1
        if (calls < 3) throw errWithCode('EBUSY')
        await fs.rename(from, to)
      },
    })
    expect(calls).toBe(3)
    expect((await fs.readFile(target)).toString()).toBe('new')
  })

  // 这是不复用 `atomicFile.renameWithRetry` 的全部理由:它在「rename 失败但目标已存在」
  // 时当作成功。覆盖写的目标永远已存在,所以那样会静默地把旧内容当成新内容。
  it('THROWS when the rename keeps failing, and the old file is untouched (never reports a stale success)', async () => {
    await fs.writeFile(target, 'old')
    const rename = vi.fn(async () => {
      throw errWithCode('EBUSY')
    })
    await expect(writeFileAtomic(target, Buffer.from('new'), { attempts: 3, delayMs: 0, rename })).rejects.toMatchObject({
      code: 'EBUSY',
    })
    expect(rename).toHaveBeenCalledTimes(3)
    expect((await fs.readFile(target)).toString()).toBe('old')
  })

  it('removes its temp file when it fails (it holds encrypted credentials)', async () => {
    await fs.writeFile(target, 'old')
    await expect(
      writeFileAtomic(target, Buffer.from('new'), {
        rename: async () => {
          throw errWithCode('EXDEV')
        },
      }),
    ).rejects.toMatchObject({ code: 'EXDEV' })
    expect(await fs.readdir(dir)).toEqual(['cred.bin'])
    await expect(fs.access(target + ATOMIC_TMP_SUFFIX)).rejects.toBeTruthy()
  })

  it('does not retry an error that is not about the file being busy', async () => {
    const rename = vi.fn(async () => {
      throw errWithCode('ENOSPC')
    })
    await expect(writeFileAtomic(target, Buffer.from('x'), { delayMs: 0, rename })).rejects.toMatchObject({
      code: 'ENOSPC',
    })
    expect(rename).toHaveBeenCalledTimes(1)
  })
})
