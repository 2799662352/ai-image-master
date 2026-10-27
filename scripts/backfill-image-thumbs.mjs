#!/usr/bin/env node
/**
 * backfill-image-thumbs — 给 image-history 里的老图补数据万象持久化缩略图。
 *
 * 2026-09-15 起主进程上传原图时带 `Pic-Operations`,万象顺手把 512 / 1024 两档
 * WebP 存成桶里的独立对象(`<key>.thumb512.webp` / `.thumb1024.webp`,见
 * src/main/services/tencent/cosThumbRules.ts);读侧把这个对象放在候选链最前面。
 * 改动之前上传的图(以及老版本客户端还会继续上传的图)没有这两个对象,读侧会先
 * 吃一个 404 再回落到实时 imageMogr2。这个脚本用 `POST /<key>?image_process`
 * (云上数据处理)把它们一次补齐。可以重复跑:已存在的缩略图会跳过。
 *
 * 用法:
 *   node scripts/backfill-image-thumbs.mjs --dry-run              只统计,不写
 *   node scripts/backfill-image-thumbs.mjs                        补齐全部缺失
 *   node scripts/backfill-image-thumbs.mjs --concurrency 8 --limit 200
 *   node scripts/backfill-image-thumbs.mjs --clean-probes         顺手删掉 image-history/_probe/ 下的探针对象
 *   node scripts/backfill-image-thumbs.mjs --clean-probes --skip-backfill   只清探针 + 看统计,不补图
 *
 * 读侧有一道日期闸(renderer/utils/cosThumb.ts `PERSISTED_THUMBS_SINCE`):只对该日期
 * 之后上传的原图去找持久化对象。回填完历史后把那个常量往前挪(或清空)才会真正用上。
 *
 * 需要 .env 里的 COS_SECRET_ID / COS_SECRET_KEY(永久密钥;STS 票据也放行 image_process,
 * 但列举桶需要 GetBucket 权限,所以这里用永久密钥)。
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..')
try {
  require('dotenv').config({ path: path.join(REPO_ROOT, '.env') })
} catch {
  // dotenv 可选 —— 环境变量直接给也行。
}
const COS = require('cos-nodejs-sdk-v5')

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const dryRun = flag('--dry-run')
const cleanProbes = flag('--clean-probes')
/** 只清探针 / 只看统计,不发任何 image_process。 */
const skipBackfill = flag('--skip-backfill')
const concurrency = Math.max(1, Number(opt('--concurrency', '6')) || 6)
const limit = Number(opt('--limit', '0')) || 0
const Prefix = opt('--prefix', 'image-history/')

const SecretId = process.env.COS_SECRET_ID
const SecretKey = process.env.COS_SECRET_KEY
const Bucket = process.env.COS_IMAGE_HISTORY_BUCKET || 'image-master-1345773498'
const Region = process.env.COS_IMAGE_HISTORY_REGION || 'ap-guangzhou'
if (!SecretId || !SecretKey) {
  console.error('❌ Missing COS_SECRET_ID / COS_SECRET_KEY (export them or put them in .env).')
  process.exit(1)
}
const Proxy = process.env.COS_PROXY || process.env.HTTPS_PROXY || process.env.https_proxy || undefined
const cos = new COS({ SecretId, SecretKey, Protocol: 'https:', Timeout: 60000, ...(Proxy ? { Proxy } : {}) })

// 与 cosThumbRules.ts 保持一致 —— 改了两边一起改。
const SIZES = [512, 1024]
const thumbRule = (edge) => `imageMogr2/thumbnail/${edge}x${edge}>/format/webp/quality/85`
const thumbKey = (key, size) => `${key.slice(0, key.lastIndexOf('.'))}.thumb${size}.webp`
const ORIGINAL = /^image-history\/\d{4}\/\d{2}\/\d{2}\/[^/]+\.(png|jpe?g|webp|gif|bmp|tiff?|avif|heic|heif)$/i
const CI_MAX_BYTES = 32 * 1024 * 1024 // 官方限制:原图 ≤ 32 MB

const call = (method, params) => new Promise((res, rej) => cos[method]({ Bucket, Region, ...params }, (e, d) => (e ? rej(e) : res(d))))

async function listAll(prefix) {
  const keys = new Map() // key → size
  let Marker
  for (;;) {
    const data = await call('getBucket', { Prefix: prefix, MaxKeys: 1000, ...(Marker ? { Marker } : {}) })
    for (const o of data.Contents ?? []) keys.set(o.Key, Number(o.Size))
    if (data.IsTruncated !== 'true' || !data.NextMarker) break
    Marker = data.NextMarker
  }
  return keys
}

async function imageProcess(key, rules) {
  return new Promise((res, rej) =>
    cos.request(
      { Bucket, Region, Key: key, Method: 'POST', Action: 'image_process', Headers: { 'Pic-Operations': JSON.stringify({ rules }) } },
      (e, d) => (e ? rej(e) : res(d)),
    ),
  )
}

async function pool(items, worker) {
  let next = 0
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      await worker(items[i], i)
    }
  })
  await Promise.all(runners)
}

const started = Date.now()
console.log(`📦 listing ${Bucket}/${Prefix} …`)
const objects = await listAll(Prefix)
const originals = [...objects.keys()].filter((k) => ORIGINAL.test(k) && !k.includes('/_probe/'))
const work = []
let complete = 0
let tooBig = 0
let workBytes = 0
for (const key of originals) {
  const missing = SIZES.filter((s) => !objects.has(thumbKey(key, s)))
  if (missing.length === 0) {
    complete++
    continue
  }
  if ((objects.get(key) ?? 0) > CI_MAX_BYTES) {
    tooBig++
    continue
  }
  work.push({ key, missing })
  workBytes += objects.get(key) ?? 0
}
const todo = limit > 0 ? work.slice(0, limit) : work
const gb = (n) => (n / 1024 / 1024 / 1024).toFixed(1)
console.log(
  `   ${objects.size} objects · ${originals.length} originals · ${complete} already complete · ${work.length} to backfill (${gb(workBytes)} GB of originals to process)` +
    `${tooBig ? ` · ${tooBig} skipped (>32MB)` : ''}${limit ? ` · limited to ${todo.length}` : ''}`,
)

if (cleanProbes) {
  const probes = [...objects.keys()].filter((k) => k.includes('/_probe/'))
  if (probes.length) {
    console.log(`🧹 ${dryRun ? 'would delete' : 'deleting'} ${probes.length} probe object(s) under ${Prefix}_probe/`)
    if (!dryRun) await call('deleteMultipleObject', { Objects: probes.map((Key) => ({ Key })) })
  }
}

if (dryRun) {
  console.log('🔍 dry-run — nothing written.')
  process.exit(0)
}
if (skipBackfill) {
  console.log('⏭  --skip-backfill — no image_process issued.')
  process.exit(0)
}

let ok = 0
let failed = 0
let bytesIn = 0
await pool(todo, async ({ key, missing }, i) => {
  const t = Date.now()
  try {
    await imageProcess(key, missing.map((size) => ({ fileid: `/${thumbKey(key, size)}`, rule: thumbRule(size) })))
    ok++
    bytesIn += objects.get(key) ?? 0
    if (ok % 25 === 0 || i === todo.length - 1) {
      console.log(`   ${ok}/${todo.length} done · last ${Date.now() - t} ms · ${((Date.now() - started) / 1000).toFixed(0)} s elapsed`)
    }
  } catch (e) {
    failed++
    console.warn(`   ✗ ${key}: ${e?.code ?? e?.statusCode ?? ''} ${e?.message ?? e}`)
  }
})
console.log(
  `✅ backfilled ${ok} · failed ${failed} · processed ${(bytesIn / 1024 / 1024).toFixed(0)} MB of originals in ${((Date.now() - started) / 1000).toFixed(0)} s`,
)
process.exit(failed ? 2 : 0)
