// scripts/test-cos-ref.mjs
//
// 端到端验证:把一张 COS 历史图 URL 当参考图,发给 gpt-image-2(edits 端点),
// 看是否能生成成功。完全复刻 app 里 `makeGptImage2FormDataRequest` 的请求形状:
//   POST {BASE}/v1/images/edits  (multipart/form-data)
//   fields: model, prompt, size, [quality], image[]=<blob>
//   header: Authorization: Bearer <KEY>
//
// 为什么用脚本而不是在 app 里点:绕开 UI 时序 / store 取值,直接证明
// 「COS URL → gpt-image-2 生成」这条链路本身通不通。脚本在 Node 里 fetch
// COS(无 CORS 限制),拿到字节再以 multipart 文件发出 —— 和 app 渲染进程
// convertToBlob 拿到 blob 后做的事一模一样。
//
// 用法(PowerShell):
//   $env:APIYI_KEY="sk-xxxx"; node scripts/test-cos-ref.mjs
//   $env:APIYI_KEY="sk-xxxx"; node scripts/test-cos-ref.mjs "<其它图URL>" "<提示词>"
//
// 取 KEY:app DevTools 控制台运行 `localStorage.getItem('api_key_apiyi')`
// (或当前站点对应的 `api_key_<site>`),复制粘到 APIYI_KEY。
//
// 需 Node 18+(全局 fetch / FormData / Blob)。

import { writeFile, mkdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

const KEY = process.env.APIYI_KEY || process.env.API_KEY
const BASE = process.env.API_BASE || 'https://api.apiyi.com'
const MODEL = process.env.MODEL || 'gpt-image-2-vip'
const COS_URL =
  process.argv[2] ||
  'https://image-master-1345773498.cos.ap-guangzhou.myqcloud.com/image-history/2026/06/06/cee7cf97c08091ca.png'
const PROMPT = process.argv[3] || '保持主体不变,把背景换成柔和的纯色棚拍'
const SIZE = process.env.SIZE || '2048x2048'

function log(...a) {
  console.log('[test-cos-ref]', ...a)
}

async function main() {
  if (!KEY) {
    console.error(
      '✗ 缺少 API Key。请先设置:  $env:APIYI_KEY="sk-..."  然后重跑。\n' +
        '  (在 app DevTools 控制台执行 localStorage.getItem("api_key_apiyi") 复制)',
    )
    process.exit(2)
  }

  // ── 1) Node 端抓取 COS 图(无 CORS) ──────────────────────────
  log('① 抓取 COS 图:', COS_URL)
  const t0 = Date.now()
  let imgBlob
  try {
    const r = await fetch(COS_URL)
    if (!r.ok) {
      console.error(`✗ COS 抓取失败:HTTP ${r.status}`)
      process.exit(1)
    }
    imgBlob = await r.blob()
    log(
      `   ok:${imgBlob.type || '(no type)'} ${(imgBlob.size / 1024).toFixed(0)}KB,耗时 ${Date.now() - t0}ms`,
    )
  } catch (e) {
    console.error('✗ COS 抓取异常:', e?.message || e)
    process.exit(1)
  }

  // ── 2) 复刻 app 的 multipart edits 请求 ─────────────────────
  const editUrl = `${BASE}/v1/images/edits`
  const form = new FormData()
  form.append('model', MODEL)
  form.append('prompt', PROMPT)
  if (SIZE && SIZE !== 'auto') form.append('size', SIZE)
  form.append('image[]', imgBlob, 'image0.png')

  log('② 发送 edits 请求:', editUrl)
  log(`   model=${MODEL} size=${SIZE} prompt="${PROMPT}"`)
  const t1 = Date.now()
  let resp
  try {
    resp = await fetch(editUrl, {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}` },
      body: form,
    })
  } catch (e) {
    console.error('✗ 请求异常(网络/超时):', e?.message || e)
    process.exit(1)
  }

  const elapsed = ((Date.now() - t1) / 1000).toFixed(1)
  log(`③ 响应:HTTP ${resp.status},耗时 ${elapsed}s`)

  const text = await resp.text()
  if (!resp.ok) {
    console.error('✗ 生成失败,响应体:')
    console.error(text.slice(0, 4000))
    process.exit(1)
  }

  let data
  try {
    data = JSON.parse(text)
  } catch {
    console.error('✗ 响应不是 JSON,前 2000 字:')
    console.error(text.slice(0, 2000))
    process.exit(1)
  }

  // ── 3) 解析 + 落盘结果图 ────────────────────────────────────
  const item = Array.isArray(data?.data) ? data.data[0] : undefined
  if (item?.b64_json) {
    const buf = Buffer.from(item.b64_json, 'base64')
    const outDir = join(__dirname, 'out')
    await mkdir(outDir, { recursive: true })
    const outPath = join(outDir, `cos-ref-${Date.now()}.png`)
    await writeFile(outPath, buf)
    log(`✓ 生成成功(b64_json ${(buf.length / 1024).toFixed(0)}KB)`)
    log(`  已保存:${outPath}`)
  } else if (item?.url) {
    log(`✓ 生成成功(url):${item.url}`)
  } else {
    log('⚠ HTTP 200 但响应里没有 data[0].b64_json / url,原始响应:')
    console.log(JSON.stringify(data, null, 2).slice(0, 3000))
  }
}

main().catch((e) => {
  console.error('✗ 未捕获异常:', e)
  process.exit(1)
})
