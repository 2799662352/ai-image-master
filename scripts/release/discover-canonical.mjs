#!/usr/bin/env node

import { appendGithubOutputs } from './github-output.mjs'
import {
  filterTrustedArtifactCandidates,
  hasUnrecoverableVersionState,
  parseReleaseVersion,
  selectCanonicalArtifact,
  validateReleaseManifest,
} from './release-contract.mjs'

const API_ROOT = 'https://api.github.com'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function requestHeaders() {
  return {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${requiredEnvironment('GITHUB_TOKEN')}`,
    'User-Agent': 'catimation-canonical-discovery',
    'X-GitHub-Api-Version': '2022-11-28',
  }
}

async function github(pathname, allowNotFound = false) {
  const response = await fetch(`${API_ROOT}${pathname}`, {
    headers: requestHeaders(),
  })
  if (allowNotFound && response.status === 404) return null
  if (!response.ok) {
    throw new Error(
      `GitHub canonical discovery failed (${response.status}) for ${pathname}`,
    )
  }
  return response.json()
}

function writeOutputs(values) {
  appendGithubOutputs(requiredEnvironment('GITHUB_OUTPUT'), values)
}

async function releaseState(repository, version, releaseSha) {
  const release = await github(
    `/repos/${repository}/releases/tags/${encodeURIComponent(`v${version}`)}`,
    true,
  )
  if (!release) return { exists: false, complete: false }
  const manifestAsset = release.assets?.find(
    (asset) => asset.name === 'release-manifest.json',
  )
  if (!manifestAsset) return { exists: true, complete: false }
  const response = await fetch(manifestAsset.url, {
    headers: {
      ...requestHeaders(),
      Accept: 'application/octet-stream',
    },
    redirect: 'follow',
  })
  if (!response.ok) return { exists: true, complete: false }
  let manifest
  try {
    manifest = validateReleaseManifest(await response.json())
  } catch {
    return { exists: true, complete: false }
  }
  if (
    manifest.version !== version ||
    manifest.provenance.kind !== 'actions-build' ||
    manifest.provenance.commitSha !== releaseSha
  ) {
    return { exists: true, complete: false }
  }
  const expected = new Set([
    ...manifest.files.map((file) => file.name),
    'release-manifest.json',
    'SHA256SUMS.txt',
  ])
  const assets = new Map(
    (release.assets ?? []).map((asset) => [asset.name, asset]),
  )
  const complete = [...expected].every((name) => {
    const asset = assets.get(name)
    const payload = manifest.files.find((file) => file.name === name)
    return (
      Boolean(asset) &&
      (!payload ||
        (Number(asset.size) === payload.size &&
          (typeof asset.digest !== 'string' ||
            asset.digest === `sha256:${payload.sha256}`)))
    )
  })
  return { exists: true, complete }
}

async function actionCandidates(repository, version, releaseSha) {
  const runs = await github(
    `/repos/${repository}/actions/workflows/release.yml/runs?event=workflow_dispatch&status=completed&head_sha=${encodeURIComponent(releaseSha)}&per_page=100`,
  )
  const candidates = []
  for (const run of runs.workflow_runs ?? []) {
    const jobs = await github(
      `/repos/${repository}/actions/runs/${run.id}/jobs?filter=all&per_page=100`,
    )
    const trustedBuild = (jobs.jobs ?? []).find(
      (job) =>
        job.conclusion === 'success' &&
        typeof job.name === 'string' &&
        (job.name === 'Build Windows x64' ||
          job.name.endsWith(' / Build Windows x64')),
    )
    if (!trustedBuild) continue
    const artifacts = await github(
      `/repos/${repository}/actions/runs/${run.id}/artifacts?per_page=100`,
    )
    for (const artifact of artifacts.artifacts ?? []) {
      if (
        typeof artifact.digest !== 'string' ||
        !artifact.digest.startsWith('sha256:')
      ) {
        continue
      }
      candidates.push({
        repository,
        workflow: '.github/workflows/release.yml',
        event: run.event,
        headSha: run.head_sha,
        conclusion: trustedBuild.conclusion,
        expired: artifact.expired,
        dryRun:
          artifact.name.startsWith('dry-run-') ||
          artifact.name.endsWith('-dry-run'),
        name: artifact.name,
        runId: String(run.id),
        artifactId: String(artifact.id),
        artifactDigest: artifact.digest,
      })
    }
  }
  return filterTrustedArtifactCandidates(candidates, {
    repository,
    workflow: '.github/workflows/release.yml',
    headSha: releaseSha,
    version,
  })
}

async function run() {
  const repository = requiredEnvironment('GITHUB_REPOSITORY')
  const version = parseReleaseVersion(requiredEnvironment('RELEASE_VERSION'))
  const releaseSha = requiredEnvironment('RELEASE_SHA')
  const canonicalRunId = process.env.CANONICAL_RUN_ID || null
  const dryRun = process.env.RELEASE_DRY_RUN === 'true'
  const remoteCosState = process.env.COS_REMOTE_STATE === 'true'
  const tagExists = process.env.RELEASE_TAG_EXISTS === 'true'

  if (dryRun) {
    writeOutputs({
      source: 'build',
      needs_build: 'true',
      run_id: '',
      artifact_name: '',
    })
    return
  }

  const githubRelease = await releaseState(repository, version, releaseSha)
  if (githubRelease.complete) {
    writeOutputs({
      source: 'github-release',
      needs_build: 'false',
      run_id: '',
      artifact_name: '',
    })
    return
  }

  const selected = selectCanonicalArtifact(
    await actionCandidates(repository, version, releaseSha),
    canonicalRunId,
  )
  if (selected) {
    writeOutputs({
      source: 'actions',
      needs_build: 'false',
      run_id: selected.runId,
      artifact_name: selected.name,
    })
    return
  }

  if (
    hasUnrecoverableVersionState({
      tagExists,
      githubReleaseExists: githubRelease.exists,
      remoteCosState,
    })
  ) {
    writeOutputs({
      source: 'unrecoverable',
      needs_build: 'false',
      run_id: '',
      artifact_name: '',
    })
    return
  }

  writeOutputs({
    source: 'build',
    needs_build: 'true',
    run_id: '',
    artifact_name: '',
  })
}

run().catch((error) => {
  console.error(
    `[canonical-discovery] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
