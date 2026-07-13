import semver from 'semver'
import { z } from 'zod'

const RELEASE_VERSION_PATTERN =
  /^\d+\.\d+\.\d+(?:-(?:beta|alpha)\.(?:0|[1-9]\d*))?$/
const PLACEHOLDER_PATTERN = /\b(?:TODO|TBD|FIXME)\b|<version>|\[待补充\]/i
const SHA256_PATTERN = /^[a-f0-9]{64}$/i
const SHA512_PATTERN = /^[a-f0-9]{128}$/i
const COMMIT_SHA_PATTERN = /^[a-f0-9]{40}$/i

const isoDateSchema = z.string().refine(
  (value) => Number.isFinite(Date.parse(value)),
  'Expected an ISO date string',
)

const fileSchema = z
  .object({
    name: z.string().min(1),
    size: z.number().int().nonnegative(),
    sha256: z.string().regex(SHA256_PATTERN),
    sha512: z.string().regex(SHA512_PATTERN).optional(),
  })
  .strict()

const actionsBuildProvenanceSchema = z
  .object({
    kind: z.literal('actions-build'),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    workflow: z.literal('.github/workflows/release.yml'),
    runId: z.string().regex(/^\d+$/),
    runAttempt: z.number().int().positive(),
    commitSha: z.string().regex(COMMIT_SHA_PATTERN),
    builtAt: isoDateSchema,
    tools: z
      .object({
        node: z.string().min(1),
        pnpm: z.string().min(1),
        electronBuilder: z.string().min(1),
      })
      .strict(),
  })
  .strict()

const legacyImportProvenanceSchema = z
  .object({
    kind: z.literal('legacy-import'),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    workflow: z.literal('.github/workflows/migrate-release-baseline.yml'),
    runId: z.string().regex(/^\d+$/),
    runAttempt: z.number().int().positive(),
    sourceKey: z.string().min(1),
    operator: z.string().min(1),
    importedAt: isoDateSchema,
    originalBuild: z.null(),
  })
  .strict()

const releaseManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    channel: z.enum(['stable', 'beta', 'alpha']),
    channelManifest: z.enum(['latest.yml', 'beta.yml', 'alpha.yml']),
    createdAt: isoDateSchema,
    signing: z
      .object({
        status: z.enum(['signed', 'unsigned']),
        subject: z.string().min(1).nullable(),
      })
      .strict(),
    files: z.array(fileSchema).min(1),
    provenance: z.discriminatedUnion('kind', [
      actionsBuildProvenanceSchema,
      legacyImportProvenanceSchema,
    ]),
  })
  .strict()
  .superRefine((manifest, context) => {
    if (
      (manifest.signing.status === 'signed' && !manifest.signing.subject) ||
      (manifest.signing.status === 'unsigned' && manifest.signing.subject)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['signing', 'subject'],
        message: 'Signing subject must exist exactly when status is signed',
      })
    }
    if (
      manifest.provenance.kind === 'legacy-import' &&
      manifest.version !== '4.3.95'
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['version'],
        message: 'legacy-import provenance is restricted to version 4.3.95',
      })
    }
  })

const githubReleaseEligibilitySchema = z
  .object({
    kind: z.literal('github-release'),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    tag: z.string().regex(/^v\d+\.\d+\.\d+(?:-(?:beta|alpha)\.\d+)?$/),
    releaseId: z.number().int().positive(),
    publishedAt: isoDateSchema,
  })
  .strict()

const legacyImportEligibilitySchema = z
  .object({
    kind: z.literal('legacy-import'),
    repository: z.string().regex(/^[^/\s]+\/[^/\s]+$/),
    workflow: z.literal('.github/workflows/migrate-release-baseline.yml'),
    runId: z.string().regex(/^\d+$/),
    runAttempt: z.number().int().positive(),
    sourceKey: z.string().min(1),
    operator: z.string().min(1),
    importedAt: isoDateSchema,
  })
  .strict()

const releaseReadySchema = z
  .object({
    schemaVersion: z.literal(1),
    version: z.string(),
    channel: z.enum(['stable', 'beta', 'alpha']),
    manifestSha256: z.string().regex(SHA256_PATTERN),
    readyAt: isoDateSchema,
    eligibility: z.discriminatedUnion('kind', [
      githubReleaseEligibilitySchema,
      legacyImportEligibilitySchema,
    ]),
  })
  .strict()

export function parseReleaseVersion(version) {
  if (
    typeof version !== 'string' ||
    !RELEASE_VERSION_PATTERN.test(version) ||
    semver.valid(version) !== version
  ) {
    throw new Error(
      `Invalid release version ${JSON.stringify(version)}; expected x.y.z, x.y.z-beta.n, or x.y.z-alpha.n`,
    )
  }

  return version
}

export function deriveReleaseChannel(version) {
  const parsedVersion = parseReleaseVersion(version)
  if (parsedVersion.includes('-beta.')) return 'beta'
  if (parsedVersion.includes('-alpha.')) return 'alpha'
  return 'stable'
}

export function channelManifestName(channel) {
  switch (channel) {
    case 'stable':
      return 'latest.yml'
    case 'beta':
      return 'beta.yml'
    case 'alpha':
      return 'alpha.yml'
    default:
      throw new Error(`Unsupported release channel: ${String(channel)}`)
  }
}

export function assertForwardRelease(targetVersion, publishedVersions) {
  const parsedTarget = parseReleaseVersion(targetVersion)
  for (const publishedVersion of publishedVersions) {
    const parsedPublished = parseReleaseVersion(publishedVersion)
    if (!semver.gt(parsedTarget, parsedPublished)) {
      throw new Error(
        `Release version ${parsedTarget} must be greater than published version ${parsedPublished}`,
      )
    }
  }
}

export function assertRollbackTarget(targetVersion, currentVersion) {
  const parsedTarget = parseReleaseVersion(targetVersion)
  const parsedCurrent = parseReleaseVersion(currentVersion)
  if (deriveReleaseChannel(parsedTarget) !== deriveReleaseChannel(parsedCurrent)) {
    throw new Error('Rollback target and current version must use the same channel')
  }
  if (!semver.lt(parsedTarget, parsedCurrent)) {
    throw new Error(
      `Rollback target ${parsedTarget} must be strictly lower than ${parsedCurrent}`,
    )
  }
}

export function shouldPromoteLegacyCompletion(targetVersion, currentVersion) {
  const target = parseReleaseVersion(targetVersion)
  if (!currentVersion) return true
  const current = parseReleaseVersion(currentVersion)
  if (deriveReleaseChannel(target) !== deriveReleaseChannel(current)) {
    throw new Error(
      'Legacy completion target and current version must use the same channel',
    )
  }
  return !semver.gt(current, target)
}

export function resolveSigningMode(environment) {
  const certificate = environment.WIN_CERTIFICATE?.trim()
  const password = environment.WIN_CERTIFICATE_PASSWORD?.trim()
  const subject = environment.WIN_CERTIFICATE_SUBJECT_NAME?.trim()
  const configuredCount = [certificate, password, subject].filter(Boolean).length

  if (configuredCount === 0) {
    return { mode: 'unsigned', subject: null }
  }
  if (!certificate || !password) {
    throw new Error(
      'Windows signing is partially configured; WIN_CERTIFICATE and WIN_CERTIFICATE_PASSWORD must be set together',
    )
  }

  return { mode: 'signed', subject: subject || null }
}

export function validateReleaseNotes(notes) {
  if (typeof notes !== 'string' || notes.trim().length === 0) {
    throw new Error('Release notes must not be empty')
  }
  if (PLACEHOLDER_PATTERN.test(notes)) {
    throw new Error('Release notes contain an unresolved placeholder')
  }
  return true
}

export function validateReleaseManifest(manifest) {
  const parsed = releaseManifestSchema.parse(manifest)
  const version = parseReleaseVersion(parsed.version)
  const channel = deriveReleaseChannel(version)
  if (parsed.channel !== channel) {
    throw new Error(
      `Release manifest channel ${parsed.channel} does not match version channel ${channel}`,
    )
  }
  if (parsed.channelManifest !== channelManifestName(channel)) {
    throw new Error(
      `Release manifest file ${parsed.channelManifest} does not match channel ${channel}`,
    )
  }
  if (parsed.signing.status === 'unsigned' && parsed.signing.subject !== null) {
    throw new Error('Unsigned release manifest must not declare a signing subject')
  }
  return parsed
}

export function validateReleaseReady(releaseReady) {
  const parsed = releaseReadySchema.parse(releaseReady)
  const version = parseReleaseVersion(parsed.version)
  if (parsed.channel !== deriveReleaseChannel(version)) {
    throw new Error('release-ready channel does not match its version')
  }
  return parsed
}

export function createLegacyReleaseReady(manifest, manifestSha256) {
  const parsed = validateReleaseManifest(manifest)
  if (parsed.provenance.kind !== 'legacy-import') {
    throw new Error('Legacy release-ready requires legacy-import provenance')
  }
  return validateReleaseReady({
    schemaVersion: 1,
    version: parsed.version,
    channel: parsed.channel,
    manifestSha256,
    readyAt: parsed.provenance.importedAt,
    eligibility: {
      kind: 'legacy-import',
      repository: parsed.provenance.repository,
      workflow: parsed.provenance.workflow,
      runId: parsed.provenance.runId,
      runAttempt: parsed.provenance.runAttempt,
      sourceKey: parsed.provenance.sourceKey,
      operator: parsed.provenance.operator,
      importedAt: parsed.provenance.importedAt,
    },
  })
}

export function filterTrustedArtifactCandidates(candidates, expected) {
  const expectedNamePrefix = `release-win-${expected.version}-${expected.headSha}`
  return candidates.filter(
    (candidate) =>
      candidate.repository === expected.repository &&
      candidate.workflow === expected.workflow &&
      candidate.event === 'workflow_dispatch' &&
      candidate.headSha === expected.headSha &&
      candidate.conclusion === 'success' &&
      candidate.expired === false &&
      candidate.dryRun === false &&
      typeof candidate.name === 'string' &&
      candidate.name.startsWith(expectedNamePrefix),
  )
}

function compareRunIds(left, right) {
  const leftId = BigInt(left.runId)
  const rightId = BigInt(right.runId)
  if (leftId < rightId) return -1
  if (leftId > rightId) return 1
  return 0
}

export function selectCanonicalArtifact(candidates, canonicalRunId) {
  if (canonicalRunId) {
    const selected = candidates.find(
      (candidate) => String(candidate.runId) === String(canonicalRunId),
    )
    if (!selected) {
      throw new Error(`canonical_run_id ${canonicalRunId} is not a trusted candidate`)
    }
    return selected
  }
  if (candidates.length === 0) return null

  const digests = new Set(candidates.map((candidate) => candidate.artifactDigest))
  if (digests.size !== 1) {
    throw new Error(
      'Trusted artifact candidates have different digests; canonical_run_id is required',
    )
  }

  return candidates.toSorted(compareRunIds)[0]
}

export function hasUnrecoverableVersionState({
  tagExists,
  githubReleaseExists,
  remoteCosState,
}) {
  return Boolean(tagExists || githubReleaseExists || remoteCosState)
}
