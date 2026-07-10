#!/usr/bin/env node
/**
 * 顶层 `skills/` 兼容镜像同步器。
 *
 * `skills/<dir>/SKILL.md` 是渲染管线(prompt-loader / storyboard-prompt-loader)
 * 的构建期输入:frontmatter 里的 `name`(管线 id,可能是短名)、`appliesTo`、
 * `priority` 属于管线元数据,由本目录自持;`description` 与正文则一律来自
 * `resources/plugins/<plugin>/skills/<dir>/SKILL.md` 权威源,禁止手工改写。
 *
 * 用法:
 *   node scripts/sync-top-level-skills.mjs           # 回填 description+body
 *   node scripts/sync-top-level-skills.mjs --check   # 只校验,漂移时 exit 1
 */

import { readdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TOP_LEVEL_ROOT = path.join(repoRoot, 'skills')
const PLUGIN_ROOT = path.join(repoRoot, 'resources', 'plugins')

function normalize(text) {
  return String(text ?? '').replaceAll('\r\n', '\n')
}

function parseFrontmatter(raw) {
  const normalized = normalize(raw).replace(/^\uFEFF/, '')
  const match = normalized.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/)
  if (!match) return null
  return { yaml: match[1], body: match[2].replace(/^\n+/, '') }
}

function yamlValue(yaml, key) {
  return yaml.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1]?.trim() ?? null
}

/** description 支持单行与 `>-` 折叠两种写法,返回单行化文本。 */
function yamlDescription(yaml) {
  const folded = yaml.match(/^description:\s*>-?\n((?:[ \t]+.*\n?)*)/m)
  if (folded) {
    return folded[1]
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join(' ')
  }
  return yamlValue(yaml, 'description')
}

async function findPluginCanonical(dirName) {
  const plugins = await readdir(PLUGIN_ROOT, { withFileTypes: true })
  for (const plugin of plugins) {
    if (!plugin.isDirectory()) continue
    const candidate = path.join(PLUGIN_ROOT, plugin.name, 'skills', dirName, 'SKILL.md')
    try {
      return { path: candidate, content: await readFile(candidate, 'utf8') }
    } catch {
      // try next plugin
    }
  }
  return null
}

function renderMirror({ pipelineName, appliesTo, priority, description, body }) {
  const lines = ['---', `name: ${pipelineName}`, `description: ${description}`]
  if (appliesTo) lines.push(`appliesTo: ${appliesTo}`)
  if (priority) lines.push(`priority: ${priority}`)
  lines.push('---', '', body.trimEnd(), '')
  return lines.join('\n')
}

async function main() {
  const check = process.argv.includes('--check')
  const dirs = (await readdir(TOP_LEVEL_ROOT, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()

  const problems = []
  let written = 0

  for (const dir of dirs) {
    const mirrorPath = path.join(TOP_LEVEL_ROOT, dir, 'SKILL.md')
    let existingRaw
    try {
      existingRaw = await readFile(mirrorPath, 'utf8')
    } catch {
      continue
    }
    const existing = parseFrontmatter(existingRaw)
    if (!existing) {
      problems.push(`${dir}: top-level SKILL.md has no frontmatter`)
      continue
    }

    const canonical = await findPluginCanonical(dir)
    if (!canonical) {
      problems.push(`${dir}: no plugin canonical found under resources/plugins/*/skills/${dir}`)
      continue
    }
    const parsedCanonical = parseFrontmatter(canonical.content)
    if (!parsedCanonical) {
      problems.push(`${dir}: plugin canonical has no frontmatter (${canonical.path})`)
      continue
    }

    const rendered = renderMirror({
      pipelineName: yamlValue(existing.yaml, 'name') ?? dir,
      appliesTo: yamlValue(existing.yaml, 'appliesTo'),
      priority: yamlValue(existing.yaml, 'priority'),
      description: yamlDescription(parsedCanonical.yaml) ?? '',
      body: parsedCanonical.body,
    })

    if (normalize(existingRaw) === rendered) continue
    if (check) {
      problems.push(`${dir}: mirror drifts from ${path.relative(repoRoot, canonical.path)}`)
      continue
    }
    await writeFile(mirrorPath, rendered, 'utf8')
    written += 1
  }

  if (problems.length > 0) {
    console.error(`[top-level-skills] ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }
  console.log(
    check
      ? `[top-level-skills] parity OK (${dirs.length} mirrors)`
      : `[top-level-skills] synced ${written}/${dirs.length} mirrors`,
  )
}

await main()
