// @vitest-environment node
//
// 「写临时文件 → 原子落位」的通用件。视频与图片两条下载路径共用它,所以这里的
// 每条断言同时守着两处。

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'af-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('renameWithRetry — Windows 上杀软会锁住刚落盘的大文件', () => {
  it('EBUSY 时重试,最终成功', async () => {
    const { renameWithRetry } = await import('../atomicFile')
    const from = path.join(tmpDir, 'a.part')
    const to = path.join(tmpDir, 'a.mp4')
    await fs.writeFile(from, 'data')

    let calls = 0
    const rename = async (f: string, t: string): Promise<void> => {
      calls += 1
      if (calls < 3) throw Object.assign(new Error('EBUSY: resource busy'), { code: 'EBUSY' })
      await fs.rename(f, t)
    }

    await renameWithRetry(from, to, { rename, delayMs: 0 })

    expect(calls).toBe(3)
    expect(await fs.readFile(to, 'utf8')).toBe('data')
  })

  it('非 EBUSY 错误立刻抛出,不空转', async () => {
    const { renameWithRetry } = await import('../atomicFile')
    let calls = 0
    const rename = async (): Promise<void> => {
      calls += 1
      throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
    }

    await expect(
      renameWithRetry(path.join(tmpDir, 'x.part'), path.join(tmpDir, 'x.mp4'), {
        rename,
        delayMs: 0,
      }),
    ).rejects.toThrow(/EACCES/)
    expect(calls).toBe(1)
  })

  // 并发或重试场景下另一次调用可能已经把文件放好了,这时报错是错的。
  it('rename 失败但目标已存在时按成功处理,并清掉源文件', async () => {
    const { renameWithRetry } = await import('../atomicFile')
    const from = path.join(tmpDir, 'b.part')
    const to = path.join(tmpDir, 'b.mp4')
    await fs.writeFile(from, 'mine')
    await fs.writeFile(to, 'already there')

    const rename = async (): Promise<void> => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' })
    }

    await renameWithRetry(from, to, { rename, delayMs: 0 })

    expect(await fs.readFile(to, 'utf8')).toBe('already there')
    await expect(fs.access(from)).rejects.toThrow()
  })

  it('EBUSY 一直不消失则最终抛出', async () => {
    const { renameWithRetry } = await import('../atomicFile')
    let calls = 0
    const rename = async (): Promise<void> => {
      calls += 1
      throw Object.assign(new Error('EBUSY'), { code: 'EBUSY' })
    }

    await expect(
      renameWithRetry(path.join(tmpDir, 'c.part'), path.join(tmpDir, 'c.mp4'), {
        rename,
        delayMs: 0,
        attempts: 4,
      }),
    ).rejects.toThrow(/EBUSY/)
    expect(calls).toBe(4)
  })
})

describe('cleanupOrphanParts', () => {
  it('删掉残留的 .part,不动别的文件', async () => {
    const { cleanupOrphanParts } = await import('../atomicFile')
    await fs.writeFile(path.join(tmpDir, 'a.mp4.part'), 'x')
    await fs.writeFile(path.join(tmpDir, 'b.mp4.part'), 'y')
    await fs.writeFile(path.join(tmpDir, 'keep.mp4'), 'z')

    expect(await cleanupOrphanParts(tmpDir)).toBe(2)
    expect(await fs.readdir(tmpDir)).toEqual(['keep.mp4'])
  })

  // 这是启动路径上的清理动作,它自己出问题不该拖垮应用启动。
  it('目录不存在时安静返回 0,不抛错', async () => {
    const { cleanupOrphanParts } = await import('../atomicFile')
    expect(await cleanupOrphanParts(path.join(tmpDir, 'nope'))).toBe(0)
  })

  it('没有 .part 时返回 0', async () => {
    const { cleanupOrphanParts } = await import('../atomicFile')
    await fs.writeFile(path.join(tmpDir, 'only.mp4'), 'z')
    expect(await cleanupOrphanParts(tmpDir)).toBe(0)
  })
})
