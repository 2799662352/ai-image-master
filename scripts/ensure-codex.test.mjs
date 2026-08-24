/**
 * ensure-codex 的版本判定 —— 它错在任何一个方向都会静默出事(2026-08-24 实录):
 * 把旧二进制认成新的 → 整台机器的 worktree 跟着用错版本;把好的认成坏的 → 每次
 * dev 都白下 350MB。所以「读不出来必须是 null,绝不能当成匹配」是这里的核心不变式。
 *
 * 分两层测:parseVersion 是纯逻辑,穷举;probeVersion 只验 spawn 边界(真二进制 /
 * 文件不存在 / 不可执行),不去造假 codex —— 在 Windows 上造假二进制是在跟平台的
 * 执行规则较劲,测的是脚手架不是产品。
 *
 * 跑法与同目录 scripts/release/*.test.mjs 一致:node --test scripts/ensure-codex.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { spawnSync } from 'node:child_process'

const { parseVersion, probeVersion, pinnedFetchSpawn } = await import('./ensure-codex.mjs')

const tmp = mkdtempSync(path.join(os.tmpdir(), 'ensure-codex-'))
test.after(() => rmSync(tmp, { recursive: true, force: true }))

test('parseVersion: 读出正常输出里的版本号', () => {
  assert.equal(parseVersion('codex-cli 0.149.1'), '0.149.1')
  assert.equal(parseVersion('codex-cli 0.149.1\n'), '0.149.1')
})

test('parseVersion: 不依赖 codex-cli 前缀 —— 上游改了措辞不该让每个 checkout 变成「版本未知」', () => {
  assert.equal(parseVersion('0.149.1'), '0.149.1')
  assert.equal(parseVersion('codex 0.150.0 (build abc123)'), '0.150.0')
})

test('parseVersion: 没有版本号就是 null，绝不瞎猜', () => {
  assert.equal(parseVersion('command not recognized'), null)
  assert.equal(parseVersion(''), null)
  assert.equal(parseVersion(undefined), null)
  assert.equal(parseVersion(null), null)
})

test('parseVersion: 两段数字不算版本号（别把 0.149 认成 0.149.0）', () => {
  assert.equal(parseVersion('codex-cli 0.149'), null)
})

test('probeVersion: 文件不存在 → null（不是抛异常）', () => {
  assert.equal(probeVersion(path.join(tmp, 'nope-does-not-exist')), null)
})

test('probeVersion: 文件在但跑不起来 → null —— AV 拦截 / 半个文件不能算匹配', () => {
  const junk = path.join(tmp, 'not-an-executable.bin')
  writeFileSync(junk, 'this is not a program')
  assert.equal(probeVersion(junk), null)
})

test('probeVersion: null 与任何 pin 都不相等（「读不出来别当成匹配」的落地形式）', () => {
  assert.notEqual(probeVersion(path.join(tmp, 'missing')), '0.149.1')
})

test('probeVersion: 对真实 codex 二进制能读出版本（有就测，没有就跳过）', (t) => {
  const real = path.join(
    import.meta.dirname,
    '..',
    'resources',
    'codex',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? 'codex.exe' : 'codex',
  )
  if (!existsSync(real)) {
    t.skip('本 checkout 尚未 provision codex 二进制')
    return
  }
  const version = probeVersion(real)
  assert.match(String(version), /^\d+\.\d+\.\d+$/)
})

test('pinnedFetchSpawn: 必须带 shell —— Windows 上 pnpm 是 .cmd，不带就 EINVAL 起不来', () => {
  const spawn = pinnedFetchSpawn()
  assert.equal(spawn.shell, true)
  assert.deepEqual(spawn.args, ['exec', 'tsx', 'scripts/fetch-codex.ts'])
  assert.equal(spawn.command, process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm')
})

test('平台事实存档:不带 shell 起 .cmd 确实失败（仅 Windows）', (t) => {
  if (process.platform !== 'win32') {
    t.skip('这条约束只存在于 Windows')
    return
  }
  // 上面那条断言的「为什么」。Node 18.20 / 20.12 起(CVE-2024-27980 加固)拒绝在无
  // shell 的情况下启动 .cmd/.bat。哪天 Node 放宽了这条，这个测试会先亮，
  // 而不是等到某人发现 ensure-codex 的下载路径悄悄坏了三个版本。
  const withoutShell = spawnSync('pnpm.cmd', ['--version'], { encoding: 'utf8' })
  assert.equal(withoutShell.error?.code, 'EINVAL')

  const withShell = spawnSync('pnpm.cmd', ['--version'], { encoding: 'utf8', shell: true })
  assert.equal(withShell.status, 0)
})

test('导入模块不会触发真实 provision（否则跑测试就下 350MB）', () => {
  // 能走到这里就说明 main() 没在 import 时执行。
  assert.equal(typeof probeVersion, 'function')
})
