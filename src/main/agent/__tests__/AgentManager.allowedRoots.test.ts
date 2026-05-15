import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentInput, IAgentBackend } from '../types'
import type { AgentStreamEvent } from '../../../types/agent'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-roots-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

function makeBackend(): IAgentBackend & { calls: Array<{ threadId: string | undefined; input: AgentInput }> } {
  const calls: Array<{ threadId: string | undefined; input: AgentInput }> = []
  return {
    calls,
    async start() {},
    async stop() {},
    isHealthy() { return true },
    async cancel() {},
    async *send(threadId: string | undefined, input: AgentInput): AsyncIterable<AgentStreamEvent> {
      calls.push({ threadId, input })
    },
  }
}

function flushMicrotasks(times = 5): Promise<void> {
  let p = Promise.resolve()
  for (let i = 0; i < times; i++) p = p.then(() => undefined)
  return p
}

describe('AgentManager allowed roots', () => {
  it('ignores non-array input without mutating writable roots', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir, backend: makeBackend() })
    expect(await mgr.setAllowedRoots('not-array')).toEqual([])
    expect(mgr.getSessionStatus().writableRoots).toEqual([])
  })

  it('keeps only existing absolute directories', async () => {
    const workspace = path.join(tmpDir, 'workspace')
    const file = path.join(tmpDir, 'file.txt')
    await fs.mkdir(workspace)
    await fs.writeFile(file, 'not a dir')

    const mgr = new AgentManager({ userDataDir: tmpDir, backend: makeBackend() })
    const accepted = await mgr.setAllowedRoots([workspace, file, path.join(tmpDir, 'missing'), 123])

    expect(accepted).toEqual([path.resolve(workspace)])
    expect(mgr.getSessionStatus().writableRoots).toEqual([path.resolve(workspace)])
  })

  it('uses the first allowed root as cwd when sending', async () => {
    const workspace = path.join(tmpDir, 'workspace')
    await fs.mkdir(workspace)
    const backend = makeBackend()
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      backend,
      store: {
        createThread: async () => ({ id: 'thread-1' }),
        addMessage: async () => ({ id: 'msg-1' }),
        updateLastMessageAt: async () => undefined,
      } as any,
      attachments: { ingest: async () => [] } as any,
    })
    await mgr.setCodexApiKey('sk-test')
    await mgr.setAllowedRoots([workspace])

    await mgr.sendMessage({ content: 'hi', attachments: [] })
    await flushMicrotasks()

    expect(backend.calls[0]?.input.cwd).toBe(path.resolve(workspace))
  })
})
