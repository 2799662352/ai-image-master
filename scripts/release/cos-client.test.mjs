import assert from 'node:assert/strict'
import test from 'node:test'

import { CosClientAdapter } from './cos-client.mjs'

function adapterWithCos(cos) {
  const adapter = new CosClientAdapter({
    secretId: 'id',
    secretKey: 'key',
    bucket: 'bucket-123',
    region: 'ap-test',
    prefix: 'releases',
  })
  adapter.cos = cos
  return adapter
}

test('lists all paginated COS release versions', async () => {
  const calls = []
  const adapter = adapterWithCos({
    async getBucket(params) {
      calls.push(params)
      if (!params.Marker) {
        return {
          IsTruncated: 'true',
          NextMarker: 'page-2',
          CommonPrefixes: [{ Prefix: 'releases/versions/4.3.95/' }],
        }
      }
      return {
        IsTruncated: 'false',
        CommonPrefixes: [{ Prefix: 'releases/versions/4.3.96/' }],
      }
    },
  })

  assert.deepEqual(await adapter.listVersions(), ['4.3.95', '4.3.96'])
  assert.equal(calls[1].Marker, 'page-2')
})

test('fails closed when COS truncates without a continuation marker', async () => {
  const adapter = adapterWithCos({
    async getBucket() {
      return {
        IsTruncated: true,
        CommonPrefixes: [],
      }
    },
  })

  await assert.rejects(
    () => adapter.listVersions(),
    /truncated without NextMarker/,
  )
})
