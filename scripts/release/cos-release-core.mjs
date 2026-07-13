import { createHash } from 'node:crypto'

import { parse } from 'yaml'

import { crc64Ecma182 } from './crc64.mjs'
import {
  assertRollbackTarget,
  validateReleaseManifest,
  validateReleaseReady,
} from './release-contract.mjs'

export const IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
export const CHANNEL_CACHE_CONTROL = 'no-cache, max-age=0, must-revalidate'

function cacheControlTokens(value) {
  return new Set(
    String(value)
      .toLowerCase()
      .split(',')
      .map((token) => token.trim())
      .filter(Boolean),
  )
}

export function assertChannelCacheControl(value) {
  const tokens = cacheControlTokens(value)
  for (const required of ['no-cache', 'max-age=0', 'must-revalidate']) {
    if (!tokens.has(required)) {
      throw new Error(`Public channel manifest is missing ${required}`)
    }
  }
  if (tokens.has('immutable')) {
    throw new Error('Public channel manifest must not be immutable')
  }
}

export function assertImmutableCacheControl(value) {
  const tokens = cacheControlTokens(value)
  for (const required of ['public', 'max-age=31536000', 'immutable']) {
    if (!tokens.has(required)) {
      throw new Error(`Public immutable asset is missing ${required}`)
    }
  }
}

function sha256(body) {
  return createHash('sha256').update(body).digest('hex')
}

function normalizePrefix(prefix) {
  return prefix.replace(/^\/+|\/+$/g, '')
}

function versionPrefix(prefix, version) {
  return `${normalizePrefix(prefix)}/versions/${version}`
}

function jsonBody(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`)
}

function expectedSha256Sums(manifest, manifestBody) {
  return Buffer.from(
    [
      ...manifest.files
        .toSorted((left, right) => left.name.localeCompare(right.name))
        .map((file) => `${file.sha256}  ${file.name}`),
      `${sha256(manifestBody)}  release-manifest.json`,
      '',
    ].join('\n'),
  )
}

function assertLocalObject(input) {
  if (Buffer.isBuffer(input.body)) {
    if (input.body.length !== input.size) {
      throw new Error(`Immutable object ${input.key} has an invalid local size`)
    }
    if (sha256(input.body) !== input.sha256) {
      throw new Error(`Immutable object ${input.key} has an invalid local SHA-256`)
    }
    if (crc64Ecma182(input.body) !== input.crc64) {
      throw new Error(`Immutable object ${input.key} has an invalid local CRC64`)
    }
    return
  }
  if (typeof input.filePath !== 'string' || input.filePath.length === 0) {
    throw new Error(
      `Immutable object ${input.key} requires either a Buffer body or filePath`,
    )
  }
}

async function remoteObjectMatches(adapter, input, head) {
  if (head.size !== input.size) return false
  if (head.crc64) return head.crc64 === input.crc64
  if (head.sha256) return head.sha256 === input.sha256

  return (await adapter.hashObject(input.key, 'sha256')) === input.sha256
}

async function assertRemoteObject(adapter, input) {
  const head = await adapter.headObject(input.key)
  if (!head || !(await remoteObjectMatches(adapter, input, head))) {
    throw new Error(`COS verification failed for immutable object ${input.key}`)
  }
}

export async function preflightCos(adapter) {
  const versioning = await adapter.getBucketVersioning()
  if (versioning) {
    throw new Error(
      `COS bucket versioning must be unconfigured; received ${versioning}`,
    )
  }
  await adapter.checkReadAccess()
}

export async function uploadImmutableAssets(
  adapter,
  objects,
  { dryRun = false } = {},
) {
  const plan = []
  for (const input of objects) {
    assertLocalObject(input)
    const existing = await adapter.headObject(input.key)
    if (existing) {
      if (!(await remoteObjectMatches(adapter, input, existing))) {
        throw new Error(
          `Immutable COS object ${input.key} already exists with different content`,
        )
      }
      plan.push({ key: input.key, action: 'reuse' })
      continue
    }

    if (dryRun) {
      plan.push({ key: input.key, action: 'upload' })
      continue
    }
    await adapter.putImmutableObject({
      ...input,
      forbidOverwrite: true,
      metadata: {
        sha256: input.sha256,
        crc64ecma: input.crc64,
      },
    })
    await assertRemoteObject(adapter, input)
    plan.push({ key: input.key, action: 'uploaded' })
  }
  return plan
}

export async function markReleaseReady(
  adapter,
  releaseReady,
  { prefix = 'releases', dryRun = false } = {},
) {
  const parsed = validateReleaseReady(releaseReady)
  const body = jsonBody(parsed)
  const key = `${versionPrefix(prefix, parsed.version)}/release-ready.json`
  await uploadImmutableAssets(
    adapter,
    [
      {
        key,
        body,
        size: body.length,
        sha256: sha256(body),
        crc64: crc64Ecma182(body),
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        contentType: 'application/json',
      },
    ],
    { dryRun },
  )
}

export async function markVerifiedReleaseReady(
  adapter,
  releaseReady,
  {
    prefix = 'releases',
    dryRun = false,
    verifyEligibility,
  } = {},
) {
  const ready = validateReleaseReady(releaseReady)
  const immutable = await verifyImmutableAssets(adapter, {
    prefix,
    version: ready.version,
  })
  if (ready.manifestSha256 !== sha256(immutable.manifestBody)) {
    throw new Error('release-ready manifest SHA-256 mismatch')
  }
  if (
    typeof verifyEligibility !== 'function' ||
    (await verifyEligibility(
      ready.eligibility,
      immutable.manifest,
      immutable,
    )) !== true
  ) {
    throw new Error('release-ready eligibility verification failed')
  }
  await markReleaseReady(adapter, ready, { prefix, dryRun })
  return immutable
}

async function verifyManifestFile(
  adapter,
  { prefix, baseKey, channelManifest },
  file,
) {
  const key =
    file.name === channelManifest
      ? `${baseKey}/${file.name}`
      : `${normalizePrefix(prefix)}/${file.name}`
  const head = await adapter.headObject(key)
  if (!head || head.size !== file.size) {
    throw new Error(`Immutable release file is missing or has wrong size: ${key}`)
  }
  if (head.sha256 && head.sha256 === file.sha256) return

  if ((await adapter.hashObject(key, 'sha256')) !== file.sha256) {
    throw new Error(`Immutable release file SHA-256 mismatch: ${key}`)
  }
}

export async function repairLegacyReleaseChecksum(
  adapter,
  { prefix = 'releases', version, dryRun = false },
) {
  const baseKey = versionPrefix(prefix, version)
  const manifestBody = await adapter.getObject(
    `${baseKey}/release-manifest.json`,
  )
  if (!manifestBody) {
    throw new Error(`Legacy release ${version} is missing release-manifest.json`)
  }
  const manifest = validateReleaseManifest(JSON.parse(manifestBody.toString()))
  if (
    manifest.version !== version ||
    manifest.provenance.kind !== 'legacy-import'
  ) {
    throw new Error('Legacy checksum repair requires matching legacy provenance')
  }
  for (const file of manifest.files) {
    await verifyManifestFile(
      adapter,
      { prefix, baseKey, channelManifest: manifest.channelManifest },
      file,
    )
  }

  const body = expectedSha256Sums(manifest, manifestBody)
  await uploadImmutableAssets(
    adapter,
    [
      {
        key: `${baseKey}/SHA256SUMS.txt`,
        body,
        size: body.length,
        sha256: sha256(body),
        crc64: crc64Ecma182(body),
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        contentType: 'text/plain; charset=utf-8',
      },
    ],
    { dryRun },
  )
}

export async function verifyImmutableAssets(
  adapter,
  { prefix = 'releases', version },
) {
  const baseKey = versionPrefix(prefix, version)
  const manifestBody = await adapter.getObject(
    `${baseKey}/release-manifest.json`,
  )
  if (!manifestBody) {
    throw new Error(`Release ${version} is missing release-manifest.json`)
  }

  const manifest = validateReleaseManifest(JSON.parse(manifestBody.toString()))
  if (manifest.version !== version) {
    throw new Error(`Release metadata version does not match ${version}`)
  }

  for (const file of manifest.files) {
    await verifyManifestFile(
      adapter,
      { prefix, baseKey, channelManifest: manifest.channelManifest },
      file,
    )
  }
  const checksumBody = await adapter.getObject(`${baseKey}/SHA256SUMS.txt`)
  if (!checksumBody) {
    throw new Error(`Release ${version} is missing SHA256SUMS.txt`)
  }
  if (!checksumBody.equals(expectedSha256Sums(manifest, manifestBody))) {
    throw new Error(`Release ${version} has an invalid SHA256SUMS.txt`)
  }

  return { manifest, manifestBody, checksumBody, baseKey }
}

export async function verifyImmutableVersion(
  adapter,
  { prefix = 'releases', version, verifyEligibility },
) {
  const immutable = await verifyImmutableAssets(adapter, { prefix, version })
  const readyBody = await adapter.getObject(
    `${immutable.baseKey}/release-ready.json`,
  )
  if (!readyBody) {
    throw new Error(`Release ${version} is missing release-ready.json`)
  }
  const ready = validateReleaseReady(JSON.parse(readyBody.toString()))
  if (ready.version !== version) {
    throw new Error(`release-ready version does not match ${version}`)
  }
  if (ready.manifestSha256 !== sha256(immutable.manifestBody)) {
    throw new Error(`release-ready manifest SHA-256 mismatch for ${version}`)
  }

  if (
    typeof verifyEligibility !== 'function' ||
    (await verifyEligibility(
      ready.eligibility,
      immutable.manifest,
      immutable,
    )) !== true
  ) {
    throw new Error(`Release ${version} eligibility verification failed`)
  }

  const channelBody = await adapter.getObject(
    `${immutable.baseKey}/${immutable.manifest.channelManifest}`,
  )
  if (!channelBody) {
    throw new Error(`Release ${version} channel manifest is missing`)
  }

  return { ...immutable, ready, channelBody }
}

async function promoteVerifiedVersion(
  adapter,
  {
    prefix,
    verified,
    dryRun = false,
    verifyPromotion,
    verifyRestoration,
  },
) {
  const targetKey = `${normalizePrefix(prefix)}/${verified.manifest.channelManifest}`
  const sourceKey = `${verified.baseKey}/${verified.manifest.channelManifest}`
  const previousBody = await adapter.getObject(targetKey)
  if (previousBody?.equals(verified.channelBody)) {
    const currentMetadata = await adapter.headObject(targetKey)
    if (
      currentMetadata?.cacheControl === CHANNEL_CACHE_CONTROL &&
      currentMetadata?.contentType === 'application/x-yaml'
    ) {
      if (verifyPromotion) {
        await verifyPromotion({ targetKey, verified })
      }
      return { targetKey, changed: false }
    }
  }
  if (dryRun) return { targetKey, changed: false }

  try {
    await adapter.copyObject({
      sourceKey,
      targetKey,
      metadataDirective: 'Replaced',
      cacheControl: CHANNEL_CACHE_CONTROL,
      contentType: 'application/x-yaml',
    })
    const promotedBody = await adapter.getObject(targetKey)
    if (!promotedBody || !promotedBody.equals(verified.channelBody)) {
      throw new Error(`Channel promotion verification failed for ${targetKey}`)
    }
    if (verifyPromotion) {
      await verifyPromotion({ targetKey, verified })
    }
  } catch (error) {
    try {
      if (previousBody) {
        await adapter.putChannelObject({
          key: targetKey,
          body: previousBody,
          cacheControl: CHANNEL_CACHE_CONTROL,
          contentType: 'application/x-yaml',
        })
        const restoredBody = await adapter.getObject(targetKey)
        if (!restoredBody?.equals(previousBody)) {
          throw new Error(`Previous channel pointer was not restored: ${targetKey}`)
        }
      } else {
        await adapter.deleteObject(targetKey)
        if (await adapter.getObject(targetKey)) {
          throw new Error(`Failed channel pointer was not removed: ${targetKey}`)
        }
      }
      if (verifyRestoration) {
        await verifyRestoration({
          targetKey,
          previousBody,
          channelManifest: verified.manifest.channelManifest,
        })
      }
    } catch (recoveryError) {
      throw new AggregateError(
        [error, recoveryError],
        `Channel promotion failed and recovery also failed: ${targetKey}`,
      )
    }
    throw error
  }

  return { targetKey, changed: true }
}

export async function promoteChannel(
  adapter,
  {
    prefix = 'releases',
    version,
    verifyEligibility,
    dryRun = false,
    verifyPromotion,
    verifyRestoration,
  },
) {
  const verified = await verifyImmutableVersion(adapter, {
    prefix,
    version,
    verifyEligibility,
  })
  return promoteVerifiedVersion(adapter, {
    prefix,
    verified,
    dryRun,
    verifyPromotion,
    verifyRestoration,
  })
}

export async function rollbackChannel(
  adapter,
  {
    prefix = 'releases',
    targetVersion,
    verifyEligibility,
    dryRun = false,
    verifyPromotion,
    verifyRestoration,
  },
) {
  const verified = await verifyImmutableVersion(adapter, {
    prefix,
    version: targetVersion,
    verifyEligibility,
  })
  const targetKey = `${normalizePrefix(prefix)}/${verified.manifest.channelManifest}`
  const currentBody = await adapter.getObject(targetKey)
  if (!currentBody) {
    throw new Error(`Current channel pointer is missing: ${targetKey}`)
  }
  const currentVersion = parse(currentBody.toString())?.version
  if (currentVersion === targetVersion) {
    const result = await promoteVerifiedVersion(adapter, {
      prefix,
      verified,
      dryRun,
      verifyPromotion,
      verifyRestoration,
    })
    return {
      ...result,
      previousVersion: currentVersion,
      manifestSha256: sha256(verified.manifestBody),
    }
  }
  assertRollbackTarget(targetVersion, currentVersion)
  const result = await promoteVerifiedVersion(adapter, {
    prefix,
    verified,
    dryRun,
    verifyPromotion,
    verifyRestoration,
  })
  return {
    ...result,
    previousVersion: currentVersion,
    manifestSha256: sha256(verified.manifestBody),
  }
}
