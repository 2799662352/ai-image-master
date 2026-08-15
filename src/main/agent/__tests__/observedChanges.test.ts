// 这一层的全部价值在「什么时候**不**显示」。四个作废条件各一条用例 ——
// 少任何一条,用户就会看到一份看起来对、实则拿脏基线算出来的 diff。
import { describe, expect, it, vi } from 'vitest'
import { beginObservedChanges } from '../observedChanges'
import type { Snapshot } from '../workspaceSnapshot'
import type { FileChange } from '../../../types/agent-timeline'

function snap(complete = true): Snapshot {
  return { files: new Map(), skipped: new Set(), complete }
}

const change = (path: string): FileChange => ({
  path,
  operation: 'edit',
  diff: '@@ -1 +1 @@\n-a\n+b',
  added: 1,
  removed: 1,
  source: 'observed',
})

function deps(over: Partial<Parameters<typeof beginObservedChanges>[0]> = {}) {
  return {
    roots: () => ['/w'],
    snapshot: vi.fn(async () => snap()),
    diff: vi.fn(() => [change('/w/a.md')]),
    ...over,
  }
}

describe('beginObservedChanges', () => {
  it('跑过命令且基线可信 → 给出观察到的改动', async () => {
    const t = beginObservedChanges(deps())
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([change('/w/a.md')])
  })

  it('本轮没跑过命令 → 不显示(apply_patch 那条路已全覆盖,不该猜)', async () => {
    const t = beginObservedChanges(deps())

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('命令比起始快照先到 → 基线可能已被污染,整轮作废', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const t = beginObservedChanges(deps({ snapshot: vi.fn(async () => { await gate; return snap() }) }))

    t.noteShellStarted() // 快照还没回来
    release()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('起始快照不完整 → 作废', async () => {
    const t = beginObservedChanges(deps({ snapshot: vi.fn(async () => snap(false)) }))
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('快照抛错 → 作废,不炸掉回合', async () => {
    const t = beginObservedChanges(
      deps({ snapshot: vi.fn(async () => { throw new Error('EACCES') }) }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('apply_patch 已报告过的路径要减掉,否则同一个文件出现两条', async () => {
    const t = beginObservedChanges(
      deps({ diff: vi.fn(() => [change('/w/a.md'), change('/w/b.md')]) }),
    )
    t.noteShellStarted()

    const out = await t.finish(new Set(['/w/a.md']))

    expect(out.map((c) => c.path)).toEqual(['/w/b.md'])
  })

  it('起始快照只拍一次,结束时再拍一次', async () => {
    const snapshot = vi.fn(async () => snap())
    const t = beginObservedChanges(deps({ snapshot }))
    t.noteShellStarted()
    t.noteShellStarted() // 多条命令不该多拍

    await t.finish(new Set())

    expect(snapshot).toHaveBeenCalledTimes(2)
  })
})
