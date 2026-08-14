/**
 * 万相 3.0 契约烟测 —— 对着真网关跑一次「组包 → 提交 → 轮询 → 取地址」。
 *
 * 它走的是**生产代码本身**（`createWan3Transport` → `buildWan3CreateBody` →
 * `createWan3Client` → `parseWan3TaskResult`），不是手写的近似请求。手写近似只能
 * 证明「网关能用」，证明不了「我们发出去的东西能用」——这两件事在 2026-08-14 就
 * 差过一次：指南写的 `output.video_url` 在查询回包里根本不在顶层，按它解析会把
 * 已完成的任务当成还在跑，空转到 30 分钟超时。
 *
 * fetch 用 Node 原生的，不碰 Electron —— 这也是 `createWan3Client` 要求外部注入
 * fetch 的原因之一。
 *
 * 用法（密钥从环境变量取，绝不落盘）：
 *   $env:MIAU_API_KEY='sk-...'; npx tsx scripts/smoke-wan3.ts
 *   npx tsx scripts/smoke-wan3.ts --dry     # 只打印组包结果，不提交、不花钱
 *
 * ⚠️ 非 --dry 会真实计费（万相按秒计费）。默认取最省的一档：5 秒 / 480P / 纯文生。
 */

import { createWan3Client } from '../src/main/services/wan3/client'
import { createWan3Transport, type VideoSubmitContext } from '../src/main/services/videoTransport'

const POLL_INTERVAL_MS = 8_000
const POLL_TIMEOUT_MS = 10 * 60_000

function fail(message: string): never {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function submitContext(): VideoSubmitContext {
  const prompt = '一只橘猫在窗台上伸懒腰，午后阳光，柔和景深'
  return {
    input: { prompt, model: 'wan3', mode: 'text2video', generateAudio: false },
    // buildContent 在真链路里会把素材换成 COS 直链；纯文生没有素材，只有提示词。
    content: [{ type: 'text', text: prompt }],
    model: 'wan3',
    resolution: '480p',
    ratio: '16:9',
    duration: 5,
  }
}

async function main(): Promise<void> {
  const dry = process.argv.includes('--dry')
  const apiKey = (process.env.MIAU_API_KEY ?? '').trim()
  if (!dry && !apiKey) fail('未设置 MIAU_API_KEY')

  const ctx = submitContext()

  if (dry) {
    // 组包结果打出来即可，不建客户端、不发请求。
    const { buildWan3CreateBody } = await import('../src/main/services/wan3/request')
    const { toWan3ResolvedMedia, resolveVideoMode } = await import('../src/main/services/wan3/fromContent')
    const resolved = toWan3ResolvedMedia(ctx.content)
    const body = buildWan3CreateBody(
      {
        prompt: ctx.input.prompt,
        mode: resolveVideoMode(ctx.input.mode, resolved),
        resolution: ctx.resolution,
        ratio: ctx.ratio,
        duration: ctx.duration,
        generateAudio: ctx.input.generateAudio,
      },
      resolved,
    )
    console.log(JSON.stringify(body, null, 2))
    return
  }

  const transport = createWan3Transport(
    createWan3Client({ fetchImpl: (url, init) => fetch(url, init as RequestInit) }),
    () => apiKey,
  )

  transport.requireApiKey()
  console.log('→ 提交…')
  const { id } = await transport.createTask(ctx)
  console.log(`✓ 任务号 ${id}`)

  const startedAt = Date.now()
  for (;;) {
    if (Date.now() - startedAt > POLL_TIMEOUT_MS) fail('轮询超时（10 分钟未出结果）')
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))

    // 查询失败不判死刑：任务还在上游跑着，退避后接着问。
    let result
    try {
      result = await transport.queryTask(id)
    } catch (e) {
      console.warn(`  查询失败，稍后重试：${e instanceof Error ? e.message : String(e)}`)
      continue
    }

    console.log(`  ${new Date().toISOString().slice(11, 19)} ${result.status}`)
    if (result.status === 'failed') {
      fail(`生成失败：${result.error?.code ?? ''} ${result.error?.message ?? '上游未给出原因'}`)
    }
    if (result.status === 'succeeded') {
      const url = result.content?.video_url
      if (!url) fail('succeeded 但没解析出 video_url —— 查询信封又变了，去看 wan3/response.ts')
      console.log(`✓ 出片：${url.slice(0, 90)}…`)
      return
    }
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)))
