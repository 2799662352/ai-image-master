// 快照是「命令行改动也能看见」的基线。它错一次,整轮 diff 就是错的,
// 所以这里盯的全是**边界**:什么该跳过、什么该让整轮作废。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DEFAULT_SNAPSHOT_BUDGET, takeSnapshot } from '../workspaceSnapshot'

let root: string

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-snap-'))
})

afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(root, { recursive: true, force: true })
})

async function write(rel: string, content: string | Buffer): Promise<void> {
  const full = path.join(root, rel)
  await fs.mkdir(path.dirname(full), { recursive: true })
  await fs.writeFile(full, content)
}

/** Windows 上没开发者模式/管理员权限就建不了链接,建不了就让调用方跳过用例。 */
async function trySymlink(target: string, rel: string, type: 'dir' | 'file'): Promise<boolean> {
  try {
    await fs.symlink(target, path.join(root, rel), type)
    return true
  } catch {
    return false
  }
}

describe('takeSnapshot', () => {
  // 这条现在是靠 Dirent 的 lstat 语义自动成立的。钉住它,是因为哪天有人把
  // isFile() 换成 fs.stat(跟随链接),环就会静悄悄地回来,而症状是扫描变慢
  // 或整轮作废 —— 不会有人第一时间想到链接。
  it('不跟符号链接 —— 目录环不能把遍历带进无限深,链接文件也不收内容', async (ctx) => {
    await write('real.md', 'real\n')
    // root/loop → root 自己:跟进去就是无限递归。
    const madeDirLink = await trySymlink(root, 'loop', 'dir')
    const madeFileLink = await trySymlink(path.join(root, 'real.md'), 'alias.md', 'file')
    if (!madeDirLink || !madeFileLink) ctx.skip()

    const snap = await takeSnapshot([root])

    expect(snap.complete).toBe(true)
    expect([...snap.files.keys()]).toEqual([path.join(root, 'real.md')])
    expect(snap.skipped.has(path.join(root, 'alias.md'))).toBe(false)
  })

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

  it('嗅探窗口之外的 NUL 不算二进制 —— 只看前 8192 字节', async () => {
    // 9000 字节纯文本 + 一个 NUL:NUL 落在嗅探窗口外,文件必须照收。
    // 若实现偷懒用 buf.includes(0) 扫全文,这条就会红。
    await write('late-nul.txt', `${'a'.repeat(9000)}\u0000`)

    const snap = await takeSnapshot([root])

    expect(snap.complete).toBe(true)
    expect(snap.files.has(path.join(root, 'late-nul.txt'))).toBe(true)
    expect(snap.skipped.has(path.join(root, 'late-nul.txt'))).toBe(false)
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

  // ---- 闸门都要在「正好等于上限」时放行 ----
  // 只测超限,把 `>` 写成 `>=` 也全绿,而那会平白少收一个文件。

  it('文件数正好等于上限 → 放行', async () => {
    await write('a.md', 'a\n')
    await write('b.md', 'b\n')
    await write('c.md', 'c\n')

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFiles: 3 })

    expect(snap.complete).toBe(true)
    expect(snap.files.size).toBe(3)
  })

  it('总字节数正好等于上限 → 放行', async () => {
    await write('a.md', 'x'.repeat(60))
    await write('b.md', 'y'.repeat(60))

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxTotalBytes: 120 })

    expect(snap.complete).toBe(true)
    expect(snap.files.size).toBe(2)
  })

  it('单文件字节数正好等于上限 → 收下,不进 skipped', async () => {
    await write('exact.md', 'x'.repeat(10))

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFileBytes: 10 })

    expect(snap.complete).toBe(true)
    expect(snap.files.get(path.join(root, 'exact.md'))).toBe('x'.repeat(10))
    expect(snap.skipped.has(path.join(root, 'exact.md'))).toBe(false)
  })

  // ---- 读不动的目录 ----

  it('root 之下的目录读不动 → complete:false,绝不当成空目录咽下去', async () => {
    await write('keep.md', 'k\n')
    await write('locked/inner.md', 'i\n')
    const denied = path.join(root, 'locked')

    // 用 spy 制造 EACCES:POSIX 的 chmod 在 Windows 上不生效,而这里就跑在
    // Windows 上,只有 mock 才是确定性的。
    const realReaddir = fs.readdir
    vi.spyOn(fs, 'readdir').mockImplementation((async (target: string, options: never) => {
      if (path.resolve(String(target)) === denied) {
        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
      }
      return realReaddir(target, options)
    }) as unknown as typeof fs.readdir)

    const snap = await takeSnapshot([root])

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  it('root 存在但不是目录(ENOTDIR)→ complete:false,只有 ENOENT 才算合法的空', async () => {
    await write('a-file.md', 'x\n')

    const snap = await takeSnapshot([path.join(root, 'a-file.md')])

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  // ---- 跳过的文件不占文件数配额 ----

  it('二进制/超大文件不消耗 maxFiles —— 它们根本没进 files', async () => {
    await write('bin1.dat', Buffer.from([0x00, 0x01]))
    await write('bin2.dat', Buffer.from([0x00, 0x02]))
    await write('a.md', 'a\n')
    await write('b.md', 'b\n')

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxFiles: 2 })

    expect(snap.complete).toBe(true)
    expect(snap.files.size).toBe(2)
    expect(snap.skipped.size).toBe(2)
  })

  // ---- 扫描条目数本身也是闸门 ----

  it('走过的条目数超 maxEntries → complete:false(留不下的也算)', async () => {
    await write('bin.dat', Buffer.from([0x00, 0x01]))
    await write('a.md', 'a\n')
    await write('b.md', 'b\n')

    const snap = await takeSnapshot([root], { ...DEFAULT_SNAPSHOT_BUDGET, maxEntries: 2 })

    expect(snap.complete).toBe(false)
    expect(snap.files.size).toBe(0)
  })

  // ---- 多个 root ----

  it('两个互不相交的 root 都要收进来', async () => {
    const other = await fs.mkdtemp(path.join(os.tmpdir(), 'ws-snap-b-'))
    try {
      await write('a.md', 'a\n')
      await fs.writeFile(path.join(other, 'b.md'), 'b\n')

      const snap = await takeSnapshot([root, other])

      expect(snap.complete).toBe(true)
      expect(snap.files.get(path.join(root, 'a.md'))).toBe('a\n')
      expect(snap.files.get(path.join(other, 'b.md'))).toBe('b\n')
    } finally {
      await fs.rm(other, { recursive: true, force: true })
    }
  })

  it('嵌套的 root 不把同一个文件的字节数记两遍', async () => {
    await write('sub/big.md', 'x'.repeat(60))

    // sub 下这 60 字节只该算一次。若重复计数就是 120,正好把 100 的闸门撞爆。
    const snap = await takeSnapshot([root, path.join(root, 'sub')], {
      ...DEFAULT_SNAPSHOT_BUDGET,
      maxTotalBytes: 100,
    })

    expect(snap.complete).toBe(true)
    expect(snap.files.size).toBe(1)
    expect(snap.files.get(path.join(root, 'sub', 'big.md'))).toBe('x'.repeat(60))
  })
})
