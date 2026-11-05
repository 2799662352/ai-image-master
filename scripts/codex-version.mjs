/**
 * Codex 版本号的纯逻辑,被 `ensure-codex.mjs`(读二进制自报版本)和
 * `fetch-codex.ts`(决定要不要升级)共用。
 *
 * 为什么要认预发布后缀:`package.json.codexCliVersion` 可以钉成
 * `0.168.0-alpha.3` 这样的预发布版本,而 `codex --version` 会如实打印
 * `codex-cli 0.168.0-alpha.3`。如果只取前三段数字(`0.168.0`),`ensure-codex`
 * 会永远认为「resources 里的二进制和 pin 不一致」—— 每次 `pnpm dev` 都丢缓存、重下
 * 350MB,下完再因为「报告成功但版本不对」抛错。
 */

// `0.168.0`、`0.168.0-alpha.3`、`0.167.0-alpha.3.1`(上游真的发过四段的预发布)。
// 只有三段数字才算版本号:`0.149` 不是。
const VERSION_PATTERN = /(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)/
const RUST_TAG_PATTERN = /^rust-v(\d+\.\d+\.\d+(?:-[0-9A-Za-z][0-9A-Za-z.]*)?)$/

/** 从 `codex --version` 的输出里取版本号;没有就是 `null`,绝不瞎猜。 */
export function parseCodexVersion(output) {
  const match = VERSION_PATTERN.exec(String(output ?? ''))
  return match ? match[1] : null
}

/** `rust-v0.168.0-alpha.3` → `0.168.0-alpha.3`;不是 rust-v 标签 → `null`。 */
export function versionFromRustTag(tag) {
  const match = RUST_TAG_PATTERN.exec(String(tag ?? ''))
  return match ? match[1] : null
}

/** `0.168.0-alpha.3` → true;`0.166.0` → false;不是版本号 → false。 */
export function isPrereleaseVersion(version) {
  const parsed = splitVersion(version)
  return parsed !== null && parsed.pre.length > 0
}

function splitVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z][0-9A-Za-z.]*))?$/.exec(String(version ?? ''))
  if (!match) return null
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split('.') : [],
  }
}

function compareIdentifier(a, b) {
  const aNum = /^\d+$/.test(a)
  const bNum = /^\d+$/.test(b)
  if (aNum && bNum) return Math.sign(Number(a) - Number(b))
  // semver:数字标识符比字母标识符小。
  if (aNum) return -1
  if (bNum) return 1
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * semver 优先级比较:`-1` / `0` / `1`;任何一边不是合法版本号返回 `null`,
 * 调用方必须当作「不知道」而不是「相等」。预发布 < 同核心的正式版
 * (`0.168.0-alpha.3` < `0.168.0`),但 `0.168.0-alpha.3` > `0.166.0`。
 */
export function compareCodexVersions(left, right) {
  const a = splitVersion(left)
  const b = splitVersion(right)
  if (!a || !b) return null
  for (let i = 0; i < 3; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1
  }
  if (a.pre.length === 0 && b.pre.length === 0) return 0
  if (a.pre.length === 0) return 1
  if (b.pre.length === 0) return -1
  const shared = Math.min(a.pre.length, b.pre.length)
  for (let i = 0; i < shared; i += 1) {
    const c = compareIdentifier(a.pre[i], b.pre[i])
    if (c !== 0) return c
  }
  return Math.sign(a.pre.length - b.pre.length)
}
