#!/usr/bin/env node
/**
 * 全仓 Skill 编排架构审计 CLI。
 *
 * 用法:
 *   node scripts/audit-skill-architecture.mjs            # 摘要 + 全部诊断
 *   node scripts/audit-skill-architecture.mjs --summary  # 仅按 code 统计
 *   node scripts/audit-skill-architecture.mjs --code DEPENDENCY_CYCLE
 */

import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { auditRepository } from './lib/skill-architecture-validator.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const summaryOnly = args.includes('--summary')
const codeFilterIndex = args.indexOf('--code')
const codeFilter = codeFilterIndex >= 0 ? args[codeFilterIndex + 1] : null

const { inventory, diagnostics } = await auditRepository(repoRoot)

const counts = {}
for (const diagnostic of diagnostics) {
  counts[diagnostic.code] = (counts[diagnostic.code] ?? 0) + 1
}

console.log(`scanned skills: ${inventory.skills.length}, hooks: ${inventory.hooks.length}`)
console.log('violations by code:')
for (const [code, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(count).padStart(4)}  ${code}`)
}
console.log(`total: ${diagnostics.length}`)

if (!summaryOnly) {
  const filtered = codeFilter
    ? diagnostics.filter((diagnostic) => diagnostic.code === codeFilter)
    : diagnostics
  if (filtered.length > 0) {
    console.log('')
    for (const diagnostic of filtered) {
      console.log(`${diagnostic.code} ${diagnostic.message}`)
    }
  }
}

process.exitCode = diagnostics.length > 0 ? 1 : 0
