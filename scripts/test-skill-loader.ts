#!/usr/bin/env npx tsx
import * as fs from 'fs'
import * as path from 'path'

const skillsDir = path.resolve(__dirname, '../skills')

interface ParsedSkill {
  name: string
  description?: string
  appliesTo: string[]
  priority: number
  body: string
}

function parseFrontmatter(raw: string): ParsedSkill | null {
  const normalized = raw.replace(/\r\n/g, '\n')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
  if (!match) return null

  const yamlBlock = match[1]
  const body = match[2].trim()

  const name = yamlBlock.match(/^name:\s*(.+)$/m)?.[1]?.trim() || ''
  const description = yamlBlock.match(/^description:\s*(.+)$/m)?.[1]?.trim()
  const priorityStr = yamlBlock.match(/^priority:\s*(\d+)$/m)?.[1]
  const appliesToMatch = yamlBlock.match(/^appliesTo:\s*\[([^\]]+)\]$/m)?.[1]

  if (!name || !appliesToMatch) return null

  const appliesTo = appliesToMatch.split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
  const priority = priorityStr ? parseInt(priorityStr, 10) : 50

  return { name, description, appliesTo, priority, body }
}

console.log('=== Skill Loader 单元测试 ===\n')

const validPasses = ['scene', 'character', 'shot', 'verify']
let totalTests = 0
let passed = 0

function check(label: string, condition: boolean) {
  totalTests++
  if (condition) {
    passed++
    console.log(`  ✓ ${label}`)
  } else {
    console.log(`  ✗ ${label}`)
  }
}

// Test 1: skills 目录存在
check('skills/ 目录存在', fs.existsSync(skillsDir))

// Test 2: 读取所有 skill 文件
const entries = fs.readdirSync(skillsDir, { withFileTypes: true })
const skillDirs = entries.filter(e => e.isDirectory())
console.log(`\n找到 ${skillDirs.length} 个 skill 目录`)
check('至少有 7 个 skill', skillDirs.length >= 7)

// Test 3: 逐个解析
const skills: ParsedSkill[] = []
for (const dir of skillDirs) {
  const skillFile = path.join(skillsDir, dir.name, 'SKILL.md')
  console.log(`\n--- ${dir.name} ---`)
  check('SKILL.md 存在', fs.existsSync(skillFile))

  if (!fs.existsSync(skillFile)) continue

  const raw = fs.readFileSync(skillFile, 'utf-8')
  const skill = parseFrontmatter(raw)
  check('frontmatter 解析成功', skill !== null)

  if (!skill) continue
  skills.push(skill)

  check(`name = "${skill.name}"`, skill.name.length > 0)
  check(`description 存在`, !!skill.description && skill.description.length > 0)
  check(`appliesTo 有效: [${skill.appliesTo.join(', ')}]`,
    skill.appliesTo.length > 0 && skill.appliesTo.every(p => validPasses.includes(p)))
  check(`priority = ${skill.priority}`, skill.priority >= 0 && skill.priority <= 100)
  check(`body 非空 (${skill.body.length} chars)`, skill.body.length > 10)
}

// Test 4: Pass 覆盖率
console.log('\n=== Pass 覆盖率 ===')
for (const pass of validPasses) {
  const matching = skills.filter(s => s.appliesTo.includes(pass))
  check(`${pass}: ${matching.length} skills [${matching.map(s => s.name).join(', ')}]`, matching.length >= 1)
}

// Test 5: 优先级排序
console.log('\n=== 优先级排序 ===')
const sorted = [...skills].sort((a, b) => a.priority - b.priority)
for (const s of sorted) {
  console.log(`  [${s.priority}] ${s.name} → [${s.appliesTo.join(', ')}]`)
}

// Test 6: 模拟 buildRulesForPass
console.log('\n=== 模拟 buildRulesForPass ===')
for (const pass of validPasses) {
  const matching = skills
    .filter(s => s.appliesTo.includes(pass))
    .sort((a, b) => a.priority - b.priority)
  const output = matching.map(s => `[Skill:${s.name}]\n${s.body}`).join('\n\n')
  console.log(`  ${pass}: ${matching.length} skills, ${output.length} chars`)
  check(`${pass} 输出非空`, output.length > 0)
}

console.log(`\n=== 结果: ${passed}/${totalTests} 通过 ===`)
process.exit(passed === totalTests ? 0 : 1)
