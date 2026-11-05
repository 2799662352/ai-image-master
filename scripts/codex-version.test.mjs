/**
 * codex-version.mjs 的纯逻辑。跑法:node --test scripts/codex-version.test.mjs
 *
 * 这些规则出过的事:pin 钉成预发布 0.168.0-alpha.3 后,旧 parseVersion 只取前三段
 * (0.168.0),ensure-codex 每次 dev 都判「版本不一致」→ 丢缓存重下 350MB;
 * `--latest` 则会把 0.168.0-alpha.3 当成「落后于 0.166.0 的稳定版」去降级。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

const {
  parseCodexVersion,
  versionFromRustTag,
  isPrereleaseVersion,
  compareCodexVersions,
} = await import('./codex-version.mjs')

test('parseCodexVersion: 正式版', () => {
  assert.equal(parseCodexVersion('codex-cli 0.166.0'), '0.166.0')
  assert.equal(parseCodexVersion('codex-cli 0.166.0\n'), '0.166.0')
  assert.equal(parseCodexVersion('codex 0.150.0 (build abc123)'), '0.150.0')
})

test('parseCodexVersion: 预发布后缀要带上,不能截成 0.168.0', () => {
  assert.equal(parseCodexVersion('codex-cli 0.168.0-alpha.3'), '0.168.0-alpha.3')
  assert.equal(parseCodexVersion('codex-cli 0.168.0-alpha.3\r\n'), '0.168.0-alpha.3')
  assert.equal(parseCodexVersion('codex-cli 0.167.0-alpha.3.1'), '0.167.0-alpha.3.1')
  assert.equal(parseCodexVersion('codex-cli 0.132.0-rc.1 (abc)'), '0.132.0-rc.1')
})

test('parseCodexVersion: 没有版本号就是 null,两段数字不算', () => {
  assert.equal(parseCodexVersion('command not recognized'), null)
  assert.equal(parseCodexVersion('codex-cli 0.149'), null)
  assert.equal(parseCodexVersion(''), null)
  assert.equal(parseCodexVersion(undefined), null)
  assert.equal(parseCodexVersion(null), null)
})

test('versionFromRustTag: 只认 rust-v<semver>,预发布含四段的也认', () => {
  assert.equal(versionFromRustTag('rust-v0.166.0'), '0.166.0')
  assert.equal(versionFromRustTag('rust-v0.168.0-alpha.3'), '0.168.0-alpha.3')
  assert.equal(versionFromRustTag('rust-v0.167.0-alpha.3.1'), '0.167.0-alpha.3.1')
  for (const bad of ['v0.168.0', '0.168.0', 'rust-v0.168', 'npm-v1.0.0', 'rust-v0.168.0-', 'rust-v0.168.0 ', ' rust-v0.168.0', '', undefined, null]) {
    assert.equal(versionFromRustTag(bad), null, `应当拒绝 ${JSON.stringify(bad)}`)
  }
})

test('isPrereleaseVersion', () => {
  assert.equal(isPrereleaseVersion('0.168.0-alpha.3'), true)
  assert.equal(isPrereleaseVersion('0.166.0'), false)
  assert.equal(isPrereleaseVersion('latest'), false)
  assert.equal(isPrereleaseVersion(undefined), false)
})

test('compareCodexVersions: 核心版本号按数值比,不按字符串', () => {
  assert.equal(compareCodexVersions('0.166.0', '0.168.0'), -1)
  assert.equal(compareCodexVersions('0.168.0', '0.166.0'), 1)
  assert.equal(compareCodexVersions('0.9.0', '0.10.0'), -1)
  assert.equal(compareCodexVersions('1.0.0', '0.999.999'), 1)
  assert.equal(compareCodexVersions('0.166.0', '0.166.0'), 0)
})

test('compareCodexVersions: 预发布比同核心的正式版小,但比更旧的正式版大(--latest 不降级的依据)', () => {
  assert.equal(compareCodexVersions('0.168.0-alpha.3', '0.166.0'), 1)
  assert.equal(compareCodexVersions('0.168.0-alpha.3', '0.168.0'), -1)
  assert.equal(compareCodexVersions('0.168.0', '0.168.0-alpha.3'), 1)
})

test('compareCodexVersions: 预发布之间按 semver 标识符比较', () => {
  assert.equal(compareCodexVersions('0.168.0-alpha.2', '0.168.0-alpha.3'), -1)
  assert.equal(compareCodexVersions('0.168.0-alpha.3', '0.168.0-alpha.10'), -1) // 数值,不是字典序
  assert.equal(compareCodexVersions('0.167.0-alpha.3', '0.167.0-alpha.3.1'), -1) // 前缀相同,多一段更大
  assert.equal(compareCodexVersions('0.167.0-alpha.5', '0.167.0-alpha.3.1'), 1)
  assert.equal(compareCodexVersions('0.168.0-alpha.3', '0.168.0-beta.1'), -1)
  assert.equal(compareCodexVersions('0.168.0-alpha.3', '0.168.0-alpha.3'), 0)
  assert.equal(compareCodexVersions('0.168.0-1', '0.168.0-alpha'), -1) // 数字标识符 < 字母标识符
})

test('compareCodexVersions: 任何一边不是版本号 → null(不能当相等)', () => {
  assert.equal(compareCodexVersions('latest', '0.166.0'), null)
  assert.equal(compareCodexVersions('0.166.0', undefined), null)
  assert.equal(compareCodexVersions('0.166', '0.166.0'), null)
})
