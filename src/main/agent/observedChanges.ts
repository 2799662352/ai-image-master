/**
 * 一个回合内「命令行改了什么」的追踪器。
 *
 * ## 为什么起始快照不能等到看见命令再拍
 *
 * 看见 `item_started` 时命令可能已经在跑了,那时拍的基线里已经含着它造成的
 * 修改,diff 会算空或算错。所以回合一开始就异步拍,并记录「第一条命令是不是
 * 比快照先到」—— 先到就说明基线不可信,整轮作废。
 *
 * 宁可不给也不给错的:这条纪律抄自上游 `TurnDiffTracker`,它在 patch 不能被
 * 精确表示时直接 `invalidate()` 丢掉整轮,而不是展示一份可能不准的。
 *
 * ## 为什么赛跑判定要晚一个微任务
 *
 * `baselineReady` 是在 promise 的回调里置位的,而 promise 回调**永远**跑在微
 * 任务队列上 —— 即便快照瞬间就完成了,只要 `noteShellStarted()` 和回合开始处
 * 在同一个同步块里(测试如此,真实回合里同 tick 到达的命令事件亦然),同步去
 * 读这个 flag 读到的必然是 false,于是每一轮都被误判成「赛跑输了」,整个功能
 * 静默失效 —— 而且失效方向是「永远不显示」,没有任何报错会提醒我们。
 *
 * 所以判定推迟一个微任务再做:此时**已经 settle** 的基线一定已经置位,而**真正
 * 还在跑**的基线(还压着一次 fs 往返)一定还没有。两者由此可区分。这不会放松
 * 纪律:真实快照的完成回调跑在另一个宏任务里,要么早于命令事件(基线可信),
 * 要么晚于本次探针(判定为输)—— 中间不存在会让脏基线蒙混过关的窗口。
 */

import type { FileChange } from '../../types/agent-timeline'
import type { Snapshot } from './workspaceSnapshot'

export interface ObservedChangesDeps {
  roots: () => string[]
  snapshot: (roots: string[]) => Promise<Snapshot>
  diff: (before: Snapshot, after: Snapshot) => FileChange[]
}

export interface ObservedChangeTracker {
  /** 每见到一个 shell item_started 调一次。 */
  noteShellStarted(): void
  /** 回合结束时调。`reportedPaths` 是 apply_patch 已经报告过的路径。 */
  finish(reportedPaths: Set<string>): Promise<FileChange[]>
}

export function beginObservedChanges(deps: ObservedChangesDeps): ObservedChangeTracker {
  const roots = deps.roots()
  let baselineReady = false
  let sawShell = false
  let raceLost = false
  /** 首个命令的赛跑判定,`finish` 必须等它有结论才敢用基线。 */
  let raceSettled: Promise<void> | null = null

  // 不 await:回合开始不该为此多等。失败收敛成 null,由 finish 统一作废。
  // 成功/失败两个回调必须挂在同一层 then 上,否则失败路径要多绕一个微任务才
  // 置位 baselineReady,会被探针误判成赛跑输了 —— 那样「快照抛错」这条用例就
  // 是靠错误的理由变绿的。
  const baseline: Promise<Snapshot | null> = deps.snapshot(roots).then(
    (snap) => {
      baselineReady = true
      return snap
    },
    () => {
      baselineReady = true
      return null
    },
  )

  return {
    noteShellStarted(): void {
      sawShell = true
      // 只认第一条命令:它赢了就说明基线在任何命令之前就已拍完,后面的命令
      // 再多也不会让一份已经拍好的基线变脏。
      if (raceSettled) return
      raceSettled = Promise.resolve().then(() => {
        if (!baselineReady) raceLost = true
      })
    },
    async finish(reportedPaths: Set<string>): Promise<FileChange[]> {
      if (!sawShell) return []
      // 先等赛跑有结论,再读 raceLost —— 直接读会读到探针跑之前的初值。
      if (raceSettled) await raceSettled
      if (raceLost) return []

      const before = await baseline
      if (!before || !before.complete) return []

      let after: Snapshot
      try {
        after = await deps.snapshot(roots)
      } catch {
        return []
      }
      if (!after.complete) return []

      return deps.diff(before, after).filter((change) => !reportedPaths.has(change.path))
    },
  }
}
