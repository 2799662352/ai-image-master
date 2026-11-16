// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  applyArrangement,
  buildRailEntries,
  flattenRailEntries,
  listGroupNames,
  normalizeGroupName,
  planAssignGroup,
  planDissolveGroup,
  planMoveGroup,
  planMoveProject,
  planNudge,
  planRenameGroup,
  type GroupItem,
} from '../projectGroups'

/** 'a' / 'b:组' = id[:group],顺序即 order。 */
const mk = (spec: string): GroupItem[] =>
  spec.split(' ').map((s) => {
    const [id, group] = s.split(':')
    return group ? { id, group } : { id }
  })

/** 剧栏当前的样子,写成 `a [G:b,c] d`,方便断言。 */
const show = (items: GroupItem[], pinned: string[] = [], empties: string[] = []): string =>
  buildRailEntries(items, pinned, empties)
    .map((e) => (e.kind === 'project' ? e.item.id : `[${e.group.name}${e.group.empty ? '(空)' : ''}:${e.group.members.map((m) => m.id).join(',')}]`))
    .join(' ')

/** 套用计划后的样子。 */
const after = (items: GroupItem[], plan: ReturnType<typeof planMoveProject>, pinned: string[] = []): string =>
  plan ? show(applyArrangement(items, plan), pinned) : '(null)'

describe('normalizeGroupName', () => {
  it('去首尾空白、折叠内部空白、去控制字符', () => {
    expect(normalizeGroupName('  第一  季\t')).toBe('第一 季')
    expect(normalizeGroupName('a\u0000b\nc')).toBe('a b c')
  })
  it('空 / 纯空白 / 非字符串 → undefined', () => {
    expect(normalizeGroupName('')).toBeUndefined()
    expect(normalizeGroupName('   ')).toBeUndefined()
    expect(normalizeGroupName(undefined)).toBeUndefined()
    expect(normalizeGroupName(5)).toBeUndefined()
  })
  it('超过 24 个字符截断,按字符不按 UTF-16 单元(不劈开 emoji)', () => {
    expect(normalizeGroupName('长'.repeat(30))).toBe('长'.repeat(24))
    expect(Array.from(normalizeGroupName('😀'.repeat(30))!)).toHaveLength(24)
  })
})

describe('buildRailEntries', () => {
  it('没有分组时就是原来的平铺列表', () => {
    expect(show(mk('a b c'))).toBe('a b c')
  })
  it('分组出现在它第一个成员的位置,成员连成一块(即使在 order 里是隔开的)', () => {
    expect(show(mk('a b:G c d:G e'))).toBe('a [G:b,d] c e')
  })
  it('两个分组各占各的位置', () => {
    expect(show(mk('a:X b:Y c:X d:Y'))).toBe('[X:a,c] [Y:b,d]')
  })
  it('顶层置顶的未分组剧排最前;分组里置顶的成员排组内最前', () => {
    expect(show(mk('a b:G c:G d'), ['d'])).toBe('d a [G:b,c]')
    expect(show(mk('a b:G c:G d'), ['c'])).toBe('a [G:c,b] d')
  })
  it('分组本身不会被「置顶成员」带到最前(置顶只在各自容器里生效)', () => {
    expect(show(mk('a b:G c'), ['b'])).toBe('a [G:b] c')
  })
  it('本机空分组排在置顶项之后、其余之前;已有成员的同名不重复;重名只留一个', () => {
    expect(show(mk('a b:G c'), ['c'], ['空1', 'G', '空1'])).toBe('c [空1(空):] a [G:b]')
  })
  it('flattenRailEntries 是剧栏从上到下能看到的剧', () => {
    expect(flattenRailEntries(buildRailEntries(mk('a b:G c d:G'), ['c'])).map((p) => p.id)).toEqual(['c', 'a', 'b', 'd'])
  })
  it('listGroupNames:有成员的按剧栏顺序,再接空分组,不重复', () => {
    expect(listGroupNames(mk('a:Y b:X c:Y'), ['Z', 'X'])).toEqual(['Y', 'X', 'Z'])
  })
})

describe('planMoveProject · 落在行上', () => {
  it('平铺列表里行为和原来的拖拽排序一致', () => {
    const items = mk('a b c d')
    expect(after(items, planMoveProject(items, [], 'a', { kind: 'row', id: 'c', place: 'after' }))).toBe('b c a d')
    expect(after(items, planMoveProject(items, [], 'd', { kind: 'row', id: 'a', place: 'before' }))).toBe('d a b c')
  })
  it('放到自己身上 / 放回原位(相邻)→ null', () => {
    const items = mk('a b c')
    expect(planMoveProject(items, [], 'b', { kind: 'row', id: 'b', place: 'before' })).toBeNull()
    expect(planMoveProject(items, [], 'a', { kind: 'row', id: 'b', place: 'before' })).toBeNull()
    expect(planMoveProject(items, [], 'b', { kind: 'row', id: 'a', place: 'after' })).toBeNull()
  })
  it('落在分组成员行上 = 进入那个分组,并落在该行的前 / 后', () => {
    const items = mk('a b:G c:G d')
    const p = planMoveProject(items, [], 'd', { kind: 'row', id: 'b', place: 'after' })!
    expect(p.groups).toEqual({ d: 'G' })
    expect(after(items, p)).toBe('a [G:b,d,c]')
  })
  it('把组内成员拖到顶层的行上 = 移出分组', () => {
    const items = mk('a b:G c:G d')
    const p = planMoveProject(items, [], 'b', { kind: 'row', id: 'd', place: 'after' })!
    expect(p.groups).toEqual({ b: null })
    expect(after(items, p)).toBe('a [G:c] d b')
  })
  it('在同一个分组里换位不改分组', () => {
    const items = mk('a:G b:G c:G')
    const p = planMoveProject(items, [], 'a', { kind: 'row', id: 'c', place: 'after' })!
    expect(p.groups).toEqual({})
    expect(after(items, p)).toBe('[G:b,c,a]')
  })
  it('从一个分组拖到另一个分组的成员行上 = 换组', () => {
    const items = mk('a:X b:X c:Y')
    const p = planMoveProject(items, [], 'a', { kind: 'row', id: 'c', place: 'before' })!
    expect(p.groups).toEqual({ a: 'Y' })
    expect(after(items, p)).toBe('[X:b] [Y:a,c]')
  })
  it('拖走分组的最后一个成员,分组随之消失(它只是字段)', () => {
    const items = mk('a:G b')
    const p = planMoveProject(items, [], 'a', { kind: 'row', id: 'b', place: 'after' })!
    expect(after(items, p)).toBe('b a')
  })
  it('置顶与否不同的两部剧不能互换(顶层与组内都是)', () => {
    expect(planMoveProject(mk('a b c'), ['a'], 'c', { kind: 'row', id: 'a', place: 'before' })).toBeNull()
    expect(planMoveProject(mk('a b c'), ['a'], 'a', { kind: 'row', id: 'c', place: 'after' })).toBeNull()
    expect(planMoveProject(mk('a:G b:G c:G'), ['a'], 'c', { kind: 'row', id: 'a', place: 'before' })).toBeNull()
  })
  it('置顶的剧可以拖进分组(落在同样置顶的成员旁),组内仍是置顶的在前、置顶之间按落点', () => {
    const items = mk('a b:G c:G')
    // a 置顶、c 没置顶 → 不同类,拒绝
    expect(planMoveProject(items, ['a'], 'a', { kind: 'row', id: 'c', place: 'after' })).toBeNull()
    const q = planMoveProject(items, ['a', 'c'], 'a', { kind: 'row', id: 'c', place: 'after' })!
    expect(q.groups).toEqual({ a: 'G' })
    expect(after(items, q, ['a', 'c'])).toBe('[G:c,a,b]')
    const r = planMoveProject(items, ['a', 'c'], 'a', { kind: 'row', id: 'c', place: 'before' })!
    expect(after(items, r, ['a', 'c'])).toBe('[G:a,c,b]')
  })
  it('置顶的剧拖到分组标题 into:进组,排在组内置顶项里最后一个', () => {
    const items = mk('a b:G c:G')
    const p = planMoveProject(items, ['a', 'c'], 'a', { kind: 'group', name: 'G', zone: 'into' })!
    expect(after(items, p, ['a', 'c'])).toBe('[G:c,a,b]')
  })
  it('不存在的 id → null', () => {
    const items = mk('a b')
    expect(planMoveProject(items, [], 'zz', { kind: 'row', id: 'a', place: 'before' })).toBeNull()
    expect(planMoveProject(items, [], 'a', { kind: 'row', id: 'zz', place: 'before' })).toBeNull()
  })
})

describe('planMoveProject · 落在分组标题上', () => {
  it('into:进入这个分组,排到组内最后', () => {
    const items = mk('a b:G c:G d')
    const p = planMoveProject(items, [], 'a', { kind: 'group', name: 'G', zone: 'into' })!
    expect(p.groups).toEqual({ a: 'G' })
    expect(after(items, p)).toBe('[G:b,c,a] d')
  })
  it('into 一个本机空分组:剧原位不动,分组出现在它那里', () => {
    const items = mk('a b c')
    const p = planMoveProject(items, [], 'b', { kind: 'group', name: '新组', zone: 'into' })!
    expect(p.ids).toEqual(['a', 'b', 'c'])
    expect(p.groups).toEqual({ b: '新组' })
    expect(after(items, p)).toBe('a [新组:b] c')
  })
  it('into 自己所在分组、且已是最后一个 → null', () => {
    expect(planMoveProject(mk('a:G b:G'), [], 'b', { kind: 'group', name: 'G', zone: 'into' })).toBeNull()
  })
  it('into 自己所在分组、不是最后 → 排到最后', () => {
    const items = mk('a:G b:G c:G')
    expect(after(items, planMoveProject(items, [], 'a', { kind: 'group', name: 'G', zone: 'into' }))).toBe('[G:b,c,a]')
  })
  it('before / after:放到整块的前 / 后,成为未分组', () => {
    const items = mk('a b:G c:G d')
    expect(after(items, planMoveProject(items, [], 'd', { kind: 'group', name: 'G', zone: 'before' }))).toBe('a d [G:b,c]')
    expect(after(items, planMoveProject(items, [], 'a', { kind: 'group', name: 'G', zone: 'after' }))).toBe('[G:b,c] a d')
  })
  it('把组内成员拖到自己分组标题的 before:移出分组、放在整块之前', () => {
    const items = mk('a b:G c:G d')
    const p = planMoveProject(items, [], 'c', { kind: 'group', name: 'G', zone: 'before' })!
    expect(p.groups).toEqual({ c: null })
    expect(after(items, p)).toBe('a c [G:b] d')
  })
  it('只有被拖这一个成员的分组,对自己的 before / after → null(没有别的成员可作锚点,也不会凭空消失)', () => {
    const items = mk('a b:G c')
    expect(planMoveProject(items, [], 'b', { kind: 'group', name: 'G', zone: 'before' })).toBeNull()
    expect(planMoveProject(items, [], 'b', { kind: 'group', name: 'G', zone: 'after' })).toBeNull()
  })
  it('空分组标题上的 before / after 无意义 → null', () => {
    expect(planMoveProject(mk('a b'), [], 'a', { kind: 'group', name: '空', zone: 'before' })).toBeNull()
  })
})

describe('planMoveProject · 列表底部空白', () => {
  it('未分组的剧拖到底部 = 排到最后', () => {
    const items = mk('a b c')
    expect(after(items, planMoveProject(items, [], 'a', { kind: 'tail' }))).toBe('b c a')
  })
  it('组内成员拖到底部 = 移出分组并排到最后', () => {
    const items = mk('a:G b:G c')
    const p = planMoveProject(items, [], 'a', { kind: 'tail' })!
    expect(p.groups).toEqual({ a: null })
    expect(after(items, p)).toBe('[G:b] c a')
  })
  it('已经是未分组且最后一个 → null', () => {
    expect(planMoveProject(mk('a b c'), [], 'c', { kind: 'tail' })).toBeNull()
  })
})

describe('planMoveGroup', () => {
  it('把整个分组挪到一部未分组的剧之后,成员保持连续和组内顺序', () => {
    const items = mk('a:G b c:G d')
    const p = planMoveGroup(items, [], 'G', { kind: 'row', id: 'd', place: 'after' })!
    expect(p.groups).toEqual({})
    expect(after(items, p)).toBe('b d [G:a,c]')
  })
  it('挪到另一个分组之前 / 之后', () => {
    const items = mk('a:X b:Y c:Z')
    expect(after(items, planMoveGroup(items, [], 'Z', { kind: 'group', name: 'X', place: 'before' }))).toBe('[Z:c] [X:a] [Y:b]')
    expect(after(items, planMoveGroup(items, [], 'X', { kind: 'group', name: 'Z', place: 'after' }))).toBe('[Y:b] [Z:c] [X:a]')
  })
  it('放回原位 / 放到自己身上 / 目标是组内成员行 → null', () => {
    const items = mk('a b:G c')
    expect(planMoveGroup(items, [], 'G', { kind: 'row', id: 'c', place: 'before' })).toBeNull()
    expect(planMoveGroup(items, [], 'G', { kind: 'group', name: 'G', place: 'after' })).toBeNull()
    expect(planMoveGroup(mk('a:G b'), [], 'G', { kind: 'row', id: 'a', place: 'after' })).toBeNull()
  })
  it('落到成员不止一个的分组前 / 后:整块的前 / 后,绝不插进它中间', () => {
    const items = mk('a:X b:Y c:Y d:Z')
    // 放到 Y 之前 = 在它第一个成员之前;放到 Y 之后 = 在它最后一个成员之后
    expect(after(items, planMoveGroup(items, [], 'Z', { kind: 'group', name: 'Y', place: 'before' }))).toBe('[X:a] [Z:d] [Y:b,c]')
    expect(after(items, planMoveGroup(items, [], 'X', { kind: 'group', name: 'Y', place: 'after' }))).toBe('[Y:b,c] [X:a] [Z:d]')
    // 被拖的分组自己有多个成员也一样:连成一块、保持组内顺序
    const two = mk('a:X b:X c:Y d:Y')
    expect(after(two, planMoveGroup(two, [], 'X', { kind: 'group', name: 'Y', place: 'after' }))).toBe('[Y:c,d] [X:a,b]')
  })
  it('目标是别的分组里的成员行 → null(分组只能落在顶层,不能被塞进另一个分组中间)', () => {
    const items = mk('a:X b:Y c:Y d')
    expect(planMoveGroup(items, [], 'X', { kind: 'row', id: 'c', place: 'before' })).toBeNull()
    expect(planMoveGroup(items, [], 'X', { kind: 'row', id: 'b', place: 'after' })).toBeNull()
    // 正向对照:同样的分组落到顶层的 d 之后是可以的
    expect(after(items, planMoveGroup(items, [], 'X', { kind: 'row', id: 'd', place: 'after' }))).toBe('[Y:b,c] d [X:a]')
  })
  it('没有这个分组 → null', () => {
    expect(planMoveGroup(mk('a b'), [], 'G', { kind: 'row', id: 'a', place: 'before' })).toBeNull()
  })
  it('拖到列表底部空白 = 整块排到最后;已经在最后 → null', () => {
    const items = mk('a:G b c:X')
    expect(after(items, planMoveGroup(items, [], 'G', { kind: 'tail' }))).toBe('b [X:c] [G:a]')
    expect(planMoveGroup(mk('a b:G'), [], 'G', { kind: 'tail' })).toBeNull()
    // 只有这一个分组:没有别的可以排在它前面
    expect(planMoveGroup(mk('a:G b:G'), [], 'G', { kind: 'tail' })).toBeNull()
  })
})

describe('planAssignGroup(菜单:移到分组 / 移出分组)', () => {
  it('移进已有分组 = 排到组内最后', () => {
    const items = mk('a b:G c')
    expect(after(items, planAssignGroup(items, [], 'c', 'G'))).toBe('a [G:b,c]')
  })
  it('移进一个全新的分组 = 原位成组', () => {
    const items = mk('a b c')
    expect(after(items, planAssignGroup(items, [], 'b', '新'))).toBe('a [新:b] c')
  })
  it('移出分组 = 留在原位,变成未分组', () => {
    const items = mk('a b:G c:G d')
    const p = planAssignGroup(items, [], 'c', null)!
    expect(p.ids).toEqual(['a', 'b', 'c', 'd'])
    expect(p.groups).toEqual({ c: null })
    expect(after(items, p)).toBe('a [G:b] c d')
  })
  it('本来就没分组再移出 / 已在这个分组再移进 → null', () => {
    expect(planAssignGroup(mk('a b'), [], 'a', null)).toBeNull()
    expect(planAssignGroup(mk('a:G'), [], 'a', 'G')).toBeNull()
  })
})

describe('planRenameGroup / planDissolveGroup', () => {
  it('重命名:所有成员的 group 都改,位置不动', () => {
    const items = mk('a b:G c:G d')
    const p = planRenameGroup(items, [], 'G', '  新  名 ')!
    expect(p.groups).toEqual({ b: '新 名', c: '新 名' })
    expect(after(items, p)).toBe('a [新 名:b,c] d')
  })
  it('改成已存在的名字 = 并入那个分组', () => {
    const items = mk('a:X b:Y c:X d:Y')
    const p = planRenameGroup(items, [], 'Y', 'X')!
    expect(after(items, p)).toBe('[X:a,b,c,d]')
  })
  it('新名无效 / 没变 / 没这个分组 → null', () => {
    const items = mk('a:G b')
    expect(planRenameGroup(items, [], 'G', '   ')).toBeNull()
    expect(planRenameGroup(items, [], 'G', 'G')).toBeNull()
    expect(planRenameGroup(items, [], 'G', ' G ')).toBeNull()
    expect(planRenameGroup(items, [], '没有', 'X')).toBeNull()
  })
  it('解散:成员回到未分组,位置不动', () => {
    const items = mk('a b:G c:G d')
    const p = planDissolveGroup(items, [], 'G')!
    expect(p.groups).toEqual({ b: null, c: null })
    expect(after(items, p)).toBe('a b c d')
    expect(planDissolveGroup(items, [], '没有')).toBeNull()
  })
})

describe('applyArrangement', () => {
  it('只给 group 变了的剧换新对象;移出分组是删字段不是写 undefined', () => {
    const items = [
      { id: 'a', n: 1 },
      { id: 'b', group: 'G', n: 2 },
    ]
    const out = applyArrangement(items, { ids: ['b', 'a'], groups: { b: null, a: 'X' } })
    expect(out[0]).toEqual({ id: 'b', n: 2 })
    expect('group' in out[0]).toBe(false)
    expect(out[1]).toEqual({ id: 'a', n: 1, group: 'X' })
    const same = applyArrangement(items, { ids: ['a', 'b'], groups: {} })
    expect(same[0]).toBe(items[0])
    expect(same[1]).toBe(items[1])
  })
})

describe('planNudge(键盘 ↑ ↓)', () => {
  it('顶层未分组的剧:和相邻项换位', () => {
    const items = mk('a b c')
    expect(after(items, planNudge(items, [], { kind: 'project', id: 'b' }, 'up'))).toBe('b a c')
    expect(after(items, planNudge(items, [], { kind: 'project', id: 'b' }, 'down'))).toBe('a c b')
    expect(planNudge(items, [], { kind: 'project', id: 'a' }, 'up')).toBeNull()
    expect(planNudge(items, [], { kind: 'project', id: 'c' }, 'down')).toBeNull()
  })
  it('邻居是整个分组:整块跳过去,自己仍未分组', () => {
    const items = mk('a b:G c:G d')
    expect(after(items, planNudge(items, [], { kind: 'project', id: 'd' }, 'up'))).toBe('a d [G:b,c]')
    expect(after(items, planNudge(items, [], { kind: 'project', id: 'a' }, 'down'))).toBe('[G:b,c] a d')
  })
  it('组内成员只在组内换位,到头不出组', () => {
    const items = mk('a:G b:G c:G')
    expect(after(items, planNudge(items, [], { kind: 'project', id: 'b' }, 'up'))).toBe('[G:b,a,c]')
    expect(planNudge(items, [], { kind: 'project', id: 'a' }, 'up')).toBeNull()
    expect(planNudge(items, [], { kind: 'project', id: 'c' }, 'down')).toBeNull()
  })
  it('分组整块和相邻项换位', () => {
    const items = mk('a b:G c')
    expect(after(items, planNudge(items, [], { kind: 'group', name: 'G' }, 'up'))).toBe('[G:b] a c')
    expect(after(items, planNudge(items, [], { kind: 'group', name: 'G' }, 'down'))).toBe('a c [G:b]')
    expect(planNudge(mk('b:G a'), [], { kind: 'group', name: 'G' }, 'up')).toBeNull()
  })
  it('被置顶规则拦住的不动', () => {
    const items = mk('a b c')
    expect(planNudge(items, ['a'], { kind: 'project', id: 'b' }, 'up')).toBeNull()
  })
})
