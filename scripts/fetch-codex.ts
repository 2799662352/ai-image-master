/**
 * Fetch the bundled Codex CLI binary for one or more target platforms.
 *
 * Two modes:
 *   1. Pinned (default) — uses `package.json.codexCliVersion` so CI builds are
 *      reproducible. Override per-invocation with `CODEX_CLI_VERSION=<semver>`
 *      or `CODEX_RELEASE_TAG=<tag>`.
 *   2. `--latest` (or `CODEX_CLI_VERSION=latest`) — queries the GitHub release
 *      list for the most recent stable `rust-v*` tag, fetches binaries, then
 *      writes the resolved version and verified GitHub asset SHA-256 values
 *      back to `package.json` and `scripts/runtime-assets.lock.json`. The
 *      scheduled `codex-auto-update.yml` workflow uses this to open a bump PR
 *      whenever a new Codex stable lands; humans can also run
 *      `pnpm codex:fetch:latest` locally to do the same thing in one shot.
 *
 * Why not "always latest at build time": the binary is the runtime; a moving
 * dependency means same git SHA can run different Codex behaviours on
 * different days, which breaks bisect/rollback. We pin in package.json and let
 * the scheduled workflow propose bumps via PR for human review (matches the
 * Renovate/Dependabot pattern).
 */
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import JSZip from 'jszip'
import {
  expectedRuntimeAssetDigest,
  githubAssetDigest,
  readRuntimeAssetLock,
  verifyRuntimeAssetBytes,
  writeRuntimeAssetComponent,
} from './runtime-asset-integrity.mjs'

type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
  digest?: string | null
}

type GitHubRelease = {
  tag_name?: string
  draft?: boolean
  prerelease?: boolean
  assets: GitHubReleaseAsset[]
}

const GITHUB_OWNER = process.env.CODEX_GITHUB_OWNER ?? 'openai'
const GITHUB_REPO = process.env.CODEX_GITHUB_REPO ?? 'codex'

// Strict semver-with-rust-prefix match. We deliberately reject pre-release
// suffixes like `rust-v0.132.0-rc.1` here so `--latest` never silently grabs
// an RC. If you want to test a pre-release, pin it via `CODEX_RELEASE_TAG`.
const RUST_TAG_PATTERN = /^rust-v(\d+\.\d+\.\d+)$/

const argv = new Set(process.argv.slice(2))
const requestedLatest = argv.has('--latest') || process.env.CODEX_CLI_VERSION === 'latest'

const projectRoot = path.resolve(path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'), '..')
const packageJsonPath = path.join(projectRoot, 'package.json')
const runtimeAssetLockPath = path.join(
  projectRoot,
  'scripts',
  'runtime-assets.lock.json',
)
const runtimeAssetLock = readRuntimeAssetLock(runtimeAssetLockPath)

function verifyDownloadedAsset(
  bytes: Buffer,
  target: string,
  asset: GitHubReleaseAsset,
  version: string,
  recordNewDigests: boolean,
  recordedTargets: Record<string, Record<string, string>>,
): void {
  const expectedDigest = recordNewDigests
    ? githubAssetDigest(asset)
    : expectedRuntimeAssetDigest(runtimeAssetLock, {
        component: 'codex',
        version,
        target,
        assetName: asset.name,
      })
  verifyRuntimeAssetBytes(bytes, expectedDigest, asset.name)
  recordedTargets[target] ??= {}
  recordedTargets[target][asset.name] = expectedDigest
}

const releaseTag = process.env.CODEX_RELEASE_TAG
const targets = (process.env.CODEX_TARGETS ?? `${process.platform}-${process.arch}`)
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean)

function getCodexBinaryName(target: string): string {
  return target.startsWith('win32-') ? 'codex.exe' : 'codex'
}

/**
 * Windows-only sibling helper binaries required by Codex 0.140+'s native
 * sandbox (`windows-sandbox-rs`). At runtime codex resolves them via
 * `bundled_executable_path_for_exe()` — first candidate is "same directory as
 * codex.exe" — so we download the per-target release assets and rename them to
 * the exact filenames codex probes for. Without these, any code path that
 * touches the Windows sandbox (setup refresh, apply_patch/fs helper — see
 * openai/codex#29200 #29072 #20942) throws a per-invocation Windows
 * "cannot find file" dialog even under `danger-full-access`.
 */
function getWindowsHelperBinaries(target: string): Array<{ assetName: string; fileName: string }> {
  if (!target.startsWith('win32-')) return []
  const triple = target === 'win32-arm64' ? 'aarch64-pc-windows-msvc' : 'x86_64-pc-windows-msvc'
  return [
    {
      assetName: `codex-windows-sandbox-setup-${triple}.exe`,
      fileName: 'codex-windows-sandbox-setup.exe',
    },
    {
      assetName: `codex-command-runner-${triple}.exe`,
      fileName: 'codex-command-runner.exe',
    },
  ]
}

function getTargetAliases(target: string): string[] {
  const aliases: Record<string, string[]> = {
    'win32-x64': ['win32-x64', 'windows-x64', 'x64-pc-windows', 'x86_64-pc-windows', 'x86_64-windows'],
    'darwin-arm64': ['darwin-arm64', 'macos-arm64', 'aarch64-apple-darwin', 'arm64-apple-darwin'],
    'darwin-x64': ['darwin-x64', 'macos-x64', 'x86_64-apple-darwin'],
    'linux-x64': ['linux-x64', 'x86_64-unknown-linux', 'x86_64-linux'],
  }

  return [target, ...(aliases[target] ?? [])]
}

function getArchiveKind(assetName: string): 'zip' | 'raw' | 'unsupported' {
  const lowerName = assetName.toLowerCase()

  if (lowerName.endsWith('.zip')) {
    return 'zip'
  }

  if (
    lowerName.endsWith('.tar.gz')
    || lowerName.endsWith('.tgz')
    || lowerName.endsWith('.tar.xz')
    || lowerName.endsWith('.tar')
    || lowerName.endsWith('.gz')
    || lowerName.endsWith('.xz')
    || lowerName.endsWith('.7z')
  ) {
    return 'unsupported'
  }

  return 'raw'
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'catimation-codex-fetcher',
    'X-GitHub-Api-Version': '2022-11-28',
  }

  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }

  return headers
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
  })

  if (!response.ok) {
    const rateLimitHint = response.status === 403 ? ' Set GITHUB_TOKEN to avoid GitHub API rate limits.' : ''
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText} (${url}).${rateLimitHint}`)
  }

  return await response.json() as T
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
  })

  if (!response.ok) {
    throw new Error(`Asset download failed: ${response.status} ${response.statusText} (${url})`)
  }

  return Buffer.from(await response.arrayBuffer())
}

type PackageManifest = { codexCliVersion?: string; [key: string]: unknown }

async function readPackageManifest(): Promise<PackageManifest> {
  const raw = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(raw) as PackageManifest
}

async function writePackageCodexVersion(version: string): Promise<void> {
  // Surgical regex replace instead of JSON.parse+stringify so the rest of
  // package.json (key order, trailing newline, whitespace) is untouched —
  // package.json normalisation belongs to a separate tool, not this script.
  const raw = await readFile(packageJsonPath, 'utf8')
  const next = raw.replace(
    /("codexCliVersion"\s*:\s*")[^"]+(")/,
    (_match, prefix: string, suffix: string) => `${prefix}${version}${suffix}`,
  )
  if (next === raw) {
    throw new Error('Could not locate `codexCliVersion` key in package.json to update.')
  }
  await writeFile(packageJsonPath, next)
}

async function resolvePinnedVersion(): Promise<string> {
  const envVersion = process.env.CODEX_CLI_VERSION
  if (envVersion && envVersion !== 'latest') return envVersion
  const manifest = await readPackageManifest()
  if (typeof manifest.codexCliVersion !== 'string' || manifest.codexCliVersion.length === 0) {
    throw new Error('package.json is missing the `codexCliVersion` field; set it or pass CODEX_CLI_VERSION.')
  }
  return manifest.codexCliVersion
}

async function fetchReleaseByTag(version: string): Promise<{ release: GitHubRelease; tag: string }> {
  const tags = releaseTag
    ? [releaseTag]
    : [`rust-v${version}`, `v${version}`, version]

  let lastError: unknown
  for (const tag of tags) {
    try {
      return {
        release: await fetchJson<GitHubRelease>(
          `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`,
        ),
        tag,
      }
    } catch (error) {
      lastError = error
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Could not find Codex release for ${GITHUB_OWNER}/${GITHUB_REPO}. Tried tags: ${tags.join(', ')}. ${message}`)
}

async function fetchLatestStableRustRelease(): Promise<{ release: GitHubRelease; tag: string; version: string }> {
  // The Codex repo ships multiple release tracks (rust-v*, npm-v*, etc.) so
  // GitHub's `/releases/latest` (which picks the most-recently-edited
  // non-prerelease across ALL tracks) is unreliable. List + filter ourselves.
  const list = await fetchJson<GitHubRelease[]>(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`,
  )
  for (const release of list) {
    if (release.draft || release.prerelease) continue
    const tag = release.tag_name ?? ''
    const match = RUST_TAG_PATTERN.exec(tag)
    if (!match) continue
    if (!Array.isArray(release.assets) || release.assets.length === 0) continue
    return { release, tag, version: match[1] }
  }
  throw new Error(
    `No stable rust-v* release found in the first 30 entries of ${GITHUB_OWNER}/${GITHUB_REPO}/releases.`,
  )
}

function findAssetForTarget(release: GitHubRelease, target: string): GitHubReleaseAsset {
  const aliases = getTargetAliases(target)
  const candidates = release.assets.filter((candidate) => {
    const lowerName = candidate.name.toLowerCase()
    return lowerName.includes('codex')
      && !lowerName.includes('codex-app-server')
      && !lowerName.includes('sigstore')
      && aliases.some((alias) => lowerName.includes(alias.toLowerCase()))
  })
  const asset = candidates.sort((left, right) => {
    const leftKind = getArchiveKind(left.name)
    const rightKind = getArchiveKind(right.name)
    if (leftKind !== rightKind) return leftKind === 'raw' ? -1 : 1
    return left.name.length - right.name.length
  })[0]

  if (!asset) {
    const availableAssets = release.assets.map((candidate) => candidate.name).join(', ') || '<none>'
    throw new Error(`No Codex release asset found for ${target}. Available assets: ${availableAssets}`)
  }

  return asset
}

async function extractBinaryFromZip(bytes: Buffer, binaryName: string): Promise<Buffer> {
  const archive = await JSZip.loadAsync(bytes)
  const binaryEntry = Object.values(archive.files).find((entry) => {
    return !entry.dir && path.basename(entry.name) === binaryName
  })

  if (!binaryEntry) {
    throw new Error(`Zip asset does not contain ${binaryName}`)
  }

  return await binaryEntry.async('nodebuffer')
}

async function writeCodexBinary(
  release: GitHubRelease,
  target: string,
  asset: GitHubReleaseAsset,
  version: string,
  recordNewDigests: boolean,
  recordedTargets: Record<string, Record<string, string>>,
): Promise<void> {
  const targetDir = path.join(process.cwd(), 'resources', 'codex', target)
  const binaryName = getCodexBinaryName(target)
  const binaryPath = path.join(targetDir, binaryName)
  const archiveKind = getArchiveKind(asset.name)

  if (archiveKind === 'unsupported') {
    throw new Error(`Unsupported Codex asset archive format for ${asset.name}. Only .zip and raw binary assets are supported.`)
  }

  const bytes = await fetchBytes(asset.browser_download_url)
  verifyDownloadedAsset(
    bytes,
    target,
    asset,
    version,
    recordNewDigests,
    recordedTargets,
  )

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })

  const binaryBytes = archiveKind === 'zip'
    ? await extractBinaryFromZip(bytes, binaryName)
    : bytes

  await writeFile(binaryPath, binaryBytes)
  await chmod(binaryPath, 0o755)
  console.log(`Fetched Codex ${version} for ${target}: ${path.relative(process.cwd(), binaryPath)}`)

  await writeWindowsHelperBinaries(
    release,
    target,
    targetDir,
    version,
    recordNewDigests,
    recordedTargets,
  )
}

/**
 * Downloads the Windows sandbox helper exes next to codex.exe. The release
 * ships them as raw `.exe` assets (plus .zip/.zst variants we don't need).
 * Missing assets are a hard error for pinned versions >= 0.140 since a build
 * without them ships the sandbox popup bug to users.
 */
async function writeWindowsHelperBinaries(
  release: GitHubRelease,
  target: string,
  targetDir: string,
  version: string,
  recordNewDigests: boolean,
  recordedTargets: Record<string, Record<string, string>>,
): Promise<void> {
  for (const helper of getWindowsHelperBinaries(target)) {
    const asset = release.assets.find((candidate) => candidate.name === helper.assetName)
    if (!asset) {
      throw new Error(
        `Codex release is missing Windows helper asset "${helper.assetName}" required for ${target}. `
        + 'Codex 0.140+ needs codex-windows-sandbox-setup.exe / codex-command-runner.exe next to codex.exe.',
      )
    }
    const bytes = await fetchBytes(asset.browser_download_url)
    verifyDownloadedAsset(
      bytes,
      target,
      asset,
      version,
      recordNewDigests,
      recordedTargets,
    )
    const helperPath = path.join(targetDir, helper.fileName)
    await writeFile(helperPath, bytes)
    await chmod(helperPath, 0o755)
    console.log(`Fetched Codex helper ${version} for ${target}: ${path.relative(process.cwd(), helperPath)}`)
  }
}

async function main(): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No Codex targets requested. Set CODEX_TARGETS to a comma-separated platform-arch list.')
  }

  let release: GitHubRelease
  let tag: string
  let resolvedVersion: string
  let isLatestBump = false
  const recordedTargets: Record<string, Record<string, string>> = {}

  if (requestedLatest) {
    const pinned = await resolvePinnedVersion()
    const latest = await fetchLatestStableRustRelease()
    if (latest.version === pinned) {
      console.log(`Codex CLI is already up to date at ${pinned} (latest stable rust-v${latest.version}).`)
      // Still re-fetch binaries so a fresh clone can populate `resources/codex/`
      // — but skip the write-back since nothing changed.
      release = latest.release
      tag = latest.tag
      resolvedVersion = latest.version
    } else {
      console.log(`Bumping Codex CLI: ${pinned} → ${latest.version} (tag ${latest.tag}).`)
      release = latest.release
      tag = latest.tag
      resolvedVersion = latest.version
      isLatestBump = true
    }
  } else {
    resolvedVersion = await resolvePinnedVersion()
    const result = await fetchReleaseByTag(resolvedVersion)
    release = result.release
    tag = result.tag
  }

  for (const target of targets) {
    const asset = findAssetForTarget(release, target)
    await writeCodexBinary(
      release,
      target,
      asset,
      resolvedVersion,
      isLatestBump,
      recordedTargets,
    )
  }

  if (isLatestBump) {
    if (!recordedTargets['win32-x64']) {
      throw new Error(
        'Codex version bumps must fetch win32-x64 to update the production digest lock',
      )
    }
    writeRuntimeAssetComponent(runtimeAssetLockPath, runtimeAssetLock, {
      component: 'codex',
      version: resolvedVersion,
      targets: recordedTargets,
    })
    await writePackageCodexVersion(resolvedVersion)
    console.log(
      `Updated package.json codexCliVersion and runtime asset digests → ${resolvedVersion}`,
    )
  }

  console.log(`Fetched Codex release ${tag} from ${GITHUB_OWNER}/${GITHUB_REPO}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
