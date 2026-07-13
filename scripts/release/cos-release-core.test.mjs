import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'

import { stringify } from 'yaml'

import { crc64Ecma182 } from './crc64.mjs'
import {
  assertChannelCacheControl,
  assertImmutableCacheControl,
  markReleaseReady,
  markVerifiedReleaseReady,
  preflightCos,
  promoteChannel,
  repairLegacyReleaseChecksum,
  rollbackChannel,
  uploadImmutableAssets,
} from './cos-release-core.mjs'

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

function objectRecord(body, overrides = {}) {
  const value = Buffer.isBuffer(body) ? body : Buffer.from(body)
  return {
    body: value,
    size: value.length,
    sha256: sha256(value),
    crc64: crc64Ecma182(value),
    ...overrides,
  }
}

test('requires the full channel and immutable cache contracts', () => {
  assert.doesNotThrow(() =>
    assertChannelCacheControl(
      'must-revalidate, no-cache, max-age=0',
    ),
  )
  assert.doesNotThrow(() =>
    assertImmutableCacheControl(
      'immutable, public, max-age=31536000',
    ),
  )
  assert.throws(
    () => assertChannelCacheControl('no-cache'),
    /max-age=0/i,
  )
  assert.throws(
    () => assertImmutableCacheControl('public, immutable'),
    /max-age=31536000/i,
  )
})

class FakeCosAdapter {
  constructor() {
    this.versioning = null
    this.objects = new Map()
    this.calls = []
  }

  async getBucketVersioning() {
    this.calls.push({ method: 'getBucketVersioning' })
    return this.versioning
  }

  async checkReadAccess() {
    this.calls.push({ method: 'checkReadAccess' })
  }

  async headObject(key) {
    this.calls.push({ method: 'headObject', key })
    const object = this.objects.get(key)
    if (!object) return null
    const { size, sha256: hash, crc64, cacheControl, contentType } = object
    return { size, sha256: hash, crc64, cacheControl, contentType }
  }

  async getObject(key) {
    this.calls.push({ method: 'getObject', key })
    return this.objects.get(key)?.body ?? null
  }

  async hashObject(key, algorithm) {
    this.calls.push({ method: 'hashObject', key, algorithm })
    const body = this.objects.get(key)?.body
    return body ? createHash(algorithm).update(body).digest('hex') : null
  }

  async putImmutableObject(input) {
    this.calls.push({ method: 'putImmutableObject', ...input })
    if (input.forbidOverwrite && this.objects.has(input.key)) {
      throw new Error('forbid overwrite')
    }
    this.objects.set(
      input.key,
      objectRecord(input.body, {
        cacheControl: input.cacheControl,
        contentType: input.contentType,
      }),
    )
  }

  async copyObject(input) {
    this.calls.push({ method: 'copyObject', ...input })
    const source = this.objects.get(input.sourceKey)
    if (!source) throw new Error('missing copy source')
    this.objects.set(
      input.targetKey,
      objectRecord(source.body, {
        cacheControl: input.cacheControl,
        contentType: input.contentType,
      }),
    )
  }

  async putChannelObject(input) {
    this.calls.push({ method: 'putChannelObject', ...input })
    this.objects.set(
      input.key,
      objectRecord(input.body, {
        cacheControl: input.cacheControl,
        contentType: input.contentType,
      }),
    )
  }

  async deleteObject(key) {
    this.calls.push({ method: 'deleteObject', key })
    this.objects.delete(key)
  }
}

function immutableInput(key, body) {
  const record = objectRecord(body)
  return {
    key,
    body: record.body,
    size: record.size,
    sha256: record.sha256,
    crc64: record.crc64,
    cacheControl: 'public, max-age=31536000, immutable',
    contentType: 'application/octet-stream',
  }
}

function seedVerifiedVersion(adapter, version, eligibilityKind = 'github-release') {
  const channel = version.includes('-beta.') ? 'beta' : version.includes('-alpha.') ? 'alpha' : 'stable'
  const channelManifest = channel === 'stable' ? 'latest.yml' : `${channel}.yml`
  const prefix = `releases/versions/${version}`
  const channelBody = Buffer.from(stringify({ version }))
  const channelRecord = objectRecord(channelBody)
  const executableName =
    `catimation-cyberpunk-master-${version}-setup.exe`
  const executableRecord = objectRecord('installer')
  const blockmapRecord = objectRecord('blockmap')
  const manifest = {
    schemaVersion: 1,
    version,
    channel,
    channelManifest,
    createdAt: '2026-07-13T00:00:00.000Z',
    signing: { status: 'unsigned', subject: null },
    files: [
      {
        name: executableName,
        size: executableRecord.size,
        sha256: executableRecord.sha256,
        sha512: createHash('sha512')
          .update(executableRecord.body)
          .digest('hex'),
      },
      {
        name: `${executableName}.blockmap`,
        size: blockmapRecord.size,
        sha256: blockmapRecord.sha256,
        sha512: createHash('sha512').update(blockmapRecord.body).digest('hex'),
      },
      {
        name: channelManifest,
        size: channelRecord.size,
        sha256: channelRecord.sha256,
        sha512: createHash('sha512').update(channelBody).digest('hex'),
      },
    ],
    provenance:
      eligibilityKind === 'legacy-import'
        ? {
            kind: 'legacy-import',
            repository: 'owner/repo',
            workflow: '.github/workflows/migrate-release-baseline.yml',
            runId: '456',
            runAttempt: 1,
            sourceKey: `releases/${channelManifest}`,
            operator: 'owner',
            importedAt: '2026-07-13T00:00:00.000Z',
            originalBuild: null,
          }
        : {
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
  }
  const manifestBody = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const checksumBody = Buffer.from(
    [
      ...manifest.files
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((file) => `${file.sha256}  ${file.name}`),
      `${sha256(manifestBody)}  release-manifest.json`,
      '',
    ].join('\n'),
  )
  const ready = {
    schemaVersion: 1,
    version,
    channel,
    manifestSha256: sha256(manifestBody),
    readyAt: '2026-07-13T00:00:00.000Z',
    eligibility:
      eligibilityKind === 'legacy-import'
        ? {
            kind: 'legacy-import',
            repository: 'owner/repo',
            workflow: '.github/workflows/migrate-release-baseline.yml',
            runId: '456',
            runAttempt: 1,
            sourceKey: `releases/${channelManifest}`,
            operator: 'owner',
            importedAt: '2026-07-13T00:00:00.000Z',
          }
        : {
            kind: 'github-release',
            repository: 'owner/repo',
            tag: `v${version}`,
            releaseId: 123,
            publishedAt: '2026-07-13T00:00:00.000Z',
          },
  }
  adapter.objects.set(`releases/${executableName}`, executableRecord)
  adapter.objects.set(
    `releases/${executableName}.blockmap`,
    blockmapRecord,
  )
  adapter.objects.set(`${prefix}/${channelManifest}`, channelRecord)
  adapter.objects.set(`${prefix}/release-manifest.json`, objectRecord(manifestBody))
  adapter.objects.set(`${prefix}/SHA256SUMS.txt`, objectRecord(checksumBody))
  adapter.objects.set(
    `${prefix}/release-ready.json`,
    objectRecord(`${JSON.stringify(ready, null, 2)}\n`),
  )
  return { manifest, manifestBody, checksumBody, ready }
}

test('calculates the standard CRC64-ECMA182 vector', () => {
  assert.equal(crc64Ecma182(Buffer.from('123456789')), '11051210869376104954')
})

test('preflight fails closed when bucket versioning is enabled or suspended', async () => {
  for (const versioning of ['Enabled', 'Suspended']) {
    const adapter = new FakeCosAdapter()
    adapter.versioning = versioning
    await assert.rejects(() => preflightCos(adapter), /versioning/i)
    assert.equal(
      adapter.calls.some((call) => call.method.startsWith('put')),
      false,
    )
  }
})

test('uploads immutable objects with forbid-overwrite and is idempotent', async () => {
  const adapter = new FakeCosAdapter()
  const input = immutableInput('releases/versions/4.3.96/app.exe', 'payload')

  await uploadImmutableAssets(adapter, [input])
  const uploadCall = adapter.calls.find(
    (call) => call.method === 'putImmutableObject',
  )
  assert.equal(uploadCall.forbidOverwrite, true)

  const uploadCount = adapter.calls.filter(
    (call) => call.method === 'putImmutableObject',
  ).length
  await uploadImmutableAssets(adapter, [input])
  assert.equal(
    adapter.calls.filter((call) => call.method === 'putImmutableObject').length,
    uploadCount,
  )

  await assert.rejects(
    () =>
      uploadImmutableAssets(adapter, [
        immutableInput(input.key, 'changed'),
      ]),
    /different content/i,
  )
})

test('falls back to full SHA-256 when historical objects have no CRC64', async () => {
  const adapter = new FakeCosAdapter()
  const input = immutableInput('releases/versions/4.3.95/app.exe', 'payload')
  adapter.objects.set(
    input.key,
    objectRecord(input.body, { crc64: null, sha256: null }),
  )

  await uploadImmutableAssets(adapter, [input])
  assert.equal(
    adapter.calls.some(
      (call) => call.method === 'hashObject' && call.key === input.key,
    ),
    true,
  )
})

test('dry-run reports upload and reuse actions without writing', async () => {
  const adapter = new FakeCosAdapter()
  const existing = immutableInput('releases/existing.exe', 'existing')
  const missing = immutableInput('releases/missing.exe', 'missing')
  adapter.objects.set(existing.key, objectRecord(existing.body))

  const plan = await uploadImmutableAssets(adapter, [existing, missing], {
    dryRun: true,
  })
  assert.deepEqual(plan, [
    { key: existing.key, action: 'reuse' },
    { key: missing.key, action: 'upload' },
  ])
  assert.equal(
    adapter.calls.some((call) => call.method === 'putImmutableObject'),
    false,
  )
})

test('does not write release-ready in dry-run mode', async () => {
  const adapter = new FakeCosAdapter()
  const ready = {
    schemaVersion: 1,
    version: '4.3.96',
    channel: 'stable',
    manifestSha256: 'a'.repeat(64),
    readyAt: '2026-07-13T00:00:00.000Z',
    eligibility: {
      kind: 'github-release',
      repository: 'owner/repo',
      tag: 'v4.3.96',
      releaseId: 123,
      publishedAt: '2026-07-13T00:00:00.000Z',
    },
  }

  await markReleaseReady(adapter, ready, { dryRun: true })
  assert.equal(adapter.objects.size, 0)
})

test('marks release-ready only after manifest-aware eligibility verification', async () => {
  const adapter = new FakeCosAdapter()
  const { ready } = seedVerifiedVersion(adapter, '4.3.96')
  const readyKey = 'releases/versions/4.3.96/release-ready.json'
  adapter.objects.delete(readyKey)
  let receivedImmutable

  await markVerifiedReleaseReady(adapter, ready, {
    prefix: 'releases',
    verifyEligibility: async (_eligibility, manifest, immutable) => {
      assert.equal(manifest.version, '4.3.96')
      receivedImmutable = immutable
      return true
    },
  })

  assert.equal(Buffer.isBuffer(receivedImmutable.checksumBody), true)
  assert.equal(adapter.objects.has(readyKey), true)
})

test('repairs the only recoverable interrupted legacy upload gap', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.95', 'legacy-import')
  adapter.objects.delete('releases/versions/4.3.95/SHA256SUMS.txt')

  await repairLegacyReleaseChecksum(adapter, {
    prefix: 'releases',
    version: '4.3.95',
  })

  assert.equal(
    adapter.objects.has('releases/versions/4.3.95/SHA256SUMS.txt'),
    true,
  )
})

test('promotes only verified versions using replaced no-cache metadata', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')

  let eligibilityContext
  await promoteChannel(adapter, {
    prefix: 'releases',
    version: '4.3.96',
    verifyEligibility: async (_eligibility, _manifest, immutable) => {
      eligibilityContext = immutable
      return true
    },
  })
  assert.equal(Buffer.isBuffer(eligibilityContext.checksumBody), true)

  const copy = adapter.calls.find((call) => call.method === 'copyObject')
  assert.equal(copy.metadataDirective, 'Replaced')
  assert.equal(copy.cacheControl, 'no-cache, max-age=0, must-revalidate')
  assert.equal(
    adapter.objects.get('releases/latest.yml').cacheControl,
    'no-cache, max-age=0, must-revalidate',
  )

  const copiesBeforeRetry = adapter.calls.filter(
    (call) => call.method === 'copyObject',
  ).length
  let retryVerification = 0
  const retry = await promoteChannel(adapter, {
    prefix: 'releases',
    version: '4.3.96',
    verifyEligibility: async () => true,
    verifyPromotion: async () => {
      retryVerification += 1
    },
  })
  assert.equal(retry.changed, false)
  assert.equal(retryVerification, 1)
  assert.equal(
    adapter.calls.filter((call) => call.method === 'copyObject').length,
    copiesBeforeRetry,
  )
})

test('rejects a release with corrupted immutable checksum metadata', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')
  adapter.objects.set(
    'releases/versions/4.3.96/SHA256SUMS.txt',
    objectRecord('corrupt'),
  )

  await assert.rejects(
    () =>
      promoteChannel(adapter, {
        prefix: 'releases',
        version: '4.3.96',
        verifyEligibility: async () => true,
      }),
    /invalid SHA256SUMS/i,
  )
  assert.equal(adapter.objects.has('releases/latest.yml'), false)
})

test('repairs channel metadata even when the manifest body is unchanged', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')
  const source = adapter.objects.get(
    'releases/versions/4.3.96/latest.yml',
  )
  adapter.objects.set(
    'releases/latest.yml',
    objectRecord(source.body, {
      cacheControl: 'public, max-age=31536000, immutable',
      contentType: 'application/octet-stream',
    }),
  )

  const result = await promoteChannel(adapter, {
    prefix: 'releases',
    version: '4.3.96',
    verifyEligibility: async () => true,
    verifyPromotion: async () => true,
  })
  assert.equal(result.changed, true)
  assert.equal(
    adapter.objects.get('releases/latest.yml').cacheControl,
    'no-cache, max-age=0, must-revalidate',
  )
  assert.equal(
    adapter.objects.get('releases/latest.yml').contentType,
    'application/x-yaml',
  )
})

test('restores the previous channel when anonymous verification fails', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')
  const previousBody = Buffer.from(stringify({ version: '4.3.95' }))
  adapter.objects.set('releases/latest.yml', objectRecord(previousBody))
  let restoredPublicBody

  await assert.rejects(
    () =>
      promoteChannel(adapter, {
        prefix: 'releases',
        version: '4.3.96',
        verifyEligibility: async () => true,
        verifyPromotion: async () => {
          throw new Error('anonymous endpoint failed')
        },
        verifyRestoration: async ({ previousBody: restored }) => {
          restoredPublicBody = restored
        },
      }),
    /anonymous endpoint failed/i,
  )
  assert.equal(
    adapter.objects.get('releases/latest.yml').body.toString(),
    previousBody.toString(),
  )
  assert.equal(restoredPublicBody.toString(), previousBody.toString())
})

test('restores an absent channel pointer when promotion verification fails', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')
  let verifiedAbsentRestoration = false
  const originalCopyObject = adapter.copyObject.bind(adapter)
  adapter.copyObject = async (input) => {
    await originalCopyObject(input)
    adapter.objects.set(input.targetKey, objectRecord('corrupt'))
  }

  await assert.rejects(
    () =>
      promoteChannel(adapter, {
        prefix: 'releases',
        version: '4.3.96',
        verifyEligibility: async () => true,
        verifyRestoration: async ({ previousBody }) => {
          assert.equal(previousBody, null)
          verifiedAbsentRestoration = true
        },
      }),
    /verification/i,
  )
  assert.equal(adapter.objects.has('releases/latest.yml'), false)
  assert.equal(verifiedAbsentRestoration, true)
  assert.equal(
    adapter.calls.some(
      (call) =>
        call.method === 'deleteObject' && call.key === 'releases/latest.yml',
    ),
    true,
  )
})

test('fails explicitly when anonymous restoration cannot be verified', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')
  adapter.objects.set(
    'releases/latest.yml',
    objectRecord(stringify({ version: '4.3.95' })),
  )

  await assert.rejects(
    () =>
      promoteChannel(adapter, {
        prefix: 'releases',
        version: '4.3.96',
        verifyEligibility: async () => true,
        verifyPromotion: async () => {
          throw new Error('new channel remained private')
        },
        verifyRestoration: async () => {
          throw new Error('CDN still serves the new channel')
        },
      }),
    /promotion failed and recovery also failed/i,
  )
})

test('fails explicitly when a channel pointer cannot be restored', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.96')
  adapter.objects.set(
    'releases/latest.yml',
    objectRecord(stringify({ version: '4.3.95' })),
  )
  const originalCopyObject = adapter.copyObject.bind(adapter)
  adapter.copyObject = async (input) => {
    await originalCopyObject(input)
    adapter.objects.set(input.targetKey, objectRecord('corrupt'))
  }
  adapter.putChannelObject = async () => {}

  await assert.rejects(
    () =>
      promoteChannel(adapter, {
        prefix: 'releases',
        version: '4.3.96',
        verifyEligibility: async () => true,
      }),
    /recovery also failed/i,
  )
})

test('rollback requires a verified lower version in the same channel', async () => {
  const adapter = new FakeCosAdapter()
  seedVerifiedVersion(adapter, '4.3.95')
  seedVerifiedVersion(adapter, '4.3.97-beta.1')
  adapter.objects.set(
    'releases/latest.yml',
    objectRecord(stringify({ version: '4.3.96' })),
  )

  const firstRollback = await rollbackChannel(adapter, {
    prefix: 'releases',
    targetVersion: '4.3.95',
    verifyEligibility: async () => true,
  })
  assert.equal(firstRollback.changed, true)
  assert.match(
    adapter.objects.get('releases/latest.yml').body.toString(),
    /4\.3\.95/,
  )
  let repeatedVerification = 0
  const repeatedRollback = await rollbackChannel(adapter, {
    prefix: 'releases',
    targetVersion: '4.3.95',
    verifyEligibility: async () => true,
    verifyPromotion: async () => {
      repeatedVerification += 1
    },
  })
  assert.equal(repeatedRollback.changed, false)
  assert.equal(repeatedVerification, 1)

  adapter.objects.set(
    'releases/beta.yml',
    objectRecord(stringify({ version: '4.3.96' })),
  )
  await assert.rejects(
    () =>
      rollbackChannel(adapter, {
        prefix: 'releases',
        targetVersion: '4.3.97-beta.1',
        verifyEligibility: async () => true,
      }),
    /same channel/i,
  )
})
