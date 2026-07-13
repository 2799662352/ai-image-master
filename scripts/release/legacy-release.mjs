#!/usr/bin/env node

import {
  createWriteStream,
  mkdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import path from 'node:path'
import { Readable } from 'node:stream'

import { parse } from 'yaml'

import {
  discoverWindowsArtifacts,
  verifyUpdaterManifest,
} from './artifact-contract.mjs'
import {
  channelManifestName,
  deriveReleaseChannel,
  parseReleaseVersion,
} from './release-contract.mjs'

function requiredEnvironment(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Missing required environment variable ${name}`)
  return value
}

async function fetchRequired(url) {
  const response = await fetch(url, { cache: 'no-store' })
  if (!response.ok) {
    throw new Error(`Legacy release download returned ${response.status}`)
  }
  return response
}

async function downloadFile(url, filePath) {
  const response = await fetchRequired(url)
  if (!response.body) throw new Error('Legacy release response has no body')
  await new Promise((resolve, reject) => {
    const input = Readable.fromWeb(response.body)
    const output = createWriteStream(filePath, { flags: 'wx' })
    input.once('error', reject)
    output.once('error', reject)
    output.once('finish', resolve)
    input.pipe(output)
  })
}

async function run() {
  const version = parseReleaseVersion(requiredEnvironment('RELEASE_VERSION'))
  const directory = path.resolve(requiredEnvironment('RELEASE_DIR'))
  const prefix = requiredEnvironment('COS_PREFIX').replace(/^\/+|\/+$/g, '')
  const publicBase =
    process.env.COS_PUBLIC_BASE_URL ||
    `https://${requiredEnvironment('COS_BUCKET')}.cos.${requiredEnvironment('COS_REGION')}.myqcloud.com/${prefix}/`
  const channelManifest = channelManifestName(deriveReleaseChannel(version))
  const channelUrl = new URL(channelManifest, publicBase)
  channelUrl.searchParams.set('migration', process.env.GITHUB_RUN_ID ?? 'local')
  const channelText = await (await fetchRequired(channelUrl)).text()
  const updaterManifest = parse(channelText)
  if (updaterManifest?.version !== version || !updaterManifest?.path) {
    throw new Error('Legacy channel manifest does not match the requested version')
  }

  const executable = path.basename(updaterManifest.path)
  rmSync(directory, { recursive: true, force: true })
  mkdirSync(directory, { recursive: true })
  writeFileSync(path.join(directory, channelManifest), channelText)
  await downloadFile(
    new URL(executable, publicBase),
    path.join(directory, executable),
  )
  await downloadFile(
    new URL(`${executable}.blockmap`, publicBase),
    path.join(directory, `${executable}.blockmap`),
  )
  const artifacts = discoverWindowsArtifacts(directory, version)
  await verifyUpdaterManifest(directory, artifacts, version)
  console.log(
    JSON.stringify({
      ok: true,
      version,
      sourceKey: `${prefix}/${channelManifest}`,
      executable,
    }),
  )
}

run().catch((error) => {
  console.error(
    `[legacy-release] ${error instanceof Error ? error.message : String(error)}`,
  )
  process.exitCode = 1
})
