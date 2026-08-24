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
 * Versions are checked by ASKING THE BINARY (`codex --version`), not by assuming
 * whatever sits in `resources/` matches the pin.
 *
 * The old rule was "presence counts as satisfied", on the theory that a version
 * bump goes through `codex:fetch` by hand. It doesn't hold, and the failure is
 * silent in both directions (observed 2026-08-24: pin said 0.149.1, a long-lived
 * checkout still ran 0.145.0):
 *
 *   - a checkout that already has ANY binary never picks up a bump — `dev` runs
 *     the old CLI with no hint that it is stale, which is how you end up shipping
 *     mitigations for an upstream break you are not actually running into yet;
 *   - worse, the seeding step then copied that stale binary into the cache slot
 *     NAMED AFTER THE PIN. Every fresh worktree afterwards took path 2, got the
 *     old binary, and believed it had the new one. One stale checkout poisons the
 *     whole machine.
 *
 * So: probe before trusting, on both sides. A mismatch in `resources/` is
 * replaced; a cache entry that lies about its version is discarded rather than
 * linked. The probe costs one process spawn (tens of ms) in front of `dev`.
 *
 * The one case that still defers to presence: the binary exists but will not run
 * (AV quarantine, half-written file, unreadable output). Forcing a 350MB download
 * on every `dev` for that would be worse than the status quo — so it is left
 * alone, but it is NEVER used to seed the cache, which is the part that spreads.
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
 * Pull the version out of `codex --version` output. `null` when there isn't one.
 *
 * Split from {@link probeVersion} because this is the part with actual logic and
 * the part worth testing exhaustively — spawning a fake binary to exercise it is
 * a fight with platform exec rules (Windows won't `spawnSync` a `.cmd` without a
 * shell), and that fight tests the harness, not the regex.
 *
 * Only the SHAPE is pinned, not the `codex-cli ` prefix: a prefix change upstream
 * should not silently turn every checkout into "unknown version".
 */
export function parseVersion(output) {
  const match = /(\d+\.\d+\.\d+)/.exec(String(output ?? ''))
  return match ? match[1] : null
}

/**
 * Ask a codex binary which version it is.
 *
 * `null` means "could not tell" — missing file, non-zero exit, or output we
 * cannot parse. Callers must treat that as *unknown*, never as *matching*:
 * assuming a match is exactly how the stale binary spread through the cache.
 */
export function probeVersion(binary) {
  if (!existsSync(binary)) return null
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 })
  if (result.status !== 0) return null
  return parseVersion(`${result.stdout ?? ''}${result.stderr ?? ''}`)
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

function runPinnedFetch(reason) {
  log(`${reason} — downloading the pinned version`)
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

  const installed = probeVersion(destBinary)

  if (installed !== version) {
    // Present but unreadable → leave it (see the header: a broken probe must not
    // cost a 350MB download), and fall through WITHOUT seeding: an unverified
    // binary is the one thing we must never publish to other checkouts.
    if (installed === null && existsSync(destBinary)) {
      log(`cannot read the version of ${destBinary} — leaving it as-is and not seeding the cache`)
      return
    }

    if (installed !== null) log(`resources has ${installed}, pin is ${version} — replacing`)

    if (probeVersion(cachedBinary) === version) {
      // Wipe first, but ONLY on this path: `materialize` skips files that already
      // exist, so linking onto a stale tree would keep the old binary and
      // silently "succeed". Safe here because the replacement is already on disk.
      // (Deliberately NOT done before the fetch below — wiping and then failing
      // to download would leave the checkout with no codex at all, which is worse
      // than the stale one we started with.)
      rmSync(destDir, { recursive: true, force: true })
      const { linked, copied } = materialize(cacheDir, destDir)
      log(`provisioned ${version} from cache (${linked} linked, ${copied} copied)`)
    } else {
      if (existsSync(cacheDir)) {
        // A slot that does not contain what its name claims is worse than an
        // empty one — every fresh worktree would take it and be wrong.
        log(`cache slot for ${version} does not hold ${version} — discarding it`)
        rmSync(cacheDir, { recursive: true, force: true })
      }
      runPinnedFetch(installed === null ? 'not provisioned yet' : `have ${installed}, need ${version}`)
      const fetched = probeVersion(destBinary)
      if (fetched !== version) {
        throw new Error(
          `codex:fetch reported success but ${destBinary} is ${fetched ?? 'unreadable'}, expected ${version}`,
        )
      }
    }
  }

  // Seed only from a binary we have VERIFIED is the pinned version.
  if (!existsSync(cachedBinary) && probeVersion(destBinary) === version) {
    // Best-effort: a failure here costs the next checkout a fetch, which is the
    // status quo, so it must never block `dev`.
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

// Only run when invoked as a script. Without this, importing the module to test
// `probeVersion` would kick off a real provision (and possibly a 350MB download).
const invokedDirectly =
  !!process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)

if (invokedDirectly) {
  try {
    main()
  } catch (error) {
    console.error(`[ensure-codex] ${error instanceof Error ? error.message : error}`)
    process.exit(1)
  }
}
