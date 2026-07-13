import { access, chmod, mkdir, writeFile } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import process from 'node:process'
import os from 'node:os'
import {
  expectedRuntimeAssetDigest,
  readRuntimeAssetLock,
  verifyRuntimeAssetBytes,
} from './runtime-asset-integrity.mjs'

type GitHubReleaseAsset = {
  name: string
  browser_download_url: string
  digest?: string | null
}

type GitHubRelease = {
  assets: GitHubReleaseAsset[]
}

const GITHUB_OWNER = 'docker'
const GITHUB_REPO = 'mcp-gateway'

const pkg = JSON.parse(readFileSync(path.join(process.cwd(), 'package.json'), 'utf-8'))
const dockerMcpVersion: string = process.env.DOCKER_MCP_VERSION ?? pkg.dockerMcpGatewayVersion ?? '0.42.1'
const runtimeAssetLock = readRuntimeAssetLock(
  path.join(process.cwd(), 'scripts', 'runtime-assets.lock.json'),
)

const targets = (process.env.DOCKER_MCP_TARGETS ?? `${process.platform}-${process.arch}`)
  .split(',')
  .map((t) => t.trim())
  .filter(Boolean)

const MAX_RETRIES = 3
const RETRY_BASE_MS = 1000

const ASSET_MAP: Record<string, string> = {
  'win32-x64': 'docker-mcp-windows-amd64.tar.gz',
  'darwin-arm64': 'docker-mcp-darwin-arm64.tar.gz',
  'darwin-x64': 'docker-mcp-darwin-amd64.tar.gz',
  'linux-x64': 'docker-mcp-linux-amd64.tar.gz',
  'linux-arm64': 'docker-mcp-linux-arm64.tar.gz',
}

function getBinaryName(target: string): string {
  return target.startsWith('win32-') ? 'docker-mcp.exe' : 'docker-mcp'
}

function getGitHubHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'catimation-docker-mcp-fetcher',
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

async function fetchRelease(): Promise<{ release: GitHubRelease, tag: string }> {
  const tags = [`v${dockerMcpVersion}`, dockerMcpVersion]

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
  throw new Error(`Could not find docker-mcp release for ${GITHUB_OWNER}/${GITHUB_REPO}. Tried tags: ${tags.join(', ')}. ${message}`)
}

async function fetchBytes(url: string): Promise<Buffer> {
  const response = await fetch(url, { headers: getGitHubHeaders() })

  if (!response.ok) {
    throw new Error(`Asset download failed: ${response.status} ${response.statusText} (${url})`)
  }

  return Buffer.from(await response.arrayBuffer())
}

function findAssetForTarget(release: GitHubRelease, target: string): GitHubReleaseAsset {
  const expectedName = ASSET_MAP[target]
  if (!expectedName) {
    const supported = Object.keys(ASSET_MAP).join(', ')
    throw new Error(`Unsupported target: ${target}. Supported targets: ${supported}`)
  }

  const asset = release.assets.find((a) => a.name === expectedName)
  if (!asset) {
    const available = release.assets.map((a) => a.name).join(', ') || '<none>'
    throw new Error(`No docker-mcp asset "${expectedName}" found for ${target}. Available: ${available}`)
  }

  return asset
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function extractTarGz(tarGzPath: string, destDir: string): Promise<void> {
  execFileSync('tar', ['-xzf', tarGzPath, '-C', destDir], { stdio: 'pipe' })
}

async function downloadWithRetry(target: string, asset: GitHubReleaseAsset): Promise<void> {
  const targetDir = path.join(process.cwd(), 'resources', 'docker-mcp', target)
  const binaryName = getBinaryName(target)
  const binaryPath = path.join(targetDir, binaryName)

  if (
    process.env.GITHUB_ACTIONS !== 'true' &&
    (await fileExists(binaryPath))
  ) {
    console.log(`Cached: ${path.relative(process.cwd(), binaryPath)} already exists, skipping download.`)
    return
  }

  await mkdir(targetDir, { recursive: true })

  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      console.log(`Downloading ${asset.name} (attempt ${attempt}/${MAX_RETRIES})...`)
      const bytes = await fetchBytes(asset.browser_download_url)
      const expectedDigest = expectedRuntimeAssetDigest(runtimeAssetLock, {
        component: 'dockerMcp',
        version: dockerMcpVersion,
        target,
        assetName: asset.name,
      })
      verifyRuntimeAssetBytes(bytes, expectedDigest, asset.name)

      const tmpTarGz = path.join(os.tmpdir(), `docker-mcp-${target}-${Date.now()}.tar.gz`)
      await writeFile(tmpTarGz, bytes)
      await extractTarGz(tmpTarGz, targetDir)

      if (!(await fileExists(binaryPath))) {
        throw new Error(`Extraction succeeded but ${binaryName} not found in ${targetDir}`)
      }

      await chmod(binaryPath, 0o755)
      console.log(`Fetched docker-mcp ${dockerMcpVersion} for ${target}: ${path.relative(process.cwd(), binaryPath)}`)
      return
    } catch (error) {
      lastError = error
      if (attempt < MAX_RETRIES) {
        const delayMs = RETRY_BASE_MS * 2 ** (attempt - 1)
        console.warn(`Attempt ${attempt} failed, retrying in ${delayMs}ms...`)
        await sleep(delayMs)
      }
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError)
  throw new Error(`Failed to download ${asset.name} after ${MAX_RETRIES} attempts: ${message}`)
}

async function main(): Promise<void> {
  if (targets.length === 0) {
    throw new Error('No docker-mcp targets requested. Set DOCKER_MCP_TARGETS to a comma-separated platform-arch list.')
  }

  console.log(`Fetching docker-mcp v${dockerMcpVersion} for targets: ${targets.join(', ')}`)
  const { release, tag } = await fetchRelease()

  for (const target of targets) {
    const asset = findAssetForTarget(release, target)
    await downloadWithRetry(target, asset)
  }

  console.log(`Done — docker-mcp release ${tag} from ${GITHUB_OWNER}/${GITHUB_REPO}`)
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(message)
  process.exitCode = 1
})
