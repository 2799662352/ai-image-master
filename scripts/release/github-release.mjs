#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  createReadStream,
  readFileSync,
  statSync,
} from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

import {
  deriveReleaseChannel,
  parseReleaseVersion,
  validateReleaseManifest,
  validateReleaseNotes,
} from './release-contract.mjs'
import { appendGithubOutputs } from './github-output.mjs'

const API_ROOT = 'https://api.github.com'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function headers(accept = 'application/vnd.github+json') {
  return {
    Accept: accept,
    Authorization: `Bearer ${requiredEnvironment('GITHUB_TOKEN')}`,
    'User-Agent': 'catimation-release-orchestrator',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function github(pathname, options = {}, allowNotFound = false) {
  const response = await fetch(`${API_ROOT}${pathname}`, {
    ...options,
    headers: {
      ...headers(),
      ...options.headers,
    },
  })
  if (allowNotFound && response.status === 404) return null
  if (!response.ok) {
    const message = await response.text()
    throw new Error(
      `GitHub API ${options.method ?? 'GET'} ${pathname} failed (${response.status}): ${message.slice(0, 500)}`,
    )
  }
  if (response.status === 204) return null
  return response.json()
}

function writeOutputs(values) {
  appendGithubOutputs(process.env.GITHUB_OUTPUT, values)
}

function releaseContext() {
  const version = parseReleaseVersion(requiredEnvironment('RELEASE_VERSION'))
  const repository = requiredEnvironment('GITHUB_REPOSITORY')
  const releaseSha = requiredEnvironment('RELEASE_SHA')
  const directory = path.resolve(requiredEnvironment('RELEASE_DIR'))
  const tag = `v${version}`
  const manifest = validateReleaseManifest(
    JSON.parse(
      readFileSync(path.join(directory, 'release-manifest.json'), 'utf8'),
    ),
  )
  if (manifest.version !== version) {
    throw new Error('Canonical manifest version does not match release input')
  }
  return {
    version,
    repository,
    releaseSha,
    directory,
    tag,
    manifest,
    prerelease: deriveReleaseChannel(version) !== 'stable',
  }
}

async function ensureTag(context) {
  const existing = await github(
    `/repos/${context.repository}/git/ref/tags/${encodeURIComponent(context.tag)}`,
    {},
    true,
  )
  if (existing) {
    let targetSha = existing.object?.sha
    if (existing.object?.type === 'tag') {
      const annotated = await github(
        `/repos/${context.repository}/git/tags/${targetSha}`,
      )
      targetSha = annotated.object?.sha
    }
    if (targetSha !== context.releaseSha) {
      throw new Error(
        `Tag ${context.tag} already points to a different commit`,
      )
    }
    return
  }
  await github(`/repos/${context.repository}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({
      ref: `refs/tags/${context.tag}`,
      sha: context.releaseSha,
    }),
  })
}

async function getRelease(context) {
  return github(
    `/repos/${context.repository}/releases/tags/${encodeURIComponent(context.tag)}`,
    {},
    true,
  )
}

function releaseBody(context) {
  const notesPath = path.resolve(requiredEnvironment('RELEASE_NOTES_PATH'))
  const notes = readFileSync(notesPath, 'utf8')
  validateReleaseNotes(notes)
  const signing =
    context.manifest.signing.status === 'signed'
      ? `Windows Authenticode：已签名（${context.manifest.signing.subject ?? '主题由证书决定'}）`
      : 'Windows Authenticode：未配置 Windows 代码签名证书'
  const hashes = context.manifest.files
    .map((file) => `- \`${file.name}\` — SHA-256 \`${file.sha256}\``)
    .join('\n')
  return `${notes.trim()}\n\n## 发布验证\n\n${signing}\n\n${hashes}\n`
}

async function ensureRelease(context) {
  const existing = await getRelease(context)
  if (existing) {
    if (existing.prerelease !== context.prerelease) {
      throw new Error('Existing GitHub Release prerelease state is inconsistent')
    }
    const expectedBody = releaseBody(context)
    if (existing.body !== expectedBody) {
      if (!existing.draft) {
        throw new Error('Published GitHub Release body is inconsistent')
      }
      return github(
        `/repos/${context.repository}/releases/${existing.id}`,
        {
          method: 'PATCH',
          body: JSON.stringify({
            name: context.tag,
            body: expectedBody,
            draft: true,
            prerelease: context.prerelease,
          }),
        },
      )
    }
    return existing
  }
  return github(`/repos/${context.repository}/releases`, {
    method: 'POST',
    body: JSON.stringify({
      tag_name: context.tag,
      name: context.tag,
      body: releaseBody(context),
      draft: true,
      prerelease: context.prerelease,
      make_latest: 'false',
    }),
  })
}

async function hashLocal(filePath) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) hash.update(chunk)
  return hash.digest('hex')
}

async function hashAsset(asset) {
  const response = await fetch(asset.url, {
    headers: headers('application/octet-stream'),
    redirect: 'follow',
  })
  if (!response.ok || !response.body) {
    throw new Error(`Unable to download existing GitHub asset ${asset.name}`)
  }
  const hash = createHash('sha256')
  for await (const chunk of response.body) hash.update(chunk)
  return hash.digest('hex')
}

function expectedAssetNames(context) {
  return [
    ...context.manifest.files.map((file) => file.name),
    'release-manifest.json',
    'SHA256SUMS.txt',
  ]
}

async function ensureAssets(context, release) {
  const assets = release.assets ?? []
  const expectedNames = expectedAssetNames(context)
  const expectedSet = new Set(expectedNames)
  const unexpected = assets.filter((asset) => !expectedSet.has(asset.name))
  if (unexpected.length > 0) {
    throw new Error(
      `GitHub Release contains unexpected assets: ${unexpected
        .map((asset) => asset.name)
        .join(', ')}`,
    )
  }
  for (const name of expectedNames) {
    const filePath = path.join(context.directory, name)
    const localHash = await hashLocal(filePath)
    const existing = assets.find((asset) => asset.name === name)
    if (existing) {
      if (
        Number(existing.size) !== statSync(filePath).size ||
        (await hashAsset(existing)) !== localHash
      ) {
        throw new Error(
          `GitHub Release asset ${name} exists with different content`,
        )
      }
      continue
    }
    if (!release.draft) {
      throw new Error(`Published GitHub Release is missing asset ${name}`)
    }
    const upload = spawnSync(
      'gh',
      [
        'release',
        'upload',
        context.tag,
        filePath,
        '--repo',
        context.repository,
      ],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          GH_TOKEN: requiredEnvironment('GITHUB_TOKEN'),
        },
      },
    )
    if (upload.status !== 0) {
      throw new Error(`Failed to upload GitHub Release asset ${name}`)
    }
  }
  return getRelease(context)
}

async function publishRelease(context, release) {
  if (!release.draft) return release
  return github(`/repos/${context.repository}/releases/${release.id}`, {
    method: 'PATCH',
    body: JSON.stringify({
      draft: false,
      prerelease: context.prerelease,
      make_latest: context.prerelease ? 'false' : 'true',
    }),
  })
}

async function verifyLatestRelease(repository, releaseId) {
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const latest = await github(`/repos/${repository}/releases/latest`)
    if (latest?.id === releaseId) return
    if (attempt < 4) {
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
  }
  throw new Error('Published stable GitHub Release is not marked latest')
}

async function verifyPublished(context, release) {
  if (release.draft) throw new Error('GitHub Release is still a draft')
  if (release.prerelease !== context.prerelease) {
    throw new Error('Published GitHub Release prerelease state is inconsistent')
  }
  if (!context.prerelease) {
    await verifyLatestRelease(context.repository, release.id)
  }
  const verified = await ensureAssets(context, release)
  if (verified.draft) throw new Error('GitHub Release verification returned a draft')
  return verified
}

function outputRelease(release) {
  writeOutputs({
    release_id: release.id,
    release_url: release.html_url,
    published_at: release.published_at,
  })
  console.log(
    JSON.stringify({
      ok: true,
      releaseId: release.id,
      url: release.html_url,
      draft: release.draft,
    }),
  )
}

const command = process.argv[2]
try {
  const context = releaseContext()
  if (command === 'ensure-draft') {
    await ensureTag(context)
    outputRelease(await ensureAssets(context, await ensureRelease(context)))
  } else if (command === 'publish') {
    outputRelease(
      await verifyPublished(
        context,
        await publishRelease(context, await getRelease(context)),
      ),
    )
  } else if (command === 'verify') {
    outputRelease(await verifyPublished(context, await getRelease(context)))
  } else {
    throw new Error(`Unsupported GitHub release command: ${String(command)}`)
  }
} catch (error) {
  console.error(
    `[github-release] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
