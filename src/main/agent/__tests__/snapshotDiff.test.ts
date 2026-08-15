import { beforeEach, describe, expect, it, vi } from 'vitest'
import { structuredPatch } from 'diff'
import { DIFF_TIMEOUT_MS, TOTAL_DIFF_BUDGET_MS, diffSnapshots } from '../snapshotDiff'
import type { Snapshot } from '../workspaceSnapshot'

// 默认走真实实现;只有超时那条用 mockReturnValueOnce 造出 jsdiff 放弃的返回值。
// 真造一个能跑满 100ms 的病态输入既慢又会随机器快慢翻脸。
vi.mock('diff', async (importOriginal) => {
  const actual = await importOriginal<typeof import('diff')>()
  return { ...actual, structuredPatch: vi.fn(actual.structuredPatch) }
})

function snap(files: Record<string, string>, over: Partial<Snapshot> = {}): Snapshot {
  return {
    files: new Map(Object.entries(files)),
    skipped: new Set(),
    complete: true,
    ...over,
  }
}

describe('diffSnapshots', () => {
  beforeEach(() => {
    vi.mocked(structuredPatch).mockClear()
  })

  it('内容变了 → edit,只给 hunk 不给 ---/+++ —— FileDiffBlock 按行首上色会把文件头当成删/增行', () => {
    const out = diffSnapshots(snap({ '/w/a.md': 'one\ntwo\n' }), snap({ '/w/a.md': 'one\nTWO\n' }))

    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/w/a.md')
    expect(out[0].operation).toBe('edit')
    expect(out[0].source).toBe('observed')
    expect(out[0].diff).toContain('@@')
    expect(out[0].diff).toContain('-two')
    expect(out[0].diff).toContain('+TWO')
    // createPatch / createTwoFilesPatch 会吐 ---/+++ 头行;countDiffLines 会跳过它们,
    // 所以 added/removed 仍是 1/1。必须按行锚定,证明输出是纯 hunk。
    expect(out[0].diff).not.toMatch(/^(---|\+\+\+) /m)
    expect(out[0].added).toBe(1)
    expect(out[0].removed).toBe(1)
  })

  it('每条都标成 observed —— 渲染层据此和 agent 自报的区分开', () => {
    const created = diffSnapshots(snap({}), snap({ '/w/n.md': 'x\n' }))
    const edited = diffSnapshots(snap({ '/w/a.md': 'one\n' }), snap({ '/w/a.md': 'two\n' }))
    const deleted = diffSnapshots(snap({ '/w/g.md': 'x\n' }), snap({}))

    expect(created[0].source).toBe('observed')
    expect(edited[0].source).toBe('observed')
    expect(deleted[0].source).toBe('observed')
  })

  it('后有前无 → create;前有后无 → delete', () => {
    expect(diffSnapshots(snap({}), snap({ '/w/n.md': 'x\n' }))[0].operation).toBe('create')
    expect(diffSnapshots(snap({ '/w/g.md': 'x\n' }), snap({}))[0].operation).toBe('delete')
  })

  it('没变的不出现', () => {
    expect(diffSnapshots(snap({ '/w/a.md': 'same\n' }), snap({ '/w/a.md': 'same\n' }))).toEqual([])
  })

  it('任一侧不完整就返回空 —— 不能把扫描范围差异当成改动', () => {
    const before = snap({ '/w/a.md': 'x\n' }, { complete: false })
    const after = snap({})

    expect(diffSnapshots(before, after)).toEqual([])
    expect(diffSnapshots(after, before)).toEqual([])
  })

  it('任一侧 skipped 的路径都不报 —— 读不动的文件不该变成「新建」', () => {
    const before = snap({}, { skipped: new Set(['/w/locked.md']) })
    const after = snap({ '/w/locked.md': 'now readable\n' })

    expect(diffSnapshots(before, after)).toEqual([])
  })

  it('后侧 skipped 的路径也不报 —— 否则前有后读不动会被当成「删了」', () => {
    const before = snap({ '/w/locked.md': 'was readable\n' })
    const after = snap({}, { skipped: new Set(['/w/locked.md']) })

    expect(diffSnapshots(before, after)).toEqual([])
  })

  it('渲染带 timeout 上限 —— 病态输入不能把主进程卡在 Myers 里', () => {
    diffSnapshots(snap({ '/w/a.md': 'one\n' }), snap({ '/w/a.md': 'two\n' }))

    expect(vi.mocked(structuredPatch)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(structuredPatch).mock.calls[0]?.[6]).toMatchObject({
      timeout: DIFF_TIMEOUT_MS,
    })
  })

  it('渲染超时 → 这条改动照出,正文换成说明 —— 咽掉它就是漏报「这文件被命令行改过」', () => {
    vi.mocked(structuredPatch).mockReturnValueOnce(undefined as never)

    const out = diffSnapshots(
      snap({ '/w/huge.json': 'before\n' }),
      snap({ '/w/huge.json': 'after\n' }),
    )

    expect(out).toHaveLength(1)
    expect(out[0].path).toBe('/w/huge.json')
    expect(out[0].operation).toBe('edit')
    expect(out[0].source).toBe('observed')
    expect(out[0].diff).toContain('差异过大')
    // 占位行不能以 +/- 开头,否则 FileDiffBlock 会把它上成增删色、countDiffLines 会数进去。
    expect(out[0].diff).not.toMatch(/^[+-]/m)
    expect(out[0].added).toBe(0)
    expect(out[0].removed).toBe(0)
  })

  it('总预算用尽 → 剩下的文件不再尝试渲染,但一条都不少报', () => {
    // 假时钟:第一个文件渲染完就把墙钟推过预算。不依赖真实耗时,不会因机器快慢翻脸。
    let t = 0
    const now = () => {
      const v = t
      t += TOTAL_DIFF_BUDGET_MS // 每次读表都跳一整个预算
      return v
    }

    const out = diffSnapshots(
      snap({ '/w/a.md': 'one\n', '/w/b.md': 'one\n', '/w/c.md': 'one\n' }),
      snap({ '/w/a.md': 'two\n', '/w/b.md': 'two\n', '/w/c.md': 'two\n' }),
      now,
    )

    // 三个文件全部出现 —— 预算管的是「能不能说清内容」,不是「报不报」。
    expect(out.map((c) => c.path)).toEqual(['/w/a.md', '/w/b.md', '/w/c.md'])
    expect(out.every((c) => c.diff.includes('渲染总预算'))).toBe(true)
    // 关键:超预算之后一次 structuredPatch 都不能再调,否则每个文件又是最多 100ms。
    expect(vi.mocked(structuredPatch)).not.toHaveBeenCalled()
  })

  it('预算充裕时照常逐个渲染 —— 别把日常路径也降级了', () => {
    const out = diffSnapshots(
      snap({ '/w/a.md': 'one\n', '/w/b.md': 'one\n' }),
      snap({ '/w/a.md': 'two\n', '/w/b.md': 'two\n' }),
      () => 0,
    )

    expect(vi.mocked(structuredPatch)).toHaveBeenCalledTimes(2)
    expect(out.every((c) => c.diff.includes('+two'))).toBe(true)
  })

  it('一个文件渲染超时不连累同轮其他文件', () => {
    vi.mocked(structuredPatch).mockReturnValueOnce(undefined as never)

    const out = diffSnapshots(
      snap({ '/w/a.md': 'one\n', '/w/b.md': 'one\n' }),
      snap({ '/w/a.md': 'two\n', '/w/b.md': 'two\n' }),
    )

    expect(out.map((c) => c.path)).toEqual(['/w/a.md', '/w/b.md'])
    expect(out[0].diff).toContain('差异过大')
    expect(out[1].diff).toContain('+two')
    expect(out[1].added).toBe(1)
  })

  it('按路径排序,输出稳定', () => {
    const out = diffSnapshots(snap({}), snap({ '/w/b.md': 'b\n', '/w/a.md': 'a\n' }))

    expect(out.map((c) => c.path)).toEqual(['/w/a.md', '/w/b.md'])
  })
})
