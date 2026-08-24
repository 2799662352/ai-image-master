/**
 * 图层拆分真机冒烟 —— 验证三件本地测不出来的事:
 *   ① 我们构造的 layer_decomposition 请求体上游真的收（而不是当未知字段忽略）;
 *   ② 响应里 z_index / bounding_box / name / description 的真实形状与我们的解析一致;
 *   ③ 一次拆分的计费口径:usage 里到底记了几张。
 *
 * 密钥从 MIAU_KEY 环境变量读，绝不落盘。原始响应会存到 tmp-layer-*.json 供人工核对
 * （已在 .gitignore 之外，跑完自己删）。
 *
 * 用法: MIAU_KEY=sk-xxx node scripts/smoke-layer-decomposition.mjs [已有图片URL]
 */
import { writeFileSync } from 'node:fs'

const KEY = process.env.MIAU_KEY
if (!KEY) {
  console.error('缺 MIAU_KEY 环境变量')
  process.exit(1)
}

// 默认走源站而非加速域名:EdgeOne 那条会触发 TLS 重协商,Windows 上 node 的
// undici 直接 ECONNRESET（curl 靠 schannel 才通）。同一台 new-api 实例，计费口径一致。
// 需要验证 CDN 链路时用 MIAU_BASE 覆盖。
const HOST = process.env.MIAU_BASE || 'http://175.178.198.17:3000'
const BASE = `${HOST}/v1/images/generations`
const MODEL = 'doubao-seedream-5-0-pro-260628'

async function post(body, label) {
  const started = Date.now()
  const res = await fetch(BASE, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const elapsed = ((Date.now() - started) / 1000).toFixed(1)
  console.log(`\n[${label}] HTTP ${res.status} · ${elapsed}s · ${text.length} bytes`)
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    console.log(`[${label}] 非 JSON 响应:`, text.slice(0, 500))
    return { ok: false, json: null, text }
  }
  return { ok: res.ok, json, text }
}

/** 把响应里每一项的字段名摊平打印 —— 这是核对线格式的关键证据。 */
function describeItems(json) {
  const items = Array.isArray(json?.data) ? json.data : []
  console.log(`  data[] 长度: ${items.length}`)
  items.forEach((it, i) => {
    const keys = Object.keys(it || {})
    const box = it?.bounding_box
    console.log(
      `  [${i}] keys=${JSON.stringify(keys)}` +
        ` z_index=${JSON.stringify(it?.z_index)}` +
        ` name=${JSON.stringify(it?.name)}` +
        (box ? ` bbox_keys=${JSON.stringify(Object.keys(box))} bbox=${JSON.stringify(box)}` : ''),
    )
  })
  if (json?.usage) console.log('  usage:', JSON.stringify(json.usage))
  const topKeys = Object.keys(json || {})
  console.log('  顶层 keys:', JSON.stringify(topKeys))
}

function firstUrl(json) {
  const item = (json?.data || [])[0]
  return item?.url || (item?.b64_json ? `data:image/png;base64,${item.b64_json}` : null)
}

const argUrl = process.argv[2]
let sourceUrl = argUrl

// ── ① 先出一张有明显层次的底图（除非调用方自带图）─────────────────────
if (!sourceUrl) {
  console.log('=== ① 生成待拆分底图（普通生图路径，同时验证 SD5 Pro 正常通路）===')
  const gen = await post(
    {
      model: MODEL,
      prompt:
        '一张极简海报：纯正蓝色背景，正中央一个写实的红苹果，画面顶部有白色粗体英文标题 "HELLO"，右下角一个白色小星星图标。元素之间界限分明，无渐变叠加。',
      size: '1024x1024',
      n: 1,
      watermark: false,
      response_format: 'url',
    },
    '生图',
  )
  if (!gen.ok) {
    console.error('生图失败，原始响应:', gen.text.slice(0, 800))
    process.exit(1)
  }
  describeItems(gen.json)
  sourceUrl = firstUrl(gen.json)
  if (!sourceUrl) {
    console.error('生图成功但拿不到 url')
    process.exit(1)
  }
  console.log('  底图 URL:', sourceUrl.slice(0, 120))
}

// ── ② 拆分：这就是 buildLayerDecompositionPayload 会构造的请求体 ────────
console.log('\n=== ② 图层拆分（layer_decomposition，空 prompt = 自动全拆）===')
const payload = {
  model: MODEL,
  layer_decomposition: true,
  size: 'auto',
  watermark: false,
  response_format: 'url',
  output_format: 'png',
  image: sourceUrl,
  // prompt 刻意缺席 —— 自动全拆
}
console.log('  请求体 keys:', JSON.stringify(Object.keys(payload)))

const split = await post(payload, '拆分')
if (!split.json) process.exit(1)
writeFileSync('tmp-layer-raw.json', JSON.stringify(split.json, null, 2))
console.log('  原始响应已存 tmp-layer-raw.json')
describeItems(split.json)

if (!split.ok) {
  console.error('\n拆分请求被拒:', split.text.slice(0, 800))
  process.exit(1)
}

// ── ③ 用**真实的解析函数**跑真实响应 ─────────────────────────────────
console.log('\n=== ③ 过 extractLayersFromApiResponse（本仓真实解析）===')
// ApiService 模块级会读 localStorage（站点配置），node 里补个最小垫片。
globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} }
globalThis.window = globalThis.window ?? { addEventListener() {}, dispatchEvent() {} }
const { extractLayersFromApiResponse } = await import('../src/renderer/src/services/api/ApiService.ts')

const layers = extractLayersFromApiResponse(split.json)
console.log(`  解析出 ${layers.length} 层:`)
layers.forEach((l) => {
  console.log(
    `   z${l.zIndex}${l.zIndex === 0 ? '(底图)' : ''} ` +
      `name=${JSON.stringify(l.name)} mime=${l.mimeType} ` +
      `bbox=${JSON.stringify(l.boundingBox)} url=${String(l.url).slice(0, 70)}…`,
  )
})

// 结论摘要 —— 这几行是这次冒烟真正要回答的问题
const items = split.json?.data?.length ?? 0
console.log('\n=== 结论 ===')
console.log(`  上游返回图片张数: ${items}`)
console.log(`  解析出的图层数:   ${layers.length}  ${layers.length === items ? '✅ 一致' : '❌ 丢层了'}`)
console.log(`  底图(z0)存在:     ${layers.some((l) => l.zIndex === 0) ? '✅' : '❌'}`)
console.log(`  升序返回:         ${layers.every((l, i, a) => i === 0 || a[i - 1].zIndex <= l.zIndex) ? '✅' : '❌'}`)
console.log(`  计费 usage:       ${JSON.stringify(split.json?.usage ?? '(上游未回 usage)')}`)
