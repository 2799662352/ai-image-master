// 快照是「命令行改动也能看见」的基线。它错一次,整轮 diff 就是错的,
// 所以这里盯的全是**边界**:什么该跳过、什么该让整轮作废。
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SNAPSHOT_BUDGET, takeSnapshot } from '../workspaceSnapshot'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-snap-'))
})

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string | Buffer): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

describe('takeSnapshot', () => {
  it('收下文本文件的内容', async () => {
    await write('a.md', 'hello\n')
    await write('sub/b.ts', 'export const x = 1\n')

    const snap = await takeSnapshot([root])

    expect(snap.complete).toBe(true)
    expect(snap.files.get(path.join(root, 'a.md'))).toBe('hello\n')
    expect(snap.files.get(path.join(root, 'sub', 'b.ts'))).toBe('export const x = 1\n')
  })

  it('跳过产物目录 —— 否则 node_modules 一进来预算立刻爆', async () => {
    await write('node_modules/pkg/index.js', 'module.exports = 1\n')
    await write('.git/HEAD', 'ref: refs/heads/main\n')
    await write('dist/out.js', 'x\n')
    await write('keep.md', 'k\n')

    const snap = await takeSnapshot([root])

    expect([...snap.files.keys()]).toEqual([path.join(root, 'keep.md')])
  })

  it('二进制文件不进 files,但要进 skipped —— 免得被当成新建/删除', async () => {
    await write('bin.dat', Buffer.from([0x41, 0x00, 0x42]))

    const snap = await takeSnapshot([root])

    expect(snap.files.has(path.join(root, 'bin.dat'))).toBe(false)
    expect(snap.skipped.has(path.join(root, 'bin.dat'))).toBe(true)
  })

  it('超过单文件上限的也进 skipped', async () => {
    await write('big.md', 'x'.repeat(100))

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFileBytes: 10 })

    expect(snap.files.has(path.join(root, 'big.md'))).toBe(false)
    expect(snap.skipped.has(path.join(root, 'big.md'))).toBe(true)
  })

  it('文件数超预算 → complete:false 且不返回半份快照', async () => {
    await write('a.md', 'a\n')
    await write('b.md', 'b\n')
    await write('c.md', 'c\n')

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFiles: 2 })

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  it('总量超预算 → complete:false', async () => {
    await write('a.md', 'x'.repeat(60))
    await write('b.md', 'y'.repeat(60))

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxTotalBytes: 100 })

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  it('根目录不存在不抛错,当作空', async () => {
    const snap = await takeSnapshot([path.join(root, 'nope')])

    expect(snap.complete).toBe(true)
    expect(snap.files.size).toBe(0)
  })
})
