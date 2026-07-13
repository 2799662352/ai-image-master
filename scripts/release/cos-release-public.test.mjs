import assert from 'node:assert/strict'
import test from 'node:test'

import { stringify } from 'yaml'

import { verifyPublicRelease } from './cos-release.mjs'

test('verifies the exact public channel body, cache headers, and assets', async (t) => {
  const originalFetch = globalThis.fetch
  const originalBase = process.env.COS_PUBLIC_BASE_URL
  t.after(() => {
    globalThis.fetch = originalFetch
    if (originalBase === undefined) delete process.env.COS_PUBLIC_BASE_URL
    else process.env.COS_PUBLIC_BASE_URL = originalBase
  })
  process.env.COS_PUBLIC_BASE_URL = 'https://updates.example/releases/'
  const body = Buffer.from(
    stringify({
      version: '4.3.96',
      files: [
        {
          url: 'catimation-cyberpunk-master-4.3.96-setup.exe',
          sha512: 'hash',
          size: 123,
        },
      ],
      path: 'catimation-cyberpunk-master-4.3.96-setup.exe',
      sha512: 'hash',
    }),
  )
  const requests = []
  globalThis.fetch = async (input, options = {}) => {
    const url = new URL(input)
    requests.push({ url, method: options.method ?? 'GET' })
    if (url.pathname.endsWith('/latest.yml')) {
      return new Response(body, {
        status: 200,
        headers: {
          'cache-control': 'no-cache, max-age=0, must-revalidate',
        },
      })
    }
    return new Response(null, {
      status: 200,
      headers: {
        'cache-control': 'public, max-age=31536000, immutable',
      },
    })
  }

  assert.equal(
    await verifyPublicRelease('releases', '4.3.96', {
      expectedChannelBody: body,
      requireImmutableAssetCache: true,
    }),
    'latest.yml',
  )
  assert.equal(requests.filter((request) => request.method === 'HEAD').length, 2)
  await assert.rejects(
    () =>
      verifyPublicRelease('releases', '4.3.96', {
        expectedChannelBody: Buffer.from('different'),
      }),
    /content does not match/,
  )
})
