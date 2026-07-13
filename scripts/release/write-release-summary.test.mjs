import assert from 'node:assert/strict'
import test from 'node:test'

import { renderReleaseSummary } from './write-release-summary.mjs'

test('renders complete release evidence and recovery guidance', () => {
  const summary = renderReleaseSummary({
    manifest: {
      version: '4.3.96',
      channel: 'stable',
      provenance: { commitSha: 'c'.repeat(40) },
      signing: { status: 'unsigned', subject: null },
      files: [
        {
          name: 'catimation-4.3.96-setup.exe',
          size: 123,
          sha256: 'a'.repeat(64),
        },
      ],
    },
    tag: 'v4.3.96',
    qualityResult: 'success',
    githubReleaseUrl: 'https://github.example/release',
    outcomes: {
      githubDraft: 'success',
      github: 'success',
      cosUpload: 'success',
      ready: 'success',
      promote: 'success',
      public: 'failure',
    },
    currentVersion: '4.3.95',
    rollbackUrl: 'https://github.example/rollback',
  })

  assert.match(summary, /4\.3\.96 \/ stable/)
  assert.match(summary, /123 bytes/)
  assert.match(summary, /SHA-256/)
  assert.match(summary, /Failed stage: public/)
  assert.match(summary, /Safe resume/)
  assert.match(summary, /rollback/)
})

test('renders an actionable summary when canonical creation never starts', () => {
  const summary = renderReleaseSummary({
    manifest: null,
    version: '4.3.96',
    channel: 'stable',
    commit: 'unknown',
    tag: 'v4.3.96',
    dryRun: 'true',
    actor: 'release-admin',
    runUrl: 'https://github.example/run/1',
    outcomes: {
      validate: 'success',
      preflight: 'success',
      quality: 'failure',
      discover: 'skipped',
      build: 'skipped',
      canonical: 'skipped',
      authenticode: 'skipped',
      githubDraft: 'unknown',
      github: 'unknown',
      cosUpload: 'unknown',
      ready: 'unknown',
      promote: 'unknown',
      public: 'unknown',
    },
    rollbackUrl: 'https://github.example/rollback',
  })

  assert.match(summary, /dry-run \(no external writes\)/)
  assert.match(summary, /Failed stage: quality/)
  assert.match(summary, /canonical stage did not complete/)
  assert.match(summary, /release-admin/)
})
