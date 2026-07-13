import assert from 'node:assert/strict'
import test from 'node:test'

import {
  expectedCosUpdateUrl,
  validateUpdateUrls,
} from './update-url-contract.mjs'

test('builds and validates the one canonical COS updater URL', () => {
  const expected = expectedCosUpdateUrl({
    bucket: 'bucket-123',
    region: 'ap-guangzhou',
    prefix: '/releases/',
  })
  assert.equal(
    expected,
    'https://bucket-123.cos.ap-guangzhou.myqcloud.com/releases/',
  )
  assert.equal(
    validateUpdateUrls({
      expected,
      builder: expected,
      runtime: expected,
    }),
    true,
  )
  assert.throws(
    () =>
      validateUpdateUrls({
        expected,
        builder: expected,
        runtime: 'https://wrong.example/releases/',
      }),
    /runtime/i,
  )
})
