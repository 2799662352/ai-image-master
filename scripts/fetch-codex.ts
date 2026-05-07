import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import JSZip from 'jszip'

type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
}

type GitHubRelease = {
  assets: GitHubReleaseAsset[]
}

const GITHUB_OWNER = process.env.CODEX_GITHUB_OWNER ?? 'openai'
const GITHUB_REPO = process.env.CODEX_GITHUB_REPO ?? 'codex'
const DEFAULT_CODEX_VERSION = '0.128.0'

const codexVersion = process.env.CODEX_CLI_VERSION ?? DEFAULT_CODEX_VERSION
const releaseTag = process.env.CODEX_RELEASE_TAG
const targets = (process.env.CODEX_TARGETS ?? `${process.platform}-${process.arch}`)
  .split(',')
  .map((target) => target.trim())
  .filter(Boolean)

function getCodexBinaryName(target: string): string {
  return target.startsWith('win32-') ? 'codex.exe' : 'codex'
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

async function fetchRelease(): Promise<{ release: GitHubRelease, tag: string }> {
  const tags = releaseTag
    ? [releaseTag]
    : [`rust-v${codexVersion}`, `v${codexVersion}`, codexVersion]

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

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, {
    headers: getGitHubHeaders(),
  })

  if (!response.ok) {
    throw new Error(`Asset download failed: ${response.status} ${response.statusText} (${url})`)
  }

  return Buffer.from(await response.arrayBuffer())
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

async function writeCodexBinary(target: string, asset: GitHubReleaseAsset): Promise<void> {
  const targetDir = path.join(process.cwd(), 'resources', 'codex', target)
  const binaryName = getCodexBinaryName(target)
  const binaryPath = path.join(targetDir, binaryName)
  const archiveKind = getArchiveKind(asset.name)

  if (archiveKind === 'unsupported') {
    throw new Error(`Unsupported Codex asset archive format for ${asset.name}. Only .zip and raw binary assets are supported.`)
  }

  const bytes = await fetchBytes(asset.browser_download_url)

  await rm(targetDir, { recursive: true, force: true })
  await mkdir(targetDir, { recursive: true })

  const binaryBytes = archiveKind === 'zip'
    ? await extractBinaryFromZip(bytes, binaryName)
    : bytes

  await writeFile(binaryPath, binaryBytes)
  await chmod(binaryPath, 0o755)
  console.log(`Fetched Codex ${codexVersion} for ${target}: ${path.relative(process.cwd(), binaryPath)}`)
}

async function main(): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No Codex targets requested. Set CODEX_TARGETS to a comma-separated platform-arch list.')
  }

  const { release, tag } = await fetchRelease()

  for (const target of targets) {
    const asset = findAssetForTarget(release, target)
    await writeCodexBinary(target, asset)
  }
  console.log(`Fetched Codex release ${tag} from ${GITHUB_OWNER}/${GITHUB_REPO}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
