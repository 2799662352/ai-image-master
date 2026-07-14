import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { refreshDownloadPageFromChannel } from './refresh-download-page.mjs'

const realRepoRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
)

const manifest = {
  schemaVersion: 1,
  version: '4.3.98',
  channel: 'stable',
  channelManifest: 'latest.yml',
  createdAt: '2026-07-14T19:12:20.063Z',
  signing: { status: 'unsigned', subject: null },
  files: [
    {
      name: 'catimation-cyberpunk-master-4.3.98-setup.exe',
      size: 482940186,
      sha256: 'b'.repeat(64),
      sha512: 'b'.repeat(128),
    },
  ],
}

function createFetchStub(routes) {
  const requestedUrls = []
  const fetchImplementation = async (url) => {
    requestedUrls.push(url)
    const body = routes[url]
    if (body === undefined) {
      return { ok: false, status: 404, text: async () => 'not found' }
    }
    return { ok: true, status: 200, text: async () => body }
  }
  return { fetchImplementation, requestedUrls }
}

function createTempRepo() {
  const repoRoot = mkdtempSync(path.join(os.tmpdir(), 'refresh-download-'))
  mkdirSync(path.join(repoRoot, 'images'), { recursive: true })
  mkdirSync(path.join(repoRoot, 'docs', 'releases'), { recursive: true })
  writeFileSync(
    path.join(repoRoot, 'images', 'logo.svg'),
    readFileSync(path.join(realRepoRoot, 'images', 'logo.svg')),
  )
  return repoRoot
}

const baseUrl =
  'https://bucket-123.cos.ap-guangzhou.myqcloud.com/releases'

test('refreshes data.json from the promoted COS channel', async () => {
  const repoRoot = createTempRepo()
  writeFileSync(
    path.join(repoRoot, 'docs', 'releases', 'v4.3.98.md'),
    '# v4.3.98\n\n## 修复\n\n- ask_user 卡片生命周期修复\n',
  )
  const { fetchImplementation } = createFetchStub({
    [`${baseUrl}/latest.yml`]: 'version: 4.3.98\npath: whatever.exe\n',
    [`${baseUrl}/versions/4.3.98/release-manifest.json`]:
      JSON.stringify(manifest),
  })

  try {
    const data = await refreshDownloadPageFromChannel({
      bucket: 'bucket-123',
      region: 'ap-guangzhou',
      prefix: 'releases',
      repository: '2799662352/ai-image-master',
      repoRoot,
      fetchImplementation,
    })

    assert.equal(data.version, '4.3.98')
    assert.deepEqual(data.highlights, ['ask_user 卡片生命周期修复'])
    const written = JSON.parse(
      readFileSync(
        path.join(repoRoot, 'docs', 'download', 'data.json'),
        'utf8',
      ),
    )
    assert.equal(written.version, '4.3.98')
    assert.match(
      written.platform.downloadUrl,
      /catimation-cyberpunk-master-4\.3\.98-setup\.exe$/,
    )
    assert.equal(
      written.githubReleaseUrl,
      'https://github.com/2799662352/ai-image-master/releases/tag/v4.3.98',
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('tolerates a missing release notes file', async () => {
  const repoRoot = createTempRepo()
  const { fetchImplementation } = createFetchStub({
    [`${baseUrl}/latest.yml`]: 'version: 4.3.98\n',
    [`${baseUrl}/versions/4.3.98/release-manifest.json`]:
      JSON.stringify(manifest),
  })

  try {
    const data = await refreshDownloadPageFromChannel({
      bucket: 'bucket-123',
      region: 'ap-guangzhou',
      prefix: 'releases',
      repository: '2799662352/ai-image-master',
      repoRoot,
      fetchImplementation,
    })
    assert.deepEqual(data.highlights, [])
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('rejects a manifest whose version disagrees with the channel', async () => {
  const repoRoot = createTempRepo()
  const { fetchImplementation } = createFetchStub({
    [`${baseUrl}/latest.yml`]: 'version: 4.3.99\n',
    [`${baseUrl}/versions/4.3.99/release-manifest.json`]:
      JSON.stringify(manifest),
  })

  try {
    await assert.rejects(
      refreshDownloadPageFromChannel({
        bucket: 'bucket-123',
        region: 'ap-guangzhou',
        prefix: 'releases',
        repository: '2799662352/ai-image-master',
        repoRoot,
        fetchImplementation,
      }),
      /does not match channel version/,
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})

test('fails loudly when the channel endpoint is unreachable', async () => {
  const repoRoot = createTempRepo()
  const { fetchImplementation } = createFetchStub({})

  try {
    await assert.rejects(
      refreshDownloadPageFromChannel({
        bucket: 'bucket-123',
        region: 'ap-guangzhou',
        prefix: 'releases',
        repository: '2799662352/ai-image-master',
        repoRoot,
        fetchImplementation,
      }),
      /HTTP 404/,
    )
  } finally {
    rmSync(repoRoot, { recursive: true, force: true })
  }
})
