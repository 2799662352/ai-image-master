#!/usr/bin/env node

import {
  validateProductionWorkflowRef,
  validateWorkflowInputs,
} from './validate-release-input.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

try {
  const version = requiredEnvironment('RELEASE_VERSION')
  validateWorkflowInputs({
    version,
    currentVersion: version,
    dryRun: 'false',
  })
  validateProductionWorkflowRef(requiredEnvironment('WORKFLOW_REF'))
  if (requiredEnvironment('RELEASE_CONFIRM') !== version) {
    throw new Error('Confirmation must exactly match the target version')
  }
  if (
    process.env.EXPECTED_RELEASE_VERSION &&
    process.env.EXPECTED_RELEASE_VERSION !== version
  ) {
    throw new Error(
      `This workflow only permits ${process.env.EXPECTED_RELEASE_VERSION}`,
    )
  }
  console.log(JSON.stringify({ ok: true, version }))
} catch (error) {
  console.error(
    `[release-confirmation] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
}
