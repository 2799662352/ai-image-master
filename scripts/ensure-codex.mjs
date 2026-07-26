/**
 * Make sure this checkout has the pinned Codex binary before `dev` starts.
 *
 * The binary is 350MB of gitignored runtime, so a fresh clone or a new git
 * worktree starts empty and the first send dies with
 * `spawn .../resources/codex/win32-x64/codex.exe ENOENT` — a failure that looks
 * like broken code but is really a missing asset. `codex:fetch` fixes it by
 * re-downloading, which is slow and pointless when another checkout on the same
 * machine already holds the exact pinned version.
 *
 * So this keeps a per-machine cache and hard-links out of it:
 *
 *   1. binary already in `resources/` → nothing to do (the common case, and the
 *      reason this is safe to put in front of every `dev`).
 *   2. cache has this version → link/copy it in (no network).
 *   3. neither → run the pinned `codex:fetch`, then seed the cache so the next
 *      checkout takes path 2.
 *
 * The cache lives inside the repo's git COMMON directory (`git rev-parse
 * --git-common-dir`), which every worktree of the repo shares and which always
 * sits on the same volume as the checkouts. Both properties matter: same volume
 * means hard links work, so N worktrees cost 350MB once rather than N times,
 * and being inside `.git` keeps it out of `git status` and out of any build
 * that copies `resources/`. Without a git dir (tarball checkout) it falls back
 * to the user cache dir and pays a copy.
 *
 * Version handling is deliberately shallow: presence of the binary counts as
 * satisfied, exactly like today's manual flow. A version BUMP goes through
 * `codex:fetch`, which overwrites `resources/` directly — this script never
 * second-guesses it, and the cache is keyed by version so an old entry is
 * simply never asked for again.
 */
import { spawnSync } from 'node:child_process'
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const projectRoot = path.resolve(import.meta.dirname, '..')
const target = `${process.platform}-${process.arch}`
const binaryName = process.platform === 'win32' ? 'codex.exe' : 'codex'
const destDir = path.join(projectRoot, 'resources', 'codex', target)
const destBinary = path.join(destDir, binaryName)

function log(message) {
  console.log(`[ensure-codex] ${message}`)
}

function pinnedVersion() {
  const manifest = JSON.parse(readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
  if (typeof manifest.codexCliVersion !== 'string' || !manifest.codexCliVersion) {
    throw new Error('package.json is missing `codexCliVersion`')
  }
  return manifest.codexCliVersion
}

/**
 * Shared cache root: the git common dir when there is one (shared by every
 * worktree, same volume as all of them), else the user cache dir.
 */
function cacheRoot() {
  const fromEnv = process.env.CATIMATION_CODEX_CACHE?.trim()
  if (fromEnv) return fromEnv
  const gitCommonDir = spawnSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    cwd: projectRoot,
    encoding: 'utf8',
  })
  const resolved = gitCommonDir.status === 0 ? gitCommonDir.stdout.trim() : ''
  if (resolved && existsSync(resolved)) {
    return path.join(resolved, 'codex-binary-cache')
  }
  const localAppData = process.env.LOCALAPPDATA?.trim()
  return localAppData
    ? path.join(localAppData, 'catimation', 'codex-binary-cache')
    : path.join(os.homedir(), '.cache', 'catimation', 'codex-binary-cache')
}

/**
 * Hard-link every file, falling back to a copy when the filesystem refuses
 * (cross-volume cache, or a filesystem without links). Links are preferred for
 * disk, but correctness never depends on which one won.
 */
function materialize(fromDir, toDir) {
  mkdirSync(toDir, { recursive: true })
  let linked = 0
  let copied = 0
  for (const entry of readdirSync(fromDir, { withFileTypes: true })) {
    if (!entry.isFile()) continue
    const from = path.join(fromDir, entry.name)
    const to = path.join(toDir, entry.name)
    if (existsSync(to)) continue
    try {
      linkSync(from, to)
      linked += 1
    } catch {
      copyFileSync(from, to)
      copied += 1
    }
  }
  return { linked, copied }
}

function totalMegabytes(dir) {
  let bytes = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isFile()) bytes += statSync(path.join(dir, entry.name)).size
  }
  return Math.round(bytes / 1024 / 1024)
}

function runPinnedFetch() {
  log('no cached copy — downloading the pinned version')
  const result = spawnSync(
    process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
    ['exec', 'tsx', 'scripts/fetch-codex.ts'],
    { cwd: projectRoot, stdio: 'inherit' },
  )
  if (result.status !== 0) {
    throw new Error('codex:fetch failed — run `pnpm codex:fetch` and read its output')
  }
}

function main() {
  const version = pinnedVersion()
  const cacheDir = path.join(cacheRoot(), version, target)
  const cachedBinary = path.join(cacheDir, binaryName)

  if (!existsSync(destBinary)) {
    if (existsSync(cachedBinary)) {
      const { linked, copied } = materialize(cacheDir, destDir)
      log(`provisioned ${version} from cache (${linked} linked, ${copied} copied)`)
    } else {
      runPinnedFetch()
      if (!existsSync(destBinary)) {
        throw new Error(`codex:fetch reported success but ${destBinary} is missing`)
      }
    }
  }

  if (!existsSync(cachedBinary) && existsSync(destBinary)) {
    // Seed from whatever this checkout has so the NEXT worktree skips the
    // download. Best-effort: a failure here costs the next checkout a fetch,
    // which is the status quo, so it must never block `dev`.
    try {
      const { linked, copied } = materialize(destDir, cacheDir)
      log(`cached ${version} for other checkouts (${linked} linked, ${copied} copied,`
        + ` ${totalMegabytes(cacheDir)}MB at ${cacheDir})`)
    } catch (error) {
      log(`could not seed the cache (${error instanceof Error ? error.message : error})`)
      try {
        rmSync(cacheDir, { recursive: true, force: true })
      } catch { /* leaving a partial cache dir is the worst case; ignore */ }
    }
  }
}

try {
  main()
} catch (error) {
  console.error(`[ensure-codex] ${error instanceof Error ? error.message : error}`)
  process.exit(1)
}
