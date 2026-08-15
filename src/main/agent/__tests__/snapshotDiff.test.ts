import { describe, expect, it } from 'vitest'
import { diffSnapshots } from '../snapshotDiff'
import type { Snapshot } from '../workspaceSnapshot'

function snap(files: Record<string, string>, over: Partial<Snapshot> = {}): Snapshot {
  return {
    files: new Map(Object.entries(files)),
    skipped: new Set(),
    complete: true,
    ...over,
  }
}

describe('diffSnapshots', () => {
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

  it('按路径排序,输出稳定', () => {
    const out = diffSnapshots(snap({}), snap({ '/w/b.md': 'b\n', '/w/a.md': 'a\n' }))

    expect(out.map((c) => c.path)).toEqual(['/w/a.md', '/w/b.md'])
  })
})
