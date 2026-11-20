/**
 * The bubble a media tool reports into — or nothing, when no chat owns the call.
 *
 * `openGenerationBubble` is the single place a tool-driven bubble is created;
 * these tests pin the two halves of its contract: with an owner every update
 * reaches THAT chat (never the open one), without an owner no update reaches
 * any chat.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { useAgentChatStore } from '../store'
import {
  DETACHED_NOTICE_MIN_INTERVAL_MS,
  DETACHED_OUTPUT_THREAD_ID,
  noteDetachedToolOutput,
  openGenerationBubble,
  resetDetachedToolOutputForTest,
} from '../detachedToolOutput'
import type { ArtifactItem, AttachmentRef } from '../../../../../types/agent-timeline'

const IMAGE: AttachmentRef = {
  id: 'a1',
  kind: 'image',
  name: 'a.png',
  mime: 'image/png',
  size: 0,
  uri: 'https://x/a.png',
}

function artifactsIn(threadId: string): ArtifactItem[] {
  const state = useAgentChatStore.getState()
  const messages = threadId === state.threadId ? state.messages : state.threadSlices[threadId]?.messages ?? []
  return messages.flatMap((m) => m.items).filter((i): i is ArtifactItem => i.type === 'artifact')
}

function everyMessageCount(): number {
  const state = useAgentChatStore.getState()
  return (
    state.messages.length
    + Object.values(state.threadSlices).reduce((n, slice) => n + (slice?.messages.length ?? 0), 0)
  )
}

const detachedNotices = () =>
  useAgentChatStore.getState().notices.filter((n) => n.kind === 'toolOutputDetached')

beforeEach(() => {
  resetDetachedToolOutputForTest()
  useAgentChatStore.setState({ messages: [], threadId: 'open', threadSlices: {}, notices: [] })
})

describe('openGenerationBubble — a call some chat owns', () => {
  it('opens the bubble in the owning chat, not the open one', () => {
    const bubble = openGenerationBubble('a cat', 'owner')

    expect(bubble.itemId).toEqual(expect.any(String))
    expect(artifactsIn('open')).toHaveLength(0)
    expect(artifactsIn('owner')).toHaveLength(1)
    expect(artifactsIn('owner')[0]).toMatchObject({ id: bubble.itemId, status: 'generating', prompt: 'a cat' })
  })

  it('carries the media kind (and omits it for images)', () => {
    openGenerationBubble('v', 'owner', 'video')
    openGenerationBubble('a', 'owner', 'audio')
    openGenerationBubble('i', 'owner')

    expect(artifactsIn('owner').map((i) => i.mediaKind)).toEqual(['video', 'audio', undefined])
  })

  it('every later update lands on that same bubble in that same chat', () => {
    const bubble = openGenerationBubble('a cat', 'owner')

    bubble.progress('排队中')
    expect(artifactsIn('owner')[0].progressText).toBe('排队中')

    bubble.resolve([IMAGE])
    expect(artifactsIn('owner')[0]).toMatchObject({ status: 'done', artifacts: [IMAGE] })

    bubble.annotate({ status: 'saved', paths: ['C:\\a.png'] })
    expect(artifactsIn('owner')[0].save).toEqual({ status: 'saved', paths: ['C:\\a.png'] })

    const swapped = { ...IMAGE, uri: 'local-file:///C:/a.png' }
    bubble.replaceArtifacts([swapped])
    expect(artifactsIn('owner')[0].artifacts).toEqual([swapped])

    expect(artifactsIn('open')).toHaveLength(0)
    expect(everyMessageCount()).toBe(1)
  })

  it('fail marks that bubble as an error', () => {
    const bubble = openGenerationBubble('a cat', 'owner')
    bubble.fail('boom')

    expect(artifactsIn('owner')[0]).toMatchObject({ status: 'error', error: 'boom' })
  })

  // The user can switch chats while a render is in flight.
  it('keeps following the owning chat when the user switches to it and away again', () => {
    const bubble = openGenerationBubble('a cat', 'owner')

    // "owner" becomes the open chat: its slice is loaded into `messages`.
    useAgentChatStore.setState((s) => ({
      threadId: 'owner',
      messages: s.threadSlices.owner?.messages ?? [],
      threadSlices: {},
    }))
    bubble.resolve([IMAGE])

    expect(artifactsIn('owner')[0].status).toBe('done')
  })

  it('never raises the detached notice', () => {
    const bubble = openGenerationBubble('a cat', 'owner')
    bubble.resolve([IMAGE])

    expect(detachedNotices()).toHaveLength(0)
  })
})

describe('openGenerationBubble — a call no chat owns', () => {
  it.each([undefined, ''])('threadId %j opens no bubble anywhere and has no item id', (threadId) => {
    const bubble = openGenerationBubble('stray', threadId)

    expect(bubble.itemId).toBeUndefined()
    expect(everyMessageCount()).toBe(0)
  })

  it('no update reaches any chat', () => {
    const bubble = openGenerationBubble('stray', undefined, 'video')

    bubble.progress('排队中')
    bubble.resolve([IMAGE])
    bubble.annotate({ status: 'saved' })
    bubble.replaceArtifacts([IMAGE])
    bubble.fail('boom')

    expect(everyMessageCount()).toBe(0)
  })

  it('resolve — output now exists where the user will not see it — raises the notice', () => {
    openGenerationBubble('stray', undefined).resolve([IMAGE])

    const notices = detachedNotices()
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ id: 'tool-output-detached', level: 'info' })
  })

  it.each(['progress', 'fail', 'annotate', 'replaceArtifacts'] as const)('%s alone raises nothing', (method) => {
    const bubble = openGenerationBubble('stray', undefined)
    if (method === 'progress') bubble.progress('x')
    if (method === 'fail') bubble.fail('boom')
    if (method === 'annotate') bubble.annotate({ status: 'pending' })
    if (method === 'replaceArtifacts') bubble.replaceArtifacts([IMAGE])

    expect(detachedNotices()).toHaveLength(0)
  })
})

describe('noteDetachedToolOutput — once per window, not once per output', () => {
  // Pinned so the comparisons below cannot pass by the window being 0 or huge.
  it('the window is ten minutes', () => {
    expect(DETACHED_NOTICE_MIN_INTERVAL_MS).toBe(10 * 60_000)
  })

  it('a burst produces one notice', () => {
    const t0 = 1_800_000_000_000
    for (let i = 0; i < 50; i++) noteDetachedToolOutput(t0 + i * 1000)

    expect(detachedNotices()).toHaveLength(1)
  })

  it('stays quiet after the user dismisses it, until the window has passed', () => {
    const t0 = 1_800_000_000_000
    noteDetachedToolOutput(t0)
    useAgentChatStore.getState().dismissNotice('tool-output-detached')

    noteDetachedToolOutput(t0 + DETACHED_NOTICE_MIN_INTERVAL_MS - 1)
    expect(detachedNotices()).toHaveLength(0)

    noteDetachedToolOutput(t0 + DETACHED_NOTICE_MIN_INTERVAL_MS)
    expect(detachedNotices()).toHaveLength(1)
  })

  it('says the output was saved and where to look, and names no chat', () => {
    noteDetachedToolOutput(1_800_000_000_000)

    const [notice] = detachedNotices()
    expect(notice.message).toContain('没有显示在任何对话里')
    expect(notice.message).toContain('已保存')
    expect(notice.message).toContain('历史记录')
  })
})

describe('the detached pseudo thread', () => {
  // The attachments IPC rejects an empty thread id, and a real thread id is a
  // cuid — this must be neither.
  it('is a non-empty id that cannot collide with a real conversation id', () => {
    expect(DETACHED_OUTPUT_THREAD_ID).toBe('detached')
    expect(DETACHED_OUTPUT_THREAD_ID).not.toMatch(/^c[a-z0-9]{20,}$/)
  })
})
