// Diagnostic probe: reproduce the second-turn 422 "untagged enum ModelInput"
// against right.codes/grok/v1/responses and bisect WHICH history item variant
// the gateway rejects. Turn 1 collects real output items; turn 2 replays them
// verbatim (codex-style stateless history), then variants strip one suspect
// at a time.
//
// Usage: node scripts/probe-rightcode-grok-422.mjs <API_KEY>

const BASE = 'https://right.codes/grok/v1'
const KEY = process.argv[2]
if (!KEY) {
  console.error('usage: node scripts/probe-rightcode-grok-422.mjs <API_KEY>')
  process.exit(1)
}

async function post(label, body) {
  const started = Date.now()
  const response = await fetch(`${BASE}/responses`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${KEY}`,
    },
    body: JSON.stringify(body),
  })
  const text = await response.text()
  const ms = Date.now() - started
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    parsed = undefined
  }
  console.log(`\n=== ${label} → HTTP ${response.status} (${ms}ms)`)
  if (!response.ok) {
    console.log(text.slice(0, 500))
  }
  return { status: response.status, json: parsed }
}

function userMessage(text) {
  return { role: 'user', content: [{ type: 'input_text', text }] }
}

async function main() {
  // Turn 1: mirror codex's stateless defaults (store:false + encrypted reasoning).
  const turn1 = await post('turn1: user only', {
    model: 'grok-4.5',
    store: false,
    stream: false,
    include: ['reasoning.encrypted_content'],
    input: [userMessage('用一句话回答:1+1=?')],
  })
  if (turn1.status !== 200) {
    console.error('turn1 failed; cannot continue')
    process.exit(1)
  }
  const output = turn1.json.output ?? []
  console.log('turn1 output item types:', output.map((item) => item.type).join(', '))
  console.log(JSON.stringify(output, null, 1).slice(0, 1500))

  // Turn 2: replay history verbatim — the codex-style second turn.
  const history = [userMessage('用一句话回答:1+1=?'), ...output]
  const turn2 = await post('turn2: verbatim replay + new user msg', {
    model: 'grok-4.5',
    store: false,
    stream: false,
    include: ['reasoning.encrypted_content'],
    input: [...history, userMessage('你是谁')],
  })

  if (turn2.status === 200) {
    console.log('\nverbatim replay OK — codex must be sending a DIFFERENT shape.')
  }

  // Bisect variants regardless, to map the gateway's tolerance.
  const reasoningItems = output.filter((item) => item.type === 'reasoning')
  const nonReasoning = output.filter((item) => item.type !== 'reasoning')

  await post('variant A: history WITHOUT reasoning items', {
    model: 'grok-4.5',
    store: false,
    stream: false,
    input: [userMessage('用一句话回答:1+1=?'), ...nonReasoning, userMessage('你是谁')],
  })

  if (reasoningItems.length > 0) {
    const bare = reasoningItems.map((item) => {
      const clone = structuredClone(item)
      delete clone.encrypted_content
      return clone
    })
    await post('variant B: reasoning WITHOUT encrypted_content', {
      model: 'grok-4.5',
      store: false,
      stream: false,
      input: [userMessage('用一句话回答:1+1=?'), ...bare, ...nonReasoning, userMessage('你是谁')],
    })

    const summaryless = reasoningItems.map((item) => {
      const clone = structuredClone(item)
      delete clone.summary
      return clone
    })
    await post('variant C: reasoning WITHOUT summary', {
      model: 'grok-4.5',
      store: false,
      stream: false,
      include: ['reasoning.encrypted_content'],
      input: [userMessage('用一句话回答:1+1=?'), ...summaryless, ...nonReasoning, userMessage('你是谁')],
    })
  }

  // Codex accumulates RAW streamed reasoning text (show_raw_agent_reasoning)
  // into the reasoning item's `content` array and replays it — vanilla server
  // output never carries `content`, so this is the codex-only delta.
  if (reasoningItems.length > 0) {
    const withContent = reasoningItems.map((item) => ({
      ...structuredClone(item),
      content: [{ type: 'reasoning_text', text: 'thinking about 1+1...' }],
    }))
    await post('variant E: reasoning WITH content[reasoning_text] (codex replay shape)', {
      model: 'grok-4.5',
      store: false,
      stream: false,
      include: ['reasoning.encrypted_content'],
      input: [userMessage('用一句话回答:1+1=?'), ...withContent, ...nonReasoning, userMessage('你是谁')],
    })

    const withEmptyContent = reasoningItems.map((item) => ({
      ...structuredClone(item),
      content: [],
    }))
    await post('variant F: reasoning WITH empty content[]', {
      model: 'grok-4.5',
      store: false,
      stream: false,
      include: ['reasoning.encrypted_content'],
      input: [userMessage('用一句话回答:1+1=?'), ...withEmptyContent, ...nonReasoning, userMessage('你是谁')],
    })
  }

  // Codex-specific shapes seen in rollout replays.
  await post('variant D: assistant message with output_text (id stripped)', {
    model: 'grok-4.5',
    store: false,
    stream: false,
    input: [
      userMessage('用一句话回答:1+1=?'),
      ...nonReasoning.map((item) => {
        const clone = structuredClone(item)
        delete clone.id
        return clone
      }),
      userMessage('你是谁'),
    ],
  })
}

main().catch((error) => {
  console.error('probe crashed:', error)
  process.exit(1)
})
