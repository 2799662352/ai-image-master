// Live smoke for the Anthropic Messages bridge (rightcode-claude channel).
//
// Sends the request shape codex actually sends — a streaming Responses-API POST
// with `prompt_cache_key` — at the loopback bridge, and prints what comes back.
// A pass proves the whole translation chain end to end against the real vendor
// pool: Responses request → Messages request → Messages SSE → Responses SSE.
//
// Checks, in order:
//   1. The channel preset resolves to the `anthropic-messages` bridge kind.
//   2. The bridge rewrites the channel onto a 127.0.0.1 port.
//   3. A streaming turn returns real assistant text and a usage record.
//   4. `prompt_cache_key` is stripped rather than forwarded (Messages API has
//      no such field and would 400 on it), so the turn succeeding IS the proof.
//   5. Non-`/responses` paths are refused, so a stray call cannot silently
//      reach the vendor unproxied.
//
// Needs a Right.Codes key, since it talks to the live pool:
//   $env:OPENAI_API_KEY = "<your right.codes key>"
//   pnpm exec tsx scripts/smoke-claude-bridge.ts
//
// Optional: pass a model slug to override the channel default (`claude-opus-5`
// or `claude-sonnet-5`; anything else is rejected by the channel allowlist).

import process from 'node:process'
import {
  resolveCompatibilityBridge,
  startProviderCompatibilityProxies,
} from '../src/main/agent/responsesCompatibilityProxy'
import { resolveProviderChannel } from '../src/main/agent/gatewayModelRouting'

const SMOKE_TIMEOUT_MS = 120_000
const PROMPT = 'Reply with exactly: bridge ok'

/** Pulls assistant text + usage out of a Responses SSE stream. */
async function readResponsesStream(response: Response): Promise<{
  text: string
  usage: Record<string, unknown> | undefined
  eventTypes: string[]
}> {
  if (!response.body) throw new Error('bridge returned no response body')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const eventTypes: string[] = []
  let buffered = ''
  let text = ''
  let usage: Record<string, unknown> | undefined

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    // SSE frames are blank-line delimited; keep the trailing partial frame.
    const frames = buffered.split('\n\n')
    buffered = frames.pop() ?? ''
    for (const frame of frames) {
      const dataLine = frame.split('\n').find((line) => line.startsWith('data:'))
      if (!dataLine) continue
      const payload = dataLine.slice('data:'.length).trim()
      if (!payload || payload === '[DONE]') continue
      let event: Record<string, unknown>
      try {
        event = JSON.parse(payload) as Record<string, unknown>
      } catch {
        continue
      }
      const type = typeof event.type === 'string' ? event.type : '(untyped)'
      eventTypes.push(type)
      if (type === 'response.output_text.delta' && typeof event.delta === 'string') {
        text += event.delta
      }
      if (type === 'response.completed') {
        const completed = event.response as { usage?: Record<string, unknown> } | undefined
        usage = completed?.usage
      }
    }
  }
  return { text, usage, eventTypes }
}

async function runSmoke(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  if (!apiKey) {
    throw new Error(
      'OPENAI_API_KEY is not set. This smoke talks to the live Right.Codes pool; '
      + 'set your key first: $env:OPENAI_API_KEY = "<key>"',
    )
  }

  const channel = resolveProviderChannel('rightcode-claude')
  const model = process.argv[2]?.trim() || channel.model
  if (!model) throw new Error('channel preset has no default model')
  if (channel.allowedModels && !channel.allowedModels.includes(model)) {
    throw new Error(
      `model "${model}" is not in the channel allowlist [${channel.allowedModels.join(', ')}]`,
    )
  }

  const bridgeKind = resolveCompatibilityBridge(channel)
  if (bridgeKind !== 'anthropic-messages') {
    throw new Error(`expected anthropic-messages bridge, channel resolved to "${bridgeKind}"`)
  }
  console.log(`[smoke] ✅ ${channel.id} resolves to the "${bridgeKind}" bridge`)
  console.log(`[smoke]    upstream ${channel.baseUrl}  model ${model}`)

  const group = await startProviderCompatibilityProxies([channel])
  const bridged = group.providers[0]
  try {
    if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(bridged.baseUrl)) {
      throw new Error(`bridge did not rewrite baseUrl (still ${bridged.baseUrl})`)
    }
    console.log(`[smoke] ✅ rewritten onto loopback ${bridged.baseUrl}`)

    // The exact shape codex sends, `prompt_cache_key` included. The Messages
    // API has no such field, so an unstripped forward would 400 right here.
    const started = Date.now()
    const response = await fetch(`${bridged.baseUrl.replace(/\/+$/, '')}/responses`, {
      method: 'POST',
      headers: {
        // Bearer on purpose: the bridge must translate it to `x-api-key`,
        // which is the only scheme this pool accepts.
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model,
        stream: true,
        prompt_cache_key: 'smoke-should-be-stripped',
        max_output_tokens: 64,
        input: [{ role: 'user', content: [{ type: 'input_text', text: PROMPT }] }],
      }),
    })

    if (!response.ok) {
      const detail = await response.text()
      throw new Error(`bridge returned HTTP ${response.status}: ${detail.slice(0, 400)}`)
    }

    const { text, usage, eventTypes } = await readResponsesStream(response)
    const elapsed = Date.now() - started
    if (!text.trim()) {
      throw new Error(`stream carried no assistant text (events: ${eventTypes.join(', ')})`)
    }
    console.log(`[smoke] ✅ streamed turn OK in ${elapsed}ms`)
    console.log(`[smoke]    assistant said: ${JSON.stringify(text.trim())}`)
    console.log(`[smoke]    Responses events: ${[...new Set(eventTypes)].join(', ')}`)
    console.log(`[smoke]    usage: ${usage ? JSON.stringify(usage) : '(absent)'}`)
    console.log('[smoke] ✅ prompt_cache_key was stripped — Messages API would have 400d on it')

    // The bridge exists to serve `/responses` only. Anything else must be
    // refused locally instead of being relayed to the vendor.
    const stray = await fetch(`${bridged.baseUrl.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model, messages: [] }),
    })
    if (stray.ok) throw new Error('bridge relayed a non-/responses path instead of refusing it')
    console.log(`[smoke] ✅ non-/responses path refused with HTTP ${stray.status}`)

    console.log('\n[smoke] PASS — Responses ⇆ Messages translation holds against the live pool.')
  } finally {
    await group.close()
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, rejectGuard) => {
    timer = setTimeout(
      () => rejectGuard(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)),
      SMOKE_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([runSmoke(), guard])
    process.exit(0)
  } catch (error) {
    console.error('\n[smoke] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

void main()
