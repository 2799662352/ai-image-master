import { describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  cleanupRetriedDuplicates,
  dedupeRetryArtifactItems,
  runStartupDedupOnce,
} from '../historyDedup'
import type { TimelineItem } from '../../../types/agent-timeline'

function text(id: string, content: string): TimelineItem {
  return { id, type: 'text', content, startedAt: 1 }
}

function reasoning(id: string, content: string): TimelineItem {
  return { id, type: 'reasoning', content, startedAt: 1 }
}

function shell(id: string): TimelineItem {
  return { id, type: 'shell', command: 'ls', stdout: '', stderr: '', startedAt: 1 }
}

describe('dedupeRetryArtifactItems', () => {
  it('drops an earlier text item that a later text item extends (prefix dup)', () => {
    const partial = '我已按技能里的原则把重点收束成三个方向：首'
    const full = '我已按技能里的原则把重点收束成三个方向：首先是……（完整版本）'
    const items = [reasoning('r1', '思路A'), text('t1', partial), reasoning('r2', '思路B'), text('t2', full)]
    const result = dedupeRetryArtifactItems(items)
    expect(result).not.toBeNull()
    expect(result!.map((i) => i.id)).toEqual(['r1', 'r2', 't2'])
  })

  it('drops an earlier text item that exactly equals a later one', () => {
    const para = '这是一段完整重复的回答段落，长度足够触发去重。'
    const items = [text('t1', para), reasoning('r1', '中间思考'), text('t2', para)]
    const result = dedupeRetryArtifactItems(items)
    expect(result!.map((i) => i.id)).toEqual(['r1', 't2'])
  })

  it('keeps legitimate distinct text items', () => {
    const items = [text('t1', '第一段：分析当前问题的成因。'), shell('s1'), text('t2', '第二段：给出修复建议。')]
    expect(dedupeRetryArtifactItems(items)).toBeNull()
  })

  it('does not dedupe short prefixes below the safety threshold', () => {
    // "好的。" is a prefix of the later text but too short to be a reliable
    // retry-artifact signal — must be preserved.
    const items = [text('t1', '好的。'), shell('s1'), text('t2', '好的。我们继续推进下一步的修复工作。')]
    expect(dedupeRetryArtifactItems(items)).toBeNull()
  })

  it('dedupes duplicated reasoning items but keeps distinct ones', () => {
    const dup = '让我仔细分析一下这个问题的根本原因所在。'
    const items = [reasoning('r1', dup), text('t1', '部分回答内容已经写了一半了'), reasoning('r2', dup), text('t2', '部分回答内容已经写了一半了，然后是完整的结尾。')]
    const result = dedupeRetryArtifactItems(items)
    expect(result!.map((i) => i.id)).toEqual(['r2', 't2'])
  })

  it('never compares across item types', () => {
    const same = '同样的内容出现在思考和正文里，这是合法的。'
    const items = [reasoning('r1', same), text('t1', same)]
    expect(dedupeRetryArtifactItems(items)).toBeNull()
  })

  it('never touches tool items even with identical-looking payloads', () => {
    const items = [shell('s1'), shell('s2'), text('t1', '执行完毕，两次都是真实运行的命令。')]
    expect(dedupeRetryArtifactItems(items)).toBeNull()
  })

  it('ignores trailing whitespace when comparing', () => {
    const para = '内容相同但是结尾多了一个换行符的段落。'
    const items = [text('t1', `${para}\n`), text('t2', para)]
    const result = dedupeRetryArtifactItems(items)
    expect(result!.map((i) => i.id)).toEqual(['t2'])
  })

  it('returns null for malformed input', () => {
    expect(dedupeRetryArtifactItems('not-an-array')).toBeNull()
    expect(dedupeRetryArtifactItems(null)).toBeNull()
    expect(dedupeRetryArtifactItems([{ noType: true }])).toBeNull()
  })
})

describe('cleanupRetriedDuplicates', () => {
  function makePrisma(rows: Array<{ id: string; items: unknown }>): {
    prisma: import('@prisma/client').PrismaClient
    update: ReturnType<typeof vi.fn>
  } {
    const update = vi.fn().mockResolvedValue({})
    const prisma = {
      agentMessage: {
        findMany: vi.fn().mockResolvedValue(rows),
        update,
      },
    } as unknown as import('@prisma/client').PrismaClient
    return { prisma, update }
  }

  it('rewrites only rows whose items actually changed', async () => {
    const para = '这是一段足够长的、会被识别为重试残留的重复段落。'
    const dirty = [text('t1', para), text('t2', para)]
    const clean = [text('t1', '完全正常的一条消息内容。')]
    const { prisma, update } = makePrisma([
      { id: 'm1', items: dirty },
      { id: 'm2', items: clean },
    ])

    const stats = await cleanupRetriedDuplicates(prisma)

    expect(update).toHaveBeenCalledTimes(1)
    expect(update).toHaveBeenCalledWith({
      where: { id: 'm1' },
      data: { items: [expect.objectContaining({ id: 't2' })] },
    })
    expect(stats).toEqual({ scanned: 2, cleaned: 1, itemsRemoved: 1 })
  })

  it('only scans assistant messages', async () => {
    const { prisma } = makePrisma([])
    await cleanupRetriedDuplicates(prisma)
    expect(prisma.agentMessage.findMany).toHaveBeenCalledWith({
      where: { role: 'assistant' },
      select: { id: true, items: true },
    })
  })

  it('keeps going when a single row update fails', async () => {
    const para = '足够长的重复段落，用来触发两行都需要清洗的场景。'
    const dirty = [text('t1', para), text('t2', para)]
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('row locked'))
      .mockResolvedValueOnce({})
    const prisma = {
      agentMessage: {
        findMany: vi.fn().mockResolvedValue([
          { id: 'm1', items: dirty },
          { id: 'm2', items: dirty },
        ]),
        update,
      },
    } as unknown as import('@prisma/client').PrismaClient

    const stats = await cleanupRetriedDuplicates(prisma)
    expect(update).toHaveBeenCalledTimes(2)
    expect(stats.cleaned).toBe(1)
  })
})

describe('runStartupDedupOnce', () => {
  function tmpMarker(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dedup-test-'))
    return path.join(dir, 'retry-dedup-v1.done')
  }

  it('runs the cleanup and writes the marker on success', async () => {
    const markerPath = tmpMarker()
    const prisma = {
      agentMessage: { findMany: vi.fn().mockResolvedValue([]), update: vi.fn() },
    } as unknown as import('@prisma/client').PrismaClient

    const stats = await runStartupDedupOnce({ prisma, markerPath })
    expect(stats).toEqual({ scanned: 0, cleaned: 0, itemsRemoved: 0 })
    expect(fs.existsSync(markerPath)).toBe(true)
  })

  it('skips when the marker already exists', async () => {
    const markerPath = tmpMarker()
    fs.writeFileSync(markerPath, '{}')
    const findMany = vi.fn()
    const prisma = {
      agentMessage: { findMany, update: vi.fn() },
    } as unknown as import('@prisma/client').PrismaClient

    const stats = await runStartupDedupOnce({ prisma, markerPath })
    expect(stats).toBeNull()
    expect(findMany).not.toHaveBeenCalled()
  })

  it('does not write the marker when the scan itself fails, so next launch retries', async () => {
    const markerPath = tmpMarker()
    const prisma = {
      agentMessage: {
        findMany: vi.fn().mockRejectedValue(new Error('db down')),
        update: vi.fn(),
      },
    } as unknown as import('@prisma/client').PrismaClient

    await expect(runStartupDedupOnce({ prisma, markerPath })).rejects.toThrow('db down')
    expect(fs.existsSync(markerPath)).toBe(false)
  })
})
