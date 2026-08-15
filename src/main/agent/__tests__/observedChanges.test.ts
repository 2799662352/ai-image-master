// 这一层的全部价值在「什么时候**不**显示」。四个作废条件都要有用例 ——
// 少任何一条,用户就会看到一份看起来对、实则拿脏基线算出来的 diff。
//
// 「快照不完整」和「快照抛错」各拆成起始/结束两条:两次快照共用一个假实现时,
// 一条用例会同时满足两个判断,删掉其中任何一个它都还是绿的 —— 那样的用例挡不住
// 任何回归。所以这里用「第 1 次成功、第 2 次出问题」的假实现把两端分开考。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import path from 'node:path'
import { beginObservedChanges, comparableKey } from '../observedChanges'
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
  // 作废是静默的,查起来无迹可寻,所以「不可信」的出口都要留一行日志。反过来,
  // 常态(没跑命令 / 跑了但没改动)不能记 —— 那会把日志变成噪音,真出事时反而看不见。
  let warn: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  afterEach(() => {
    warn.mockRestore()
  })

  it('跑过命令且基线可信 → 给出观察到的改动', async () => {
    const t = beginObservedChanges(deps())
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([change('/w/a.md')])
    expect(warn).not.toHaveBeenCalled()
  })

  it('本轮没跑过命令 → 不显示(apply_patch 那条路已全覆盖,不该猜)', async () => {
    const t = beginObservedChanges(deps())

    await expect(t.finish(new Set())).resolves.toEqual([])
    // 这是常态,不是异常:一个只聊天的回合不该往日志里写东西。
    expect(warn).not.toHaveBeenCalled()
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
    expect(warn).toHaveBeenCalledOnce()
  })

  it('起始快照不完整 → 作废(结束那次是完整的,只能靠 before 挡下来)', async () => {
    const t = beginObservedChanges(
      deps({ snapshot: snapshotSequence(() => snap(false), () => snap()) }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
    expect(warn).toHaveBeenCalledOnce()
  })

  it('结束快照不完整 → 作废(起始那次是完整的,只能靠 after 挡下来)', async () => {
    const t = beginObservedChanges(
      deps({ snapshot: snapshotSequence(() => snap(), () => snap(false)) }),
    )
    t.noteShellStarted()

    await expect(t.finish(new Set())).resolves.toEqual([])
    expect(warn).toHaveBeenCalledOnce()
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
    // 抛错走的是 before === null 那条,不能被误记成「赛跑输了」。
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('起始快照抛错'))
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
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('结束快照抛错'))
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

  // 上面那条同格式用例挡不住真正的病:两侧都写 `/w/a.md` 时,任何比较方式都能过。
  // 线上两侧压根不是同一种写法 —— reported 来自 codex 的 wire 值,`parseChange`
  // 原样透传;observed 是快照键,由 `path.join(path.resolve(root), …)` 生成的原生
  // 绝对路径。写法一错,`Set.has` 永远不命中,去重就成了死代码,同一个文件会既出现
  // 在 apply_patch 卡里、又出现在 observed 卡里。
  describe('reported 与快照键的写法不同,要归一化之后再比', () => {
    const root = path.resolve('/w')
    const target = path.join(root, 'src', 'a.md')
    const other = path.join(root, 'src', 'keep.md')

    /** 固定产出 target + other 两条观察结果,返回减掉 `reported` 之后还剩谁。 */
    async function remainingAfterSubtracting(reported: string): Promise<string[]> {
      const t = beginObservedChanges(
        deps({ roots: () => [root], diff: vi.fn(() => [change(target), change(other)]) }),
      )
      t.noteShellStarted()
      const out = await t.finish(new Set([reported]))
      return out.map((c) => c.path)
    }

    it('绝对原生路径', async () => {
      await expect(remainingAfterSubtracting(target)).resolves.toEqual([other])
    })

    it('绝对 POSIX 路径 —— D:/w/src/a.md 和 D:\\w\\src\\a.md 是同一个文件', async () => {
      await expect(remainingAfterSubtracting(target.replace(/\\/g, '/'))).resolves.toEqual([other])
    })

    it('工作区相对路径 —— 仓库里所有 codex fixture 都是这种写法', async () => {
      await expect(remainingAfterSubtracting('src/a.md')).resolves.toEqual([other])
    })

    it.skipIf(process.platform !== 'win32')('相对反斜杠路径', async () => {
      await expect(remainingAfterSubtracting('src\\a.md')).resolves.toEqual([other])
    })

    it.skipIf(process.platform !== 'win32')('大小写不同 —— NTFS 不区分,同一个文件', async () => {
      await expect(remainingAfterSubtracting(target.toUpperCase())).resolves.toEqual([other])
    })

    it('同名不同目录不能误杀 —— 归一化不是「只比文件名」', async () => {
      await expect(remainingAfterSubtracting('other/a.md')).resolves.toEqual([target, other])
    })
  })

  // 上面两条大小写用例带 skipIf,而单测跑在 ubuntu、主要发行的却是 Windows ——
  // 也就是说把 `.toLowerCase()` 删掉,CI 照样全绿。所以把平台这一维显式注进来考。
  describe('comparableKey 的大小写折叠按平台走', () => {
    const lower = path.resolve('/w/src/a.md')
    const upper = path.resolve('/w/src/A.md')

    it.each<NodeJS.Platform>(['win32', 'darwin'])(
      '%s 上折叠 —— NTFS 与 APFS 都不区分大小写,不折叠就减不掉,同一个文件出两张卡',
      (platform) => {
        expect(comparableKey(upper, platform)).toBe(comparableKey(lower, platform))
      },
    )

    it('linux 上不折叠 —— 那边 A.md 和 a.md 真是两个文件,折叠会误杀掉真改动', () => {
      expect(comparableKey(upper, 'linux')).not.toBe(comparableKey(lower, 'linux'))
    })

    it('分隔符一律统一成正斜杠,与平台无关', () => {
      expect(comparableKey(path.resolve('/w/src/a.md'), 'linux')).not.toContain('\\')
    })
  })

  describe('快照拖太久要放弃 —— 结束快照是在落库前 await 的', () => {
    it('起始快照挂住由赛跑闸兜底,不需要自己的时限 —— 这里钉的是「别再加一条死分支」', async () => {
      const t = beginObservedChanges(
        deps({ snapshot: vi.fn(() => new Promise<Snapshot>(() => {})), deadlineMs: 5 }),
      )
      t.noteShellStarted()

      await expect(t.finish(new Set())).resolves.toEqual([])
      // 走到 `await baseline` 的前提是 baselineWon 为 true,而那意味着起始快照
      // 已经 settle —— 所以它永远不会在那儿等,给它加超时是加一段跑不到的代码。
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('第一条命令早于起始快照'))
    })

    it('结束快照超时 → 作废,而不是把这一轮的消息一起拖住', async () => {
      const snapshot = vi
        .fn<(roots: string[]) => Promise<Snapshot>>()
        .mockResolvedValueOnce(snap())
        .mockImplementation(() => new Promise<Snapshot>(() => {}))
      const t = beginObservedChanges(deps({ snapshot, deadlineMs: 5 }))
      t.noteShellStarted()

      await expect(t.finish(new Set())).resolves.toEqual([])
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('结束快照超过 5ms'))
    })
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
