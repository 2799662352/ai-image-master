#!/usr/bin/env node
/**
 * 端到端验证「本机视频 → COS → qwen 视频理解」整条链路(复刻 app 内 mediaRelay
 * + understand_video 的真实生产路径)。
 *
 * 用法(PowerShell):
 *   $env:MIAU_API_KEY="sk-xxx"; node scripts/understand-local-video.mjs "C:\path\to\clip.mp4" ["问题"]
 *
 * 步骤:
 *   1) 向 SCF STS 端点取 30 分钟临时凭证(只授权 image-history/* PutObject,无需密钥)。
 *   2) 用临时凭证把本机文件 PutObject 到历史桶 image-history/media-relay/*,拿公网 URL。
 *   3) 用该公网 URL 调网关 /v1/chat/completions(qwen3.7-max-dashscope, video_url)。
 * 不打印任何密钥。
 */

import { createRequire } from 'node:module'
import { promises as fs } from 'node:fs'
import { randomBytes } from 'node:crypto'
import path from 'node:path'

const require = createRequire(import.meta.url)
const COS = require('cos-nodejs-sdk-v5')

const KEY = process.env.MIAU_API_KEY
const BASE = process.env.MIAU_BASE_URL || 'https://miauapi.13797248455.xyz'
const MODEL = process.env.MIAU_UNDERSTAND_MODEL || 'qwen3.7-max-dashscope'
const STS_ENDPOINT =
  process.env.COS_STS_ENDPOINT || 'https://1345773498-bfu1wpfnrt.ap-guangzhou.tencentscf.com'
const BUCKET = 'image-master-1345773498'
const REGION = 'ap-guangzhou'

const EXT_MIME = { mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/mp4' }

if (!KEY) {
  console.error('缺少 MIAU_API_KEY 环境变量(脚本不会打印它)。')
  process.exit(1)
}
const localPath = process.argv[2]
if (!localPath) {
  console.error('用法: node scripts/understand-local-video.mjs <本机视频路径> [问题]')
  process.exit(1)
}
const question = process.argv[3] || '用中文详细描述这个视频里发生了什么:画面、动作、字幕、整体风格。'

async function getSts() {
  const headers = { 'Content-Type': 'application/json' }
  if (process.env.COS_STS_APP_TOKEN) headers['X-App-Token'] = process.env.COS_STS_APP_TOKEN
  const res = await fetch(STS_ENDPOINT, { method: 'POST', headers })
  if (!res.ok) throw new Error(`STS 端点 HTTP ${res.status}`)
  const data = await res.json()
  const c = data?.credentials
  if (!c?.tmpSecretId || !c?.tmpSecretKey || !c?.sessionToken) {
    throw new Error(`STS 响应缺凭证${data?.error ? ': ' + data.error : ''}`)
  }
  return c
}

function relayKey(ext) {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `image-history/media-relay/${y}/${m}/${day}/${randomBytes(8).toString('hex')}.${ext}`
}

async function uploadToCos(buf, ext, creds) {
  const cos = new COS({
    Protocol: 'https:',
    Timeout: 120000,
    getAuthorization: (_o, cb) =>
      cb({
        TmpSecretId: creds.tmpSecretId,
        TmpSecretKey: creds.tmpSecretKey,
        SecurityToken: creds.sessionToken,
        StartTime: Math.floor(Date.now() / 1000),
        ExpiredTime: Math.floor(Date.now() / 1000) + 1800,
      }),
  })
  const Key = relayKey(ext)
  await new Promise((resolve, reject) =>
    cos.putObject(
      { Bucket: BUCKET, Region: REGION, Key, Body: buf, ContentType: EXT_MIME[ext] || 'video/mp4' },
      (err) => (err ? reject(err) : resolve()),
    ),
  )
  return `https://${BUCKET}.cos.${REGION}.myqcloud.com/${Key}`
}

async function understandVideo(url) {
  const body = {
    model: MODEL,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: question },
          { type: 'video_url', video_url: { url } },
        ],
      },
    ],
  }
  const resp = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const raw = await resp.text()
  if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText}: ${raw.slice(0, 400)}`)
  const json = JSON.parse(raw)
  const text = json?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || !text) throw new Error(`无文本: ${raw.slice(0, 400)}`)
  return text
}

;(async () => {
  const ext = (path.extname(localPath).slice(1) || 'mp4').toLowerCase()
  console.log(`\n📹 ${localPath}`)
  const buf = await fs.readFile(localPath)
  console.log(`   ${(buf.byteLength / 1048576).toFixed(2)} MB · ${EXT_MIME[ext] || 'video/mp4'}`)

  console.log('① 取 STS 临时凭证…')
  const creds = await getSts()
  console.log('② 上传到历史 COS 桶…')
  const url = await uploadToCos(buf, ext, creds)
  console.log(`   ✓ 公网 URL: ${url}`)

  console.log(`③ qwen 视频理解(${MODEL})…`)
  // 瞬时掉线自动重试一次
  let text
  for (let i = 1; i <= 2; i++) {
    try {
      text = await understandVideo(url)
      break
    } catch (e) {
      if (i === 2) throw e
      console.log(`   ⚠ 第 ${i} 次失败,重试: ${e instanceof Error ? e.message : String(e)}`)
      await new Promise((r) => setTimeout(r, 800))
    }
  }
  console.log('\n———— 理解结果 ————\n' + text + '\n')
})().catch((e) => {
  console.error('❌ 失败:', e instanceof Error ? e.message : String(e))
  process.exit(2)
})
