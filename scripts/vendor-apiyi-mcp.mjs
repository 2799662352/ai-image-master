#!/usr/bin/env node
/**
 * Vendor apiyi-mcp-server into resources/apiyi-mcp/.
 *
 * Idempotent: if resources/apiyi-mcp/version.json shows the locked commit
 * already vendored AND --update-ref is NOT passed, exits with code 0 silently.
 *
 * Usage:
 *   node scripts/vendor-apiyi-mcp.mjs           # vendor at locked commit
 *   node scripts/vendor-apiyi-mcp.mjs --update-ref  # resolve ref to new SHA and update lock
 */
import { execSync, spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const REPO_ROOT = path.resolve(__dirname, '..')
const LOCK_PATH = path.join(__dirname, 'vendor-apiyi-mcp.lock.json')
const VENDOR_DIR = path.join(REPO_ROOT, 'resources', 'apiyi-mcp')
const VERSION_FILE = path.join(VENDOR_DIR, 'version.json')

const UPDATE_REF = process.argv.includes('--update-ref')
const COMMIT_PLACEHOLDER = 'REPLACE_WITH_RESOLVED_SHA_AT_VENDOR_TIME'

function readLock() {
  if (!existsSync(LOCK_PATH)) {
    throw new Error(`Lockfile missing: ${LOCK_PATH}`)
  }
  return JSON.parse(readFileSync(LOCK_PATH, 'utf8'))
}

function writeLock(lock) {
  writeFileSync(LOCK_PATH, JSON.stringify(lock, null, 2) + '\n', 'utf8')
}

function resolveRefToSha(repo, ref) {
  const res = spawnSync('git', ['ls-remote', repo, ref], { encoding: 'utf8' })
  if (res.status !== 0) {
    throw new Error(`git ls-remote failed: ${res.stderr}`)
  }
  const line = res.stdout.trim().split('\n')[0]
  if (!line) throw new Error(`ref ${ref} not found in ${repo}`)
  const sha = line.split(/\s+/)[0]
  if (!/^[0-9a-f]{40}$/.test(sha)) throw new Error(`bad SHA: ${sha}`)
  return sha
}

function alreadyVendoredAt(sha) {
  if (!existsSync(VERSION_FILE)) return false
  try {
    const v = JSON.parse(readFileSync(VERSION_FILE, 'utf8'))
    return v.commit === sha
  } catch {
    return false
  }
}

function hashDir(dir) {
  const pkg = path.join(dir, 'package.json')
  if (!existsSync(pkg)) return null
  return createHash('sha256').update(readFileSync(pkg)).digest('hex').slice(0, 16)
}

function sh(cmd, opts) {
  console.log(`$ ${cmd}`)
  execSync(cmd, { stdio: 'inherit', ...opts })
}

function main() {
  let lock = readLock()

  if (lock.commit !== COMMIT_PLACEHOLDER && !/^[0-9a-f]{40}$/.test(lock.commit)) {
    throw new Error(`lockfile commit is not a valid 40-char SHA or placeholder: ${JSON.stringify(lock.commit)}`)
  }

  if (UPDATE_REF) {
    const sha = resolveRefToSha(lock.repo, lock.ref)
    if (sha !== lock.commit) {
      lock = { ...lock, commit: sha }
      writeLock(lock)
      console.log(`[vendor-apiyi-mcp] updated lock to commit ${sha}`)
    } else {
      console.log(`[vendor-apiyi-mcp] lock already at ${sha}`)
    }
  }

  if (lock.commit === COMMIT_PLACEHOLDER) {
    const sha = resolveRefToSha(lock.repo, lock.ref)
    lock = { ...lock, commit: sha }
    writeLock(lock)
    console.log(`[vendor-apiyi-mcp] initial resolve to ${sha}`)
  }

  if (alreadyVendoredAt(lock.commit)) {
    console.log(`[vendor-apiyi-mcp] already vendored at ${lock.commit} (no-op)`)
    return
  }

  const tmpDir = path.join(REPO_ROOT, 'node_modules', '.apiyi-mcp-vendor-tmp')
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })

  console.log(`[vendor-apiyi-mcp] cloning ${lock.repo} @ ${lock.commit} ...`)
  sh(`git clone --depth=1 "${lock.repo}" "${tmpDir}"`)
  sh(`git -C "${tmpDir}" fetch --depth=1 origin "${lock.commit}"`)
  sh(`git -C "${tmpDir}" checkout "${lock.commit}"`)

  console.log(`[vendor-apiyi-mcp] installing production deps ...`)
  const hasLockfile = existsSync(path.join(tmpDir, 'package-lock.json'))
  const installCmd = hasLockfile
    ? 'npm ci --omit=dev --no-audit --no-fund --ignore-scripts'
    : 'npm install --omit=dev --no-audit --no-fund --ignore-scripts'
  sh(installCmd, { cwd: tmpDir })

  const upstreamPkg = JSON.parse(readFileSync(path.join(tmpDir, 'package.json'), 'utf8'))
  if (upstreamPkg.scripts && upstreamPkg.scripts.build) {
    sh(`npm run build`, { cwd: tmpDir })
  }

  rmSync(VENDOR_DIR, { recursive: true, force: true })
  mkdirSync(VENDOR_DIR, { recursive: true })
  for (const entry of ['dist', 'node_modules', 'package.json', 'README.md', 'LICENSE']) {
    const src = path.join(tmpDir, entry)
    const dst = path.join(VENDOR_DIR, entry)
    if (!existsSync(src)) {
      if (entry === 'dist') {
        throw new Error(`upstream missing dist/ after build — abort`)
      }
      continue
    }
    console.log(`$ copy ${entry}`)
    cpSync(src, dst, { recursive: true })
  }

  const manifest = {
    commit: lock.commit,
    repo: lock.repo,
    vendoredAt: new Date().toISOString(),
    nodeVersion: process.version,
    pkgHash: hashDir(VENDOR_DIR),
  }
  writeFileSync(VERSION_FILE, JSON.stringify(manifest, null, 2) + '\n', 'utf8')

  rmSync(tmpDir, { recursive: true, force: true })
  console.log(`[vendor-apiyi-mcp] vendored at ${VENDOR_DIR}`)
}

try {
  main()
} catch (err) {
  console.error(`[vendor-apiyi-mcp] FAILED: ${err.message}`)
  process.exit(1)
}
