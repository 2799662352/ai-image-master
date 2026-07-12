// Offline smoke for the production model-context launch path.
//
// It starts the bundled Codex app-server with an isolated CODEX_HOME, passes
// context limits through CodexLocalBackend.getModelContextConfig (the same
// getter production restarts consume), and verifies config/read sees both the
// requested context window and its shared 90% auto-compaction threshold.
// No model turn or Provider credential is required.

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { CodexLocalBackend } from '../src/main/agent/CodexLocalBackend'
import { modelAutoCompactTokenLimit } from '../src/shared/modelSettings'
import type { CodexModelContextConfig } from '../src/types/agent'

const SMOKE_TIMEOUT_MS = 30_000
const DEFAULT_SMOKE_CONTEXT_WINDOW = 372_000

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)
const projectRoot = path.resolve(__dirname, '..')
const resourceRoot = path.join(projectRoot, 'resources')

export function resolveSmokeContextConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): CodexModelContextConfig {
  const contextWindow = Number(
    env.CODEX_SMOKE_CONTEXT_WINDOW ?? DEFAULT_SMOKE_CONTEXT_WINDOW,
  )
  if (
    !Number.isFinite(contextWindow)
    || !Number.isSafeInteger(contextWindow)
    || contextWindow <= 0
  ) {
    throw new TypeError(
      'CODEX_SMOKE_CONTEXT_WINDOW must be a finite positive safe integer',
    )
  }

  return {
    modelContextWindow: contextWindow,
    modelAutoCompactTokenLimit: modelAutoCompactTokenLimit(contextWindow),
  }
}

async function runSmoke(): Promise<void> {
  const contextConfig = resolveSmokeContextConfig()
  const smokeCodexHome = mkdtempSync(
    path.join(os.tmpdir(), 'catimation-codex-compaction-smoke-'),
  )

  // Production boot seeds these transport-bearing entries before launch.
  // Reproduce only their non-secret shape so strict config validation accepts
  // the same dotted runtime overrides as the application.
  writeFileSync(
    path.join(smokeCodexHome, 'config.toml'),
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

  console.log(`SMOKE_CONTEXT_CONFIG=${JSON.stringify(contextConfig)}`)

  const backend = new CodexLocalBackend({
    resourceRoot,
    codexHome: smokeCodexHome,
    getModelContextConfig: () => ({ ...contextConfig }),
  })

  try {
    await backend.start()
    const { config } = await backend.readConfig()
    if (config.model_context_window !== contextConfig.modelContextWindow) {
      throw new Error(
        `config/read model_context_window mismatch: expected `
        + `${contextConfig.modelContextWindow}, received ${String(config.model_context_window)}`,
      )
    }
    if (
      config.model_auto_compact_token_limit
      !== contextConfig.modelAutoCompactTokenLimit
    ) {
      throw new Error(
        `config/read model_auto_compact_token_limit mismatch: expected `
        + `${contextConfig.modelAutoCompactTokenLimit}, received `
        + `${String(config.model_auto_compact_token_limit)}`,
      )
    }

    console.log('SMOKE_CONTEXT_OK')
  } finally {
    await backend.stop().catch(() => undefined)
    try {
      rmSync(smokeCodexHome, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      })
    } catch (error) {
      console.warn(
        '[compaction-smoke] temp cleanup deferred:',
        error instanceof Error ? error.message : error,
      )
    }
  }
}

async function main(): Promise<void> {
  let timeout: NodeJS.Timeout | undefined
  const guard = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(
      () => reject(new Error(`smoke timed out after ${SMOKE_TIMEOUT_MS}ms`)),
      SMOKE_TIMEOUT_MS,
    )
    timeout.unref?.()
  })

  try {
    await Promise.race([runSmoke(), guard])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

if (
  process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(__filename)
) {
  main().catch((error) => {
    console.error(
      '[compaction-smoke] FAIL:',
      error instanceof Error ? error.message : error,
    )
    process.exitCode = 1
  })
}
