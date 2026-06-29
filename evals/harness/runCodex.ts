import { spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildExecArgs } from './codexArgs'
import { resolveEvalConfig } from './env'
import { parseJsonl } from './jsonl'
import type { ThreadEvent } from './types'

/** A canned tool the stub MCP exposes to the agent. */
export interface StubToolDef {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
  /** JSON returned (as text content) on a successful call. Defaults to `{}`. */
  cannedResult?: unknown
  /** When set, the tool returns an `isError` result carrying this message. */
  cannedError?: string
}

export interface RunCodexOptions {
  /** The user prompt that kicks off the turn. */
  prompt: string
  /** Tools the stub MCP exposes (with canned responses). */
  tools?: StubToolDef[]
  /** MCP server name the agent sees (default `catimation`). */
  mcpName?: string
  /** Override the model from CODEX_EVAL_MODEL. */
  model?: string
  /** Path to a JSON Schema for `--output-schema` rubric scoring. */
  outputSchemaFile?: string
  /** Hard wall-clock timeout (default 300s). */
  timeoutMs?: number
}

export interface RunCodexResult {
  /** Parsed JSONL event stream (the trajectory). */
  events: ThreadEvent[]
  /** Raw stdout (JSONL). */
  stdout: string
  /** Raw stderr (codex progress logs + stub diagnostics). */
  stderr: string
  /** Process exit code (`null` if killed). */
  exitCode: number | null
  /** True if the run was killed by the timeout. */
  timedOut: boolean
}

/**
 * Run ONE live agent turn: spawn the bundled `codex exec --json` against the
 * stub MCP, capture the JSONL stream, and return the parsed trajectory.
 *
 * Requires eval creds (see {@link resolveEvalConfig}); call from scenarios
 * gated behind `describe.skipIf(!hasEvalCreds())`.
 */
export async function runCodex(options: RunCodexOptions): Promise<RunCodexResult> {
  const config = resolveEvalConfig()
  const mcpName = options.mcpName ?? 'catimation'
  const tools = options.tools ?? []

  const args = buildExecArgs({
    prompt: options.prompt,
    model: options.model ?? config.model,
    outputSchemaFile: options.outputSchemaFile,
    provider: config.provider,
    mcp: {
      name: mcpName,
      command: process.execPath, // node — runs the plain .mjs stub directly
      args: [config.stubPath],
      env: { STUB_MCP_CONFIG: JSON.stringify({ tools }) },
    },
  })

  // Fresh temp cwd so codex never touches the repo (sandbox is read-only too).
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'codex-eval-'))
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    // Inject the key under BOTH the provider's declared env var (apiyi →
    // OPENAI_API_KEY) and OPENAI_API_KEY as a belt-and-suspenders default.
    OPENAI_API_KEY: config.apiKey,
    [config.providerEnvKey]: config.apiKey,
  }

  const timeoutMs = options.timeoutMs ?? 300_000

  return await new Promise<RunCodexResult>((resolve, reject) => {
    const child = spawn(config.binaryPath, args, { cwd, env })
    let stdout = ''
    let stderr = ''
    let timedOut = false

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGKILL')
    }, timeoutMs)
    timer.unref?.()

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => (stdout += d))
    child.stderr.on('data', (d: string) => (stderr += d))

    child.once('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.once('close', (code) => {
      clearTimeout(timer)
      resolve({ events: parseJsonl(stdout), stdout, stderr, exitCode: code, timedOut })
    })
  })
}
