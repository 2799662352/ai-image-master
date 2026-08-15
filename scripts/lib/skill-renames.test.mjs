// 改名映射表的不变量。这些断言守的都是**用户盘上的孤儿**,不是代码整洁。

import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  loadSkillRenames,
  renamedFromByCurrentName,
  validateSkillRenames,
} from './skill-renames.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

test('合法的表通过', () => {
  assert.deepEqual(validateSkillRenames({ 'old-a': 'new-a', 'old-b': 'new-b' }), [])
  assert.deepEqual(validateSkillRenames({}), [])
})

test('链未折叠会被拦下 —— 这是漏掉一批用户的形式', () => {
  // a → b → c 写成链式:装 c 时只查到 b→c,盘上还叫 a 的用户永远收不到清理。
  // 正确写法是 { a: c, b: c }。
  const problems = validateSkillRenames({ a: 'b', b: 'c' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /链未折叠/)
  // 报的是**中间节点** b,并给出修法(把指向 b 的行改成直接指向 c)——
  // 那正是要动的地方,比报链头 a 更可执行。
  assert.match(problems[0], /"b"/)
  assert.match(problems[0], /"c"/)

  // 折叠后同一组关系合法。
  assert.deepEqual(validateSkillRenames({ a: 'c', b: 'c' }), [])
})

test('自指被拦下', () => {
  const problems = validateSkillRenames({ same: 'same' })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /自指/)
})

test('一次报全部问题,不是修一个跑一次', () => {
  const problems = validateSkillRenames({ x: 'x', a: 'b', b: 'c' })
  assert.equal(problems.length, 2)
})

test('renamedFrom 按现名归组,且排序稳定', () => {
  // catalog 是内容寻址的:同样的输入必须得到同样的字节,键序不能随插入顺序漂。
  const grouped = renamedFromByCurrentName({ zeta: 'now', alpha: 'now', other: 'x' })
  assert.deepEqual(grouped.get('now'), ['alpha', 'zeta'])
  assert.deepEqual(grouped.get('x'), ['other'])
})

test('仓库里那份真表必须合法', async () => {
  const renames = await loadSkillRenames(repoRoot)
  assert.deepEqual(
    validateSkillRenames(renames),
    [],
    '改名表违反不变量 —— 发布出去会在用户盘上留孤儿',
  )
})

test('表文件缺失视为「没有改名」,不是错误', async () => {
  assert.deepEqual(await loadSkillRenames(path.join(repoRoot, 'does-not-exist')), {})
})
