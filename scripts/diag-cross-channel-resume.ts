// E2E repro/verify for the cross-channel resume bug: a thread created on the
// rightcode-grok channel must survive a switch to rightcode-standard (gpt).
// Before the fix, codex `thread/resume` restored the persisted provider
// `rightcode-grok` from thread metadata, which is not in the new launch
// config → "failed to load configuration: Model provider `rightcode-grok`
// not found". With the fix, resume pins modelProvider to the CURRENT channel.
//
// Usage: npx tsx scripts/diag-cross-channel-resume.ts <RIGHTCODE_KEY>

import { mkdtempSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import { resolveWorkspacePaths } from '../src/main/agent/codexConfigStore'
import { resolveProviderChannel } from '../src/main/agent/gatewayModelRouting'
import type { AgentStreamEvent } from '../src/types/agent'

const KEY = process.argv[2]
if (!KEY) {
  console.error('usage: npx tsx scripts/diag-cross-channel-resume.ts <RIGHTCODE_KEY>')
  process.exit(1)
}

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(__dirname, '..')

async function runTurn(
  backend: CodexLocalBackend,
  threadId: string | undefined,
  text: string,
): Promise<string | undefined> {
  console.log(`\n[turn] user: ${text}`)
  const stream = backend.send(threadId, {
    items: [{ type: 'text', text }],
  }) as AsyncIterable<AgentStreamEvent>
  let resolvedThreadId = threadId
  for await (const event of stream) {
    const withThread = event as { threadId?: string }
    if (!resolvedThreadId && withThread.threadId) resolvedThreadId = withThread.threadId
    if (event.type === 'error') {
      console.log(`[turn] ERROR event: ${JSON.stringify(event).slice(0, 400)}`)
    }
    if (event.type === 'item_completed' && (event as { item?: { type?: string; content?: string } }).item?.type === 'text') {
      const content = (event as { item: { content?: string } }).item.content ?? ''
      console.log(`[turn] agent: ${content.slice(0, 200)}`)
    }
    if (event.type === 'turn_completed') console.log('[turn] completed')
  }
  return resolvedThreadId
}

async function main(): Promise<void> {
  process.env.NO_PROXY = [process.env.NO_PROXY, '127.0.0.1,localhost']
    .filter(Boolean)
    .join(',')
  process.env.no_proxy = process.env.NO_PROXY
  const codexHome = mkdtempSync(path.join(os.tmpdir(), 'diag-xchan-codex-'))
  writeFileSync(
    path.join(codexHome, 'config.toml'),
    [
      '[mcp_servers.apiyi]',
      'command = "node"',
      'args = []',
      'enabled = false',
      '',
      '[mcp_servers.cinematography_kb]',
      'command = "node"',
      'args = []',
      'enabled = false',
      '',
    ].join('\n'),
    'utf8',
  )

  const grokChannel = resolveProviderChannel('rightcode-grok')
  const standardChannel = resolveProviderChannel('rightcode-standard')

  const backend = new CodexLocalBackend({
    resourceRoot: path.join(projectRoot, 'resources'),
    codexHome,
    getApiKey: () => KEY,
    catimationMcp: { port: 59998, token: 'diag-token' },
    provider: { ...grokChannel, model: 'grok-4.5' },
  })

  try {
    await backend.start()
    console.log('[diag] codex started on rightcode-grok')
    const threadId = await runTurn(backend, undefined, '用一句话回答:1+1=?')
    if (!threadId) throw new Error('no thread id from first turn')
    console.log(`[diag] thread: ${threadId}`)

    console.log('\n[diag] switching channel rightcode-grok → rightcode-standard (gpt-5.6-sol) + restart')
    backend.setProvider({ ...standardChannel, model: 'gpt-5.6-sol' })
    await backend.restartCodex(resolveWorkspacePaths({
      home: os.homedir(),
      cwd: projectRoot,
      userData: codexHome,
    }))
    console.log('[diag] codex restarted on rightcode-standard')

    console.log('[diag] thread/resume with current-channel override ...')
    await backend.resumeThread(threadId)
    console.log('[diag] resume OK — no "Model provider not found"')

    await runTurn(backend, threadId, '用一句话回答:我上一个问题是什么?')
    console.log('\n[diag] PASS: cross-channel resume + follow-up turn succeeded')
  } finally {
    await backend.stop().catch(() => undefined)
  }
}

main().catch((error) => {
  console.error('[diag] crashed:', error)
  process.exit(1)
})
