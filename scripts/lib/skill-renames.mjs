/**
 * 旧 skill 名 → 现名的映射表，以及它的不变量校验。
 *
 * ## 为什么需要它
 *
 * 我们逐条目安装进**共享的平铺命名空间** `~/.agents/skills/<name>/`。改名之后，
 * 新名字装进来，旧目录既不被覆盖（不在新包里）也不被删除（台账已被整条替换），
 * 变成既不更新也删不掉的孤儿 —— 而它的正文引用的还是老名字，新旧两套会同时被
 * agent 看见。客户端没有任何办法自己看出 `a` 和 `b` 是同一个东西，所以改名必须
 * 在清单里**显式声明**。做法同 Homebrew 的 `formula_renames.json`。
 *
 * （Codex 不需要这种表：它的市场是 git 仓库、`marketplace/upgrade` 是整棵树检出，
 * 删除与改名自动传播。那是另一种模型，代价是要把 skill 收进插件自己的 root。）
 *
 * ## 不变量
 *
 * 1. **链必须折叠**：`a → b → c` 存成 `{a: c, b: c}`，不是 `{a: b, b: c}`。
 *    否则客户端要做传递解析，而**只升级过一次的用户会被漏掉** —— 他盘上是 `b`，
 *    表里 `b → c` 能救他；但如果写成链式，装 `c` 时只查到 `b → c` 而漏掉 `a`。
 * 2. **不能自指**：`a → a` 是无意义的，通常是复制粘贴留下的。
 * 3. **旧名不能同时是现名**：那正是没折叠的链，第 1 条的机器可判形式。
 */

import fs from 'node:fs/promises'
import path from 'node:path'

export const SKILL_RENAMES_FILE = 'resources/codex-skills/skill-renames.json'

/** 读映射表。文件不存在视为「没有任何改名」，不是错误。 */
export async function loadSkillRenames(repoRoot) {
  const file = path.join(repoRoot, SKILL_RENAMES_FILE)
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch (err) {
    if (err?.code === 'ENOENT') return {}
    throw err
  }
  const parsed = JSON.parse(text)
  return parsed?.renames ?? {}
}

/**
 * 校验不变量，返回违规说明数组（空 = 通过）。
 *
 * 返回而不是抛：调用方（发布脚本 / 测试）各自决定怎么报，且一次能看到全部问题，
 * 而不是修一个跑一次。
 */
export function validateSkillRenames(renames) {
  const problems = []
  const currentNames = new Set(Object.values(renames))

  for (const [oldName, newName] of Object.entries(renames)) {
    if (!oldName || !newName) {
      problems.push(`空名字: ${JSON.stringify({ [oldName]: newName })}`)
      continue
    }
    if (oldName === newName) {
      problems.push(`自指: "${oldName}" → 自己。改名表里不该有这一行。`)
      continue
    }
    if (currentNames.has(oldName)) {
      problems.push(
        `链未折叠: "${oldName}" 既是旧名(→ "${newName}")又是别人的现名。`
        + ` 请把指向 "${oldName}" 的那些行改为直接指向 "${newName}"。`,
      )
    }
  }
  return problems
}

/**
 * 现名 → 它的全部历史名字。catalog 的 `renamedFrom` 就是这个。
 *
 * 排序后返回:catalog 要内容寻址(同样输入必须得到同样字节),键序不能随
 * Object.entries 的插入顺序漂。
 */
export function renamedFromByCurrentName(renames) {
  const byCurrent = new Map()
  for (const [oldName, newName] of Object.entries(renames)) {
    if (!byCurrent.has(newName)) byCurrent.set(newName, [])
    byCurrent.get(newName).push(oldName)
  }
  for (const list of byCurrent.values()) list.sort()
  return byCurrent
}
