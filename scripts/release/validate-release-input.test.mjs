import assert from 'node:assert/strict'
import test from 'node:test'

import {
  compareReleaseVersions,
  validateProductionWorkflowRef,
  validateStableBaseline,
  validateWorkflowInputs,
} from './validate-release-input.mjs'

test('compares supported stable, beta, and alpha versions', () => {
  assert.equal(compareReleaseVersions('4.3.96', '4.3.95'), 1)
  assert.equal(compareReleaseVersions('4.3.96-beta.1', '4.3.96-alpha.2'), 1)
  assert.equal(compareReleaseVersions('4.3.96', '4.3.96-beta.1'), 1)
  assert.equal(compareReleaseVersions('4.3.96-beta.1', '4.3.96'), -1)
})

test('allows production workflows only from main', () => {
  assert.equal(
    validateProductionWorkflowRef('refs/heads/main'),
    'refs/heads/main',
  )
  assert.throws(
    () => validateProductionWorkflowRef('refs/heads/feature/release'),
    /main branch/i,
  )
})

test('requires the migrated stable baseline before newer stable releases', () => {
  assert.doesNotThrow(() =>
    validateStableBaseline('4.3.96', ['4.3.95']),
  )
  assert.doesNotThrow(() =>
    validateStableBaseline('4.3.96-beta.1', []),
  )
  assert.throws(
    () => validateStableBaseline('4.3.96', []),
    /baseline 4\.3\.95/i,
  )
})

test('validates untrusted workflow inputs without shell interpolation', () => {
  assert.deepEqual(
    validateWorkflowInputs({
      version: '4.3.96-beta.1',
      currentVersion: '4.3.95',
      dryRun: 'true',
      canonicalRunId: '123',
      versionPolicy: 'greater',
    }),
    {
      version: '4.3.96-beta.1',
      channel: 'beta',
      channelManifest: 'beta.yml',
      dryRun: true,
      canonicalRunId: '123',
    },
  )
  assert.throws(
    () =>
      validateWorkflowInputs({
        version: '4.3.95',
        currentVersion: '4.3.95',
        dryRun: 'false',
        versionPolicy: 'greater',
      }),
    /greater/i,
  )
  assert.throws(
    () =>
      validateWorkflowInputs({
        version: '4.3.96;echo pwned',
        currentVersion: '4.3.95',
        dryRun: 'false',
        versionPolicy: 'greater',
      }),
    /invalid/i,
  )
})
