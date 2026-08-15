// 这一层的全部价值在「什么时候**不**显示」。四个作废条件都要有用例 ——
// 少任何一条,用户就会看到一份看起来对、实则拿脏基线算出来的 diff。
//
// 「快照不完整」和「快照抛错」各拆成起始/结束两条:两次快照共用一个假实现时,
// 一条用例会同时满足两个判断,删掉其中任何一个它都还是绿的 —— 那样的用例挡不住
// 任何回归。所以这里用「第 1 次成功、第 2 次出问题」的假实现把两端分开考。
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

/** 按调用次序给不同结果:`() => Snapshot` 就返回它,抛出就是快照失败。 */
function snapshotSequence(...calls: Array<() => Snapshot>) {
  let i = 0
  return vi.fn(async () => (calls[Math.min(i++, calls.length - 1)] as () => Snapshot)())
}

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

  it('起始快照不完整 → 作废(结束那次是完整的,只能靠 before 挡下来)', async () => {
    const t = beginObservedChanges(
      deps({ snapshot: snapshotSequence(() => snap(false), () => snap()) }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('结束快照不完整 → 作废(起始那次是完整的,只能靠 after 挡下来)', async () => {
    const t = beginObservedChanges(
      deps({ snapshot: snapshotSequence(() => snap(), () => snap(false)) }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('起始快照抛错 → 作废,不炸掉回合', async () => {
    const t = beginObservedChanges(
      deps({
        snapshot: snapshotSequence(
          () => { throw new Error('EACCES') },
          () => snap(),
        ),
      }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
  })

  it('结束快照抛错 → 作废,不炸掉回合(起始那次成功,走的是另一条 catch)', async () => {
    const t = beginObservedChanges(
      deps({
        snapshot: snapshotSequence(
          () => snap(),
          () => { throw new Error('EACCES') },
        ),
      }),
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

  it('finish 重复调用只算一次:第二次不能拿更晚的工作区当结束快照', async () => {
    // 这不是省一次 IO 的问题。第二次 finish 会重新拍一份**更晚**的结束快照,
    // 把回合结束之后发生的改动算进这一轮 —— 正是「给错的」。所以结果要记忆化。
    const snapshot = vi.fn(async () => snap())
    const t = beginObservedChanges(deps({ snapshot }))
    t.noteShellStarted()

    const first = await t.finish(new Set())
    const second = await t.finish(new Set())

    expect(snapshot).toHaveBeenCalledTimes(2) // 起始 1 次 + 结束 1 次,没有第 3 次
    expect(second).toEqual(first)
  })

  it('起始快照在构造时就拍掉,不是等第一条命令来了才拍', async () => {
    const snapshot = vi.fn(async () => snap())
    const t = beginObservedChanges(deps({ snapshot }))

    // 这一条才是设计的根:等看见命令再拍,基线里就已经含着那条命令造成的修改了。
    // 只断言总次数为 2 的话,一个「首次 noteShellStarted 时才懒拍」的实现同样能过。
    expect(snapshot).toHaveBeenCalledTimes(1)

    t.noteShellStarted()
    t.noteShellStarted() // 多条命令不该多拍
    expect(snapshot).toHaveBeenCalledTimes(1)

    await t.finish(new Set())

    expect(snapshot).toHaveBeenCalledTimes(2) // 第二次只发生在结束时
  })
})
