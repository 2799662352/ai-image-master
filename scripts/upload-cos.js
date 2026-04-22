#!/usr/bin/env node
/**
 * 将 electron-builder 产物上传到腾讯云 COS（热更新加速）
 *
 * 用法：node scripts/upload-cos.js
 * 环境变量：COS_SECRET_ID, COS_SECRET_KEY, COS_BUCKET, COS_REGION（也可从 .env 读取）
 */
const path = require('path')
const fs = require('fs')

try { require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') }) } catch {}

const COS = require('cos-nodejs-sdk-v5')

const SecretId = process.env.COS_SECRET_ID
const SecretKey = process.env.COS_SECRET_KEY
const Bucket = process.env.COS_BUCKET || 'map-tiles-bucket-1345773498'
const Region = process.env.COS_REGION || 'ap-guangzhou'
const COS_PREFIX = 'releases/'

if (!SecretId || !SecretKey) {
  console.error('缺少 COS_SECRET_ID / COS_SECRET_KEY 环境变量')
  process.exit(1)
}

const cos = new COS({ SecretId, SecretKey })

const pkg = require(path.resolve(__dirname, '..', 'package.json'))
const version = pkg.version
const releaseDir = path.resolve(__dirname, '..', 'release')

const files = [
  `catimation-cyberpunk-master-${version}-setup.exe`,
  `catimation-cyberpunk-master-${version}-setup.exe.blockmap`,
  'latest.yml',
]

async function upload(fileName) {
  const filePath = path.join(releaseDir, fileName)
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠ 跳过：${fileName}（文件不存在）`)
    return
  }

  const stat = fs.statSync(filePath)
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
  console.log(`⬆ 上传 ${fileName}（${sizeMB} MB）...`)

  const start = Date.now()
  await new Promise((resolve, reject) => {
    cos.sliceUploadFile(
      {
        Bucket,
        Region,
        Key: COS_PREFIX + fileName,
        FilePath: filePath,
        onProgress(info) {
          const pct = (info.percent * 100).toFixed(1)
          const speed = (info.speed / 1024 / 1024).toFixed(1)
          process.stdout.write(`\r  ${pct}%  ${speed} MB/s`)
        },
      },
      (err, data) => (err ? reject(err) : resolve(data))
    )
  })

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`\n✓ ${fileName} — ${elapsed}s`)
}

;(async () => {
  console.log(`\n📦 CATIMATION v${version} → COS ${Bucket}/${COS_PREFIX}\n`)

  for (const f of files) {
    await upload(f)
  }

  const url = `https://${Bucket}.cos.${Region}.myqcloud.com/${COS_PREFIX}latest.yml`
  console.log(`\n✅ 全部上传完成`)
  console.log(`🔗 更新检查地址：${url}\n`)
})()
