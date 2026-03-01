#!/usr/bin/env npx tsx
/**
 * 4-Pass Storyboard Pipeline 实际运行测试
 *
 * 用法:
 *   VISION_API_KEY=xxx VISION_BASE_URL=xxx npx tsx scripts/run-pipeline-test.ts [图片路径]
 *
 * 环境变量:
 *   VISION_API_KEY  - 视觉 API Key (必需)
 *   VISION_BASE_URL - API 地址，如 https://api.openai.com 或 Gemini endpoint
 *
 * 参数:
 *   可选: 图片文件路径 (jpg/png)。若不提供，使用 1x1 占位图(输出质量有限)
 *
 * 输出:
 *   - 控制台打印完整 StoryboardResponse JSON
 *   - 结构校验：scene/objs/seq/cont/notes 等字段
 */

import * as fs from 'fs'
import * as path from 'path'

async function loadImageAsBase64(filePath: string): Promise<{ base64: string; mimeType: string }> {
  const resolved = path.resolve(process.cwd(), filePath)
  if (!fs.existsSync(resolved)) {
    throw new Error(`图片不存在: ${resolved}`)
  }
  const ext = path.extname(resolved).toLowerCase()
  const mimeType = ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : 'image/png'
  const buffer = fs.readFileSync(resolved)
  return { base64: buffer.toString('base64'), mimeType }
}

/** 最小 1x1 透明 PNG (67 bytes) - 无图时占位 */
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='

async function main() {
  const apiKey = process.env.VISION_API_KEY
  const baseURL = process.env.VISION_BASE_URL
  const imagePath = process.argv[2]
  const contextFile = process.argv[3] || process.env.VISION_CONTEXT_FILE

  if (!apiKey || !baseURL) {
    console.error(`
缺少环境变量。请设置:
  VISION_API_KEY  - 视觉模型 API Key
  VISION_BASE_URL - API 地址 (如 https://api.openai.com 或 Gemini 兼容端点)

示例:
  $env:VISION_API_KEY="sk-xxx"; $env:VISION_BASE_URL="https://api.openai.com"
  npx tsx scripts/run-pipeline-test.ts [图片路径] [剧本文件路径]
`)
    process.exit(1)
  }

  let images: Array<{ base64: string; mimeType: string }>
  if (imagePath) {
    images = [await loadImageAsBase64(imagePath)]
    console.log('[run-pipeline-test] 使用图片:', path.resolve(process.cwd(), imagePath))
  } else {
    images = [{ base64: TINY_PNG_BASE64, mimeType: 'image/png' }]
    console.warn('[run-pipeline-test] 未提供图片，使用 1x1 占位图，输出质量可能有限')
  }

  let context: string | undefined
  if (contextFile) {
    const resolved = path.resolve(process.cwd(), contextFile)
    if (fs.existsSync(resolved)) {
      context = fs.readFileSync(resolved, 'utf-8')
      console.log(`[run-pipeline-test] 剧本文件: ${resolved} (${context.length} chars)`)
    } else {
      console.warn(`[run-pipeline-test] 剧本文件不存在: ${resolved}，忽略`)
    }
  }
  if (!context && !imagePath) {
    context = '（占位图测试，请基于极小画面合理推断）'
  }

  const { StoryboardPipelineService } = await import(
    '../src/renderer/src/services/storyboard-pipeline/StoryboardPipelineService'
  )

  const service = new StoryboardPipelineService({
    apiKey,
    baseURL,
    model: process.env.VISION_MODEL || 'gemini-2.5-flash'
  })

  console.log('[run-pipeline-test] 启动 4-Pass Pipeline...')
  if (context) console.log(`[run-pipeline-test] 剧本预览: ${context.slice(0, 80)}...`)
  const start = Date.now()

  const progressLog = (p: { pass: number; label: string; data: any }) => {
    console.log(`  [Pass ${p.pass}] ${p.label}`)
    if (p.data?.retry) console.log(`  [Retry] 第 ${p.data.retryCount} 次精修`)
  }

  const result = await service.analyze(
    images,
    {
      rolePrompt: '请分析这张分镜图，输出专业电影分镜格式。',
      context
    },
    progressLog as any
  )

  const elapsed = ((Date.now() - start) / 1000).toFixed(1)
  console.log(`[run-pipeline-test] 完成，耗时 ${elapsed}s`)

  // 结构校验
  const checks = [
    ['scene.d', !!result.scene?.d],
    ['scene.cap', !!result.scene?.cap],
    ['scene.env', !!result.scene?.env],
    ['scene.timeline', Array.isArray(result.scene?.timeline) && result.scene.timeline.length > 0],
    ['objs', Array.isArray(result.objs) && result.objs.length >= 0],
    ['seq', Array.isArray(result.seq) && result.seq.length > 0],
    ['cont', typeof result.cont === 'string' && result.cont.length > 0],
    ['notes', typeof result.notes === 'string' && result.notes.length > 0]
  ]

  console.log('\n--- 结构校验 ---')
  let pass = 0
  for (const [name, ok] of checks) {
    const status = ok ? '✓' : '✗'
    if (ok) pass++
    console.log(`  ${status} ${name}`)
  }
  console.log(`\n通过: ${pass}/${checks.length}`)

  console.log('\n--- 输出摘要 ---')
  console.log('叙事弧线:', result.scene?.d?.slice(0, 80) + (result.scene?.d && result.scene.d.length > 80 ? '...' : ''))
  console.log('角色数:', result.objs?.length ?? 0)
  console.log('镜头数:', result.seq?.length ?? 0)
  console.log('连续性:', result.cont?.slice(0, 100) + (result.cont && result.cont.length > 100 ? '...' : ''))

  // audio 字段质量检查
  console.log('\n--- Audio 字段检查 ---')
  const seqWithAudio = result.seq?.filter((s: any) => s.audio && s.audio.length > 10) || []
  console.log(`有 audio 的镜头: ${seqWithAudio.length}/${result.seq?.length ?? 0}`)
  for (const s of seqWithAudio.slice(0, 3)) {
    console.log(`  [${(s as any).id}] ${((s as any).audio as string).slice(0, 120)}...`)
  }

  // dodge/sanitizer 效果检查
  console.log('\n--- Dodge/Sanitizer 检查 ---')
  const allText = JSON.stringify(result)
  const dodgeIndicators = ['artistic shadow', 'shallow DOF', 'SHADOW_VEIL', 'DEPTH_BLUR', 'contour', 'silhouette', '轮廓', '曲线']
  const riskyWords = ['性交', '做爱', '插入', 'fucking', 'penetrat', 'naked', 'nude']
  for (const d of dodgeIndicators) {
    if (allText.includes(d)) console.log(`  ✓ dodge 痕迹: "${d}"`)
  }
  let riskyFound = false
  for (const r of riskyWords) {
    if (allText.toLowerCase().includes(r.toLowerCase())) {
      console.log(`  ✗ 危险词泄漏: "${r}"`)
      riskyFound = true
    }
  }
  if (!riskyFound) console.log('  ✓ 无危险词泄漏')

  // 角色名验证
  console.log('\n--- 角色名验证 ---')
  const expectedNames = ['翠娘', '卯生', '樱梅']
  const objNames = result.objs?.map((o: any) => o.n) || []
  for (const name of expectedNames) {
    const found = objNames.some((n: string) => n.includes(name))
    console.log(`  ${found ? '✓' : '✗'} 剧本角色 "${name}" ${found ? '已提取' : '未找到'}`)
  }

  console.log('\n--- 完整 JSON ---')
  console.log(JSON.stringify(result, null, 2))
}

main().catch((err) => {
  console.error('[run-pipeline-test] 失败:', err)
  process.exit(1)
})
