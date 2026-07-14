#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { expectedCosUpdateUrl } from './update-url-contract.mjs'

const PRODUCT_NAME = 'CATIMATION-Cyberpunk Master'
const TAGLINE = 'AI 图片与视频创作桌面应用 · Windows x64'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'))
}

function findInstaller(files) {
  const installers = files.filter((file) => file.name.endsWith('.exe'))
  if (installers.length !== 1) {
    throw new Error('Expected exactly one Windows installer in release-manifest.json')
  }
  return installers[0]
}

function extractHighlights(markdown) {
  const lines = markdown.split(/\r?\n/)
  const highlights = []
  let inSection = false

  for (const line of lines) {
    if (/^#\s/.test(line) && !/^##\s/.test(line)) continue
    if (/^##\s/.test(line)) {
      inSection = true
      continue
    }
    if (/^##\s/.test(line) && highlights.length > 0) break
    if (!inSection) continue
    const match = line.match(/^\s*[-*]\s+(.+)$/)
    if (match) highlights.push(match[1].trim())
    if (highlights.length >= 6) break
  }

  return highlights
}

function formatBytes(bytes) {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(2)} GB`
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${bytes} B`
}

export function buildDownloadPageData({
  manifest,
  cosBaseUrl,
  githubReleaseUrl,
  releaseNotesMarkdown = '',
  repository,
}) {
  const installer = findInstaller(manifest.files)
  const normalizedBase = cosBaseUrl.replace(/\/+$/, '')
  const highlights = extractHighlights(releaseNotesMarkdown)

  return {
    schemaVersion: 1,
    productName: PRODUCT_NAME,
    tagline: TAGLINE,
    repository,
    version: manifest.version,
    channel: manifest.channel,
    publishedAt: manifest.createdAt,
    signing: manifest.signing,
    platform: {
      os: 'Windows',
      arch: 'x64',
      label: 'Windows x64',
      installerName: installer.name,
      sizeBytes: installer.size,
      sizeLabel: formatBytes(installer.size),
      sha256: installer.sha256,
      downloadUrl: `${normalizedBase}/${installer.name}`,
    },
    githubReleaseUrl,
    hotUpdateUrl: `${normalizedBase}/${manifest.channelManifest}`,
    highlights,
    updatedAt: new Date().toISOString(),
  }
}

export function writeDownloadPageBundle({
  data,
  outputDirectory,
  repoRoot = process.cwd(),
}) {
  mkdirSync(outputDirectory, { recursive: true })
  mkdirSync(path.join(outputDirectory, 'assets'), { recursive: true })

  writeFileSync(
    path.join(outputDirectory, 'data.json'),
    `${JSON.stringify(data, null, 2)}\n`,
    'utf8',
  )

  const logoSource = path.join(repoRoot, 'images', 'logo.svg')
  copyFileSync(logoSource, path.join(outputDirectory, 'assets', 'logo.svg'))
}

function runCli() {
  const repoRoot = process.cwd()
  const releaseDirectory = path.resolve(requiredEnvironment('RELEASE_DIR'))
  const outputDirectory = path.resolve(
    process.env.DOWNLOAD_PAGE_DIR ?? path.join(repoRoot, 'docs', 'download'),
  )
  const manifest = readJson(path.join(releaseDirectory, 'release-manifest.json'))
  const notesPath = process.env.RELEASE_NOTES_PATH
  const releaseNotesMarkdown = notesPath
    ? readFileSync(path.resolve(notesPath), 'utf8')
    : ''

  const cosBaseUrl = expectedCosUpdateUrl({
    bucket: requiredEnvironment('COS_BUCKET'),
    region: requiredEnvironment('COS_REGION'),
    prefix: requiredEnvironment('COS_PREFIX'),
  })

  const repository =
    process.env.GITHUB_REPOSITORY ?? '2799662352/ai-image-master'
  const versionTag = `v${manifest.version}`
  const githubReleaseUrl =
    process.env.GITHUB_RELEASE_URL ??
    `https://github.com/${repository}/releases/tag/${versionTag}`

  const data = buildDownloadPageData({
    manifest,
    cosBaseUrl,
    githubReleaseUrl,
    releaseNotesMarkdown,
    repository,
  })

  writeDownloadPageBundle({ data, outputDirectory, repoRoot })
  console.log(
    JSON.stringify({
      ok: true,
      version: data.version,
      outputDirectory,
      downloadUrl: data.platform.downloadUrl,
    }),
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runCli()
  } catch (error) {
    console.error(
      `[download-page] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
