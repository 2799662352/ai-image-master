import { describe, expect, it } from 'vitest'
import {
  dropSupersededStreamItems,
  dropSupersededStreamItemsInLastMessage,
  type Message,
  type TimelineItem,
} from '../agent-timeline'

/**
 * Guards against the cumulative-snapshot streaming pattern observed live on
 * 2026-06-10 (apiyi gateway, msg cmq7z96v60002ccn7zpsf7chw): every SSE chunk
 * arrived as a NEW `agentMessage` item carrying the FULL accumulated text,
 * preceded by a NEW empty `reasoning` item — 130 pairs in one reply, all
 * stacked into the same assistant bubble ("对话重复"). No error/willRetry
 * events fired, so the v4.3.29 stream-retry trim never engaged.
 */

function text(id: string, content: string): TimelineItem {
  return { type: 'text', id, startedAt: 1, content }
}

function reasoning(id: string, content: string): TimelineItem {
  return { type: 'reasoning', id, startedAt: 1, content, endedAt: 1 }
}

function shell(id: string): TimelineItem {
  return { type: 'shell', id, startedAt: 1, command: 'ls', stdout: '', stderr: '', exitCode: 0 }
}

describe('dropSupersededStreamItems', () => {
  it('drops an earlier text item that is a full prefix of the touched one', () => {
    const items = [text('msg-1', '我先读取你给的文本，确认原文'), text('msg-2', '我先读取你给的文本，确认原文的叙事和语气。')]
    const out = dropSupersededStreamItems(items, 'msg-2')
    expect(out.map((i) => i.id)).toEqual(['msg-2'])
  })

  it('drops an earlier exact-duplicate text item', () => {
    const items = [text('msg-1', '完全一样的一段话内容。'), text('msg-2', '完全一样的一段话内容。')]
    const out = dropSupersededStreamItems(items, 'msg-2')
    expect(out.map((i) => i.id)).toEqual(['msg-2'])
  })

  it('collapses the real-world snapshot chain (reasoning,text pairs with growing prefixes)', () => {
    const base = '我按原文的温柔、克制语气扩写了一版，保留核心意象。'
    const items: TimelineItem[] = []
    for (let n = 0; n < 5; n++) {
      items.push(reasoning(`rs-${n}`, ''))
      items.push(text(`msg-${n}`, base.slice(0, 10 + n * 4)))
    }
    // Simulate live arrival: dedup runs after each new text item gets content.
    let live: TimelineItem[] = []
    for (const it of items) {
      live = [...live, it]
      live = dropSupersededStreamItems(live, it.id)
    }
    const texts = live.filter((i) => i.type === 'text')
    const reasonings = live.filter((i) => i.type === 'reasoning')
    expect(texts).toHaveLength(1)
    expect((texts[0] as { content: string }).content).toBe(base.slice(0, 10 + 4 * 4))
    // empty reasoning snapshots collapse down to the final one
    expect(reasonings).toHaveLength(1)
  })

  it('keeps tool items between snapshots', () => {
    const items = [text('msg-1', '前缀前缀前缀前缀'), shell('call-1'), text('msg-2', '前缀前缀前缀前缀，然后继续。')]
    const out = dropSupersededStreamItems(items, 'msg-2')
    expect(out.map((i) => i.id)).toEqual(['call-1', 'msg-2'])
  })

  it('does NOT drop unrelated earlier paragraphs (no prefix relation)', () => {
    const items = [text('msg-1', '第一段：独立的内容。'), text('msg-2', '第二段：完全不同的内容。')]
    const out = dropSupersededStreamItems(items, 'msg-2')
    expect(out).toBe(items)
  })

  it('does NOT drop short repeated openings (below the 8-char floor)', () => {
    const items = [text('msg-1', '好的。'), text('msg-2', '好的。我们继续下一步的处理。')]
    const out = dropSupersededStreamItems(items, 'msg-2')
    expect(out.map((i) => i.id)).toEqual(['msg-1', 'msg-2'])
  })

  it('does NOT cross types (reasoning prefix never supersedes text)', () => {
    const items = [reasoning('rs-1', '这是一段足够长的思考内容'), text('msg-1', '这是一段足够长的思考内容，以及答案。')]
    const out = dropSupersededStreamItems(items, 'msg-1')
    expect(out.map((i) => i.id)).toEqual(['rs-1', 'msg-1'])
  })

  it('keeps an empty reasoning item when followed by non-reasoning content', () => {
    // Gateways that strip reasoning deltas leave legit empty reasoning items
    // — those still render a useful "Thought" pill before the answer.
    const items = [reasoning('rs-1', ''), text('msg-1', '答案内容足够长足够长。')]
    const out = dropSupersededStreamItems(items, 'msg-1')
    expect(out.map((i) => i.id)).toEqual(['rs-1', 'msg-1'])
  })

  it('returns the same reference when nothing changes', () => {
    const items = [text('msg-1', '独立内容一二三四五六。')]
    expect(dropSupersededStreamItems(items, 'msg-1')).toBe(items)
  })
})

describe('dropSupersededStreamItemsInLastMessage', () => {
  it('only touches the last assistant message', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', createdAt: 1, items: [text('t0', '用户消息内容内容内容')] },
      {
        id: 'a1',
        role: 'assistant',
        createdAt: 2,
        items: [text('msg-1', '前缀前缀前缀前缀'), text('msg-2', '前缀前缀前缀前缀，完整版。')],
      },
    ]
    const out = dropSupersededStreamItemsInLastMessage(messages, 'msg-2')
    expect(out[1].items.map((i) => i.id)).toEqual(['msg-2'])
    expect(out[0]).toBe(messages[0])
  })

  it('no-ops when the last message is from the user', () => {
    const messages: Message[] = [
      { id: 'u1', role: 'user', createdAt: 1, items: [text('t0', '用户消息内容内容内容')] },
    ]
    expect(dropSupersededStreamItemsInLastMessage(messages, 't0')).toBe(messages)
  })
})
