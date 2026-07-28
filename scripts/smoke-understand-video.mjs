#!/usr/bin/env node
/**
 * 烟雾测试:验证 qwen3.7-max-dashscope 的「视频理解 + 联网扒资料」是否真的可用
 * (走与出图同一条 new-api 网关)。这是回答「现在可以理解视频了吗」的实测脚本。
 *
 * 用法(PowerShell):
 *   $env:MIAU_API_KEY="sk-xxx"; node scripts/smoke-understand-video.mjs [videoUrl]
 * 用法(bash):
 *   MIAU_API_KEY=sk-xxx node scripts/smoke-understand-video.mjs [videoUrl]
 *
 * 说明:
 * - 不会打印任何密钥;只输出每项是 ✅/❌ 及模型返回的前若干字。
 * - videoUrl 必须是 DashScope 服务器(CN)可拉取的公网 URL。app 内的本机文件会
 *   自动转存到历史 COS 桶解决可达性;这里手动测时请给一个公网可达的 mp4。
 * - 默认 videoUrl 是阿里云官方文档示例视频(CN 可达);可用第一个参数覆盖。
 */

const BASE = process.env.MIAU_BASE_URL || 'https://miauapi.13797248455.xyz'
const KEY = process.env.MIAU_API_KEY
const MODEL = process.env.MIAU_UNDERSTAND_MODEL || 'qwen3.7-max-dashscope'

if (!KEY) {
  console.error('缺少 MIAU_API_KEY 环境变量。请先设置你的 Miau 令牌(脚本不会打印它)。')
  process.exit(1)
}

// 阿里云 DashScope 文档公开示例视频(CN 可达),仅用于连通性验证。
const DEFAULT_VIDEO =
  'https://help-static-aliyun-doc.aliyuncs.com/file-manage-files/zh-CN/20250328/sxhmtg/cherry.mp4'
const videoUrl = process.argv[2] || DEFAULT_VIDEO

async function call(body, label) {
  let resp
  try {
    resp = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
      body: JSON.stringify(body),
    })
  } catch (e) {
    const cause = e && typeof e === 'object' && 'cause' in e ? ` (cause: ${String(e.cause)})` : ''
    console.log(`❌ ${label}: 网络错误 — ${e instanceof Error ? e.message : String(e)}${cause}`)
    return false
  }
  const raw = await resp.text()
  if (!resp.ok) {
    console.log(`❌ ${label}: HTTP ${resp.status} ${resp.statusText}\n   ${raw.slice(0, 400)}`)
    return false
  }
  let json
  try {
    json = JSON.parse(raw)
  } catch {
    console.log(`❌ ${label}: 非 JSON 响应(可能是网关错误页)\n   ${raw.slice(0, 400)}`)
    return false
  }
  const text = json?.choices?.[0]?.message?.content
  if (typeof text !== 'string' || text.length === 0) {
    console.log(`❌ ${label}: 无可用文本\n   ${JSON.stringify(json).slice(0, 400)}`)
    return false
  }
  console.log(`✅ ${label}:\n   ${text.slice(0, 500).replace(/\n/g, '\n   ')}\n`)
  return true
}

const webBody = {
  model: MODEL,
  enable_search: true,
  messages: [{ role: 'user', content: '用一句话说一条今天的科技新闻。' }],
}

const videoBody = {
  model: MODEL,
  messages: [
    {
      role: 'user',
      content: [
        { type: 'text', text: '用一句中文描述这个视频里发生了什么。' },
        { type: 'video_url', video_url: { url: videoUrl } },
      ],
    },
  ],
}

console.log(`\n🔎 网关 ${BASE} · 模型 ${MODEL}\n   视频 URL: ${videoUrl}\n`)

const okWeb = await call(webBody, 'web_research (enable_search)')
const okVideo = await call(videoBody, 'understand_video')

console.log('—'.repeat(40))
console.log(`web_research:   ${okWeb ? '可用 ✅' : '失败 ❌'}`)
console.log(`understand_video: ${okVideo ? '可用 ✅(模型确实能收视频)' : '失败 ❌(看上面的错误)'}`)
process.exit(okVideo ? 0 : 2)
