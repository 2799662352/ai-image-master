import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveStdioNodeCommand, whichNode } from '../stdioNodeCommand'

// 通用的「stdio MCP 用哪个可执行文件跑 node 脚本」逻辑。
// catimation 桥与运镜知识库都靠它：系统装了 node 就用 node，没装就把 Electron
// 自己当 node 用（ELECTRON_RUN_AS_NODE=1）。这块原先藏在 apiyi 的启动器里、
// 没有任何直接测试，这里补上。

describe('whichNode', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'which-node-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  // PATH 分隔符与 Windows 盘符的冒号会冲突（`C:\…` 在 POSIX 分支里会被劈开），
  // 所以涉及真实临时目录的用例一律跟随主机平台，不伪造 platform。
  const host = process.platform
  const sep = host === 'win32' ? ';' : ':'
  const exeName = host === 'win32' ? 'node.exe' : 'node'

  it('在 PATH 里找到 node 时返回绝对路径（Windows 按 PATHEXT 补扩展名）', async () => {
    const exe = path.join(dir, exeName)
    await writeFile(exe, '')
    expect(await whichNode(dir, '.EXE;.CMD', host)).toBe(exe)
  })

  it('PATHEXT 缺省时 Windows 回落到 .EXE;.CMD;.BAT', async () => {
    // win32 分支只用 `;` 分隔，在任何主机上都能安全地用真实目录跑。
    const exe = path.join(dir, 'node.exe')
    await writeFile(exe, '')
    expect(await whichNode(dir, undefined, 'win32')).toBe(exe)
  })

  it.skipIf(host === 'win32')('POSIX 下不加扩展名', async () => {
    const bin = path.join(dir, 'node')
    await writeFile(bin, '')
    expect(await whichNode(dir, undefined, 'linux')).toBe(bin)
  })

  it('按 PATH 顺序取第一个命中', async () => {
    const other = await mkdtemp(path.join(os.tmpdir(), 'which-node-b-'))
    try {
      await writeFile(path.join(dir, exeName), '')
      await writeFile(path.join(other, exeName), '')
      expect(await whichNode([other, dir].join(sep), '.EXE', host)).toBe(path.join(other, exeName))
    } finally {
      await rm(other, { recursive: true, force: true })
    }
  })

  it('PATH 里没有 node、或 PATH 为空串时返回 null', async () => {
    // 注意：不测 `undefined`——那会触发默认参数去读真实的 process.env.PATH。
    expect(await whichNode(dir, '.EXE', host)).toBeNull()
    expect(await whichNode('', '.EXE', host)).toBeNull()
  })
})

describe('resolveStdioNodeCommand', () => {
  it('系统有 node：直接用它，不需要额外环境变量', async () => {
    const resolved = await resolveStdioNodeCommand('/opt/electron', async () => '/usr/bin/node')
    expect(resolved).toEqual({ command: '/usr/bin/node', extraEnv: {} })
  })

  it('系统没有 node：回落到 Electron 自身并带上 ELECTRON_RUN_AS_NODE=1', async () => {
    const resolved = await resolveStdioNodeCommand('/opt/electron', async () => null)
    expect(resolved).toEqual({
      command: '/opt/electron',
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    })
  })
})
