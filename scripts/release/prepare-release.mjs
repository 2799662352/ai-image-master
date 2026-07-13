#!/usr/bin/env node

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import {
  createReleaseManifest,
  discoverWindowsArtifacts,
  verifyReleaseBundle,
  verifyUpdaterManifest,
  writeReleaseMetadata,
} from './artifact-contract.mjs'
import { appendGithubOutputs } from './github-output.mjs'
import {
  channelManifestName,
  deriveReleaseChannel,
  parseReleaseVersion,
  resolveSigningMode,
  validateReleaseManifest,
  validateReleaseReady,
} from './release-contract.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function writeOutputs(values) {
  appendGithubOutputs(process.env.GITHUB_OUTPUT, values)
}

function stageArtifacts() {
  const version = parseReleaseVersion(requiredEnvironment('RELEASE_VERSION'))
  const sourceDirectory = path.resolve(
    requiredEnvironment('RELEASE_SOURCE_DIR'),
  )
  const targetDirectory = path.resolve(
    requiredEnvironment('RELEASE_DIR'),
  )
  const expectedManifest = channelManifestName(deriveReleaseChannel(version))
  const names = readdirSync(sourceDirectory)
  const executables = names.filter(
    (name) => name.endsWith('.exe') && name.includes(version),
  )
  if (executables.length !== 1) {
    throw new Error(`Expected one Windows installer for ${version}`)
  }
  const selected = [
    executables[0],
    `${executables[0]}.blockmap`,
    expectedManifest,
  ]
  for (const name of selected) {
    if (!names.includes(name)) {
      throw new Error(`Missing build artifact ${name}`)
    }
  }

  rmSync(targetDirectory, { recursive: true, force: true })
  mkdirSync(targetDirectory, { recursive: true })
  for (const name of selected) {
    copyFileSync(
      path.join(sourceDirectory, name),
      path.join(targetDirectory, name),
    )
  }
  discoverWindowsArtifacts(targetDirectory, version)
}

function signingStatus() {
  const signing = resolveSigningMode(process.env)
  writeOutputs({
    signing_status: signing.mode,
    signing_subject: signing.subject,
  })
  console.log(
    JSON.stringify({
      ok: true,
      signing: signing.mode,
      subject: signing.subject,
    }),
  )
}

function toolVersions(repoRoot) {
  const packageJson = JSON.parse(
    readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
  )
  const electronBuilder = JSON.parse(
    readFileSync(
      path.join(repoRoot, 'node_modules', 'electron-builder', 'package.json'),
      'utf8',
    ),
  )
  return {
    node: process.versions.node,
    pnpm: packageJson.packageManager.replace(/^pnpm@/, ''),
    electronBuilder: electronBuilder.version,
  }
}

async function createMetadata() {
  const repoRoot = process.cwd()
  const version = parseReleaseVersion(requiredEnvironment('RELEASE_VERSION'))
  const directory = path.resolve(requiredEnvironment('RELEASE_DIR'))
  const createdAt = requiredEnvironment('RELEASE_BUILT_AT')
  const signingStatusValue = requiredEnvironment('RELEASE_SIGNING_STATUS')
  const signingSubject = process.env.RELEASE_SIGNING_SUBJECT || null
  const provenanceKind = process.env.RELEASE_PROVENANCE_KIND ?? 'actions-build'
  const provenance =
    provenanceKind === 'legacy-import'
      ? {
          kind: 'legacy-import',
          repository: requiredEnvironment('GITHUB_REPOSITORY'),
          workflow: '.github/workflows/migrate-release-baseline.yml',
          runId: requiredEnvironment('GITHUB_RUN_ID'),
          runAttempt: Number(requiredEnvironment('GITHUB_RUN_ATTEMPT')),
          sourceKey: requiredEnvironment('RELEASE_SOURCE_KEY'),
          operator: requiredEnvironment('RELEASE_OPERATOR'),
          importedAt: createdAt,
          originalBuild: null,
        }
      : {
          kind: 'actions-build',
          repository: requiredEnvironment('GITHUB_REPOSITORY'),
          workflow: '.github/workflows/release.yml',
          runId: requiredEnvironment('GITHUB_RUN_ID'),
          runAttempt: Number(requiredEnvironment('GITHUB_RUN_ATTEMPT')),
          commitSha:
            process.env.RELEASE_SHA ?? requiredEnvironment('GITHUB_SHA'),
          builtAt: createdAt,
          tools: toolVersions(repoRoot),
        }

  const artifacts = discoverWindowsArtifacts(directory, version)
  await verifyUpdaterManifest(directory, artifacts, version)
  const manifest = await createReleaseManifest({
    directory,
    artifacts,
    version,
    createdAt,
    signing: {
      status: signingStatusValue,
      subject: signingSubject,
    },
    provenance,
  })
  await writeReleaseMetadata(directory, artifacts, manifest)
  await verifyReleaseBundle(directory)
}

function createReleaseReady() {
  const directory = path.resolve(requiredEnvironment('RELEASE_DIR'))
  const manifestBody = readFileSync(
    path.join(directory, 'release-manifest.json'),
  )
  const manifest = validateReleaseManifest(JSON.parse(manifestBody.toString()))
  const ready = validateReleaseReady({
    schemaVersion: 1,
    version: manifest.version,
    channel: manifest.channel,
    manifestSha256: createHash('sha256').update(manifestBody).digest('hex'),
    readyAt: requiredEnvironment('RELEASE_READY_AT'),
    eligibility: {
      kind: 'github-release',
      repository: requiredEnvironment('GITHUB_REPOSITORY'),
      tag: `v${manifest.version}`,
      releaseId: Number(requiredEnvironment('GITHUB_RELEASE_ID')),
      publishedAt: requiredEnvironment('GITHUB_RELEASE_PUBLISHED_AT'),
    },
  })
  const outputPath = path.join(directory, 'release-ready.json')
  writeFileSync(outputPath, `${JSON.stringify(ready, null, 2)}\n`)
  writeOutputs({ release_ready_path: outputPath })
}

const command = process.argv[2]
try {
  if (command === 'stage') {
    stageArtifacts()
  } else if (command === 'signing') {
    signingStatus()
  } else if (command === 'metadata') {
    await createMetadata()
  } else if (command === 'ready') {
    createReleaseReady()
  } else if (command === 'verify') {
    await verifyReleaseBundle(
      path.resolve(requiredEnvironment('RELEASE_DIR')),
    )
  } else {
    throw new Error(`Unsupported prepare-release command: ${String(command)}`)
  }
} catch (error) {
  console.error(
    `[prepare-release] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
