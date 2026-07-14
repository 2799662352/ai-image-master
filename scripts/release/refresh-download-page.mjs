#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

import {
  buildDownloadPageData,
  writeDownloadPageBundle,
} from './generate-download-page.mjs'
import { expectedCosUpdateUrl } from './update-url-contract.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

async function fetchText(url, { fetchImplementation = fetch } = {}) {
  const response = await fetchImplementation(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`GET ${url} failed with HTTP ${response.status}`)
  }
  return response.text()
}

export async function refreshDownloadPageFromChannel({
  bucket,
  region,
  prefix,
  repository,
  repoRoot = process.cwd(),
  outputDirectory = path.join(repoRoot, 'docs', 'download'),
  fetchImplementation = fetch,
}) {
  const cosBaseUrl = expectedCosUpdateUrl({ bucket, region, prefix }).replace(
    /\/+$/,
    '',
  )

  const channelManifest = parse(
    await fetchText(`${cosBaseUrl}/latest.yml`, { fetchImplementation }),
  )
  const version = channelManifest?.version
  if (!version) {
    throw new Error('Channel latest.yml does not declare a version')
  }

  const manifest = JSON.parse(
    await fetchText(`${cosBaseUrl}/versions/${version}/release-manifest.json`, {
      fetchImplementation,
    }),
  )
  if (manifest.version !== version) {
    throw new Error(
      `release-manifest.json version ${manifest.version} does not match channel version ${version}`,
    )
  }

  const notesPath = path.join(repoRoot, 'docs', 'releases', `v${version}.md`)
  const releaseNotesMarkdown = existsSync(notesPath)
    ? readFileSync(notesPath, 'utf8')
    : ''

  const data = buildDownloadPageData({
    manifest,
    cosBaseUrl,
    githubReleaseUrl: `https://github.com/${repository}/releases/tag/v${version}`,
    releaseNotesMarkdown,
    repository,
  })

  writeDownloadPageBundle({ data, outputDirectory, repoRoot })
  return data
}

async function runCli() {
  const data = await refreshDownloadPageFromChannel({
    bucket: requiredEnvironment('COS_BUCKET'),
    region: requiredEnvironment('COS_REGION'),
    prefix: requiredEnvironment('COS_PREFIX'),
    repository: process.env.GITHUB_REPOSITORY ?? '2799662352/ai-image-master',
  })
  console.log(
    JSON.stringify({
      ok: true,
      version: data.version,
      downloadUrl: data.platform.downloadUrl,
    }),
  )
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  runCli().catch((error) => {
    console.error(
      `[download-page] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
