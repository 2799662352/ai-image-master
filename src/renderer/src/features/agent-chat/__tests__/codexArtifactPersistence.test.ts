import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Message } from '../../../../../types/agent-timeline'
import {
  clearCodexArtifacts,
  getCodexArtifacts,
  mergeCodexArtifacts,
  recordCodexArtifact,
} from '../codexArtifactPersistence'

const THREAD = 'thread-1'

function userMsg(id: string, createdAt: number): Message {
  return {
    id,
    role: 'user',
    createdAt,
    items: [{ type: 'text', id: `${id}-t`, startedAt: createdAt, content: 'hi' }],
  }
}

describe('codexArtifactPersistence', () => {
  beforeEach(() => globalThis.localStorage?.clear())
  afterEach(() => globalThis.localStorage?.clear())

  it('records and reads anchors per thread', () => {
    recordCodexArtifact(THREAD, { id: 'codex-artifact-1', createdAt: 100, prompt: 'cat', historyId: 1 })
    const anchors = getCodexArtifacts(THREAD)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ id: 'codex-artifact-1', historyId: 1, prompt: 'cat' })
    expect(getCodexArtifacts('other')).toEqual([])
  })

  it('replaces an anchor on id collision (idempotent re-record)', () => {
    recordCodexArtifact(THREAD, { id: 'a', createdAt: 1, historyId: 1 })
    recordCodexArtifact(THREAD, { id: 'a', createdAt: 2, historyId: 1, prompt: 'updated' })
    const anchors = getCodexArtifacts(THREAD)
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({ createdAt: 2, prompt: 'updated' })
  })

  it('clears anchors for a thread', () => {
    recordCodexArtifact(THREAD, { id: 'a', createdAt: 1, historyId: 1 })
    clearCodexArtifacts(THREAD)
    expect(getCodexArtifacts(THREAD)).toEqual([])
  })

  it('rebuilds an artifact bubble from the history URLs and appends it after the server messages', () => {
    recordCodexArtifact(THREAD, { id: 'codex-artifact-7', createdAt: 150, prompt: 'orange cat', historyId: 7 })
    const server = [userMsg('u1', 100), userMsg('u2', 200)]

    const merged = mergeCodexArtifacts(THREAD, server, (id) =>
      id === 7 ? ['https://cdn.example/cat.png'] : undefined,
    )

    // Appended at the END — matches where `beginImageGeneration` put it live.
    expect(merged.map((m) => m.id)).toEqual(['u1', 'u2', 'msg-codex-artifact-7'])
    const bubble = merged[2]
    expect(bubble.role).toBe('assistant')
    const item = bubble.items[0]
    expect(item.type).toBe('artifact')
    if (item.type === 'artifact') {
      expect(item.status).toBe('done')
      expect(item.artifacts[0].uri).toBe('https://cdn.example/cat.png')
      expect(item.prompt).toBe('orange cat')
    }
  })

  it('never floats a rebuilt bubble above the server messages, even when server times read newer (reload clock skew)', () => {
    // Reproduces the reported bug: after closing/reopening, server messages can
    // come back stamped with the reopen time (newer than the anchor). The image
    // must stay at the bottom where it was generated, not drift to the top.
    recordCodexArtifact(THREAD, { id: 'codex-artifact-7', createdAt: 150, prompt: 'cat', historyId: 7 })
    const reopenedAt = 9_000_000_000_000
    const server = [userMsg('u1', reopenedAt), userMsg('u2', reopenedAt)]

    const merged = mergeCodexArtifacts(THREAD, server, () => ['https://cdn.example/cat.png'])

    expect(merged.map((m) => m.id)).toEqual(['u1', 'u2', 'msg-codex-artifact-7'])
  })

  it('appends multiple anchors after the server messages, ordered among themselves by createdAt', () => {
    recordCodexArtifact(THREAD, { id: 'codex-artifact-2', createdAt: 320, historyId: 2 })
    recordCodexArtifact(THREAD, { id: 'codex-artifact-1', createdAt: 120, historyId: 1 })
    const server = [userMsg('u1', 100), userMsg('u2', 300)]

    const merged = mergeCodexArtifacts(THREAD, server, (id) => [`https://cdn.example/${id}.png`])

    expect(merged.map((m) => m.id)).toEqual([
      'u1',
      'u2',
      'msg-codex-artifact-1',
      'msg-codex-artifact-2',
    ])
  })

  it('skips anchors whose history record no longer resolves to a URL', () => {
    recordCodexArtifact(THREAD, { id: 'gone', createdAt: 150, historyId: 99 })
    const server = [userMsg('u1', 100)]
    const merged = mergeCodexArtifacts(THREAD, server, () => undefined)
    expect(merged).toEqual(server)
  })

  it('drops pending placeholder URLs (upload not yet settled)', () => {
    recordCodexArtifact(THREAD, { id: 'p', createdAt: 150, historyId: 5 })
    const server = [userMsg('u1', 100)]
    const merged = mergeCodexArtifacts(THREAD, server, () => ['pending:123'])
    expect(merged).toEqual(server)
  })

  it('returns server messages untouched when no anchors exist', () => {
    const server = [userMsg('u1', 100)]
    expect(mergeCodexArtifacts(THREAD, server, () => ['x'])).toBe(server)
  })
})
