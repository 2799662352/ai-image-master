#!/usr/bin/env node
/**
 * Generate `latest.yml` (electron-updater manifest) for an existing
 * setup.exe artifact in `release/`.
 *
 * Used when electron-builder's publish step gets interrupted but the
 * package + blockmap are already on disk — we only need the manifest
 * to make hot-update work for clients on the existing build.
 *
 * Format reference: https://www.electron.build/auto-update.html
 *
 * Usage: node scripts/gen-latest-yml.js
 */
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

const pkg = require(path.resolve(__dirname, '..', 'package.json'))
const version = pkg.version
const releaseDir = path.resolve(__dirname, '..', 'release')

const setupName = `catimation-cyberpunk-master-${version}-setup.exe`
const setupPath = path.join(releaseDir, setupName)
const ymlPath = path.join(releaseDir, 'latest.yml')

if (!fs.existsSync(setupPath)) {
  console.error(`❌ ${setupName} not found in release/`)
  process.exit(1)
}

const stat = fs.statSync(setupPath)
const size = stat.size
const sizeMB = (size / 1024 / 1024).toFixed(2)

console.log(`Hashing ${setupName} (${sizeMB} MB)...`)
const start = Date.now()

// Stream-hash so we don't OOM on 347MB files.
const hash = crypto.createHash('sha512')
const stream = fs.createReadStream(setupPath, { highWaterMark: 64 * 1024 * 1024 })
stream.on('data', (chunk) => hash.update(chunk))
stream.on('end', () => {
  const sha512 = hash.digest('base64')
  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`SHA-512 (base64): ${sha512.slice(0, 24)}…   [${elapsed}s]`)

  // electron-updater is strict about field order / quoting. We follow
  // the exact shape that electron-builder emits so the parser doesn't
  // choke. `path` is the legacy field (kept for old client compat).
  const releaseDate = new Date().toISOString()
  const yml = [
    `version: ${version}`,
    `files:`,
    `  - url: ${setupName}`,
    `    sha512: ${sha512}`,
    `    size: ${size}`,
    `path: ${setupName}`,
    `sha512: ${sha512}`,
    `releaseDate: '${releaseDate}'`,
    '',
  ].join('\n')

  fs.writeFileSync(ymlPath, yml, 'utf8')
  console.log(`\n✅ Wrote ${ymlPath}`)
  console.log(`   version: ${version}`)
  console.log(`   size:    ${size.toLocaleString()} bytes (${sizeMB} MB)`)
  console.log(`   date:    ${releaseDate}`)
})

stream.on('error', (err) => {
  console.error('Stream error:', err)
  process.exit(1)
})
