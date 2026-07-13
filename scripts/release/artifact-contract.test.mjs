import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { parse, stringify } from 'yaml'

import {
  createReleaseManifest,
  createSha256Sums,
  discoverWindowsArtifacts,
  verifyReleaseBundle,
  verifyUpdaterManifest,
  writeReleaseMetadata,
} from './artifact-contract.mjs'

function sha512Base64(buffer) {
  return createHash('sha512').update(buffer).digest('base64')
}

function createFixture(version = '4.3.96') {
  const directory = mkdtempSync(path.join(tmpdir(), 'catimation-release-'))
  const executableName =
    `catimation-cyberpunk-master-${version}-setup.exe`
  const executable = Buffer.from('exe')
  const blockmapName = `${executableName}.blockmap`
  const channelManifest =
    version.includes('-beta.') ? 'beta.yml' : version.includes('-alpha.') ? 'alpha.yml' : 'latest.yml'
  writeFileSync(path.join(directory, executableName), executable)
  writeFileSync(path.join(directory, blockmapName), 'blockmap')
  writeFileSync(
    path.join(directory, channelManifest),
    stringify({
      version,
      files: [
        {
          url: executableName,
          sha512: sha512Base64(executable),
          size: executable.length,
        },
      ],
      path: executableName,
      sha512: sha512Base64(executable),
      releaseDate: '2026-07-13T00:00:00.000Z',
    }),
  )
  return { directory, executableName, blockmapName, channelManifest }
}

test('discovers one Windows installer, blockmap, and matching channel manifest', async (t) => {
  const fixture = createFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))

  assert.deepEqual(discoverWindowsArtifacts(fixture.directory, '4.3.96'), {
    executable: fixture.executableName,
    blockmap: fixture.blockmapName,
    channelManifest: fixture.channelManifest,
  })
})

test('fails closed for missing or non-Windows artifacts', async (t) => {
  const missing = createFixture()
  t.after(() => rmSync(missing.directory, { recursive: true, force: true }))
  rmSync(path.join(missing.directory, missing.blockmapName))
  assert.throws(
    () => discoverWindowsArtifacts(missing.directory, '4.3.96'),
    /one blockmap/i,
  )

  const foreign = createFixture()
  t.after(() => rmSync(foreign.directory, { recursive: true, force: true }))
  writeFileSync(path.join(foreign.directory, 'catimation.dmg'), 'mac')
  assert.throws(
    () => discoverWindowsArtifacts(foreign.directory, '4.3.96'),
    /non-Windows/i,
  )
})

test('verifies updater path, size, version, and sha512', async (t) => {
  const fixture = createFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const artifacts = discoverWindowsArtifacts(fixture.directory, '4.3.96')

  assert.equal(
    (await verifyUpdaterManifest(fixture.directory, artifacts)).version,
    '4.3.96',
  )

  const manifestPath = path.join(fixture.directory, fixture.channelManifest)
  writeFileSync(manifestPath, readFileSync(manifestPath, 'utf8').replace('size: 3', 'size: 4'))
  await assert.rejects(
    () => verifyUpdaterManifest(fixture.directory, artifacts),
    /size/i,
  )
})

test('rejects external, traversal, duplicate, and wrong-version updater references', async (t) => {
  const fixture = createFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const artifacts = discoverWindowsArtifacts(fixture.directory, '4.3.96')
  const manifestPath = path.join(fixture.directory, fixture.channelManifest)
  const original = parse(readFileSync(manifestPath, 'utf8'))

  for (const mutate of [
    (manifest) => {
      manifest.path = `https://evil.example/${fixture.executableName}`
    },
    (manifest) => {
      manifest.files[0].url = `..%2f${fixture.executableName}`
    },
    (manifest) => {
      manifest.files.push({ ...manifest.files[0] })
    },
    (manifest) => {
      manifest.version = '4.3.97'
    },
  ]) {
    const candidate = structuredClone(original)
    mutate(candidate)
    writeFileSync(manifestPath, stringify(candidate))
    await assert.rejects(
      () => verifyUpdaterManifest(fixture.directory, artifacts, '4.3.96'),
      /path|URL|exactly one|version/i,
    )
  }
})

test('generates deterministic metadata without a SHA256SUMS self-reference', async (t) => {
  const fixture = createFixture()
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const artifacts = discoverWindowsArtifacts(fixture.directory, '4.3.96')
  await verifyUpdaterManifest(fixture.directory, artifacts)
  const manifest = await createReleaseManifest({
    directory: fixture.directory,
    artifacts,
    version: '4.3.96',
    createdAt: '2026-07-13T00:00:00.000Z',
    signing: { status: 'unsigned', subject: null },
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
  })
  const sums = await createSha256Sums(fixture.directory, artifacts, manifest)

  assert.match(sums, /release-manifest\.json/)
  assert.doesNotMatch(sums, /SHA256SUMS\.txt/)
  assert.equal(manifest.files.length, 3)
  assert.deepEqual(
    manifest.files.map((file) => file.name).sort(),
    [fixture.executableName, fixture.blockmapName, fixture.channelManifest].sort(),
  )
})

test('writes and re-verifies the complete release bundle', async (t) => {
  const fixture = createFixture('4.3.96-beta.1')
  t.after(() => rmSync(fixture.directory, { recursive: true, force: true }))
  const artifacts = discoverWindowsArtifacts(fixture.directory, '4.3.96-beta.1')
  const manifest = await createReleaseManifest({
    directory: fixture.directory,
    artifacts,
    version: '4.3.96-beta.1',
    createdAt: '2026-07-13T00:00:00.000Z',
    signing: { status: 'signed', subject: 'CATIMATION' },
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
  })

  await writeReleaseMetadata(fixture.directory, artifacts, manifest)
  assert.equal(
    (await verifyReleaseBundle(fixture.directory)).version,
    '4.3.96-beta.1',
  )

  writeFileSync(path.join(fixture.directory, fixture.blockmapName), 'tampered')
  await assert.rejects(() => verifyReleaseBundle(fixture.directory), /SHA-256/i)
})
