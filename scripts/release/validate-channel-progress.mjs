#!/usr/bin/env node

import {
  compareReleaseVersions,
  validateStableBaseline,
  validateWorkflowInputs,
} from './validate-release-input.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (value === undefined) {
    throw new Error(`Missing required environment variable ${name}`)
  }
  return value
}

try {
  const version = requiredEnvironment('RELEASE_VERSION')
  const tagExists = requiredEnvironment('RELEASE_TAG_EXISTS') === 'true'
  const currentVersion = requiredEnvironment('CURRENT_CHANNEL_VERSION')
  const publishedVersions = JSON.parse(
    requiredEnvironment('PUBLISHED_VERSIONS') || '[]',
  )
  validateWorkflowInputs({
    version,
    currentVersion: version,
    dryRun: 'false',
  })
  if (!Array.isArray(publishedVersions)) {
    throw new Error('PUBLISHED_VERSIONS must be a JSON array')
  }
  validateStableBaseline(version, publishedVersions)

  const references = new Set(
    [currentVersion, ...publishedVersions].filter(Boolean),
  )
  for (const reference of references) {
    const comparison = compareReleaseVersions(version, reference)
    if (comparison < 0) {
      throw new Error(
        `Release ${version} cannot move backward from published ${reference}`,
      )
    }
    if (comparison === 0 && !tagExists) {
      throw new Error(
        `Release ${version} already has remote state but no matching tag`,
      )
    }
  }
  console.log(
    JSON.stringify({
      ok: true,
      version,
      currentVersion: currentVersion || null,
      publishedVersions,
    }),
  )
} catch (error) {
  console.error(
    `[channel-progress] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
