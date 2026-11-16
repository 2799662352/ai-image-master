// 剧栏分组:纯函数,不碰 store、不碰库。
//
// 分组没有独立记录 —— 只是剧上的一个可选字段 `group`(同名即同组,见 VideoWorkbenchProject.group)。
// 所以「剧栏现在长什么样」是从剧的 `order` + `group` + 置顶 **推出来**的(buildRailEntries),
// 「拖一下之后会变成什么样」是一份**完整的新顺序 + 谁换了分组**(ArrangePlan),交给 store 的
// arrangeProjects 一次落地(一次撤销、一次落库)。
//
// 推导规则(拖动 / 菜单 / 键盘都靠它,改动要连测试一起改):
//  - 顶层按 `order` 排;分组出现在它**第一个成员**的位置,成员连成一块;未分组的剧各占一行。
//  - 置顶只是显示:顶层置顶的(未分组)排最前;分组里置顶的成员排在组内最前。
//  - 空分组(用户新建、还没放进任何剧的)是本机偏好,排在顶层置顶项之后、其余之前。
//  - 一个计划若摆完剧栏**长得和现在一样**(放到自己旁边、本来就相邻),返回 null:调用方不必 bump
//    revision、不必重写库。

import { WORKBENCH_PROJECT_GROUP_MAX } from '../../../../types/videoWorkbench'
// 只借类型(import type 会被擦掉),避免与 projects.ts 形成运行时循环依赖
import type { DropPlace } from './projects'

/** 参与排布的最小形状;store 里的 VideoWorkbenchProject 满足它。 */
export interface GroupItem {
  id: string
  group?: string
}

/** 分组名规整:去控制字符、折叠空白、trim、截到上限;空 → undefined。非字符串 → undefined。 */
export function normalizeGroupName(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim()
  if (!s) return undefined
  return Array.from(s).slice(0, WORKBENCH_PROJECT_GROUP_MAX).join('').trim() || undefined
}

// ---------------------------------------------------------------------------
// 推导:剧栏的结构
// ---------------------------------------------------------------------------

export interface GroupBlock<T> {
  name: string
  /** 组内顺序:置顶的在前,其余按 order。空分组为 []。 */
  members: T[]
  /** 本机暂存的空分组(没有任何剧带着它)。 */
  empty: boolean
}

export type RailEntry<T> = { kind: 'project'; item: T } | { kind: 'group'; group: GroupBlock<T> }

function pinnedFirst<T extends GroupItem>(items: readonly T[], pinned: ReadonlySet<string>): T[] {
  if (pinned.size === 0) return [...items]
  return [...items.filter((it) => pinned.has(it.id)), ...items.filter((it) => !pinned.has(it.id))]
}

/** `items` 须已按 order 升序(同 order 的相对顺序保持)。 */
export function buildRailEntries<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[] = [],
  emptyGroups: readonly string[] = [],
): RailEntry<T>[] {
  const pinned = new Set(pinnedIds)
  const membersBy = new Map<string, T[]>()
  for (const it of items) {
    if (!it.group) continue
    const list = membersBy.get(it.group)
    if (list) list.push(it)
    else membersBy.set(it.group, [it])
  }
  const top: RailEntry<T>[] = []
  const seen = new Set<string>()
  for (const it of items) {
    if (!it.group) {
      top.push({ kind: 'project', item: it })
    } else if (!seen.has(it.group)) {
      seen.add(it.group)
      top.push({ kind: 'group', group: { name: it.group, members: pinnedFirst(membersBy.get(it.group)!, pinned), empty: false } })
    }
  }
  const pinnedTop = top.filter((e) => e.kind === 'project' && pinned.has(e.item.id))
  const rest = top.filter((e) => !(e.kind === 'project' && pinned.has(e.item.id)))
  const empties: RailEntry<T>[] = []
  const emptySeen = new Set<string>()
  for (const name of emptyGroups) {
    if (membersBy.has(name) || emptySeen.has(name)) continue
    emptySeen.add(name)
    empties.push({ kind: 'group', group: { name, members: [], empty: true } })
  }
  return [...pinnedTop, ...empties, ...rest]
}

/** 剧栏里能看到的剧,按显示顺序(不考虑折叠)。 */
export function flattenRailEntries<T>(entries: readonly RailEntry<T>[]): T[] {
  return entries.flatMap((e) => (e.kind === 'project' ? [e.item] : e.group.members))
}

/** 供选择的分组名:真有成员的按剧栏顺序,再接本机的空分组。 */
export function listGroupNames(items: readonly GroupItem[], emptyGroups: readonly string[] = []): string[] {
  const names: string[] = []
  for (const it of items) if (it.group && !names.includes(it.group)) names.push(it.group)
  for (const n of emptyGroups) if (!names.includes(n)) names.push(n)
  return names
}

function signature<T extends GroupItem>(items: readonly T[], pinnedIds: readonly string[]): string {
  return buildRailEntries(items, pinnedIds)
    .map((e) => (e.kind === 'project' ? e.item.id : `[${e.group.name}:${e.group.members.map((m) => m.id).join(',')}]`))
    .join('|')
}

// ---------------------------------------------------------------------------
// 计划:一次摆放 = 完整的新顺序 + 谁换了分组
// ---------------------------------------------------------------------------

export interface ArrangePlan {
  /** 全部剧的新顺序(全集)。 */
  ids: string[]
  /** 换了分组的剧:id → 新分组名;null = 移出分组。没出现的不变。 */
  groups: Record<string, string | null>
}

/** 把一组 id(保持彼此相对顺序,连成一块)挪到 targetId 的前 / 后。target 在块里 / 不在 ids 里 → null。 */
function moveIdsNear(ids: readonly string[], moving: readonly string[], targetId: string, place: DropPlace): string[] | null {
  const m = new Set(moving)
  if (m.has(targetId) || !ids.includes(targetId) || moving.some((id) => !ids.includes(id))) return null
  const block = ids.filter((id) => m.has(id))
  const rest = ids.filter((id) => !m.has(id))
  const at = rest.indexOf(targetId)
  rest.splice(place === 'before' ? at : at + 1, 0, ...block)
  return rest
}

/** 把计划摆上去:返回按新顺序排好的剧(`group` 变了的换新对象,其余原对象)。不动 order 字段。 */
export function applyArrangement<T extends GroupItem>(items: readonly T[], plan: ArrangePlan): T[] {
  const byId = new Map(items.map((it) => [it.id, it]))
  return plan.ids.map((id) => {
    const it = byId.get(id)!
    if (!(id in plan.groups)) return it
    const next = plan.groups[id]
    if (next === null) {
      if (it.group === undefined) return it
      const { group: _drop, ...rest } = it
      return rest as T
    }
    return it.group === next ? it : { ...it, group: next }
  })
}

/** 全集校验 + 摆完是否和现在一样。一样 → null。 */
function finalize<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  ids: string[] | null,
  groups: Record<string, string | null>,
): ArrangePlan | null {
  if (!ids) return null
  // 只留真的变了的分组(落到同一个分组 / 本来就没分组的「移出」不算变)
  const byId = new Map(items.map((it) => [it.id, it]))
  const changed: Record<string, string | null> = {}
  for (const [id, g] of Object.entries(groups)) {
    const cur = byId.get(id)?.group ?? null
    if (cur !== g) changed[id] = g
  }
  const plan: ArrangePlan = { ids, groups: changed }
  const after = applyArrangement(items, plan)
  return signature(after, pinnedIds) === signature(items, pinnedIds) ? null : plan
}

export type ProjectDropTarget =
  | { kind: 'row'; id: string; place: DropPlace }
  /** 分组标题:before / after = 放到整块的前 / 后(成为未分组的剧),into = 放进这个分组(排到组内最后)。 */
  | { kind: 'group'; name: string; zone: 'before' | 'into' | 'after' }
  /** 列表底部的空白:移出分组并放到最后。 */
  | { kind: 'tail' }

/**
 * 拖一部剧到某处。
 *  - 落在另一部剧的行上:进入那部剧所在的位置(它在某个分组里就进那个组,在顶层就留在顶层)。
 *    置顶与否不同的两部剧不能互换(置顶的永远在各自容器的最前)。
 *  - 落在分组标题上、或列表底部空白:见 ProjectDropTarget。
 * 摆完剧栏没有变化 → null。
 */
export function planMoveProject<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  dragId: string,
  target: ProjectDropTarget,
): ArrangePlan | null {
  const drag = items.find((it) => it.id === dragId)
  if (!drag) return null
  const ids = items.map((it) => it.id)
  const pinned = new Set(pinnedIds)

  if (target.kind === 'row') {
    const t = items.find((it) => it.id === target.id)
    if (!t || t.id === drag.id) return null
    if (pinned.has(drag.id) !== pinned.has(t.id)) return null
    return finalize(items, pinnedIds, moveIdsNear(ids, [drag.id], t.id, target.place), { [drag.id]: t.group ?? null })
  }

  if (target.kind === 'tail') {
    return finalize(items, pinnedIds, [...ids.filter((id) => id !== drag.id), drag.id], { [drag.id]: null })
  }

  // 分组标题:成员里不算被拖的这一部(它自己在不在组里,摆完都以落点为准)
  const others = items.filter((it) => it.group === target.name && it.id !== drag.id)
  if (target.zone === 'into') {
    const last = others[others.length - 1]
    const next = last ? moveIdsNear(ids, [drag.id], last.id, 'after') : ids
    return finalize(items, pinnedIds, next, { [drag.id]: target.name })
  }
  const anchor = target.zone === 'before' ? others[0] : others[others.length - 1]
  if (!anchor) return null
  return finalize(items, pinnedIds, moveIdsNear(ids, [drag.id], anchor.id, target.zone), { [drag.id]: null })
}

export type GroupDropTarget =
  /** 落在一部未分组的剧上。 */
  | { kind: 'row'; id: string; place: DropPlace }
  /** 落在另一个分组上:放到那一整块的前 / 后。 */
  | { kind: 'group'; name: string; place: DropPlace }
  /** 列表底部的空白:放到最后。 */
  | { kind: 'tail' }

/** 拖一整个分组(成员连成一块,保持组内相对顺序)到顶层某处。放到自己身上 / 摆完没变 → null。 */
export function planMoveGroup<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  name: string,
  target: GroupDropTarget,
): ArrangePlan | null {
  const block = items.filter((it) => it.group === name).map((it) => it.id)
  if (block.length === 0) return null
  const ids = items.map((it) => it.id)
  let anchor: string | undefined
  let place: DropPlace = 'after'
  if (target.kind === 'tail') {
    anchor = ids.filter((id) => !block.includes(id)).pop()
  } else if (target.kind === 'row') {
    const t = items.find((it) => it.id === target.id)
    if (!t || t.group) return null
    anchor = t.id
    place = target.place
  } else {
    if (target.name === name) return null
    const members = items.filter((it) => it.group === target.name)
    anchor = (target.place === 'before' ? members[0] : members[members.length - 1])?.id
    place = target.place
  }
  if (!anchor) return null
  return finalize(items, pinnedIds, moveIdsNear(ids, block, anchor, place), {})
}

/**
 * 菜单 / 对话框里「把这部剧移到分组 X」(null = 移出分组)。
 * 进已有分组 → 排到组内最后;新分组(没有别的成员)→ 剧留在原位,分组就出现在它那里;
 * 移出分组 → 留在原位。
 */
export function planAssignGroup<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  id: string,
  group: string | null,
): ArrangePlan | null {
  if (group === null) {
    return finalize(items, pinnedIds, items.map((it) => it.id), { [id]: null })
  }
  return planMoveProject(items, pinnedIds, id, { kind: 'group', name: group, zone: 'into' })
}

/** 重命名分组(改的是每个成员的 group)。新名已存在 = 并入那个分组。名字无效 / 没变 / 没这个分组 → null。 */
export function planRenameGroup<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  from: string,
  to: unknown,
): ArrangePlan | null {
  const next = normalizeGroupName(to)
  if (!next || next === from) return null
  const members = items.filter((it) => it.group === from)
  if (members.length === 0) return null
  const groups: Record<string, string | null> = {}
  for (const m of members) groups[m.id] = next
  return finalize(items, pinnedIds, items.map((it) => it.id), groups)
}

/** 解散分组:成员回到未分组,位置不动。 */
export function planDissolveGroup<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  name: string,
): ArrangePlan | null {
  const members = items.filter((it) => it.group === name)
  if (members.length === 0) return null
  const groups: Record<string, string | null> = {}
  for (const m of members) groups[m.id] = null
  return finalize(items, pinnedIds, items.map((it) => it.id), groups)
}

/**
 * ↑ ↓ 键:在**自己所在的容器**里挪一格。
 *  - 组内的成员:和组内相邻的成员换位(置顶规则同拖动)。
 *  - 顶层未分组的剧:和顶层相邻的一项换位;邻居是整个分组就整块跳过去。
 *  - 分组本身(name):整块和顶层相邻的一项换位。
 * 已在头 / 尾、或被置顶规则拦住 → null。(本机暂存的空分组不在这里排布,它们没有成员可挪。)
 */
export function planNudge<T extends GroupItem>(
  items: readonly T[],
  pinnedIds: readonly string[],
  who: { kind: 'project'; id: string } | { kind: 'group'; name: string },
  dir: 'up' | 'down',
): ArrangePlan | null {
  const entries = buildRailEntries(items, pinnedIds)
  const place: DropPlace = dir === 'up' ? 'before' : 'after'

  if (who.kind === 'group') {
    const at = entries.findIndex((e) => e.kind === 'group' && e.group.name === who.name)
    const nb = entries[at + (dir === 'up' ? -1 : 1)]
    if (at < 0 || !nb) return null
    const target: GroupDropTarget = nb.kind === 'project' ? { kind: 'row', id: nb.item.id, place } : { kind: 'group', name: nb.group.name, place }
    return planMoveGroup(items, pinnedIds, who.name, target)
  }

  const me = items.find((it) => it.id === who.id)
  if (!me) return null
  if (me.group) {
    const g = entries.find((e) => e.kind === 'group' && e.group.name === me.group)
    if (!g || g.kind !== 'group') return null
    const at = g.group.members.findIndex((m) => m.id === me.id)
    const nb = g.group.members[at + (dir === 'up' ? -1 : 1)]
    if (!nb) return null
    return planMoveProject(items, pinnedIds, me.id, { kind: 'row', id: nb.id, place })
  }
  const at = entries.findIndex((e) => e.kind === 'project' && e.item.id === me.id)
  const nb = entries[at + (dir === 'up' ? -1 : 1)]
  if (at < 0 || !nb) return null
  if (nb.kind === 'project') return planMoveProject(items, pinnedIds, me.id, { kind: 'row', id: nb.item.id, place })
  // 邻居是整个分组:跳到它的另一侧,仍是未分组
  return planMoveProject(items, pinnedIds, me.id, { kind: 'group', name: nb.group.name, zone: dir === 'up' ? 'before' : 'after' })
}
