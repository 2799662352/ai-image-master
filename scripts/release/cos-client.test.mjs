import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import test from 'node:test'

import { CosClientAdapter, describeCosError } from './cos-client.mjs'

// 用 SDK 自己的 util.error 构造输入,而不是凭印象手写错误对象:
// 它会把「没有 .error 字段的 Error 实例」换成一个新的普通对象 { code, name, message }
// (传输层错误、没有 XML 错误体的 HTTP 错误都走这条路),String() 之后就是 [object Object]。
const sdkUtil = createRequire(import.meta.url)('cos-nodejs-sdk-v5/sdk/util.js')

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

test('describes a transport failure that the SDK turned into a plain object', () => {
  const sdkError = sdkUtil.error(
    Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' }),
  )

  // 这正是 4.9.17 首次发版预检里的症状:不是 Error 实例,String() 只剩 [object Object]
  assert.equal(sdkError instanceof Error, false)
  assert.equal(String(sdkError), '[object Object]')

  const text = describeCosError(sdkError)
  assert.match(text, /ECONNRESET/)
  assert.match(text, /read ECONNRESET/)
  assert.doesNotMatch(text, /\[object Object\]/)
})

test('describes an HTTP failure without an XML body (e.g. a gateway 503)', () => {
  const sdkError = sdkUtil.error(new Error('Service Unavailable'), {
    code: '503',
  })

  assert.equal(String(sdkError), '[object Object]')
  const text = describeCosError(sdkError)
  assert.match(text, /503/)
  assert.match(text, /Service Unavailable/)
})

test('keeps the code and message of a real Error without repeating them', () => {
  const sdkError = sdkUtil.error(new Error('Access Denied.'), {
    code: 'AccessDenied',
    error: { Code: 'AccessDenied', Message: 'Access Denied.' },
  })

  assert.equal(sdkError instanceof Error, true)
  assert.equal(describeCosError(sdkError), 'AccessDenied: Access Denied.')

  // 消息里已经带着 code 时不再重复
  assert.equal(
    describeCosError(Object.assign(new Error('ECONNRESET: boom'), { code: 'ECONNRESET' })),
    'ECONNRESET: boom',
  )
  // 没有 code 的普通 Error 原样返回消息(行为与改动前一致)
  assert.equal(describeCosError(new Error('plain failure')), 'plain failure')
})

test('adds request context but never the query string or headers', () => {
  // _submitRequest 在回调前会把 statusCode / headers / url / method 补到错误对象上
  const sdkError = Object.assign(
    sdkUtil.error(
      Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' }),
    ),
    {
      statusCode: 200,
      method: 'GET',
      url: 'https://bucket-123.cos.ap-test.myqcloud.com/releases/app-4.3.95-setup.exe?q-sign-algorithm=sha1&q-signature=SECRET',
      headers: { authorization: 'SECRET-HEADER' },
    },
  )

  const text = describeCosError(sdkError)
  assert.match(text, /ECONNRESET/)
  assert.match(text, /GET/)
  assert.match(text, /\/releases\/app-4\.3\.95-setup\.exe/)
  assert.match(text, /HTTP 200/)
  assert.doesNotMatch(text, /q-signature|SECRET|authorization/i)
})

test('falls back safely for values that are not COS errors', () => {
  assert.equal(describeCosError('already a string'), 'already a string')
  assert.equal(describeCosError(undefined), 'unknown error')
  assert.equal(describeCosError(null), 'unknown error')
  assert.equal(describeCosError(42), '42')

  // 没有 message / code 的对象:只列字段名,不倾倒字段值(可能含头信息)
  const opaque = describeCosError({ headers: { authorization: 'SECRET' }, foo: 1 })
  assert.match(opaque, /headers/)
  assert.match(opaque, /foo/)
  assert.doesNotMatch(opaque, /SECRET/)

  // 循环引用不能让错误描述本身再抛错
  const cyclic = {}
  cyclic.self = cyclic
  assert.doesNotThrow(() => describeCosError(cyclic))
})

test('truncates very long messages', () => {
  const text = describeCosError(new Error('x'.repeat(5000)))
  assert.ok(text.length <= 400, `unexpected length ${text.length}`)
  assert.match(text, /…$/)
})

test('cos-release.mjs reports COS failures through describeCosError', () => {
  // 守卫:这三处都会接到 COS SDK 的错误对象,不能再退回 String(error)
  const source = readFileSync(new URL('./cos-release.mjs', import.meta.url), 'utf8')
  assert.match(source, /import \{[^}]*describeCosError[^}]*\} from '\.\/cos-client\.mjs'/)
  assert.doesNotMatch(source, /String\((error|lastError)\)/)
  assert.ok(
    (source.match(/describeCosError\(/g) ?? []).length >= 3,
    'status warning, restoration retry and the top-level handler must all use describeCosError',
  )
})
