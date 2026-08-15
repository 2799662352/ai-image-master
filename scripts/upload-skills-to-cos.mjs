#!/usr/bin/env node
/**
 * Publish the bundled Codex skills to Tencent COS as a public marketplace.
 *
 * For each directory under `resources/codex-skills/*` (excluding the
 * `skill-versions.json` manifest):
 *   1. Read the SKILL.md `description` for the catalog entry.
 *   2. Look up the version from `resources/codex-skills/skill-versions.json`.
 *   3. Build a zip of the skill folder (SKILL.md + references/*).
 *   4. Upload the zip to `cos://<bucket>/skills/<name>-<version>-<sha8>.zip`.
 *   5. Aggregate catalog entries and upload `cos://<bucket>/skills/catalog.json`.
 *
 * NOTE: zips are NOT byte-stable across runs (jszip stamps internal
 * timestamps we don't control). Rather than fight that, the zip filename is
 * CONTENT-ADDRESSED (a `-<sha8>` suffix): a content change yields a new object
 * instead of overwriting, so even a stale CDN-cached catalog still resolves to
 * an existing zip whose digest matches its entry — the sha256 check can never
 * be tripped by cache skew. The catalog remains the single source of truth at
 * install time; the client hashes the downloaded zip and compares to `sha256`.
 *
 * Env vars (reads `.env` automatically):
 *   COS_SECRET_ID         (required)
 *   COS_SECRET_KEY        (required)
 *   COS_SKILLS_BUCKET     (default: image-master-1345773498)
 *   COS_SKILLS_REGION     (default: ap-guangzhou)
 *   COS_SKILLS_PREFIX     (default: skills/)
 *
 * Flags:
 *   --dry-run             Build everything and print the catalog but do not upload.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import {
  loadSkillRenames,
  renamedFromByCurrentName,
  validateSkillRenames,
} from './lib/skill-renames.mjs'

// `cos-nodejs-sdk-v5` and `dotenv` ship as CJS; pull in via dynamic require.
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const SKILLS_SRC = path.join(REPO_ROOT, 'resources', 'codex-skills')
const VERSIONS_FILE = path.join(SKILLS_SRC, 'skill-versions.json')

try {
  require('dotenv').config({ path: path.join(REPO_ROOT, '.env') })
} catch {
  // dotenv is optional — env can be set directly.
}

const COS = require('cos-nodejs-sdk-v5')

const SecretId = process.env.COS_SECRET_ID
const SecretKey = process.env.COS_SECRET_KEY
const Bucket = process.env.COS_SKILLS_BUCKET || 'image-master-1345773498'
const Region = process.env.COS_SKILLS_REGION || 'ap-guangzhou'
const Prefix = (process.env.COS_SKILLS_PREFIX || 'skills/').replace(/^\/+/, '')

const dryRun = process.argv.includes('--dry-run')

if (!dryRun && (!SecretId || !SecretKey)) {
  console.error('❌ Missing COS_SECRET_ID / COS_SECRET_KEY env vars.')
  console.error('   Either export them or add them to .env at the repo root.')
  console.error('   Use --dry-run to build without uploading.')
  process.exit(1)
}

const cos = dryRun ? null : new COS({ SecretId, SecretKey })

// Fixed file-entry timestamp for cleanliness. (Not enough to make the whole
// zip byte-stable — jszip stamps additional internal fields — but at least
// the listed mtimes are reproducible.)
const ZIP_FIXED_DATE = new Date('1980-01-01T00:00:00Z')

function extractDescription(skillMd) {
  const fm = skillMd.match(/^---\s*\n([\s\S]*?)\n---/)
  if (!fm) return ''
  // Frontmatter `description:` may span a single line OR a folded/blocked
  // YAML value. For our bundled skills we always emit a single line so this
  // simple regex suffices.
  const m = fm[1].match(/^description:\s*(.+)$/m)
  return m ? m[1].trim() : ''
}

async function walkSkillFiles(skillDir) {
  const results = []
  async function recurse(currentDir, relPrefix) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(currentDir, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await recurse(abs, rel)
      } else if (entry.isFile()) {
        results.push({ abs, rel })
      }
    }
  }
  await recurse(skillDir, '')
  // Sort for determinism.
  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return results
}

async function buildSkillZip(skillDir) {
  const zip = new JSZip()
  const files = await walkSkillFiles(skillDir)
  for (const f of files) {
    const buf = await fs.readFile(f.abs)
    zip.file(f.rel, buf, { date: ZIP_FIXED_DATE, binary: true })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    // `platform: UNIX` keeps mode bits identical between Windows/macOS/Linux
    // build hosts, removing another source of zip-byte drift.
    platform: 'UNIX',
  })
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function uploadBuffer(key, buf, contentType) {
  if (dryRun) {
    console.log(`    (dry-run) would upload ${key} (${buf.length} B)`)
    return
  }
  await new Promise((resolve, reject) => {
    cos.putObject(
      {
        Bucket,
        Region,
        Key: key,
        Body: buf,
        ContentType: contentType,
        // `image-master-1345773498` is configured public-read; bucket ACL
        // covers reads, but we tag each object too so a future bucket-policy
        // change doesn't silently break the marketplace.
        ACL: 'public-read',
      },
      (err, data) => (err ? reject(err) : resolve(data)),
    )
  })
}

async function main() {
  console.log(`📦 Skill marketplace publish → cos://${Bucket}/${Prefix}\n`)
  if (dryRun) console.log('   (--dry-run: building only, nothing will be uploaded)\n')

  const versionsRaw = await fs.readFile(VERSIONS_FILE, 'utf8')
  const versionsDoc = JSON.parse(versionsRaw)
  const skillVersions = versionsDoc.skills ?? {}

  const skillDirs = (await fs.readdir(SKILLS_SRC, { withFileTypes: true }))
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort()

  // 改名表:发布前先验不变量。链没折叠就发出去,只升级过一次的用户永远收不到
  // 清理 —— 那种孤儿事后无法补救(客户端已经不知道那个目录属于谁)。
  const renames = await loadSkillRenames(REPO_ROOT)
  const renameProblems = validateSkillRenames(renames)
  if (renameProblems.length > 0) {
    console.error('✗ skill-renames.json 违反不变量:')
    for (const p of renameProblems) console.error(`   - ${p}`)
    process.exit(1)
  }
  const renamedFrom = renamedFromByCurrentName(renames)

  const catalogEntries = []
  let unknownInVersions = 0
  let missingDirs = 0

  // First: warn about manifest <-> filesystem drift.
  for (const name of Object.keys(skillVersions)) {
    if (!skillDirs.includes(name)) {
      console.warn(`  ⚠ skill-versions.json lists "${name}" but no directory exists — skipping`)
      missingDirs++
    }
  }

  for (const skillName of skillDirs) {
    const version = skillVersions[skillName]
    if (!version) {
      console.warn(`  ⚠ ${skillName} — not in skill-versions.json, skipping`)
      unknownInVersions++
      continue
    }
    const skillDir = path.join(SKILLS_SRC, skillName)
    const skillMdPath = path.join(skillDir, 'SKILL.md')
    let skillMd
    try {
      skillMd = await fs.readFile(skillMdPath, 'utf8')
    } catch {
      console.warn(`  ⚠ ${skillName} — no SKILL.md found, skipping`)
      continue
    }
    const description = extractDescription(skillMd)
    const zipBuf = await buildSkillZip(skillDir)
    const digest = sha256(zipBuf)
    const size = zipBuf.length
    // Content-addressed filename: the sha8 suffix makes the object immutable
    // per content. Re-publishing a version with changed bytes produces a NEW
    // object rather than overwriting, so a stale cached catalog still points at
    // an existing (old) zip whose digest matches — no sha256 mismatch can ever
    // block install/update from CDN cache skew (review finding C1).
    const key = `${Prefix}${skillName}-${version}-${digest.slice(0, 8)}.zip`
    const url = `https://${Bucket}.cos.${Region}.myqcloud.com/${key}`

    console.log(`  ⬆ ${skillName}@${version} — ${(size / 1024).toFixed(1)} KB  sha256=${digest.slice(0, 12)}…`)
    await uploadBuffer(key, zipBuf, 'application/zip')

    catalogEntries.push({
      name: skillName,
      version,
      description,
      size,
      sha256: digest,
      url,
      // 改名过的 skill 带上历史名字,客户端据此清掉用户盘上的旧目录并迁移台账。
      // 没改过名的条目不出现这个字段(而不是空数组)—— catalog 是内容寻址的,
      // 多一个恒为 [] 的键会让所有 skill 的 sha 无谓变一次。
      ...(renamedFrom.has(skillName) ? { renamedFrom: renamedFrom.get(skillName) } : {}),
    })
  }

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    skills: catalogEntries,
  }
  const catalogJson = Buffer.from(JSON.stringify(catalog, null, 2), 'utf8')
  const catalogKey = `${Prefix}catalog.json`
  console.log(`\n  ⬆ catalog.json — ${catalogEntries.length} skills`)
  await uploadBuffer(catalogKey, catalogJson, 'application/json')

  const catalogUrl = `https://${Bucket}.cos.${Region}.myqcloud.com/${catalogKey}`
  console.log(`\n✅ Catalog ${dryRun ? 'built (not uploaded)' : 'published'}: ${catalogUrl}`)

  if (unknownInVersions || missingDirs) {
    console.log(
      `\n⚠ Drift summary — ${unknownInVersions} unversioned dirs, ${missingDirs} missing dirs in manifest. Reconcile resources/codex-skills/skill-versions.json.`,
    )
  }
}

main().catch((err) => {
  console.error('❌ Upload failed:', err)
  process.exit(1)
})
