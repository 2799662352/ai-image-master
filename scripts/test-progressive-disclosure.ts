#!/usr/bin/env npx tsx
/**
 * Progressive Disclosure 本地验证 — 无 API 调用
 * 验证 buildRulesForPass 的三级过滤逻辑：
 *   Level 1: appliesTo 过滤
 *   Level 2: condition(state) 按场景信号过滤 (dodge)
 *   Level 3: dynamic rules(state) 动态内容 (continuity)
 */

import { buildRulesForPass, BUILTIN_SKILLS, type PassType, type PipelineStateSlice } from
  '../src/renderer/src/services/storyboard-pipeline/prompt-skills'

let passed = 0
let failed = 0

function assert(label: string, ok: boolean, detail?: string) {
  if (ok) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    failed++
    console.error(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

function logSection(title: string) {
  console.log(`\n=== ${title} ===`)
}

// ---------- Level 1: appliesTo 过滤 ----------

logSection('Level 1: appliesTo 过滤')

const passExpected: Record<PassType, string[]> = {
  scene:     ['core', 'style', 'dodge'],
  character: ['core', 'physics', 'dodge'],
  shot:      ['core', 'dialogue', 'physics', 'audio', 'dodge', 'continuity'],
  verify:    ['core', 'dialogue', 'dodge'],
}

for (const [pass, expected] of Object.entries(passExpected) as [PassType, string[]][]) {
  const skillsForPass = BUILTIN_SKILLS.filter(s => s.appliesTo.includes(pass))
  const ids = skillsForPass.map(s => s.id)
  assert(
    `Pass "${pass}" 包含 [${expected.join(', ')}]`,
    expected.every(e => ids.includes(e)),
    `实际: [${ids.join(', ')}]`
  )
}

// ---------- Level 2: condition — dodge 按场景信号过滤 ----------

logSection('Level 2: condition — dodge Progressive Disclosure')

const sensitiveScenes = [
  '两人亲密交织在月光下',
  'intimate scene under moonlight',
  '角色裸露上身站在雨中',
  'violence erupts in the corridor, blood splatters',
  '施刑者冷冷看着囚犯',
]

const safeScenes = [
  '阳光明媚的街道，行人匆匆',
  'A sunny park with children playing',
  '办公室里两人讨论项目方案',
  'A spaceship drifts silently in deep space',
]

for (const sd of sensitiveScenes) {
  const rules = buildRulesForPass('shot', BUILTIN_SKILLS, { sceneDescription: sd })
  assert(
    `敏感场景 → dodge 注入: "${sd.slice(0, 30)}..."`,
    rules.includes('[Skill:dodge]')
  )
}

for (const sd of safeScenes) {
  const rules = buildRulesForPass('shot', BUILTIN_SKILLS, { sceneDescription: sd })
  assert(
    `安全场景 → dodge 跳过: "${sd.slice(0, 30)}..."`,
    !rules.includes('[Skill:dodge]')
  )
}

// sceneDescription 为空时 dodge 应注入（防御性：未知场景视为需要防护）
const rulesNoDesc = buildRulesForPass('shot', BUILTIN_SKILLS, {})
assert(
  'sceneDescription 为空 → dodge 注入（防御性默认）',
  rulesNoDesc.includes('[Skill:dodge]')
)

// ---------- Level 3: dynamic rules — continuity lock ----------

logSection('Level 3: dynamic rules — continuity lock')

const noRetryState: PipelineStateSlice = {}
const rulesNoRetry = buildRulesForPass('shot', BUILTIN_SKILLS, noRetryState)
assert(
  '无 retryFeedback → continuity 无内容输出',
  !rulesNoRetry.includes('CONTINUITY LOCK')
)

const retryState: PipelineStateSlice = {
  retryFeedback: '[S3] desc: 缺少微表情参数 → 补充眉间距和瞳孔大小',
  previousShots: [
    { id: 'S1', desc: '全景|城市天际线|无台词|平静→渺小|缓慢推进' },
    { id: 'S2', desc: '中景|角色转身|"走吧"(疲惫)|释然→放手|跟拍' },
    { id: 'S3', desc: '特写|面部|无台词|痛苦→压抑|固定' },
  ],
  characters: [
    { n: '小明', t: '短发/左眼角旧伤/灰色风衣' } as any,
  ],
}
const rulesRetry = buildRulesForPass('shot', BUILTIN_SKILLS, retryState)
assert(
  '有 retryFeedback → continuity 输出 CONTINUITY LOCK',
  rulesRetry.includes('CONTINUITY LOCK')
)
assert(
  'continuity 包含参考帧 S1/S2/S3',
  rulesRetry.includes('S1:') && rulesRetry.includes('S2:') && rulesRetry.includes('S3:')
)
assert(
  'continuity 包含角色锚点 [小明]',
  rulesRetry.includes('[小明]')
)

// ---------- skill 组合验证 ----------

logSection('skill 组合验证')

const shotRules = buildRulesForPass('shot', BUILTIN_SKILLS, { sceneDescription: '亲密' })
const expectedSkills = ['core', 'dialogue', 'physics', 'audio', 'dodge']
for (const sid of expectedSkills) {
  assert(`shot+敏感场景 包含 [Skill:${sid}]`, shotRules.includes(`[Skill:${sid}]`))
}

const sceneRules = buildRulesForPass('scene', BUILTIN_SKILLS, { sceneDescription: '普通街道' })
assert('scene+安全 包含 [Skill:core]', sceneRules.includes('[Skill:core]'))
assert('scene+安全 包含 [Skill:style]', sceneRules.includes('[Skill:style]'))
assert('scene+安全 不含 [Skill:dodge]', !sceneRules.includes('[Skill:dodge]'))

// ---------- 总结 ----------

logSection('总结')
console.log(`通过: ${passed}  失败: ${failed}  总计: ${passed + failed}`)
if (failed > 0) {
  process.exit(1)
}
