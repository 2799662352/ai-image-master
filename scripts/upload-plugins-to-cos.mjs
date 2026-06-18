#!/usr/bin/env node
/**
 * Publish the bundled CATIMATION plugins to Tencent COS as a downloadable
 * plugin marketplace (parallel to the per-skill marketplace in
 * `upload-skills-to-cos.mjs`).
 *
 * Source of truth: `resources/plugins/.claude-plugin/marketplace.json`
 * (a copy of D:\tecx\catimation-plugins). For each plugin listed there:
 *   1. Zip the plugin directory (skills + commands + hooks + manifests).
 *   2. Upload the zip to `cos://<bucket>/plugins/<name>-<version>-<sha8>.zip`.
 * Plus a full bundle of every plugin:
 *   3. Zip the whole `resources/plugins` tree → `catimation-plugins-<ver>-<sha8>.zip`.
 *   4. Aggregate `cos://<bucket>/plugins/plugins-catalog.json`.
 *
 * The catalog is the single source of truth at download time. Zips are not
 * byte-stable across runs, so filenames are CONTENT-ADDRESSED (`-<sha8>`):
 * immutable per content, so a stale cached catalog can never resolve to a zip
 * whose digest mismatches its entry (review finding C1).
 *
 * Env vars (reads `.env` automatically):
 *   COS_SECRET_ID         (required)
 *   COS_SECRET_KEY        (required)
 *   COS_SKILLS_BUCKET     (default: image-master-1345773498)
 *   COS_SKILLS_REGION     (default: ap-guangzhou)
 *   COS_PLUGINS_PREFIX    (default: plugins/)
 *
 * Flags:
 *   --dry-run             Build everything and print the catalog but do not upload.
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import JSZip from 'jszip'

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
const PLUGINS_SRC = path.join(REPO_ROOT, 'resources', 'plugins')
const MARKETPLACE_FILE = path.join(PLUGINS_SRC, '.claude-plugin', 'marketplace.json')

// Top-level bundle version (the marketplace.json carries per-plugin versions
// but no umbrella version, so we stamp one here).
const BUNDLE_VERSION = '1.0.0'

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
const Prefix = (process.env.COS_PLUGINS_PREFIX || 'plugins/').replace(/^\/+/, '')

const dryRun = process.argv.includes('--dry-run')

if (!dryRun && (!SecretId || !SecretKey)) {
  console.error('❌ Missing COS_SECRET_ID / COS_SECRET_KEY env vars.')
  console.error('   Either export them or add them to .env at the repo root.')
  console.error('   Use --dry-run to build without uploading.')
  process.exit(1)
}

const cos = dryRun ? null : new COS({ SecretId, SecretKey })

const ZIP_FIXED_DATE = new Date('1980-01-01T00:00:00Z')

async function walkFiles(rootDir) {
  const results = []
  async function recurse(currentDir, relPrefix) {
    const entries = await fs.readdir(currentDir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.name === '.git') continue
      const abs = path.join(currentDir, entry.name)
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await recurse(abs, rel)
      } else if (entry.isFile()) {
        results.push({ abs, rel })
      }
    }
  }
  await recurse(rootDir, '')
  results.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
  return results
}

async function buildZip(rootDir, zipRootName) {
  const zip = new JSZip()
  const files = await walkFiles(rootDir)
  for (const f of files) {
    const buf = await fs.readFile(f.abs)
    // Nest under a stable top-level folder so the archive extracts cleanly.
    const entryName = zipRootName ? `${zipRootName}/${f.rel}` : f.rel
    zip.file(entryName, buf, { date: ZIP_FIXED_DATE, binary: true })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'UNIX',
  })
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex')
}

async function countFiles(rootDir, predicate) {
  const files = await walkFiles(rootDir)
  return files.filter(predicate).length
}

async function uploadBuffer(key, buf, contentType) {
  if (dryRun) {
    console.log(`    (dry-run) would upload ${key} (${buf.length} B)`)
    return
  }
  await new Promise((resolve, reject) => {
    cos.putObject(
      { Bucket, Region, Key: key, Body: buf, ContentType: contentType, ACL: 'public-read' },
      (err, data) => (err ? reject(err) : resolve(data)),
    )
  })
}

function urlFor(key) {
  return `https://${Bucket}.cos.${Region}.myqcloud.com/${key}`
}

async function main() {
  console.log(`📦 Plugin marketplace publish → cos://${Bucket}/${Prefix}\n`)
  if (dryRun) console.log('   (--dry-run: building only, nothing will be uploaded)\n')

  const marketplaceRaw = await fs.readFile(MARKETPLACE_FILE, 'utf8')
  const marketplace = JSON.parse(marketplaceRaw)
  const plugins = marketplace.plugins ?? []

  const catalogPlugins = []

  for (const plugin of plugins) {
    const name = plugin.name
    const version = plugin.version || '1.0.0'
    const relSource = (plugin.source || `./${name}`).replace(/^\.\//, '')
    const pluginDir = path.join(PLUGINS_SRC, relSource)

    let stat
    try {
      stat = await fs.stat(pluginDir)
    } catch {
      console.warn(`  ⚠ ${name} — source dir "${relSource}" not found, skipping`)
      continue
    }
    if (!stat.isDirectory()) {
      console.warn(`  ⚠ ${name} — source "${relSource}" is not a directory, skipping`)
      continue
    }

    const skillCount = await countFiles(pluginDir, (f) => /(^|\/)skills\/[^/]+\/SKILL\.md$/i.test(f.rel))
    const commandCount = await countFiles(pluginDir, (f) => /(^|\/)commands\/[^/]+\.md$/i.test(f.rel))

    const zipBuf = await buildZip(pluginDir, name)
    const digest = sha256(zipBuf)
    const size = zipBuf.length
    // Content-addressed filename (see upload-skills-to-cos.mjs / finding C1):
    // immutable per content, so a stale cached catalog never mismatches.
    const key = `${Prefix}${name}-${version}-${digest.slice(0, 8)}.zip`

    console.log(
      `  ⬆ ${name}@${version} — ${(size / 1024).toFixed(1)} KB  ` +
        `(${skillCount} skills, ${commandCount} cmds)  sha256=${digest.slice(0, 12)}…`,
    )
    await uploadBuffer(key, zipBuf, 'application/zip')

    catalogPlugins.push({
      name,
      version,
      description: plugin.description || '',
      skills: skillCount,
      commands: commandCount,
      size,
      sha256: digest,
      url: urlFor(key),
    })
  }

  // Full bundle: every plugin + marketplace.json + README/AGENTS.
  const bundleBuf = await buildZip(PLUGINS_SRC, 'catimation-plugins')
  const bundleDigest = sha256(bundleBuf)
  const bundleKey = `${Prefix}catimation-plugins-${BUNDLE_VERSION}-${bundleDigest.slice(0, 8)}.zip`
  console.log(
    `\n  ⬆ bundle catimation-plugins@${BUNDLE_VERSION} — ` +
      `${(bundleBuf.length / 1024).toFixed(1)} KB  sha256=${bundleDigest.slice(0, 12)}…`,
  )
  await uploadBuffer(bundleKey, bundleBuf, 'application/zip')

  const catalog = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    marketplace: {
      name: marketplace.name,
      description: marketplace.description,
      owner: marketplace.owner,
    },
    bundle: {
      name: 'catimation-plugins',
      version: BUNDLE_VERSION,
      size: bundleBuf.length,
      sha256: bundleDigest,
      url: urlFor(bundleKey),
    },
    plugins: catalogPlugins,
  }
  const catalogJson = Buffer.from(JSON.stringify(catalog, null, 2), 'utf8')
  const catalogKey = `${Prefix}plugins-catalog.json`
  console.log(`\n  ⬆ plugins-catalog.json — ${catalogPlugins.length} plugins`)
  await uploadBuffer(catalogKey, catalogJson, 'application/json')

  console.log(`\n✅ Plugin catalog ${dryRun ? 'built (not uploaded)' : 'published'}: ${urlFor(catalogKey)}`)
}

main().catch((err) => {
  console.error('❌ Upload failed:', err)
  process.exit(1)
})
