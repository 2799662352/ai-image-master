import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'

const SHA256_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/

export function readRuntimeAssetLock(filePath) {
  const lock = JSON.parse(readFileSync(filePath, 'utf8'))
  if (
    lock?.schemaVersion !== 1 ||
    !lock.components ||
    typeof lock.components !== 'object'
  ) {
    throw new Error('Invalid runtime asset lock schema')
  }
  return lock
}

export function expectedRuntimeAssetDigest(
  lock,
  { component, version, target, assetName },
) {
  const entry = lock.components[component]
  if (!entry || entry.version !== version) {
    throw new Error(
      `Runtime asset lock does not pin ${component} version ${version}`,
    )
  }
  const digest = entry.targets?.[target]?.[assetName]
  if (!SHA256_DIGEST_PATTERN.test(digest ?? '')) {
    throw new Error(
      `Runtime asset lock is missing ${component}/${target}/${assetName}`,
    )
  }
  return digest
}

export function githubAssetDigest(asset) {
  if (!SHA256_DIGEST_PATTERN.test(asset?.digest ?? '')) {
    throw new Error(`GitHub asset ${asset?.name ?? '<unknown>'} has no SHA-256 digest`)
  }
  return asset.digest
}

export function verifyRuntimeAssetBytes(bytes, expectedDigest, assetName) {
  if (!SHA256_DIGEST_PATTERN.test(expectedDigest ?? '')) {
    throw new Error(`Invalid expected SHA-256 digest for ${assetName}`)
  }
  const actual = `sha256:${createHash('sha256').update(bytes).digest('hex')}`
  if (actual !== expectedDigest) {
    throw new Error(
      `Runtime asset SHA-256 mismatch for ${assetName}: expected ${expectedDigest}, got ${actual}`,
    )
  }
}

export function writeRuntimeAssetComponent(
  filePath,
  lock,
  { component, version, targets },
) {
  const next = structuredClone(lock)
  next.components[component] = { version, targets }
  writeFileSync(filePath, `${JSON.stringify(next, null, 2)}\n`)
  return next
}
