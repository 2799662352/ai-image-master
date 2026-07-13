#!/usr/bin/env node

import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

function value(input, fallback = 'unknown') {
  return input || fallback
}

export function renderReleaseSummary({
  manifest,
  tag,
  qualityResult,
  githubReleaseUrl,
  outcomes,
  currentVersion,
  restoredVersion,
  rollbackUrl,
  version,
  channel,
  commit,
  actor,
  runUrl,
  dryRun,
  manifestError,
}) {
  const resolvedVersion = manifest?.version ?? version
  const resolvedChannel = manifest?.channel ?? channel
  const resolvedCommit = manifest?.provenance?.commitSha ?? commit
  const signing =
    manifest?.signing && typeof manifest.signing === 'object'
      ? manifest.signing
      : { status: 'unknown', subject: null }
  const failedStage =
    Object.entries(outcomes).find(([, outcome]) => outcome === 'failure')?.[0] ??
    'none'
  const manifestSummary = manifestError
    ? `unreadable (${manifestError})`
    : manifest
      ? 'available'
      : 'unavailable'
  const files = Array.isArray(manifest?.files)
    ? manifest.files
        .map(
          (file) =>
            `- \`${file.name}\` — ${file.size} bytes — SHA-256 \`${file.sha256}\``,
        )
        .join('\n')
    : '- unavailable (canonical stage did not complete)'
  return [
    '## Windows release orchestration',
    `- Mode: ${dryRun === 'true' ? 'dry-run (no external writes)' : 'production'}`,
    `- Version/channel: ${value(resolvedVersion)} / ${value(resolvedChannel)}`,
    `- Commit/tag: \`${value(resolvedCommit)}\` / \`${tag}\``,
    `- Actor/run: ${value(actor)} / ${value(runUrl)}`,
    `- Validation/preflight: ${outcomes.validate}/${outcomes.preflight}`,
    `- Quality gate: ${value(qualityResult ?? outcomes.quality)}`,
    `- Discovery/build: ${outcomes.discover}/${outcomes.build}`,
    `- Canonical/Authenticode: ${outcomes.canonical}/${outcomes.authenticode}`,
    `- Manifest summary: ${manifestSummary}`,
    `- Authenticode declaration: ${signing.status}${signing.subject ? ` (${signing.subject})` : ''}`,
    `- GitHub draft/publish: ${outcomes.githubDraft}/${outcomes.github}`,
    `- Publish job: ${outcomes.publishJob}`,
    `- GitHub Release: ${value(githubReleaseUrl, 'not published')}`,
    `- COS immutable upload: ${outcomes.cosUpload}`,
    `- COS release-ready: ${outcomes.ready}`,
    `- COS promotion/public verification: ${outcomes.promote}/${outcomes.public}`,
    `- COS channel current version: ${value(currentVersion)}`,
    `- Restored channel version after failure: ${value(restoredVersion, 'not applicable')}`,
    `- Failed stage: ${failedStage}`,
    '- Safe resume: rerun the same version from main; matching immutable objects are reused and an existing tag is never moved.',
    `- Rollback workflow: ${rollbackUrl}`,
    '',
    '### Canonical files',
    files,
    '',
  ].join('\n')
}

function run() {
  const directory = path.resolve(process.env.RELEASE_DIR ?? 'canonical')
  const manifestPath = path.join(directory, 'release-manifest.json')
  let manifest = null
  let manifestError = null
  if (existsSync(manifestPath)) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
    } catch (error) {
      manifestError = error instanceof Error ? error.message : String(error)
    }
  }
  const repository = process.env.GITHUB_REPOSITORY
  const serverUrl = process.env.GITHUB_SERVER_URL ?? 'https://github.com'
  const rollbackUrl = repository
    ? `${serverUrl}/${repository}/actions/workflows/rollback-hot-update.yml`
    : 'unavailable'
  const summary = renderReleaseSummary({
    manifest,
    tag: value(process.env.RELEASE_TAG),
    qualityResult: value(process.env.QUALITY_RESULT),
    githubReleaseUrl: process.env.GITHUB_RELEASE_URL,
    outcomes: {
      validate: value(process.env.VALIDATE_RESULT),
      preflight: value(process.env.PREFLIGHT_RESULT),
      quality: value(process.env.QUALITY_RESULT),
      discover: value(process.env.DISCOVER_RESULT),
      build: value(process.env.BUILD_RESULT),
      canonical: value(process.env.CANONICAL_RESULT),
      authenticode: value(process.env.AUTHENTICODE_RESULT),
      publishJob: value(process.env.PUBLISH_RESULT),
      githubDraft: value(process.env.GITHUB_DRAFT_OUTCOME),
      github: value(process.env.GITHUB_RELEASE_OUTCOME),
      cosUpload: value(process.env.COS_UPLOAD_OUTCOME),
      ready: value(process.env.READY_OUTCOME),
      promote: value(process.env.PROMOTE_OUTCOME),
      public: value(process.env.PUBLIC_OUTCOME),
    },
    currentVersion: process.env.CURRENT_CHANNEL_VERSION,
    restoredVersion: process.env.RESTORED_CHANNEL_VERSION,
    rollbackUrl,
    version: process.env.RELEASE_VERSION,
    channel: process.env.RELEASE_CHANNEL,
    commit: process.env.RELEASE_SHA,
    actor: process.env.GITHUB_ACTOR,
    runUrl: process.env.RELEASE_RUN_URL,
    dryRun: process.env.RELEASE_DRY_RUN,
    manifestError,
  })
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${summary}\n`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    run()
  } catch (error) {
    console.error(
      `[release-summary] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
