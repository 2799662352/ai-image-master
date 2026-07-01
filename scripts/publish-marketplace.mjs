#!/usr/bin/env node
/**
 * ONE-COMMAND marketplace publisher — plugins + skills, drift-proof.
 *
 *   node scripts/publish-marketplace.mjs            # publish both catalogs
 *   node scripts/publish-marketplace.mjs --dry-run  # full plan, nothing written/uploaded
 *
 * What it does, in order:
 *   1. VERSION  — marketplace.json is the single source of truth. Detect each
 *      plugin's content change vs the committed publish-state; AUTO patch-bump
 *      changed plugins (unless the author already bumped). Then AUTO-align all
 *      three per-plugin manifests to marketplace.json. 4-place drift becomes
 *      structurally impossible; "forgot to bump" is handled for you.
 *   2. SYNC     — mirror changed plugin skills into the per-skill tree and bump
 *      skill-versions.json (scripts/sync-plugin-skills-to-codex.mjs).
 *   3. AUDIT    — assert marketplace.json == all 3 manifests, valid JSON.
 *   4. PUBLISH  — upload the plugin catalog, then the per-skill catalog.
 *
 * Old granular scripts still exist (publish:plugins / publish:skills / the sync
 * script) for advanced use; this is the everyday entry point.
 */
import { spawnSync } from 'node:child_process'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MANIFEST_DIRS,
  decideVersion,
  nextStateFromDecisions,
  pluginContentSignature,
} from './lib/marketplace-versioning.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PLUGINS_SRC = path.join(REPO_ROOT, 'resources', 'plugins')
const MARKETPLACE_FILE = path.join(PLUGINS_SRC, '.claude-plugin', 'marketplace.json')
// Publish-state lives OUTSIDE resources/plugins so it never ends up inside a
// published zip. Committed so content-change detection has a stable baseline.
const STATE_FILE = path.join(REPO_ROOT, 'scripts', 'plugin-publish-state.json')

const dryRun = process.argv.includes('--dry-run')

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'))
  } catch {
    return fallback
  }
}

function run(label, scriptRelPath, args) {
  console.log(`\n▶ ${label}: node ${scriptRelPath} ${args.join(' ')}`.trimEnd())
  const res = spawnSync(process.execPath, [path.join(REPO_ROOT, scriptRelPath), ...args], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
  if (res.status !== 0) {
    console.error(`\n❌ Step failed: ${label} (exit ${res.status}). Aborting.`)
    process.exit(res.status || 1)
  }
}

/** Rewrite exactly the top-level "version" string of a manifest, preserving formatting. */
async function setManifestVersion(file, version) {
  let text
  try {
    text = await fs.readFile(file, 'utf8')
  } catch {
    return false // manifest missing — audit will catch it
  }
  const next = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`)
  if (next !== text) await fs.writeFile(file, next, 'utf8')
  return true
}

async function auditAlignment(marketplace) {
  const problems = []
  for (const plugin of marketplace.plugins ?? []) {
    const rel = (plugin.source || `./${plugin.name}`).replace(/^\.\//, '')
    for (const dir of MANIFEST_DIRS) {
      const file = path.join(PLUGINS_SRC, rel, dir, 'plugin.json')
      const doc = await readJson(file, null)
      if (doc === null) {
        problems.push(`${plugin.name}/${dir}: missing or invalid JSON`)
      } else if (doc.version !== plugin.version) {
        problems.push(`${plugin.name}/${dir}: ${doc.version} != marketplace ${plugin.version}`)
      }
    }
  }
  return problems
}

async function main() {
  console.log(`🚀 Marketplace publish (plugins + skills)${dryRun ? '  [DRY-RUN]' : ''}\n`)

  const marketplace = await readJson(MARKETPLACE_FILE, null)
  if (!marketplace) {
    console.error(`❌ Cannot read ${MARKETPLACE_FILE}`)
    process.exit(1)
  }
  const prevState = (await readJson(STATE_FILE, { plugins: {} })).plugins ?? {}

  // ---- STEP 1: version decisions -------------------------------------------
  const decisions = []
  for (const plugin of marketplace.plugins ?? []) {
    const rel = (plugin.source || `./${plugin.name}`).replace(/^\.\//, '')
    const dir = path.join(PLUGINS_SRC, rel)
    let sig
    try {
      sig = await pluginContentSignature(dir)
    } catch {
      console.error(`❌ ${plugin.name}: source dir "${rel}" not found`)
      process.exit(1)
    }
    const d = decideVersion(plugin, sig, prevState[plugin.name])
    decisions.push(d)
    plugin.version = d.version // apply to in-memory marketplace
  }

  const ICON = { seed: '🌱', unchanged: '✅', manual: '✍️ ', 'auto-bump': '⬆️ ' }
  console.log('Plugin version plan:')
  for (const d of decisions) {
    const arrow = d.version !== d.from ? `${d.from} → ${d.version}` : d.version
    console.log(`  ${ICON[d.action] || '  '} ${d.name.padEnd(26)} ${arrow}   (${d.action})`)
  }
  const bumped = decisions.filter((d) => d.version !== d.from)

  if (dryRun) {
    console.log('\n(DRY-RUN) would align 3 manifests per plugin to the versions above,')
    console.log('(DRY-RUN) then sync skills + publish both catalogs. Running sub-steps in dry mode:')
  } else {
    // ---- STEP 1b: persist versions + align manifests + save state ----------
    await fs.writeFile(MARKETPLACE_FILE, JSON.stringify(marketplace, null, 2) + '\n', 'utf8')
    for (const plugin of marketplace.plugins ?? []) {
      const rel = (plugin.source || `./${plugin.name}`).replace(/^\.\//, '')
      for (const dir of MANIFEST_DIRS) {
        await setManifestVersion(path.join(PLUGINS_SRC, rel, dir, 'plugin.json'), plugin.version)
      }
    }
    await fs.writeFile(
      STATE_FILE,
      JSON.stringify({ generatedAt: new Date().toISOString(), plugins: nextStateFromDecisions(decisions) }, null, 2) +
        '\n',
      'utf8',
    )
    console.log(
      `\n✔ marketplace.json + ${(marketplace.plugins?.length ?? 0) * 3} manifests aligned; ` +
        `${bumped.length} plugin(s) bumped; publish-state saved.`,
    )
  }

  // ---- STEP 2: sync plugin skills → per-skill tree -------------------------
  run('Sync skills', 'scripts/sync-plugin-skills-to-codex.mjs', dryRun ? [] : ['--apply'])

  // ---- STEP 3: audit (real run only; dry hasn't written manifests yet) -----
  if (!dryRun) {
    const problems = await auditAlignment(marketplace)
    if (problems.length) {
      console.error('\n❌ Alignment audit failed — NOT publishing:')
      for (const p of problems) console.error(`   - ${p}`)
      process.exit(1)
    }
    console.log('\n✔ Audit: marketplace.json == all 3 manifests for every plugin.')
  }

  // ---- STEP 4: publish both catalogs --------------------------------------
  const pubArgs = dryRun ? ['--dry-run'] : []
  run('Publish plugin catalog', 'scripts/upload-plugins-to-cos.mjs', pubArgs)
  run('Publish per-skill catalog', 'scripts/upload-skills-to-cos.mjs', pubArgs)

  console.log(
    `\n🎉 Done${dryRun ? ' (dry-run — nothing uploaded)' : ''}. Plugins + skills marketplace ${
      dryRun ? 'plan verified' : 'published'
    }.`,
  )
}

main().catch((err) => {
  console.error('❌ publish-marketplace failed:', err)
  process.exit(1)
})
