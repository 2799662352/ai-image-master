import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AgentManager } from '../AgentManager'
import type { AgentStreamEvent } from '../../../types/agent'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-mgr-test-'))
})

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('AgentManager codex api key', () => {
  it('returns empty string when codex-agent.json is absent', () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('loads codex api key from disk on construction', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ openaiApiKey: 'sk-stored' }),
      'utf8',
    )
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('sk-stored')
  })

  it('returns empty string when codex-agent.json is malformed', async () => {
    await fs.writeFile(path.join(tmpDir, 'codex-agent.json'), 'not json {{{', 'utf8')
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('returns empty string when codex-agent.json has no openaiApiKey field', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-agent.json'),
      JSON.stringify({ other: 'value' }),
      'utf8',
    )
    const mgr = new AgentManager({ userDataDir: tmpDir })
    expect(mgr.getCodexApiKey()).toBe('')
  })

  it('setCodexApiKey atomically writes to disk and updates the cache', async () => {
    const mgr = new AgentManager({ userDataDir: tmpDir })
    await mgr.setCodexApiKey('  sk-new  ')

    expect(mgr.getCodexApiKey()).toBe('sk-new')

    const onDisk = JSON.parse(
      await fs.readFile(path.join(tmpDir, 'codex-agent.json'), 'utf8'),
    )
    expect(onDisk.openaiApiKey).toBe('sk-new')

    const entries = await fs.readdir(tmpDir)
    expect(entries).not.toContain('codex-agent.json.tmp')
  })

  it('a second AgentManager construction reads back what setCodexApiKey wrote', async () => {
    const writer = new AgentManager({ userDataDir: tmpDir })
    await writer.setCodexApiKey('sk-persist')

    const reader = new AgentManager({ userDataDir: tmpDir })
    expect(reader.getCodexApiKey()).toBe('sk-persist')
  })
})

describe('AgentManager sendMessage empty-key gate', () => {
  it('emits error event and does not start backend when sendMessage called with empty key', async () => {
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      eventSink: (event) => events.push(event),
    })

    const result = await mgr.sendMessage({
      threadId: 't1',
      content: 'hi',
      attachments: [],
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      threadId: 't1',
      error: '请在设置页填写 Codex Agent API Key',
    })
    expect(result.threadId).toBe('t1')
  })

  it('uses a placeholder threadId when sendMessage called without threadId and key is empty', async () => {
    const events: AgentStreamEvent[] = []
    const mgr = new AgentManager({
      userDataDir: tmpDir,
      eventSink: (event) => events.push(event),
    })

    await mgr.sendMessage({ content: 'hi', attachments: [] })

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('error')
    expect(events[0]?.error).toBe('请在设置页填写 Codex Agent API Key')
    expect(typeof events[0]?.threadId).toBe('string')
    expect(events[0]?.threadId.length).toBeGreaterThan(0)
  })

  it('does not invoke store/attachments when key is empty', async () => {
    let createCalls = 0
    let ingestCalls = 0
    const fakeStore = {
      createThread: async () => {
        createCalls += 1
        return { id: 'should-not-happen' }
      },
    } as any
    const fakeAttachments = {
      ingest: async () => {
        ingestCalls += 1
        return []
      },
    } as any

    const mgr = new AgentManager({
      userDataDir: tmpDir,
      store: fakeStore,
      attachments: fakeAttachments,
      eventSink: () => {},
    })

    await mgr.sendMessage({ threadId: 't-empty', content: 'hi', attachments: [] })

    expect(createCalls).toBe(0)
    expect(ingestCalls).toBe(0)
  })
})
