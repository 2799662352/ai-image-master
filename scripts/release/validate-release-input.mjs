#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { appendGithubOutputs } from './github-output.mjs'

const VERSION_PATTERN =
  /^(\d+)\.(\d+)\.(\d+)(?:-(beta|alpha)\.(0|[1-9]\d*))?$/
const PLACEHOLDER_PATTERN = /\b(?:TODO|TBD|FIXME)\b|<version>|\[待补充\]/i

function parsedVersion(version) {
  const match = VERSION_PATTERN.exec(version)
  if (!match) throw new Error(`Invalid release version: ${version}`)
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    channel: match[4] ?? 'stable',
    prereleaseNumber: match[5] === undefined ? null : Number(match[5]),
  }
}

export function compareReleaseVersions(left, right) {
  const a = parsedVersion(left)
  const b = parsedVersion(right)
  for (let index = 0; index < a.core.length; index += 1) {
    if (a.core[index] !== b.core[index]) {
      return a.core[index] > b.core[index] ? 1 : -1
    }
  }
  if (a.channel === b.channel) {
    const aNumber = a.prereleaseNumber ?? Number.POSITIVE_INFINITY
    const bNumber = b.prereleaseNumber ?? Number.POSITIVE_INFINITY
    return aNumber === bNumber ? 0 : aNumber > bNumber ? 1 : -1
  }
  const rank = { alpha: 0, beta: 1, stable: 2 }
  return rank[a.channel] > rank[b.channel] ? 1 : -1
}

export function validateProductionWorkflowRef(ref) {
  if (ref !== 'refs/heads/main') {
    throw new Error('Production workflows must be dispatched from the main branch')
  }
  return ref
}

export function validateStableBaseline(
  version,
  publishedVersions,
  baselineVersion = '4.3.95',
) {
  const parsed = parsedVersion(version)
  if (
    parsed.channel === 'stable' &&
    compareReleaseVersions(version, baselineVersion) > 0 &&
    !publishedVersions.includes(baselineVersion)
  ) {
    throw new Error(
      `Stable baseline ${baselineVersion} must be release-ready before ${version}`,
    )
  }
}

export function validateWorkflowInputs({
  version,
  currentVersion,
  dryRun,
  canonicalRunId,
  versionPolicy = 'equal',
}) {
  const parsed = parsedVersion(version)
  parsedVersion(currentVersion)
  const comparison = compareReleaseVersions(version, currentVersion)
  if (versionPolicy === 'greater' && comparison <= 0) {
    throw new Error(
      `Release version ${version} must be greater than current package version ${currentVersion}`,
    )
  }
  if (versionPolicy === 'equal' && comparison !== 0) {
    throw new Error(
      `Release version ${version} must equal package version ${currentVersion}`,
    )
  }
  if (versionPolicy !== 'equal' && versionPolicy !== 'greater') {
    throw new Error(`Unsupported version policy: ${versionPolicy}`)
  }
  if (dryRun !== 'true' && dryRun !== 'false') {
    throw new Error('dry_run must be true or false')
  }
  if (canonicalRunId && !/^\d+$/.test(canonicalRunId)) {
    throw new Error('canonical_run_id must contain digits only')
  }

  return {
    version,
    channel: parsed.channel,
    channelManifest:
      parsed.channel === 'stable' ? 'latest.yml' : `${parsed.channel}.yml`,
    dryRun: dryRun === 'true',
    canonicalRunId: canonicalRunId || null,
  }
}

export function validateReleaseNotesText(notes) {
  if (!notes.trim() || PLACEHOLDER_PATTERN.test(notes)) {
    throw new Error('Release notes are empty or contain an unresolved placeholder')
  }
}

function validateReleaseNotes(repoRoot, notesPath) {
  if (!notesPath) return
  const absolutePath = path.resolve(repoRoot, notesPath)
  const relativePath = path.relative(repoRoot, absolutePath)
  if (
    relativePath.startsWith('..') ||
    path.isAbsolute(relativePath) ||
    !existsSync(absolutePath)
  ) {
    throw new Error('release_notes_path must reference a repository file')
  }
  const notes = readFileSync(absolutePath, 'utf8')
  validateReleaseNotesText(notes)
}

function runCli() {
  const repoRoot = process.cwd()
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  )
  const validated = validateWorkflowInputs({
    version: process.env.RELEASE_VERSION,
    currentVersion: packageJson.version,
    dryRun: process.env.RELEASE_DRY_RUN,
    canonicalRunId: process.env.CANONICAL_RUN_ID,
    versionPolicy: process.env.RELEASE_VERSION_POLICY ?? 'equal',
  })
  validateReleaseNotes(repoRoot, process.env.RELEASE_NOTES_PATH)

  appendGithubOutputs(process.env.GITHUB_OUTPUT, {
    version: validated.version,
    channel: validated.channel,
    channel_manifest: validated.channelManifest,
    dry_run: String(validated.dryRun),
    canonical_run_id: validated.canonicalRunId ?? '',
  })
  console.log(
    JSON.stringify({
      ok: true,
      version: validated.version,
      channel: validated.channel,
      dryRun: validated.dryRun,
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
      `[release-input] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
