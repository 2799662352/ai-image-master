#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

import { parse } from 'yaml'

export function expectedCosUpdateUrl({ bucket, region, prefix }) {
  if (!bucket || !region || !prefix) {
    throw new Error('COS_BUCKET, COS_REGION, and COS_PREFIX are required')
  }
  const normalizedPrefix = prefix.replace(/^\/+|\/+$/g, '')
  return `https://${bucket}.cos.${region}.myqcloud.com/${normalizedPrefix}/`
}

export function validateUpdateUrls({ expected, builder, runtime }) {
  if (builder !== expected) {
    throw new Error(
      `electron-builder updater URL does not match production COS URL: ${builder}`,
    )
  }
  if (runtime !== expected) {
    throw new Error(
      `Runtime updater URL does not match production COS URL: ${runtime}`,
    )
  }
  return true
}

function runCli() {
  const repoRoot = process.cwd()
  const builderConfig = parse(
    readFileSync(path.join(repoRoot, 'electron-builder.yml'), 'utf8'),
  )
  const genericProvider = builderConfig.publish?.find(
    (provider) => provider.provider === 'generic',
  )
  const runtimeSource = readFileSync(
    path.join(repoRoot, 'src', 'main', 'index.ts'),
    'utf8',
  )
  const runtimeMatch = runtimeSource.match(
    /url:\s*['"](https:\/\/[^'"]+\/releases\/)['"]/,
  )
  if (!genericProvider?.url || !runtimeMatch) {
    throw new Error('Unable to resolve configured updater URLs')
  }
  const expected = expectedCosUpdateUrl({
    bucket: process.env.COS_BUCKET,
    region: process.env.COS_REGION,
    prefix: process.env.COS_PREFIX,
  })
  validateUpdateUrls({
    expected,
    builder: genericProvider.url,
    runtime: runtimeMatch[1],
  })
  console.log(JSON.stringify({ ok: true, updaterUrl: expected }))
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
) {
  try {
    runCli()
  } catch (error) {
    console.error(
      `[update-url] ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exitCode = 1
  }
}
