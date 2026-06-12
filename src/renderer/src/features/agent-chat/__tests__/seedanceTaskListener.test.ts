/**
 * Seedance video-task → chat-bubble state machine.
 *
 * `generate_video` runs entirely in the main process; the renderer only sees
 * `seedance:task-update` broadcasts. These tests drive the pure handler with
 * synthetic updates and assert the bubble lifecycle: queued → running →
 * succeeded (+ decoupled persistence banner) / failed.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentChatStore } from '../store'
import { handleSeedanceTaskUpdate } from '../SeedanceTaskListener'
import { ServiceRegistry, SERVICE_KEYS } from '../../../services/ServiceBridge'
import { clearCodexArtifacts, getCodexArtifacts } from '../codexArtifactPersistence'
import type { ArtifactItem } from '../../../../../types/agent-timeline'
import type { SeedanceTaskUpdate } from '../../../../../types/seedance'

let taskSeq = 0

function makeUpdate(partial: Partial<SeedanceTaskUpdate>): SeedanceTaskUpdate {
  return {
    taskId: partial.taskId ?? `task-${taskSeq}`,
    prompt: '一只赛博猫在雨夜奔跑',
    model: '2.0-fast',
    resolution: '720p',
    ratio: '16:9',
    duration: 5,
    status: 'queued',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    persistence: 'idle',
    ...partial,
  }
}

function lastArtifact(): ArtifactItem {
  const { messages } = useAgentChatStore.getState()
  return messages[messages.length - 1].items[0] as ArtifactItem
}

beforeEach(() => {
  taskSeq += 1
  useAgentChatStore.setState({ messages: [] })
  ServiceRegistry.clear()
  clearCodexArtifacts('thread-1')
})

describe('seedance task-update → artifact bubble', () => {
  it('queued update creates a generating VIDEO bubble with a progress line', () => {
    handleSeedanceTaskUpdate(makeUpdate({ status: 'queued' }))

    const item = lastArtifact()
    expect(item.status).toBe('generating')
    expect(item.mediaKind).toBe('video')
    expect(item.prompt).toBe('一只赛博猫在雨夜奔跑')
    expect(item.progressText).toContain('排队中')
  })

  it('running update edits the SAME bubble progress line (no new message)', () => {
    const taskId = `task-${taskSeq}`
    handleSeedanceTaskUpdate(makeUpdate({ taskId, status: 'queued' }))
    handleSeedanceTaskUpdate(
      makeUpdate({ taskId, status: 'running', createdAt: Date.now() - 23_000 }),
    )

    expect(useAgentChatStore.getState().messages).toHaveLength(1)
    const item = lastArtifact()
    expect(item.status).toBe('generating')
    expect(item.progressText).toMatch(/正在生成视频 · \d+s/)
  })

  it('succeeded with persistence still running resolves with the proxy URL + pending banner', () => {
    const taskId = `task-${taskSeq}`
    handleSeedanceTaskUpdate(makeUpdate({ taskId, status: 'running' }))
    handleSeedanceTaskUpdate(
      makeUpdate({
        taskId,
        status: 'succeeded',
        videoUrl: 'https://ark.example/video.mp4',
        persistence: 'running',
      }),
    )

    const item = lastArtifact()
    expect(item.status).toBe('done')
    expect(item.artifacts).toHaveLength(1)
    expect(item.artifacts[0].kind).toBe('video')
    expect(item.artifacts[0].uri).toBe('https://ark.example/video.mp4')
    expect(item.save?.status).toBe('pending')
  })

  it('persistence done swaps in the local mp4, marks saved, and records history + anchor', async () => {
    const addToHistory = vi.fn().mockResolvedValue({ id: 42 })
    ServiceRegistry.register(SERVICE_KEYS.HISTORY_DATA, {
      init: vi.fn().mockResolvedValue(undefined),
      addToHistory,
    })
    // Make thread-1 the ACTIVE thread so the bubble lands in `messages`
    // (otherwise patchThreadMessages routes it into threadSlices['thread-1']).
    useAgentChatStore.setState({ threadId: 'thread-1' })

    const taskId = `task-${taskSeq}`
    handleSeedanceTaskUpdate(makeUpdate({ taskId, threadId: 'thread-1', status: 'running' }))
    handleSeedanceTaskUpdate(
      makeUpdate({
        taskId,
        threadId: 'thread-1',
        status: 'succeeded',
        videoUrl: 'https://ark.example/video.mp4',
        localPath: 'C:\\data\\uploads\\seedance-x.mp4',
        persistence: 'done',
      }),
    )
    // persistHistory is async fire-and-forget; let it settle.
    await vi.waitFor(() => expect(addToHistory).toHaveBeenCalledTimes(1))

    const item = lastArtifact()
    expect(item.artifacts[0].uri).toBe('file:///C:/data/uploads/seedance-x.mp4')
    expect(item.save?.status).toBe('saved')
    expect(item.save?.dir).toBe('C:\\data\\uploads')
    expect(item.save?.paths).toEqual(['C:\\data\\uploads\\seedance-x.mp4'])

    expect(addToHistory).toHaveBeenCalledWith(
      'codex-video',
      '一只赛博猫在雨夜奔跑',
      ['file:///C:/data/uploads/seedance-x.mp4'],
      '16:9',
      'seedance-2.0-fast',
    )
    const anchors = getCodexArtifacts('thread-1')
    expect(anchors).toHaveLength(1)
    expect(anchors[0]).toMatchObject({
      id: `codex-video-${taskId}`,
      historyId: 42,
      kind: 'video',
      paths: ['C:\\data\\uploads\\seedance-x.mp4'],
    })
  })

  it('persistence failed keeps the playable video but shows the failed-save banner', () => {
    const taskId = `task-${taskSeq}`
    handleSeedanceTaskUpdate(
      makeUpdate({
        taskId,
        status: 'succeeded',
        videoUrl: 'https://ark.example/video.mp4',
        persistence: 'failed',
      }),
    )

    const item = lastArtifact()
    expect(item.status).toBe('done')
    expect(item.artifacts[0].uri).toBe('https://ark.example/video.mp4')
    expect(item.save?.status).toBe('failed')
  })

  it('failed update marks the bubble error with the upstream message', () => {
    const taskId = `task-${taskSeq}`
    handleSeedanceTaskUpdate(makeUpdate({ taskId, status: 'running' }))
    handleSeedanceTaskUpdate(
      makeUpdate({ taskId, status: 'failed', error: 'OutputVideoSensitive: blocked' }),
    )

    const item = lastArtifact()
    expect(item.status).toBe('error')
    expect(item.error).toBe('OutputVideoSensitive: blocked')
  })

  it('updateGenerationProgress is a no-op once the item settled', () => {
    const chat = useAgentChatStore.getState()
    const id = chat.beginImageGeneration('p', undefined, 'video')
    chat.failImageGeneration(id, 'boom')
    const before = useAgentChatStore.getState().messages
    useAgentChatStore.getState().updateGenerationProgress(id, 'late progress')
    const item = lastArtifact()
    expect(item.progressText).toBeUndefined()
    expect(useAgentChatStore.getState().messages).not.toBe(undefined)
    expect(before[before.length - 1].items[0]).toMatchObject({ status: 'error' })
  })
})
