// 人像库「本地叠加层」主进程存储 —— 单一真相源。
//
// 上游 Seedance 素材接口只支持 列表/导入,没有改名/删除/分组。这里在主进程
// 用一个明文 JSON 文件(userData/portrait-library-overlay.json)按 assetId 维护
// 自定义名 / 分组 / 软删除(隐藏)标记。放主进程的原因:渲染端人像库 UI 和
// MCP agent 都要读写同一份数据 —— agent 列素材时要看到自定义名/分组、要能
// 按分组搜索、要能改名整理,这些只有在主进程做单一真相源才自洽。
//
// 非机密数据,故用明文 JSON(凭证才用 safeStorage)。任何变更都会写盘并通过
// onChange 回调广播给渲染端,使 UI 实时反映 agent 的编辑。

import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import type {
  AssetOverlayEntry,
  PortraitOverlayMutation,
  PortraitOverlayState,
} from '../../../types/seedance'

const FILENAME = 'portrait-library-overlay.json'

let cached: PortraitOverlayState | null = null
const listeners = new Set<(state: PortraitOverlayState) => void>()

function filePath(): string {
  return path.join(app.getPath('userData'), FILENAME)
}

function read(): PortraitOverlayState {
  try {
    const raw = fs.readFileSync(filePath(), 'utf8')
    const parsed = JSON.parse(raw) as Partial<PortraitOverlayState>
    return {
      entries: parsed.entries && typeof parsed.entries === 'object' ? parsed.entries : {},
      groups: Array.isArray(parsed.groups) ? parsed.groups.filter((g): g is string => typeof g === 'string') : [],
    }
  } catch {
    return { entries: {}, groups: [] }
  }
}

function write(state: PortraitOverlayState): void {
  try {
    fs.writeFileSync(filePath(), JSON.stringify(state, null, 2), 'utf8')
  } catch (e) {
    console.warn('[seedance/overlay] write failed:', e)
  }
}

/** 清掉空字段,返回 undefined 表示该条可删除。 */
function pruneEntry(entry: AssetOverlayEntry | undefined): AssetOverlayEntry | undefined {
  if (!entry) return undefined
  const next: AssetOverlayEntry = {}
  if (entry.name) next.name = entry.name
  if (entry.group) next.group = entry.group
  if (entry.hidden) next.hidden = true
  if (entry.thumbUrl) next.thumbUrl = entry.thumbUrl
  return Object.keys(next).length > 0 ? next : undefined
}

export function getPortraitOverlay(): PortraitOverlayState {
  if (!cached) cached = read()
  return cached
}

function commit(next: PortraitOverlayState): PortraitOverlayState {
  cached = next
  write(next)
  for (const cb of listeners) {
    try {
      cb(next)
    } catch (e) {
      console.warn('[seedance/overlay] listener failed:', e)
    }
  }
  return next
}

export function onPortraitOverlayChange(cb: (state: PortraitOverlayState) => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}

/** 应用一条变更指令,返回新状态。所有改名/分组/隐藏都经这里。 */
export function mutatePortraitOverlay(mutation: PortraitOverlayMutation): PortraitOverlayState {
  const cur = getPortraitOverlay()
  const entries = { ...cur.entries }
  let groups = [...cur.groups]

  const patch = (ids: string[], p: Partial<AssetOverlayEntry>): void => {
    for (const id of ids) {
      const pruned = pruneEntry({ ...entries[id], ...p })
      if (pruned) entries[id] = pruned
      else delete entries[id]
    }
  }

  switch (mutation.op) {
    case 'rename':
      patch([mutation.assetId], { name: mutation.name.trim() || undefined })
      break
    case 'moveToGroup': {
      const group = mutation.group?.trim() || undefined
      patch(mutation.assetIds, { group })
      if (group && !groups.includes(group)) groups.push(group)
      break
    }
    case 'setHidden':
      patch(mutation.assetIds, { hidden: mutation.hidden || undefined })
      break
    case 'setThumb':
      patch(mutation.assetIds, { thumbUrl: mutation.thumbUrl.trim() || undefined })
      break
    case 'addGroup': {
      const name = mutation.name.trim()
      if (name && !groups.includes(name)) groups.push(name)
      break
    }
    case 'removeGroup': {
      for (const id of Object.keys(entries)) {
        if (entries[id]?.group === mutation.name) {
          const pruned = pruneEntry({ ...entries[id], group: undefined })
          if (pruned) entries[id] = pruned
          else delete entries[id]
        }
      }
      groups = groups.filter((g) => g !== mutation.name)
      break
    }
    default: {
      // 穷尽性检查:新增 op 未处理时编译期报错。
      const _exhaustive: never = mutation
      return _exhaustive
    }
  }

  return commit({ entries, groups })
}
