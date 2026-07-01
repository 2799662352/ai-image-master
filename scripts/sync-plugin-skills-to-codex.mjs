#!/usr/bin/env node
/**
 * Curated sync of plugin skills → the standalone skill marketplace tree.
 *
 * The standalone skill marketplace (`scripts/upload-skills-to-cos.mjs`) reads
 * from `resources/codex-skills/*` + `skill-versions.json`, a DIFFERENT tree
 * from the plugin sources (`resources/plugins/<plugin>/skills/<name>/`). The
 * two drift: edits land in `plugins/` but `codex-skills/` is only synced at
 * release time. This script reconciles them WITHOUT polluting the curated
 * standalone catalog:
 *
 *   - Only skills already present in `codex-skills/` (the curated intersection)
 *     get their content refreshed from `plugins/`.
 *   - Plus an explicit ADD list for new craft skills that should join.
 *   - App-integration skills (catimation-image/video/brainstorm/portrait,
 *     trailer-plan-generator, create-storyboard) are intentionally excluded —
 *     they can't run outside the app and are delivered via the plugin
 *     marketplace + firstPartySkills instead.
 *   - `codex-skills`-only entries (e.g. find-skills) are left untouched.
 *
 * For every skill whose content actually changed (content hash differs) the
 * version in `skill-versions.json` is bumped (patch+1) so the marketplace
 * flags an update. New skills are added at 1.0.0.
 *
 * Usage:
 *   node scripts/sync-plugin-skills-to-codex.mjs            # dry-run (report only)
 *   node scripts/sync-plugin-skills-to-codex.mjs --apply    # write files + bump versions
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PLUGINS_SRC = path.join(REPO_ROOT, 'resources', 'plugins')
const CODEX_SKILLS = path.join(REPO_ROOT, 'resources', 'codex-skills')
const VERSIONS_FILE = path.join(CODEX_SKILLS, 'skill-versions.json')

const apply = process.argv.includes('--apply')

// New craft skills explicitly allowed to JOIN the standalone marketplace.
// catimation-video-director-router is the STEP -1 companion of director-orchestrator
// (already curated here); ship it standalone too so orchestrator's router handoff
// doesn't dangle for users who install skills individually rather than the plugin.
const ADD_LIST = new Set(['storyboard-grid-to-seedance', 'catimation-video-director-router'])

async function listDirs(dir) {
  const entries = await fs.readdir(dir, { withFileTypes: true })
  return entries.filter((e) => e.isDirectory()).map((e) => e.name)
}

async function walkFiles(rootDir) {
  const out = []
  async function recurse(cur, rel) {
    const entries = await fs.readdir(cur, { withFileTypes: true })
    for (const e of entries) {
      if (e.name === '.git') continue
      const abs = path.join(cur, e.name)
      const r = rel ? `${rel}/${e.name}` : e.name
      if (e.isDirectory()) await recurse(abs, r)
      else if (e.isFile()) out.push({ abs, rel: r })
    }
  }
  await recurse(rootDir, '')
  out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return out
}

async function dirSignature(dir) {
  let exists = true
  try {
    await fs.stat(dir)
  } catch {
    exists = false
  }
  if (!exists) return null
  const files = await walkFiles(dir)
  const h = createHash('sha256')
  for (const f of files) {
    h.update(f.rel)
    h.update('\0')
    h.update(await fs.readFile(f.abs))
    h.update('\0')
  }
  return h.digest('hex')
}

function bumpPatch(v) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(v || '')
  if (!m) return '1.0.1'
  return `${m[1]}.${m[2]}.${Number(m[3]) + 1}`
}

async function main() {
  console.log(`🔁 Curated skill sync plugins → codex-skills  ${apply ? '(APPLY)' : '(dry-run)'}\n`)

  const versionsDoc = JSON.parse(await fs.readFile(VERSIONS_FILE, 'utf8'))
  const versions = versionsDoc.skills ?? {}

  const codexNames = new Set(await listDirs(CODEX_SKILLS))
  codexNames.delete('skill-versions.json') // not a dir, but guard anyway

  // Enumerate plugin skills, detect leaf-name collisions across plugins.
  const plugins = await listDirs(PLUGINS_SRC)
  const pluginSkills = new Map() // name -> { src, plugin }
  for (const plugin of plugins) {
    const skillsDir = path.join(PLUGINS_SRC, plugin, 'skills')
    let names
    try {
      names = await listDirs(skillsDir)
    } catch {
      continue
    }
    for (const name of names) {
      if (pluginSkills.has(name)) {
        console.error(
          `❌ Name collision: "${name}" in both ${pluginSkills.get(name).plugin} and ${plugin}. Aborting.`,
        )
        process.exit(1)
      }
      pluginSkills.set(name, { src: path.join(skillsDir, name), plugin })
    }
  }

  const changed = []
  const added = []
  const unchanged = []
  const skippedAppOnly = []

  for (const [name, info] of [...pluginSkills.entries()].sort()) {
    const inCodex = codexNames.has(name)
    const allowed = inCodex || ADD_LIST.has(name)
    if (!allowed) {
      skippedAppOnly.push({ name, plugin: info.plugin })
      continue
    }
    const dest = path.join(CODEX_SKILLS, name)
    const srcSig = await dirSignature(info.src)
    const dstSig = await dirSignature(dest)

    if (dstSig === null) {
      added.push({ name, info, dest })
    } else if (srcSig !== dstSig) {
      changed.push({ name, info, dest })
    } else {
      unchanged.push(name)
    }
  }

  // Report
  const report = (title, arr, fmt) => {
    console.log(`${title} (${arr.length}):`)
    for (const x of arr) console.log(`  ${fmt(x)}`)
    console.log('')
  }
  report('🆕 ADD (new → 1.0.0)', added, (x) => `${x.name}  ← ${x.info.plugin}`)
  report('✏️  CHANGED (content differs → bump)', changed, (x) => {
    const cur = versions[x.name] || '(none)'
    return `${x.name}  ${cur} → ${bumpPatch(cur)}  ← ${x.info.plugin}`
  })
  report('✅ UNCHANGED (skip)', unchanged.map((n) => ({ n })), (x) => x.n)
  report('⏭️  SKIPPED app-only / not curated', skippedAppOnly, (x) => `${x.name}  (${x.plugin})`)

  // codex-only (no plugin counterpart): informational, left untouched.
  const codexOnly = [...codexNames].filter((n) => !pluginSkills.has(n)).sort()
  report('🔒 codex-skills-only (untouched)', codexOnly.map((n) => ({ n })), (x) => x.n)

  if (!apply) {
    console.log('Dry-run only. Re-run with --apply to write files + bump skill-versions.json.')
    return
  }

  // Apply: mirror src → dest (clean replace) for added + changed; bump versions.
  for (const { name, info, dest } of [...added, ...changed]) {
    await fs.rm(dest, { recursive: true, force: true })
    await fs.cp(info.src, dest, { recursive: true })
  }
  for (const { name } of added) {
    versions[name] = versions[name] || '1.0.0'
  }
  for (const { name } of changed) {
    versions[name] = bumpPatch(versions[name])
  }
  versionsDoc.skills = versions
  await fs.writeFile(VERSIONS_FILE, JSON.stringify(versionsDoc, null, 2) + '\n', 'utf8')

  console.log(
    `✅ Applied: ${added.length} added, ${changed.length} bumped, ${unchanged.length} unchanged. skill-versions.json updated.`,
  )
}

main().catch((err) => {
  console.error('❌ Sync failed:', err)
  process.exit(1)
})
