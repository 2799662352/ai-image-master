// 人像库「本地叠加层」—— 上游 Seedance 素材接口只支持 列表/导入,没有
// 改名/删除/分组能力。叠加层(自定义名 / 用户分组 / 软删除隐藏)的单一真相源
// 已上移到主进程(services/seedance/portraitOverlay.ts),通过 IPC 读写。
//
// 为什么放主进程:人像库 UI 与 MCP agent 要操作同一份数据 —— agent 能自主
// 列素材/搜索/改名/整理,UI 必须实时反映这些编辑。本 hook 负责:
//  - 挂载时从主进程拉取叠加层;
//  - 订阅 `onOverlayChanged` 广播,使 agent 的编辑即时同步到页面;
//  - 各变更方法走 IPC 提交,用返回的新状态刷新本地态。
// 公开 API 与旧版完全一致,PortraitLibraryPage 无需改动。

import { useCallback, useEffect, useState } from 'react'
import type {
  AssetOverlayEntry,
  PortraitOverlayMutation,
  PortraitOverlayState,
} from '../../../types/seedance'

export type { AssetOverlayEntry, PortraitOverlayState }

const EMPTY_STATE: PortraitOverlayState = { entries: {}, groups: [] }

interface OverlayBridge {
  getOverlay: () => Promise<PortraitOverlayState>
  mutateOverlay: (mutation: PortraitOverlayMutation) => Promise<PortraitOverlayState>
  onOverlayChanged: (cb: (state: PortraitOverlayState) => void) => () => void
}

function getBridge(): OverlayBridge | null {
  const api = (window as unknown as { electronAPI?: { seedance?: Partial<OverlayBridge> } }).electronAPI?.seedance
  if (api?.getOverlay && api.mutateOverlay && api.onOverlayChanged) return api as OverlayBridge
  return null
}

export interface PortraitOverlayApi {
  entries: Record<string, AssetOverlayEntry>
  groups: string[]
  /** 改名(空串=清除自定义名,回退上游 name)。 */
  rename: (assetId: string, name: string) => void
  /** 把一批素材移动到分组(group 为 undefined=移出分组)。自动登记新分组名。 */
  moveToGroup: (assetIds: string[], group: string | undefined) => void
  /** 设置一批素材的隐藏(软删除)状态。 */
  setHidden: (assetIds: string[], hidden: boolean) => void
  /** 新建一个空分组。 */
  addGroup: (name: string) => void
  /** 删除分组(同时把该组下素材移出分组,不删素材本身)。 */
  removeGroup: (name: string) => void
}

export function usePortraitLibraryOverlay(): PortraitOverlayApi {
  const [state, setState] = useState<PortraitOverlayState>(EMPTY_STATE)

  // 初次加载 + 订阅主进程广播(agent 编辑时即时同步)。
  useEffect(() => {
    const bridge = getBridge()
    if (!bridge) return
    let alive = true
    void bridge.getOverlay().then((s) => {
      if (alive && s) setState(s)
    })
    const off = bridge.onOverlayChanged((s) => setState(s ?? EMPTY_STATE))
    return () => {
      alive = false
      off()
    }
  }, [])

  const mutate = useCallback((mutation: PortraitOverlayMutation) => {
    const bridge = getBridge()
    if (!bridge) return
    void bridge.mutateOverlay(mutation).then((s) => {
      // 主进程会广播同一状态;这里也直接刷新,避免等广播的视觉延迟。
      if (s) setState(s)
    })
  }, [])

  const rename = useCallback(
    (assetId: string, name: string) => mutate({ op: 'rename', assetId, name }),
    [mutate],
  )
  const moveToGroup = useCallback(
    (assetIds: string[], group: string | undefined) => {
      if (assetIds.length === 0) return
      mutate({ op: 'moveToGroup', assetIds, group })
    },
    [mutate],
  )
  const setHidden = useCallback(
    (assetIds: string[], hidden: boolean) => {
      if (assetIds.length === 0) return
      mutate({ op: 'setHidden', assetIds, hidden })
    },
    [mutate],
  )
  const addGroup = useCallback(
    (name: string) => {
      if (name.trim()) mutate({ op: 'addGroup', name })
    },
    [mutate],
  )
  const removeGroup = useCallback((name: string) => mutate({ op: 'removeGroup', name }), [mutate])

  return { entries: state.entries, groups: state.groups, rename, moveToGroup, setHidden, addGroup, removeGroup }
}
