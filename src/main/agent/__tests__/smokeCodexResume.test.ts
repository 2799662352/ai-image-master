import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { parse as parseToml } from 'toml'
import { afterEach, describe, expect, it } from 'vitest'
import {
  allocateFreeLoopbackPorts,
  assertResumedThreadId,
  buildResumeSpawnEnv,
  prepareResumeCodexHome,
  waitForPersistedRollout,
} from '../../../../evals/harness/resumeClient'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  )
})

async function canBind(port: number): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

describe('smoke-codex-resume ports', () => {
  it('allocates distinct released loopback ports', async () => {
    const ports = await allocateFreeLoopbackPorts(4)

    expect(new Set(ports).size).toBe(4)
    for (const port of ports) {
      expect(Number.isSafeInteger(port)).toBe(true)
      expect(port).toBeGreaterThan(0)
      await expect(canBind(port)).resolves.toBe(true)
    }
  })
})

describe('resume rollout persistence', () => {
  it('strips provider credentials from the offline core environment', () => {
    const env = buildResumeSpawnEnv(
      'C:\\temp\\codex-home',
      { offline: true },
      {
        PATH: 'C:\\Windows',
        OPENAI_API_KEY: 'secret',
        MIAU_API_KEY: 'secret',
        RIGHTCODE_TOKEN: 'secret',
        CUSTOM_SECRET: 'secret',
        NORMAL_FLAG: 'kept',
      },
    )

    expect(env).toMatchObject({
      PATH: 'C:\\Windows',
      CODEX_HOME: 'C:\\temp\\codex-home',
      NORMAL_FLAG: 'kept',
    })
    expect(env).not.toHaveProperty('OPENAI_API_KEY')
    expect(env).not.toHaveProperty('MIAU_API_KEY')
    expect(env).not.toHaveProperty('RIGHTCODE_TOKEN')
    expect(env).not.toHaveProperty('CUSTOM_SECRET')
  })

  it('requires thread/resume to return the exact persisted thread id', () => {
    expect(() => assertResumedThreadId({}, 'thread-1')).toThrow(
      'thread/resume did not return a thread id',
    )
    expect(() => assertResumedThreadId(
      { thread: { id: 'thread-2' } },
      'thread-1',
    )).toThrow('thread-2 != thread-1')
    expect(() => assertResumedThreadId(
      { thread: { id: 'thread-1' } },
      'thread-1',
    )).not.toThrow()
  })

  it('seeds production MCP transports before standalone launch', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'resume-client-test-'))
    tempDirs.push(codexHome)
    const resourceRoot = path.join(codexHome, 'resources')

    await prepareResumeCodexHome(codexHome, resourceRoot)

    const config = parseToml(
      await readFile(path.join(codexHome, 'config.toml'), 'utf8'),
    ) as {
      mcp_servers: Record<
        string,
        { command: string; args: string[]; enabled: boolean }
      >
    }
    expect(config.mcp_servers.apiyi).toMatchObject({
      command: process.execPath,
      args: [path.join(resourceRoot, 'apiyi-mcp', 'dist', 'index.js')],
      enabled: true,
    })
    expect(config.mcp_servers.cinematography_kb).toMatchObject({
      command: process.execPath,
      args: [path.join(resourceRoot, 'cinematography-kb-mcp', 'index.js')],
      enabled: true,
    })
  })

  it('waits until the rollout contains session data', async () => {
    const codexHome = await mkdtemp(path.join(os.tmpdir(), 'resume-rollout-test-'))
    tempDirs.push(codexHome)
    const threadId = 'thread-persisted'
    const sessionDir = path.join(codexHome, 'sessions', '2026', '07', '13')
    const rolloutPath = path.join(sessionDir, `rollout-${threadId}.jsonl`)
    await mkdir(sessionDir, { recursive: true })
    await writeFile(rolloutPath, '', 'utf8')

    const waiting = waitForPersistedRollout(codexHome, threadId, {
      timeoutMs: 1_000,
      pollIntervalMs: 10,
    })
    await new Promise((resolve) => setTimeout(resolve, 30))
    await writeFile(rolloutPath, '{"type":"session_meta"}\n', 'utf8')

    await expect(waiting).resolves.toBe(rolloutPath)
  })
})
