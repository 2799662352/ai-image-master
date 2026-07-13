import { createHash } from 'node:crypto'
import {
  createReadStream,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'

import { parse } from 'yaml'

import {
  channelManifestName,
  deriveReleaseChannel,
  parseReleaseVersion,
  validateReleaseManifest,
} from './release-contract.mjs'

const RELEASE_MANIFEST_NAME = 'release-manifest.json'
const SHA256_SUMS_NAME = 'SHA256SUMS.txt'
const NON_WINDOWS_ARTIFACT_PATTERN = /\.(?:dmg|AppImage|deb|rpm|pkg|zip)$/i

async function hashFile(filePath, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest(encoding)
}

function hashBuffer(buffer, algorithm, encoding) {
  return createHash(algorithm).update(buffer).digest(encoding)
}

function serializeManifest(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`
}

export function discoverWindowsArtifacts(directory, version) {
  const parsedVersion = parseReleaseVersion(version)
  const expectedChannelManifest = channelManifestName(
    deriveReleaseChannel(parsedVersion),
  )
  const entries = readdirSync(directory, { withFileTypes: true })
  if (entries.some((entry) => !entry.isFile())) {
    throw new Error('Release staging directory must contain files only')
  }

  const names = entries.map((entry) => entry.name)
  const foreignArtifact = names.find((name) =>
    NON_WINDOWS_ARTIFACT_PATTERN.test(name),
  )
  if (foreignArtifact) {
    throw new Error(`Non-Windows artifact is not allowed: ${foreignArtifact}`)
  }

  const expectedExecutable =
    `catimation-cyberpunk-master-${parsedVersion}-setup.exe`
  const executables = names.filter((name) => name.toLowerCase().endsWith('.exe'))
  if (executables.length !== 1 || executables[0] !== expectedExecutable) {
    throw new Error(
      `Expected exactly one canonical Windows executable named ${expectedExecutable}`,
    )
  }

  const blockmaps = names.filter((name) =>
    name.toLowerCase().endsWith('.blockmap'),
  )
  if (
    blockmaps.length !== 1 ||
    blockmaps[0] !== `${executables[0]}.blockmap`
  ) {
    throw new Error('Expected exactly one blockmap matching the Windows executable')
  }

  const yamlFiles = names.filter((name) => name.toLowerCase().endsWith('.yml'))
  if (
    yamlFiles.length !== 1 ||
    yamlFiles[0].toLowerCase() !== expectedChannelManifest.toLowerCase()
  ) {
    throw new Error(
      `Expected only the ${expectedChannelManifest} updater manifest for ${parsedVersion}`,
    )
  }

  const allowedNames = new Set([
    executables[0],
    blockmaps[0],
    yamlFiles[0],
    RELEASE_MANIFEST_NAME,
    SHA256_SUMS_NAME,
  ])
  const unexpected = names.filter((name) => !allowedNames.has(name))
  if (unexpected.length > 0) {
    throw new Error(`Unexpected release staging files: ${unexpected.join(', ')}`)
  }

  return {
    executable: executables[0],
    blockmap: blockmaps[0],
    channelManifest: yamlFiles[0],
  }
}

export async function verifyUpdaterManifest(
  directory,
  artifacts,
  expectedVersion = null,
) {
  const manifestPath = path.join(directory, artifacts.channelManifest)
  const manifest = parse(readFileSync(manifestPath, 'utf8'))
  const version = parseReleaseVersion(manifest?.version)
  if (expectedVersion && version !== parseReleaseVersion(expectedVersion)) {
    throw new Error(
      `Updater manifest version ${version} does not match ${expectedVersion}`,
    )
  }
  const expectedManifest = channelManifestName(deriveReleaseChannel(version))
  if (artifacts.channelManifest !== expectedManifest) {
    throw new Error(
      `Updater manifest ${artifacts.channelManifest} does not match version ${version}`,
    )
  }

  if (manifest?.path !== artifacts.executable) {
    throw new Error('Updater manifest path does not match the Windows executable')
  }
  if (!Array.isArray(manifest?.files) || manifest.files.length !== 1) {
    throw new Error('Updater manifest must contain exactly one Windows file')
  }

  const executablePath = path.join(directory, artifacts.executable)
  const executableSize = statSync(executablePath).size
  const executableSha512 = await hashFile(executablePath, 'sha512', 'base64')
  if (manifest?.sha512 !== executableSha512) {
    throw new Error('Updater manifest sha512 does not match the Windows executable')
  }

  const [fileEntry] = manifest.files
  if (fileEntry?.url !== artifacts.executable) {
    throw new Error(
      'Updater manifest file URL does not exactly match the Windows executable',
    )
  }
  if (fileEntry.size !== executableSize) {
    throw new Error(
      `Updater manifest size ${String(fileEntry.size)} does not match ${executableSize}`,
    )
  }
  if (fileEntry.sha512 !== executableSha512) {
    throw new Error('Updater manifest files sha512 does not match the executable')
  }

  return manifest
}

export async function createReleaseManifest({
  directory,
  artifacts,
  version,
  createdAt,
  signing,
  provenance,
}) {
  const parsedVersion = parseReleaseVersion(version)
  const payloadNames = [
    artifacts.executable,
    artifacts.blockmap,
    artifacts.channelManifest,
  ]
  const files = await Promise.all(
    payloadNames.map(async (name) => {
      const filePath = path.join(directory, name)
      return {
        name,
        size: statSync(filePath).size,
        sha256: await hashFile(filePath, 'sha256', 'hex'),
        sha512: await hashFile(filePath, 'sha512', 'hex'),
      }
    }),
  )

  return validateReleaseManifest({
    schemaVersion: 1,
    version: parsedVersion,
    channel: deriveReleaseChannel(parsedVersion),
    channelManifest: artifacts.channelManifest,
    createdAt,
    signing,
    provenance,
    files,
  })
}

export async function createSha256Sums(directory, artifacts, manifest) {
  const manifestText = serializeManifest(manifest)
  const manifestHash = hashBuffer(Buffer.from(manifestText), 'sha256', 'hex')
  const expectedPayloadNames = new Set([
    artifacts.executable,
    artifacts.blockmap,
    artifacts.channelManifest,
  ])
  const payloadFiles = manifest.files
    .filter((file) => expectedPayloadNames.has(file.name))
    .toSorted((left, right) => left.name.localeCompare(right.name))

  if (payloadFiles.length !== expectedPayloadNames.size) {
    throw new Error('Release manifest does not contain all payload files')
  }

  for (const file of payloadFiles) {
    const actualHash = await hashFile(
      path.join(directory, file.name),
      'sha256',
      'hex',
    )
    if (actualHash !== file.sha256) {
      throw new Error(`SHA-256 mismatch while generating sums for ${file.name}`)
    }
  }

  return [
    ...payloadFiles.map((file) => `${file.sha256}  ${file.name}`),
    `${manifestHash}  ${RELEASE_MANIFEST_NAME}`,
    '',
  ].join('\n')
}

export async function writeReleaseMetadata(directory, artifacts, manifest) {
  const manifestText = serializeManifest(manifest)
  const sums = await createSha256Sums(directory, artifacts, manifest)
  writeFileSync(path.join(directory, RELEASE_MANIFEST_NAME), manifestText)
  writeFileSync(path.join(directory, SHA256_SUMS_NAME), sums)
}

function parseSha256Sums(text) {
  const entries = new Map()
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue
    const match = line.match(/^([a-f0-9]{64}) {2}(.+)$/i)
    if (!match) {
      throw new Error(`Invalid SHA256SUMS line: ${line}`)
    }
    if (entries.has(match[2])) {
      throw new Error(`Duplicate SHA256SUMS entry: ${match[2]}`)
    }
    entries.set(match[2], match[1].toLowerCase())
  }
  return entries
}

export async function verifyReleaseBundle(directory) {
  const manifestText = readFileSync(
    path.join(directory, RELEASE_MANIFEST_NAME),
    'utf8',
  )
  const manifest = validateReleaseManifest(JSON.parse(manifestText))
  const artifacts = discoverWindowsArtifacts(directory, manifest.version)
  await verifyUpdaterManifest(directory, artifacts, manifest.version)

  const expectedPayloadNames = new Set([
    artifacts.executable,
    artifacts.blockmap,
    artifacts.channelManifest,
  ])
  if (
    manifest.files.length !== expectedPayloadNames.size ||
    manifest.files.some((file) => !expectedPayloadNames.has(file.name))
  ) {
    throw new Error('Release manifest payload set is incomplete or unexpected')
  }

  for (const file of manifest.files) {
    const filePath = path.join(directory, file.name)
    const sha256 = await hashFile(filePath, 'sha256', 'hex')
    if (sha256 !== file.sha256) {
      throw new Error(`SHA-256 mismatch for ${file.name}`)
    }
    if (file.sha512) {
      const sha512 = await hashFile(filePath, 'sha512', 'hex')
      if (sha512 !== file.sha512) {
        throw new Error(`SHA-512 mismatch for ${file.name}`)
      }
    }
  }

  const sums = parseSha256Sums(
    readFileSync(path.join(directory, SHA256_SUMS_NAME), 'utf8'),
  )
  if (sums.has(SHA256_SUMS_NAME)) {
    throw new Error('SHA256SUMS.txt must not contain a self-reference')
  }
  const expectedSumNames = new Set([
    ...expectedPayloadNames,
    RELEASE_MANIFEST_NAME,
  ])
  if (
    sums.size !== expectedSumNames.size ||
    [...sums.keys()].some((name) => !expectedSumNames.has(name))
  ) {
    throw new Error('SHA256SUMS.txt contains an incomplete or unexpected file set')
  }

  for (const name of expectedSumNames) {
    const actual =
      name === RELEASE_MANIFEST_NAME
        ? hashBuffer(Buffer.from(manifestText), 'sha256', 'hex')
        : await hashFile(path.join(directory, name), 'sha256', 'hex')
    if (sums.get(name) !== actual) {
      throw new Error(`SHA-256 checksum file mismatch for ${name}`)
    }
  }

  return manifest
}
