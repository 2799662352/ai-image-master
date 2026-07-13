/**
 * Fetch the bundled gyan.dev FFmpeg (ffmpeg + ffprobe) for one or more Windows
 * targets, mirroring scripts/fetch-codex.ts.
 *
 * Why bundle ffmpeg at all: Codex (running with sandbox_mode=danger-full-access)
 * shells out to `ffmpeg`/`ffprobe` for video transcode / 抽帧 / 字幕 / 封面 /
 * 音频提取. Shipping the binary + injecting its dir into Codex's PATH (see
 * src/main/agent/CodexLocalBackend.ts → buildCodexSpawnEnv) means the user
 * installs NOTHING and gets full capability with zero Docker dependency.
 *
 * Why gyan `full_build-shared`: gyan.dev is the distribution ffmpeg.org lists
 * for Windows, and the npm `ffmpeg-static` we already ship is itself a gyan
 * build. The *shared* full build has the SAME complete codec/filter set as the
 * static full build but ~half the on-disk size (tiny exes + one set of shared
 * DLLs instead of statically linking ~120MB into every exe). We extract the
 * whole `bin/` (ffmpeg.exe + ffprobe.exe + the avcodec/avformat/... DLLs) and
 * drop only ffplay.exe — Codex never plays video. The exe + its DLLs MUST stay
 * in the same folder (Windows loads DLLs from the exe dir first), which our
 * single `resources/ffmpeg/<target>/` layout guarantees.
 *
 * Two modes (identical contract to fetch-codex.ts):
 *   1. Pinned (default) — `package.json.ffmpegBuildTag` for reproducible CI
 *      builds. Override per-invocation with `FFMPEG_BUILD_TAG=<tag>`.
 *   2. `--latest` (or `FFMPEG_BUILD_TAG=latest`) — queries GyanD/codexffmpeg for
 *      the most recent stable versioned release, fetches it, then writes the
 *      resolved tag and verified asset SHA-256 to `package.json` and
 *      `scripts/runtime-assets.lock.json`.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
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

const GITHUB_OWNER = process.env.FFMPEG_GITHUB_OWNER ?? 'GyanD'
const GITHUB_REPO = process.env.FFMPEG_GITHUB_REPO ?? 'codexffmpeg'

// gyan release tags are bare versions: `8.1.1`, `7.1`, `6.0`. We reject the
// date-`git-*` tags here so `--latest` never silently grabs a git snapshot —
// shipped builds should be stable releases. ffplay.exe is dropped (unused).
const RELEASE_TAG_PATTERN = /^(\d+\.\d+(?:\.\d+)?)$/
const DROPPED_BINARIES = new Set(['ffplay.exe'])

const argv = new Set(process.argv.slice(2))
const requestedLatest = argv.has('--latest') || process.env.FFMPEG_BUILD_TAG === 'latest'

const projectRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname).replace(/^\/([A-Za-z]:)/, '$1'),
  '..',
)
const packageJsonPath = path.join(projectRoot, 'package.json')
const runtimeAssetLockPath = path.join(
  projectRoot,
  'scripts',
  'runtime-assets.lock.json',
)
const runtimeAssetLock = readRuntimeAssetLock(runtimeAssetLockPath)

// gyan ships Windows only. Non-Windows targets fall back to system/Docker
// ffmpeg, so we skip them instead of failing the whole build.
const targets = (process.env.FFMPEG_TARGETS ?? `${process.platform}-${process.arch}`)
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean)

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'catimation-ffmpeg-fetcher',
    'X-GitHub-Api-Version': '2022-11-28',
  }
  if (process.env.GITHUB_TOKEN) {
    headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`
  }
  return headers
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { headers: getGitHubHeaders() })
  if (!response.ok) {
    const rateLimitHint = response.status === 403 ? ' Set GITHUB_TOKEN to avoid GitHub API rate limits.' : ''
    throw new Error(`GitHub request failed: ${response.status} ${response.statusText} (${url}).${rateLimitHint}`)
  }
  return await response.json() as T
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: getGitHubHeaders() })
  if (!response.ok) {
    throw new Error(`Asset download failed: ${response.status} ${response.statusText} (${url})`)
  }
  return Buffer.from(await response.arrayBuffer())
}

type PackageManifest = { ffmpegBuildTag?: string; [key: string]: unknown }

async function readPackageManifest(): Promise<PackageManifest> {
  const raw = await readFile(packageJsonPath, 'utf8')
  return JSON.parse(raw) as PackageManifest
}

async function writePackageFfmpegTag(tag: string): Promise<void> {
  // Surgical regex replace (not JSON.parse+stringify) so key order / whitespace
  // / trailing newline in package.json stay untouched — same approach as
  // fetch-codex.ts's writePackageCodexVersion.
  const raw = await readFile(packageJsonPath, 'utf8')
  const next = raw.replace(
    /("ffmpegBuildTag"\s*:\s*")[^"]+(")/,
    (_match, prefix: string, suffix: string) => `${prefix}${tag}${suffix}`,
  )
  if (next === raw) {
    throw new Error('Could not locate `ffmpegBuildTag` key in package.json to update.')
  }
  await writeFile(packageJsonPath, next)
}

async function resolvePinnedTag(): Promise<string> {
  const envTag = process.env.FFMPEG_BUILD_TAG
  if (envTag && envTag !== 'latest') return envTag
  const manifest = await readPackageManifest()
  if (typeof manifest.ffmpegBuildTag !== 'string' || manifest.ffmpegBuildTag.length === 0) {
    throw new Error('package.json is missing the `ffmpegBuildTag` field; set it or pass FFMPEG_BUILD_TAG.')
  }
  return manifest.ffmpegBuildTag
}

async function fetchReleaseByTag(tag: string): Promise<GitHubRelease> {
  return await fetchJson<GitHubRelease>(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/tags/${tag}`,
  )
}

async function fetchLatestStableRelease(): Promise<{ release: GitHubRelease; tag: string }> {
  const list = await fetchJson<GitHubRelease[]>(
    `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases?per_page=30`,
  )
  for (const release of list) {
    if (release.draft || release.prerelease) continue
    const tag = release.tag_name ?? ''
    if (!RELEASE_TAG_PATTERN.test(tag)) continue
    if (!Array.isArray(release.assets) || release.assets.length === 0) continue
    if (!release.assets.some((asset) => asset.name.toLowerCase().includes('full_build-shared.zip'))) continue
    return { release, tag }
  }
  throw new Error(
    `No stable full_build-shared.zip release found in the first 30 entries of ${GITHUB_OWNER}/${GITHUB_REPO}/releases.`,
  )
}

function findSharedZipAsset(release: GitHubRelease): GitHubReleaseAsset {
  const asset = release.assets.find((candidate) => candidate.name.toLowerCase().includes('full_build-shared.zip'))
  if (!asset) {
    const available = release.assets.map((candidate) => candidate.name).join(', ') || '<none>'
    throw new Error(`No full_build-shared.zip asset found. Available assets: ${available}`)
  }
  return asset
}

async function extractFfmpegBinaries(bytes: Buffer, targetDir: string): Promise<string[]> {
  const archive = await JSZip.loadAsync(bytes)
  // gyan zips are nested as `ffmpeg-<tag>-full_build-shared/bin/<files>`. We
  // take every file under a `bin/` directory (exes + DLLs) and flatten it into
  // targetDir, skipping the unused ffplay.exe.
  const binEntries = Object.values(archive.files).filter((entry) => {
    if (entry.dir) return false
    const normalized = entry.name.replace(/\\/g, '/')
    if (!/\/bin\/[^/]+$/.test(normalized)) return false
    return !DROPPED_BINARIES.has(path.basename(normalized).toLowerCase())
  })

  if (binEntries.length === 0) {
    throw new Error('Shared zip contained no bin/ files (ffmpeg.exe / ffprobe.exe / *.dll).')
  }

  const written: string[] = []
  for (const entry of binEntries) {
    const fileName = path.basename(entry.name)
    const outPath = path.join(targetDir, fileName)
    const data = await entry.async('nodebuffer')
    await writeFile(outPath, data)
    written.push(fileName)
  }
  return written
}

async function writeFfmpegBundle(
  target: string,
  asset: GitHubReleaseAsset,
  tag: string,
  recordNewDigests: boolean,
  recordedTargets: Record<string, Record<string, string>>,
): Promise<void> {
  const targetDir = path.join(process.cwd(), 'resources', 'ffmpeg', target)
  if (!target.startsWith('win32-')) {
    // gyan ships Windows only. Still create the (empty) target dir so the
    // electron-builder `extraResources` `from:` path exists on mac/linux builds
    // (a missing `from` aborts packaging). Non-win runtime falls back to system
    // ffmpeg, so an empty bundle dir is the correct, harmless outcome.
    await mkdir(targetDir, { recursive: true })
    console.log(`Skipping ffmpeg binaries for ${target}: gyan ships Windows only. Created empty ${path.relative(process.cwd(), targetDir)} for packaging.`)
    return
  }
  const bytes = await fetchBytes(asset.browser_download_url)
  const expectedDigest = recordNewDigests
    ? githubAssetDigest(asset)
    : expectedRuntimeAssetDigest(runtimeAssetLock, {
        component: 'ffmpeg',
        version: tag,
        target,
        assetName: asset.name,
      })
  verifyRuntimeAssetBytes(bytes, expectedDigest, asset.name)
  recordedTargets[target] ??= {}
  recordedTargets[target][asset.name] = expectedDigest

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })

  const written = await extractFfmpegBinaries(bytes, targetDir)
  const hasFfmpeg = written.some((name) => name.toLowerCase() === 'ffmpeg.exe')
  const hasFfprobe = written.some((name) => name.toLowerCase() === 'ffprobe.exe')
  if (!hasFfmpeg || !hasFfprobe) {
    throw new Error(`Extracted bundle is missing ffmpeg.exe and/or ffprobe.exe (got: ${written.join(', ')}).`)
  }
  console.log(`Fetched gyan ffmpeg ${tag} for ${target}: ${written.length} files → ${path.relative(process.cwd(), targetDir)}`)
}

async function main(): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No ffmpeg targets requested. Set FFMPEG_TARGETS to a comma-separated platform-arch list.')
  }

  let release: GitHubRelease
  let tag: string
  let isLatestBump = false
  const recordedTargets: Record<string, Record<string, string>> = {}

  if (requestedLatest) {
    const pinned = await resolvePinnedTag().catch(() => '')
    const latest = await fetchLatestStableRelease()
    tag = latest.tag
    release = latest.release
    if (latest.tag !== pinned) {
      console.log(`Bumping gyan ffmpeg: ${pinned || '<unset>'} → ${latest.tag}.`)
      isLatestBump = true
    } else {
      console.log(`gyan ffmpeg already up to date at ${pinned}.`)
    }
  } else {
    tag = await resolvePinnedTag()
    release = await fetchReleaseByTag(tag)
  }

  const asset = findSharedZipAsset(release)
  for (const target of targets) {
    await writeFfmpegBundle(
      target,
      asset,
      tag,
      isLatestBump,
      recordedTargets,
    )
  }

  if (isLatestBump) {
    if (!recordedTargets['win32-x64']) {
      throw new Error(
        'FFmpeg version bumps must fetch win32-x64 to update the production digest lock',
      )
    }
    writeRuntimeAssetComponent(runtimeAssetLockPath, runtimeAssetLock, {
      component: 'ffmpeg',
      version: tag,
      targets: recordedTargets,
    })
    await writePackageFfmpegTag(tag)
    console.log(
      `Updated package.json ffmpegBuildTag and runtime asset digests → ${tag}`,
    )
  }

  console.log(`Fetched gyan ffmpeg release ${tag} from ${GITHUB_OWNER}/${GITHUB_REPO}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
