#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto'
import {
  createReadStream,
  readFileSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

import {
  verifyReleaseBundle,
} from './artifact-contract.mjs'
import { CosClientAdapter } from './cos-client.mjs'
import {
  IMMUTABLE_CACHE_CONTROL,
  assertChannelCacheControl,
  assertImmutableCacheControl,
  markReleaseReady,
  markVerifiedReleaseReady,
  preflightCos,
  promoteChannel,
  repairLegacyReleaseChecksum,
  rollbackChannel,
  uploadImmutableAssets,
  verifyImmutableAssets,
  verifyImmutableVersion,
} from './cos-release-core.mjs'
import { Crc64Ecma182 } from './crc64.mjs'
import { appendGithubOutputs } from './github-output.mjs'
import {
  channelManifestName,
  createLegacyReleaseReady,
  deriveReleaseChannel,
  parseReleaseVersion,
  shouldPromoteLegacyCompletion,
  validateReleaseReady,
} from './release-contract.mjs'

/**
 * 单个 HTTP 请求的上限。
 *
 * 2026-08-09 的 4.5.3 发版:「COS 只读预检」在 `cos-release.mjs status` 上挂了
 * 18 分钟,直到 job 超时被取消 —— 后面所有阶段跳过,而日志里只有一句
 * "The operation was canceled",没有任何可诊断的东西。
 *
 * 病根是**有重试但没有超时**:这些地方都写了 4 次重试 + 1 秒退避,可那只挡得住
 * 「快速失败」。socket 级挂起既不返回也不抛错,`await fetch` 就一直等下去,重试
 * 一次都不会触发。所以超时不是重试的补充,是重试能生效的前提。
 *
 * 30 秒:远小于 job 超时(所以我们会拿到真正的错误信息和重试),又远大于 COS 正常
 * 响应(所以不会把慢网络误判成故障)。
 */
const HTTP_TIMEOUT_MS = Number(process.env.COS_HTTP_TIMEOUT_MS ?? 30_000)

/**
 * 带超时的 fetch。签名与 fetch 一致,可直接替换。
 *
 * 超时后抛出**点名了 URL 和秒数**的错误 —— 上层那些重试循环只把 `lastError` 原样
 * 带出来,错误信息不具体的话,失败时依旧无从下手。
 */
export async function fetchWithTimeout(input, init = {}) {
  try {
    return await fetch(input, { ...init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) })
  } catch (error) {
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      const url = typeof input === 'string' ? input : input?.url ?? String(input)
      throw new Error(`Request timed out after ${HTTP_TIMEOUT_MS}ms: ${url}`)
    }
    throw error
  }
}

const WRITE_COMMANDS = new Set([
  'upload-assets',
  'mark-ready',
  'promote',
  'rollback',
  'import-legacy',
  'complete-legacy',
])

function parseArguments(argv) {
  const [command, ...rest] = argv
  const options = { command, dryRun: false }
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index]
    if (argument === '--dry-run') {
      options.dryRun = true
      continue
    }
    if (!argument.startsWith('--')) {
      throw new Error(`Unexpected argument: ${argument}`)
    }
    const key = argument.slice(2)
    const value = rest[index + 1]
    if (!value || value.startsWith('--')) {
      throw new Error(`Missing value for ${argument}`)
    }
    options[key] = value
    index += 1
  }
  return options
}

function contentType(name) {
  if (name.endsWith('.json')) return 'application/json'
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8'
  if (name.endsWith('.yml')) return 'application/x-yaml'
  return 'application/octet-stream'
}

async function fileIntegrity(filePath) {
  const hash = createHash('sha256')
  const crc64 = new Crc64Ecma182()
  let size = 0
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
    crc64.update(chunk)
    size += chunk.length
  }
  return {
    size,
    sha256: hash.digest('hex'),
    crc64: crc64.digest(),
  }
}

async function createImmutableInputs(directory, manifest, prefix) {
  const names = [
    ...manifest.files.map((file) => file.name),
    'release-manifest.json',
    'SHA256SUMS.txt',
  ]
  return Promise.all(
    names.map(async (name) => {
      const filePath = path.join(directory, name)
      const integrity = await fileIntegrity(filePath)
      const versionScoped =
        name === manifest.channelManifest ||
        name === 'release-manifest.json' ||
        name === 'SHA256SUMS.txt'
      const input = {
        key: versionScoped
          ? `${prefix}/versions/${manifest.version}/${name}`
          : `${prefix}/${name}`,
        filePath,
        ...integrity,
        cacheControl: IMMUTABLE_CACHE_CONTROL,
        contentType: contentType(name),
      }
      if (integrity.size <= 8 * 1024 * 1024) {
        input.body = readFileSync(filePath)
        delete input.filePath
      }
      return input
    }),
  )
}

function createClient(prefix) {
  return new CosClientAdapter({
    secretId: process.env.COS_SECRET_ID,
    secretKey: process.env.COS_SECRET_KEY,
    bucket: process.env.COS_BUCKET,
    region: process.env.COS_REGION,
    prefix,
  })
}

async function githubAssetSha256(repository, assetId) {
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/releases/assets/${assetId}`,
    {
      headers: {
        Accept: 'application/octet-stream',
        'User-Agent': 'catimation-release-verifier',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
      redirect: 'follow',
    },
  )
  if (!response.ok || !response.body) return null
  const hash = createHash('sha256')
  for await (const chunk of response.body) hash.update(chunk)
  return hash.digest('hex')
}

async function githubTagCommit(repository, tag) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'catimation-release-verifier',
    ...(process.env.GITHUB_TOKEN
      ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
      : {}),
  }
  const referenceResponse = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    { headers },
  )
  if (!referenceResponse.ok) return null
  const reference = await referenceResponse.json()
  if (reference.object?.type === 'commit') return reference.object.sha
  if (reference.object?.type !== 'tag' || !reference.object.sha) return null

  const tagResponse = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/git/tags/${reference.object.sha}`,
    { headers },
  )
  if (!tagResponse.ok) return null
  const annotatedTag = await tagResponse.json()
  return annotatedTag.object?.type === 'commit'
    ? annotatedTag.object.sha
    : null
}

function githubReleaseFiles(manifest, immutable) {
  const manifestBody = immutable.manifestBody
  const manifestSha256 = createHash('sha256')
    .update(manifestBody)
    .digest('hex')
  const sumsBody = immutable.checksumBody
  return [
    ...manifest.files,
    {
      name: 'release-manifest.json',
      size: manifestBody.length,
      sha256: manifestSha256,
    },
    {
      name: 'SHA256SUMS.txt',
      size: sumsBody.length,
      sha256: createHash('sha256').update(sumsBody).digest('hex'),
    },
  ]
}

async function verifyOptionalLegacyGithubRelease(manifest) {
  const repository = manifest.provenance.repository
  const tag = `v${manifest.version}`
  const githubToken = process.env.GITHUB_TOKEN
  if (!githubToken) {
    throw new Error('GITHUB_TOKEN is required for legacy GitHub Release lookup')
  }
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${githubToken}`,
        'User-Agent': 'catimation-legacy-release-verifier',
      },
    },
  )
  if (response.status === 404) return
  if (!response.ok) {
    throw new Error(
      `Unable to verify optional legacy GitHub Release (${response.status})`,
    )
  }
  const release = await response.json()
  const expectedFiles = manifest.files
  if (
    release.tag_name !== tag ||
    release.draft !== false ||
    release.prerelease !== false ||
    !Array.isArray(release.assets)
  ) {
    throw new Error('Existing legacy GitHub Release metadata is inconsistent')
  }
  for (const file of expectedFiles) {
    const asset = release.assets.find(
      (candidate) =>
        candidate.name === file.name && Number(candidate.size) === file.size,
    )
    const sameNameAsset = release.assets.find(
      (candidate) => candidate.name === file.name,
    )
    if (!sameNameAsset) continue
    if (!asset) {
      throw new Error(
        `Existing legacy GitHub Release asset ${file.name} has a different size`,
      )
    }
    const remoteSha256 =
      typeof asset.digest === 'string' && asset.digest.startsWith('sha256:')
        ? asset.digest.slice('sha256:'.length)
        : await githubAssetSha256(repository, asset.id)
    if (remoteSha256 !== file.sha256) {
      throw new Error(
        `Existing legacy GitHub Release asset ${file.name} does not match COS`,
      )
    }
  }
}

async function verifyEligibility(eligibility, prefix, manifest, immutable) {
  if (eligibility.kind === 'legacy-import') {
    return (
      manifest?.version === '4.3.95' &&
      manifest?.provenance?.kind === 'legacy-import' &&
      eligibility.sourceKey.startsWith(`${prefix}/`) &&
      eligibility.repository === manifest.provenance.repository &&
      eligibility.workflow === manifest.provenance.workflow &&
      eligibility.runId === manifest.provenance.runId &&
      eligibility.runAttempt === manifest.provenance.runAttempt &&
      eligibility.sourceKey === manifest.provenance.sourceKey &&
      eligibility.operator === manifest.provenance.operator &&
      eligibility.importedAt === manifest.provenance.importedAt
    )
  }

  if (
    manifest?.provenance?.kind !== 'actions-build' ||
    !immutable?.manifestBody ||
    !immutable?.checksumBody
  ) {
    return false
  }
  const response = await fetchWithTimeout(
    `https://api.github.com/repos/${eligibility.repository}/releases/tags/${encodeURIComponent(eligibility.tag)}`,
    {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'catimation-release-verifier',
        ...(process.env.GITHUB_TOKEN
          ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
          : {}),
      },
    },
  )
  if (!response.ok) return false
  const release = await response.json()
  if (
    release.id === eligibility.releaseId &&
    release.tag_name === eligibility.tag &&
    release.draft === false &&
    release.published_at === eligibility.publishedAt &&
    release.prerelease === (manifest?.channel !== 'stable')
  ) {
    if (
      (await githubTagCommit(eligibility.repository, eligibility.tag)) !==
      manifest.provenance.commitSha
    ) {
      return false
    }
    const expectedFiles = githubReleaseFiles(manifest, immutable)
    const expectedNames = new Set(expectedFiles.map((file) => file.name))
    if (
      release.assets?.length !== expectedFiles.length ||
      release.assets.some((asset) => !expectedNames.has(asset.name))
    ) {
      return false
    }
    for (const file of expectedFiles) {
      const asset = release.assets?.find(
        (candidate) =>
          candidate.name === file.name && Number(candidate.size) === file.size,
      )
      if (!asset) return false
      const remoteSha256 =
        typeof asset.digest === 'string' &&
        asset.digest.startsWith('sha256:')
          ? asset.digest.slice('sha256:'.length)
          : await githubAssetSha256(
              eligibility.repository,
              asset.id,
            )
      if (remoteSha256 !== file.sha256) return false
    }
    return true
  }
  return false
}

export async function verifyPublicRelease(
  prefix,
  version,
  { requireImmutableAssetCache = false, expectedChannelBody = null } = {},
) {
  const channelManifest = channelManifestName(deriveReleaseChannel(version))
  const publicBase =
    process.env.COS_PUBLIC_BASE_URL ||
    `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com/${prefix}/`
  const cacheBuster = encodeURIComponent(
    `${process.env.GITHUB_RUN_ID ?? 'local'}-${randomUUID()}`,
  )
  const channelUrl = new URL(channelManifest, publicBase)
  channelUrl.searchParams.set('ci', cacheBuster)
  const channelResponse = await fetchWithTimeout(channelUrl)
  if (!channelResponse.ok) {
    throw new Error(
      `Public channel manifest returned ${channelResponse.status}`,
    )
  }
  const cacheControl =
    channelResponse.headers.get('cache-control')?.toLowerCase() ?? ''
  assertChannelCacheControl(cacheControl)
  const channelBody = Buffer.from(await channelResponse.text())
  if (expectedChannelBody && !channelBody.equals(expectedChannelBody)) {
    throw new Error('Public channel manifest content does not match the verified release')
  }
  const updaterManifest = parse(channelBody.toString())
  if (updaterManifest?.version !== version || !updaterManifest?.path) {
    throw new Error('Public channel manifest does not reference the release')
  }
  for (const assetName of [
    path.basename(updaterManifest.path),
    `${path.basename(updaterManifest.path)}.blockmap`,
  ]) {
    const response = await fetchWithTimeout(new URL(assetName, publicBase), {
      method: 'HEAD',
    })
    if (!response.ok) {
      throw new Error(
        `Public release asset ${assetName} returned ${response.status}`,
      )
    }
    if (requireImmutableAssetCache) {
      assertImmutableCacheControl(response.headers.get('cache-control') ?? '')
    }
  }
  return channelManifest
}

async function verifyPublicRestoration(
  prefix,
  { previousBody, channelManifest },
) {
  let lastError
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    try {
      if (previousBody) {
        const previousVersion = parseReleaseVersion(
          parse(previousBody.toString())?.version,
        )
        await verifyPublicRelease(prefix, previousVersion, {
          expectedChannelBody: previousBody,
        })
        return previousVersion
      } else {
        const publicBase =
          process.env.COS_PUBLIC_BASE_URL ||
          `https://${process.env.COS_BUCKET}.cos.${process.env.COS_REGION}.myqcloud.com/${prefix}/`
        const channelUrl = new URL(channelManifest, publicBase)
        channelUrl.searchParams.set(
          'recovery',
          `${process.env.GITHUB_RUN_ID ?? 'local'}-${randomUUID()}`,
        )
        const response = await fetchWithTimeout(channelUrl, { cache: 'no-store' })
        if (response.status !== 404) {
          throw new Error(
            `Restored absent channel returned ${response.status}`,
          )
        }
        return 'absent'
      }
    } catch (error) {
      lastError = error
      if (attempt < 4) {
        await new Promise((resolve) => setTimeout(resolve, 1000))
      }
    }
  }
  throw new Error(
    `Public channel restoration verification failed: ${
      lastError instanceof Error ? lastError.message : String(lastError)
    }`,
  )
}

async function verifyPublicRestorationWithOutput(prefix, context) {
  const restoredVersion = await verifyPublicRestoration(prefix, context)
  writeOutputs({ restored_version: restoredVersion })
}

function assertWriteContext(command, dryRun) {
  if (
    WRITE_COMMANDS.has(command) &&
    !dryRun &&
    process.env.GITHUB_ACTIONS !== 'true'
  ) {
    throw new Error(
      `${command} can write production state only from GitHub Actions; use --dry-run locally`,
    )
  }
}

function requiredOption(options, name, fallback) {
  const value = options[name] ?? fallback
  if (!value) throw new Error(`Missing required --${name}`)
  return value
}

function writeOutputs(values) {
  appendGithubOutputs(process.env.GITHUB_OUTPUT, values)
}

async function loadLocalBundle(options) {
  const directory = path.resolve(
    requiredOption(options, 'directory', process.env.RELEASE_DIR),
  )
  const manifest = await verifyReleaseBundle(directory)
  const requestedVersion = options.version ?? process.env.RELEASE_VERSION
  if (requestedVersion && requestedVersion !== manifest.version) {
    throw new Error(
      `Requested version ${requestedVersion} does not match bundle ${manifest.version}`,
    )
  }
  return { directory, manifest }
}

async function run() {
  const options = parseArguments(process.argv.slice(2))
  const command = options.command
  if (!command) throw new Error('A release command is required')
  assertWriteContext(command, options.dryRun)

  if (command === 'verify') {
    const { manifest } = await loadLocalBundle(options)
    console.log(
      JSON.stringify({
        ok: true,
        version: manifest.version,
        channel: manifest.channel,
        signing: manifest.signing.status,
      }),
    )
    return
  }

  const prefix = requiredOption(options, 'prefix', process.env.COS_PREFIX)
    .replace(/^\/+|\/+$/g, '')
  const client = createClient(prefix)
  await preflightCos(client)
  const eligibilityVerifier = (eligibility, manifest, immutable) =>
    verifyEligibility(eligibility, prefix, manifest, immutable)

  if (command === 'preflight') {
    console.log(JSON.stringify({ ok: true, command, prefix }))
    return
  }

  if (command === 'status') {
    const version = requiredOption(
      options,
      'version',
      process.env.RELEASE_VERSION,
    )
    const channelManifest = channelManifestName(deriveReleaseChannel(version))
    const targetChannel = deriveReleaseChannel(version)
    const versionBase = `${prefix}/versions/${version}`
    const manifestExists = Boolean(
      await client.headObject(`${versionBase}/release-manifest.json`),
    )
    const readyExists = Boolean(
      await client.headObject(`${versionBase}/release-ready.json`),
    )
    const channelBody = await client.getObject(
      `${prefix}/${channelManifest}`,
    )
    const currentVersion = channelBody
      ? parseReleaseVersion(parse(channelBody.toString())?.version)
      : ''
    if (
      currentVersion &&
      deriveReleaseChannel(currentVersion) !== targetChannel
    ) {
      throw new Error(
        `${channelManifest} points to a ${deriveReleaseChannel(currentVersion)} release`,
      )
    }
    const publishedVersions = []
    for (const candidate of await client.listVersions()) {
      try {
        const candidateVersion = parseReleaseVersion(candidate)
        if (deriveReleaseChannel(candidateVersion) === targetChannel) {
          await verifyImmutableVersion(client, {
            prefix,
            version: candidateVersion,
            verifyEligibility: eligibilityVerifier,
          })
          publishedVersions.push(candidate)
        }
      } catch (error) {
        console.warn(
          `[status] Ignoring invalid release folder ${JSON.stringify(candidate)}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
    }
    const remoteState = manifestExists || readyExists
    writeOutputs({
      remote_state: String(remoteState),
      manifest_exists: String(manifestExists),
      ready_exists: String(readyExists),
      current_version: currentVersion,
      published_versions: JSON.stringify(publishedVersions),
    })
    console.log(
      JSON.stringify({
        ok: true,
        command,
        version,
        remoteState,
        manifestExists,
        readyExists,
        currentVersion,
        publishedVersions,
      }),
    )
    return
  }

  if (command === 'verify-public') {
    const version = requiredOption(
      options,
      'version',
      process.env.RELEASE_VERSION,
    )
    const immutable = await verifyImmutableAssets(client, { prefix, version })
    const expectedChannelBody = await client.getObject(
      `${immutable.baseKey}/${immutable.manifest.channelManifest}`,
    )
    if (!expectedChannelBody) {
      throw new Error('Verified release channel manifest is missing')
    }
    const channelManifest = await verifyPublicRelease(prefix, version, {
      requireImmutableAssetCache:
        immutable.manifest.provenance.kind === 'actions-build',
      expectedChannelBody,
    })
    writeOutputs({
      current_version: version,
      channel_manifest: channelManifest,
    })
    console.log(
      JSON.stringify({ ok: true, command, version, channelManifest }),
    )
    return
  }

  if (command === 'download-metadata') {
    const version = requiredOption(
      options,
      'version',
      process.env.RELEASE_VERSION,
    )
    const directory = path.resolve(
      requiredOption(options, 'directory', process.env.RELEASE_DIR),
    )
    const versionBase = `${prefix}/versions/${version}`
    for (const name of ['release-manifest.json', 'SHA256SUMS.txt']) {
      const body = await client.getObject(`${versionBase}/${name}`)
      if (!body) {
        throw new Error(`Existing release is missing ${name}`)
      }
      writeFileSync(path.join(directory, name), body)
    }
    await verifyReleaseBundle(directory)
    console.log(JSON.stringify({ ok: true, command, version }))
    return
  }

  if (command === 'upload-assets') {
    const { directory, manifest } = await loadLocalBundle(options)
    const inputs = await createImmutableInputs(directory, manifest, prefix)
    const plan = await uploadImmutableAssets(client, inputs, {
      dryRun: options.dryRun,
    })
    console.log(
      JSON.stringify({
        ok: true,
        command,
        version: manifest.version,
        dryRun: options.dryRun,
        plan,
      }),
    )
    return
  }

  const version = requiredOption(
    options,
    'version',
    process.env.RELEASE_VERSION,
  )
  if (command === 'verify-version') {
    const verified = await verifyImmutableVersion(client, {
      prefix,
      version,
      verifyEligibility: eligibilityVerifier,
    })
    if (verified.manifest.provenance.kind === 'legacy-import') {
      await verifyOptionalLegacyGithubRelease(verified.manifest)
    }
    console.log(JSON.stringify({ ok: true, command, version }))
    return
  }

  if (command === 'complete-legacy') {
    await repairLegacyReleaseChecksum(client, {
      prefix,
      version,
      dryRun: options.dryRun,
    })
    const immutable = await verifyImmutableAssets(client, { prefix, version })
    if (immutable.manifest.provenance.kind !== 'legacy-import') {
      throw new Error('complete-legacy requires legacy-import provenance')
    }
    await verifyOptionalLegacyGithubRelease(immutable.manifest)
    const ready = createLegacyReleaseReady(
      immutable.manifest,
      createHash('sha256').update(immutable.manifestBody).digest('hex'),
    )
    const channelKey = `${prefix}/${immutable.manifest.channelManifest}`
    const currentBody = await client.getObject(channelKey)
    const parsedCurrentVersion = currentBody
      ? parse(currentBody.toString())?.version
      : null
    if (currentBody && typeof parsedCurrentVersion !== 'string') {
      throw new Error(`Current channel pointer is invalid: ${channelKey}`)
    }
    const currentVersion = parsedCurrentVersion ?? null
    const promote = shouldPromoteLegacyCompletion(version, currentVersion)
    await markReleaseReady(client, ready, { prefix, dryRun: options.dryRun })
    if (promote) {
      await promoteChannel(client, {
        prefix,
        version,
        verifyEligibility: eligibilityVerifier,
        dryRun: options.dryRun,
        verifyPromotion: ({ verified }) =>
          verifyPublicRelease(prefix, version, {
            requireImmutableAssetCache:
              verified.manifest.provenance.kind === 'actions-build',
            expectedChannelBody: verified.channelBody,
          }),
        verifyRestoration: (context) =>
          verifyPublicRestorationWithOutput(prefix, context),
      })
    }
    console.log(
      JSON.stringify({
        ok: true,
        command,
        version,
        promoted: promote,
        currentVersion,
      }),
    )
    return
  }

  if (command === 'mark-ready') {
    const readyPath = path.resolve(
      requiredOption(options, 'ready', process.env.RELEASE_READY_PATH),
    )
    const ready = validateReleaseReady(
      JSON.parse(readFileSync(readyPath, 'utf8')),
    )
    if (ready.version !== version) {
      throw new Error('release-ready version does not match requested version')
    }
    await markVerifiedReleaseReady(client, ready, {
      prefix,
      dryRun: options.dryRun,
      verifyEligibility: eligibilityVerifier,
    })
    console.log(JSON.stringify({ ok: true, command, version }))
    return
  }

  if (command === 'promote') {
    const result = await promoteChannel(client, {
      prefix,
      version,
      verifyEligibility: eligibilityVerifier,
      dryRun: options.dryRun,
      verifyPromotion: ({ verified }) =>
        verifyPublicRelease(prefix, version, {
          requireImmutableAssetCache:
            verified.manifest.provenance.kind === 'actions-build',
          expectedChannelBody: verified.channelBody,
        }),
      verifyRestoration: (context) =>
        verifyPublicRestorationWithOutput(prefix, context),
    })
    writeOutputs({
      current_version: version,
      channel_manifest: result.targetKey.split('/').at(-1),
      changed: String(result.changed),
    })
    console.log(JSON.stringify({ ok: true, command, version, ...result }))
    return
  }

  if (command === 'rollback') {
    const result = await rollbackChannel(client, {
      prefix,
      targetVersion: version,
      verifyEligibility: eligibilityVerifier,
      dryRun: options.dryRun,
      verifyPromotion: ({ verified }) =>
        verifyPublicRelease(prefix, version, {
          requireImmutableAssetCache:
            verified.manifest.provenance.kind === 'actions-build',
          expectedChannelBody: verified.channelBody,
        }),
      verifyRestoration: (context) =>
        verifyPublicRestorationWithOutput(prefix, context),
    })
    writeOutputs({
      previous_version: result.previousVersion,
      target_version: version,
      manifest_sha256: result.manifestSha256,
      changed: String(result.changed),
    })
    console.log(JSON.stringify({ ok: true, command, version, ...result }))
    return
  }

  if (command === 'import-legacy') {
    const { directory, manifest } = await loadLocalBundle(options)
    if (manifest.provenance.kind !== 'legacy-import') {
      throw new Error('import-legacy requires legacy-import provenance')
    }
    const manifestBody = readFileSync(
      path.join(directory, 'release-manifest.json'),
    )
    await verifyOptionalLegacyGithubRelease(manifest)
    const inputs = await createImmutableInputs(directory, manifest, prefix)
    await uploadImmutableAssets(client, inputs, { dryRun: options.dryRun })
    if (!options.dryRun) {
      const ready = createLegacyReleaseReady(
        manifest,
        createHash('sha256').update(manifestBody).digest('hex'),
      )
      await markReleaseReady(client, ready, { prefix })
      await promoteChannel(client, {
        prefix,
        version: manifest.version,
        verifyEligibility: eligibilityVerifier,
        verifyPromotion: ({ verified }) =>
          verifyPublicRelease(prefix, manifest.version, {
            expectedChannelBody: verified.channelBody,
          }),
        verifyRestoration: (context) =>
          verifyPublicRestorationWithOutput(prefix, context),
      })
    }
    console.log(
      JSON.stringify({
        ok: true,
        command,
        version: manifest.version,
        dryRun: options.dryRun,
      }),
    )
    return
  }

  throw new Error(`Unsupported release command: ${command}`)
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  run().catch((error) => {
    console.error(
      `[release] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  })
}
