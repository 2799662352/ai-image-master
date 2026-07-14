#!/usr/bin/env node

import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { expectedCosUpdateUrl } from './update-url-contract.mjs'

const PRODUCT_NAME = 'CATIMATION-Cyberpunk Master'
const TAGLINE = 'AI 图片与视频创作桌面应用 · Windows x64'

export const SITE_COPY = {
  summary:
    '面向创作者的 Windows 桌面工作站：从 AI 出图、视频分镜到 Agent 协作，一套工具完成视觉生产流程。',
  pagePurpose:
    '这是 CATIMATION 的官方下载页。它不负责在 GitHub 上托管 460MB 安装包，而是展示最新版本信息，并安全跳转到腾讯云 COS 直链。适合首次安装、换机重装，或需要核对 SHA-256 的用户。',
  product:
    'CATIMATION-Cyberpunk Master 是 Electron 桌面应用，内置图片生成、视频创作、分镜导演、Agent 对话与 MCP 工具链。安装后可在本地离线使用核心界面，联网时调用模型与热更新服务。',
  updates:
    '已安装用户会在应用内自动收到更新提示；此页面面向新用户首次下载。版本清单由 COS 热更新频道维护，GitHub Release 作为维护者审计与备用下载面。',
  features: [
    {
      id: 'image',
      title: 'AI 图片生成',
      description:
        '多模型出图、批量对比、历史管理与模板工作流，适合概念设计和高频迭代。',
    },
    {
      id: 'video',
      title: '视频与分镜',
      description:
        '从参考图到分镜表，再到 Seedance 视频提示词，一条龙完成视觉叙事。',
    },
    {
      id: 'agent',
      title: 'Agent 工作台',
      description:
        '内置 Codex Agent、Skills 与 MCP 工具，让复杂创作任务可对话式编排。',
    },
    {
      id: 'director',
      title: '导演台',
      description: '三维导演台与 Canvas 画布协同，适合镜头语言、构图和场景预演。',
    },
    {
      id: 'update',
      title: '自动热更新',
      description:
        '安装后无需反复打开此页面；稳定版会通过 electron-updater 自动推送。',
    },
    {
      id: 'verify',
      title: '可验证发布',
      description:
        '每个版本附带 SHA-256、Release 说明与 immutable 制品清单，便于核对完整性。',
    },
  ],
}

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
    site: SITE_COPY,
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
