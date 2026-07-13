import assert from 'node:assert/strict'
import test from 'node:test'

import {
  assertForwardRelease,
  assertRollbackTarget,
  channelManifestName,
  createLegacyReleaseReady,
  deriveReleaseChannel,
  filterTrustedArtifactCandidates,
  hasUnrecoverableVersionState,
  parseReleaseVersion,
  resolveSigningMode,
  selectCanonicalArtifact,
  shouldPromoteLegacyCompletion,
  validateReleaseManifest,
  validateReleaseNotes,
  validateReleaseReady,
} from './release-contract.mjs'

test('accepts only supported release versions', () => {
  for (const version of ['4.3.96', '4.3.96-beta.1', '4.3.96-alpha.2']) {
    assert.equal(parseReleaseVersion(version), version)
  }

  for (const version of [
    'v4.3.96',
    '4.3.96-rc.1',
    '4.3.96-beta',
    '4.3.96-beta.01',
    '4.3.96;echo pwned',
  ]) {
    assert.throws(() => parseReleaseVersion(version), /release version/i)
  }
})

test('maps logical channels to updater manifest names', () => {
  assert.equal(deriveReleaseChannel('4.3.96'), 'stable')
  assert.equal(deriveReleaseChannel('4.3.96-beta.1'), 'beta')
  assert.equal(deriveReleaseChannel('4.3.96-alpha.1'), 'alpha')
  assert.equal(channelManifestName('stable'), 'latest.yml')
  assert.equal(channelManifestName('beta'), 'beta.yml')
  assert.equal(channelManifestName('alpha'), 'alpha.yml')
})

test('requires forward releases and same-channel rollback', () => {
  assert.doesNotThrow(() => assertForwardRelease('4.3.97', ['4.3.95', '4.3.96']))
  assert.throws(() => assertForwardRelease('4.3.96', ['4.3.96']), /greater/i)
  assert.doesNotThrow(() => assertRollbackTarget('4.3.95', '4.3.96'))
  assert.throws(
    () => assertRollbackTarget('4.3.95-beta.1', '4.3.96'),
    /same channel/i,
  )
  assert.throws(() => assertRollbackTarget('4.3.97', '4.3.96'), /lower/i)
})

test('does not repromote an interrupted legacy baseline over a newer channel', () => {
  assert.equal(shouldPromoteLegacyCompletion('4.3.95', ''), true)
  assert.equal(shouldPromoteLegacyCompletion('4.3.95', '4.3.94'), true)
  assert.equal(shouldPromoteLegacyCompletion('4.3.95', '4.3.95'), true)
  assert.equal(shouldPromoteLegacyCompletion('4.3.95', '4.3.96'), false)
  assert.throws(
    () => shouldPromoteLegacyCompletion('4.3.95', '4.3.96-beta.1'),
    /same channel/i,
  )
})

test('detects unsigned, signed, and partial signing configuration', () => {
  assert.deepEqual(resolveSigningMode({}), { mode: 'unsigned', subject: null })
  assert.deepEqual(
    resolveSigningMode({
      WIN_CERTIFICATE: 'base64',
      WIN_CERTIFICATE_PASSWORD: 'secret',
      WIN_CERTIFICATE_SUBJECT_NAME: 'CATIMATION',
    }),
    { mode: 'signed', subject: 'CATIMATION' },
  )
  assert.throws(
    () => resolveSigningMode({ WIN_CERTIFICATE: 'base64' }),
    /partially configured/i,
  )
  assert.throws(
    () => resolveSigningMode({ WIN_CERTIFICATE_SUBJECT_NAME: 'CATIMATION' }),
    /partially configured/i,
  )
})

test('rejects placeholder release notes', () => {
  assert.equal(validateReleaseNotes('# 4.3.96\n\n- 修复更新流程'), true)
  for (const placeholder of ['TODO', 'TBD', 'FIXME', '<version>', '[待补充]']) {
    assert.throws(() => validateReleaseNotes(`# Release\n${placeholder}`), /placeholder/i)
  }
})

test('validates actions-build and legacy-import provenance without fabrication', () => {
  const common = {
    schemaVersion: 1,
    version: '4.3.96',
    channel: 'stable',
    channelManifest: 'latest.yml',
    createdAt: '2026-07-13T00:00:00.000Z',
    signing: { status: 'unsigned', subject: null },
    files: [
      {
        name: 'app.exe',
        size: 3,
        sha256: 'a'.repeat(64),
        sha512: 'b'.repeat(128),
      },
    ],
  }

  assert.equal(
    validateReleaseManifest({
      ...common,
      provenance: {
        kind: 'actions-build',
        repository: 'owner/repo',
        workflow: '.github/workflows/release.yml',
        runId: '123',
        runAttempt: 1,
        commitSha: 'c'.repeat(40),
        builtAt: '2026-07-13T00:00:00.000Z',
        tools: {
          node: '20.19.4',
          pnpm: '10.12.4',
          electronBuilder: '26.4.0',
        },
      },
    }).provenance.kind,
    'actions-build',
  )

  assert.equal(
    validateReleaseManifest({
      ...common,
      version: '4.3.95',
      provenance: {
        kind: 'legacy-import',
        repository: 'owner/repo',
        workflow: '.github/workflows/migrate-release-baseline.yml',
        runId: '456',
        runAttempt: 1,
        sourceKey: 'releases/latest.yml',
        operator: 'owner',
        importedAt: '2026-07-13T00:00:00.000Z',
        originalBuild: null,
      },
    }).provenance.kind,
    'legacy-import',
  )
})

test('validates release-ready eligibility variants', () => {
  const base = {
    schemaVersion: 1,
    version: '4.3.96',
    channel: 'stable',
    manifestSha256: 'a'.repeat(64),
    readyAt: '2026-07-13T00:00:00.000Z',
  }

  assert.equal(
    validateReleaseReady({
      ...base,
      eligibility: {
        kind: 'github-release',
        repository: 'owner/repo',
        tag: 'v4.3.96',
        releaseId: 123,
        publishedAt: '2026-07-13T00:00:00.000Z',
      },
    }).eligibility.kind,
    'github-release',
  )
  assert.equal(
    validateReleaseReady({
      ...base,
      eligibility: {
        kind: 'legacy-import',
        repository: 'owner/repo',
        workflow: '.github/workflows/migrate-release-baseline.yml',
        runId: '456',
        runAttempt: 1,
        sourceKey: 'releases/latest.yml',
        operator: 'owner',
        importedAt: '2026-07-13T00:00:00.000Z',
      },
    }).eligibility.kind,
    'legacy-import',
  )
})

test('filters trustworthy historical artifacts and resolves canonical ambiguity', () => {
  const base = {
    name: `release-win-4.3.96-${'c'.repeat(40)}`,
    repository: 'owner/repo',
    workflow: '.github/workflows/release.yml',
    event: 'workflow_dispatch',
    headSha: 'c'.repeat(40),
    conclusion: 'success',
    expired: false,
    dryRun: false,
  }
  const candidates = [
    { ...base, runId: '10', artifactId: '100', artifactDigest: 'sha256:aaa' },
    { ...base, runId: '11', artifactId: '101', artifactDigest: 'sha256:aaa' },
    { ...base, runId: '12', artifactId: '102', artifactDigest: 'sha256:bbb', dryRun: true },
  ]
  const trusted = filterTrustedArtifactCandidates(candidates, {
    repository: 'owner/repo',
    workflow: '.github/workflows/release.yml',
    headSha: 'c'.repeat(40),
    version: '4.3.96',
  })

  assert.equal(trusted.length, 2)
  assert.equal(selectCanonicalArtifact(trusted).runId, '10')
  assert.equal(selectCanonicalArtifact(trusted, '10').runId, '10')
  assert.throws(
    () =>
      selectCanonicalArtifact([
        trusted[0],
        { ...trusted[1], artifactDigest: 'sha256:different' },
      ]),
    /canonical_run_id/i,
  )
})

test('creates deterministic legacy release-ready metadata across retries', () => {
  const manifest = {
    schemaVersion: 1,
    version: '4.3.95',
    channel: 'stable',
    channelManifest: 'latest.yml',
    createdAt: '2026-07-13T08:00:00.000Z',
    signing: { status: 'unsigned', subject: null },
    files: [
      {
        name: 'catimation-4.3.95.exe',
        size: 1,
        sha256: 'a'.repeat(64),
        sha512: 'b'.repeat(128),
      },
    ],
    provenance: {
      kind: 'legacy-import',
      repository: 'owner/repo',
      workflow: '.github/workflows/migrate-release-baseline.yml',
      runId: '456',
      runAttempt: 1,
      sourceKey: 'releases/latest.yml',
      operator: 'release-admin',
      importedAt: '2026-07-13T08:00:00.000Z',
      originalBuild: null,
    },
  }
  const first = createLegacyReleaseReady(manifest, 'c'.repeat(64))
  const second = createLegacyReleaseReady(manifest, 'c'.repeat(64))

  assert.deepEqual(first, second)
  assert.equal(first.readyAt, manifest.provenance.importedAt)
  assert.equal(first.eligibility.runId, manifest.provenance.runId)
  assert.equal(first.eligibility.workflow, manifest.provenance.workflow)
  assert.throws(
    () =>
      createLegacyReleaseReady(
        { ...manifest, version: '4.3.96' },
        'c'.repeat(64),
      ),
    /restricted to version 4\.3\.95/i,
  )
})

test('treats a tag-only version as unrecoverable without canonical evidence', () => {
  assert.equal(
    hasUnrecoverableVersionState({
      tagExists: true,
      githubReleaseExists: false,
      remoteCosState: false,
    }),
    true,
  )
  assert.equal(
    hasUnrecoverableVersionState({
      tagExists: false,
      githubReleaseExists: false,
      remoteCosState: false,
    }),
    false,
  )
})
