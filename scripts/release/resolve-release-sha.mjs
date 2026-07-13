#!/usr/bin/env node

import { spawnSync } from 'node:child_process'

import { appendGithubOutputs } from './github-output.mjs'
import {
  validateProductionWorkflowRef,
  validateReleaseNotesText,
  validateWorkflowInputs,
} from './validate-release-input.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

function git(arguments_, allowFailure = false) {
  const result = spawnSync('git', arguments_, {
    encoding: 'utf8',
    windowsHide: true,
  })
  if (result.status !== 0) {
    if (allowFailure) return null
    throw new Error(
      `git ${arguments_.join(' ')} failed: ${(result.stderr || '').trim()}`,
    )
  }
  return result.stdout.trim()
}

function fileAtCommit(commitSha, filePath) {
  const result = git(['show', `${commitSha}:${filePath}`], true)
  if (result === null) {
    throw new Error(`Required release file is missing: ${filePath}`)
  }
  return result
}

function run() {
  const version = requiredEnvironment('RELEASE_VERSION')
  const dryRun = requiredEnvironment('RELEASE_DRY_RUN')
  const canonicalRunId = process.env.CANONICAL_RUN_ID || ''
  const tag = `v${version}`

  // Parse and reject hostile input before it is used in any git ref or path.
  const validated = validateWorkflowInputs({
    version,
    currentVersion: version,
    dryRun,
    canonicalRunId,
  })
  validateProductionWorkflowRef(requiredEnvironment('GITHUB_REF'))

  const tagSha = git(['rev-parse', '--verify', `refs/tags/${tag}^{commit}`], true)
  let releaseSha
  if (tagSha) {
    releaseSha = tagSha
  } else {
    const dispatchSha = requiredEnvironment('GITHUB_SHA')
    const mainSha = git(['rev-parse', 'refs/remotes/origin/main'])
    if (dispatchSha !== mainSha) {
      throw new Error(
        'The dispatch commit must equal the current origin/main head',
      )
    }
    releaseSha = dispatchSha
  }

  const packageJson = JSON.parse(fileAtCommit(releaseSha, 'package.json'))
  validateWorkflowInputs({
    version,
    currentVersion: packageJson.version,
    dryRun,
    canonicalRunId,
  })
  const notesPath = `docs/releases/v${version}.md`
  validateReleaseNotesText(fileAtCommit(releaseSha, notesPath))

  appendGithubOutputs(requiredEnvironment('GITHUB_OUTPUT'), {
    release_sha: releaseSha,
    tag,
    tag_exists: String(Boolean(tagSha)),
    notes_path: notesPath,
    channel: validated.channel,
  })
}

try {
  run()
} catch (error) {
  console.error(
    `[release-sha] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
