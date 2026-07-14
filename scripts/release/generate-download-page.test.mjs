import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  buildDownloadPageData,
  writeDownloadPageBundle,
} from './generate-download-page.mjs'

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

const manifest = {
  schemaVersion: 1,
  version: '4.3.96',
  channel: 'stable',
  channelManifest: 'latest.yml',
  createdAt: '2026-07-14T00:19:21.000Z',
  signing: { status: 'unsigned', subject: null },
  files: [
    {
      name: 'catimation-cyberpunk-master-4.3.96-setup.exe',
      size: 483000907,
      sha256: '0e60a6e046639b0d73d1670952b52446b32daac658191b4948c9030441fa8b90',
      sha512: 'a'.repeat(128),
    },
  ],
  provenance: {
    kind: 'actions-build',
    repository: '2799662352/ai-image-master',
    workflow: '.github/workflows/release.yml',
    runId: '1',
    runAttempt: 1,
    commitSha: 'a'.repeat(40),
    builtAt: '2026-07-14T00:19:21.000Z',
    tools: { node: '20', pnpm: '10', electronBuilder: '26' },
  },
}

test('builds download metadata from release manifest and notes', () => {
  const data = buildDownloadPageData({
    manifest,
    cosBaseUrl:
      'https://bucket-123.cos.ap-guangzhou.myqcloud.com/releases/',
    githubReleaseUrl:
      'https://github.com/2799662352/ai-image-master/releases/tag/v4.3.96',
    releaseNotesMarkdown: `# v4.3.96

## 发布可靠性

- CI 统一使用阻断式质量门禁
- Windows 安装包只构建一次
`,
    repository: '2799662352/ai-image-master',
  })

  assert.equal(data.version, '4.3.96')
  assert.equal(data.platform.sizeLabel, '460.6 MB')
  assert.match(
    data.platform.downloadUrl,
    /catimation-cyberpunk-master-4\.3\.96-setup\.exe$/,
  )
  assert.equal(data.hotUpdateUrl, 'https://bucket-123.cos.ap-guangzhou.myqcloud.com/releases/latest.yml')
  assert.deepEqual(data.highlights.slice(0, 2), [
    'CI 统一使用阻断式质量门禁',
    'Windows 安装包只构建一次',
  ])
})

test('writes data.json and copies logo assets', () => {
  const tempRoot = mkdtempSync(path.join(os.tmpdir(), 'download-page-'))
  const outputDirectory = path.join(tempRoot, 'docs', 'download')

  try {
    writeDownloadPageBundle({
      data: buildDownloadPageData({
        manifest,
        cosBaseUrl:
          'https://bucket-123.cos.ap-guangzhou.myqcloud.com/releases/',
        githubReleaseUrl:
          'https://github.com/2799662352/ai-image-master/releases/tag/v4.3.96',
        repository: '2799662352/ai-image-master',
      }),
      outputDirectory,
      repoRoot,
    })

    const written = JSON.parse(
      readFileSync(path.join(outputDirectory, 'data.json'), 'utf8'),
    )
    assert.equal(written.version, '4.3.96')
    assert.match(
      readFileSync(path.join(outputDirectory, 'assets', 'logo.svg'), 'utf8'),
      /<svg/,
    )
  } finally {
    rmSync(tempRoot, { recursive: true, force: true })
  }
})
