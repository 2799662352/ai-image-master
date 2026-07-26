// Probes whether a gateway serves Claude, and over WHICH wire protocol.
//
// The answer decides how a Claude channel must be configured, and the two
// answers need opposite settings:
//
//   • Responses works  → `compatibilityPolicy: 'none'` (or the namespace bridge
//     if tools misbehave). No protocol translation, no stripped fields.
//   • only Messages works → `compatibilityPolicy: 'anthropic-messages-bridge'`,
//     the rightcode-claude arrangement.
//
// Guessing wrong is not a soft failure: pointing a Responses payload at a
// Messages-only endpoint fails every turn, and bridging an endpoint that
// already speaks Responses adds a translation layer that mangles tool calls.
//
// Also reports whether the gateway serves a GPT slug on the SAME endpoint,
// because that decides the memories question. `features.memories` writes
// malformed artifacts on Claude, and the temperate fix is `memoriesModel`
// pointing at a GPT model on the same base URL — available only if GPT answers
// there. If it does not, the channel needs `supportsMemories: false`.
//
// Usage (PowerShell):
//   $env:OPENAI_API_KEY = "<key for the gateway you are probing>"
//   pnpm exec tsx scripts/probe-gateway-claude.ts https://api.apiyi.com/v1
//   pnpm exec tsx scripts/probe-gateway-claude.ts https://api.apiyi.com/v1 claude-opus-5
//
// Read-only: every call is a minimal 1-token request or a plain GET.

import process from 'node:process'

const PROBE_TIMEOUT_MS = 45_000
const PROBE_PROMPT = 'hi'
const GPT_PROBE_MODEL = 'gpt-5.5'

interface ProbeResult {
  ok: boolean
  status: number | 'network-error'
  /** Upstream's own words, truncated — the useful part when a probe fails. */
  detail: string
}

async function post(url: string, apiKey: string, body: unknown): Promise<ProbeResult> {
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${apiKey}`,
        // Sent unconditionally: Anthropic-native endpoints want `x-api-key` and
        // ignore `authorization`, OpenAI-compatible ones do the reverse. Sending
        // both means one probe covers either flavour without a second attempt.
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
    })
    const text = await response.text()
    return { ok: response.ok, status: response.status, detail: text.slice(0, 300) }
  } catch (error) {
    return {
      ok: false,
      status: 'network-error',
      detail: error instanceof Error ? error.message : String(error),
    }
  }
}

function report(label: string, result: ProbeResult): void {
  const mark = result.ok ? '✅' : '❌'
  console.log(`[probe] ${mark} ${label} → ${result.status}`)
  if (!result.ok) console.log(`[probe]      ${result.detail.replace(/\s+/g, ' ')}`)
}

async function listClaudeModels(baseUrl: string, apiKey: string): Promise<string[] | null> {
  try {
    const response = await fetch(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${apiKey}`, 'x-api-key': apiKey },
    })
    if (!response.ok) return null
    const payload = await response.json() as { data?: Array<{ id?: unknown }> }
    if (!Array.isArray(payload.data)) return null
    return payload.data
      .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
      .filter((id) => id.toLowerCase().includes('claude'))
      .sort()
  } catch {
    return null
  }
}

async function runProbe(): Promise<void> {
  const apiKey = process.env.OPENAI_API_KEY?.trim()
  const baseUrlArg = process.argv[2]?.trim()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is not set: $env:OPENAI_API_KEY = "<key>"')
  }
  if (!baseUrlArg) {
    throw new Error(
      'pass the gateway base URL, e.g. '
      + 'pnpm exec tsx scripts/probe-gateway-claude.ts https://api.apiyi.com/v1',
    )
  }
  const baseUrl = baseUrlArg.replace(/\/+$/, '')

  const listed = await listClaudeModels(baseUrl, apiKey)
  if (listed === null) {
    console.log('[probe] ⚠️  /models unavailable or unparseable — falling back to direct calls')
  } else if (listed.length === 0) {
    console.log('[probe] ⚠️  /models responded but advertises NO claude slug')
  } else {
    console.log(`[probe] /models advertises ${listed.length} claude slug(s): ${listed.join(', ')}`)
  }

  // An advertised slug beats a guessed one: aggregators often expose only
  // date-suffixed or vendor-prefixed names, and a wrong slug 404s in a way
  // that looks identical to "protocol unsupported".
  const model = process.argv[3]?.trim() || listed?.[0] || 'claude-opus-5'
  console.log(`[probe] probing model "${model}" at ${baseUrl}\n`)

  const responses = await post(`${baseUrl}/responses`, apiKey, {
    model,
    max_output_tokens: 16,
    input: [{ role: 'user', content: [{ type: 'input_text', text: PROBE_PROMPT }] }],
  })
  report('Responses API  POST /responses', responses)

  const messages = await post(`${baseUrl}/messages`, apiKey, {
    model,
    max_tokens: 16,
    messages: [{ role: 'user', content: PROBE_PROMPT }],
  })
  report('Messages API   POST /messages', messages)

  const gpt = await post(`${baseUrl}/responses`, apiKey, {
    model: GPT_PROBE_MODEL,
    max_output_tokens: 16,
    input: [{ role: 'user', content: [{ type: 'input_text', text: PROBE_PROMPT }] }],
  })
  report(`same endpoint serves ${GPT_PROBE_MODEL} (memories fallback)`, gpt)

  console.log('\n[probe] ── verdict ──')
  if (responses.ok) {
    console.log('[probe] Responses works → add the channel with compatibilityPolicy: \'none\'.')
    console.log('[probe] No bridge needed. Watch tool calls on the first real turn; if')
    console.log('[probe] subagent tools get stripped, escalate to responses-namespace-bridge.')
  } else if (messages.ok) {
    console.log('[probe] Messages only → compatibilityPolicy: \'anthropic-messages-bridge\'')
    console.log('[probe] (the rightcode-claude arrangement).')
  } else {
    console.log('[probe] Neither protocol answered for this slug. Either the gateway does not')
    console.log('[probe] serve Claude, or the slug is wrong — re-run with a slug from /models')
    console.log('[probe] above before concluding it is unsupported.')
  }
  if (responses.ok || messages.ok) {
    console.log(
      gpt.ok
        ? `[probe] memories: keep enabled with memoriesModel: '${GPT_PROBE_MODEL}'.`
        : '[probe] memories: no GPT fallback here → set supportsMemories: false.',
    )
  }
}

async function main(): Promise<void> {
  let timer: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_, rejectGuard) => {
    timer = setTimeout(
      () => rejectGuard(new Error(`probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
      PROBE_TIMEOUT_MS,
    )
  })
  try {
    await Promise.race([runProbe(), guard])
    process.exit(0)
  } catch (error) {
    console.error('\n[probe] FAIL:', error instanceof Error ? error.message : error)
    process.exit(1)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

void main()
