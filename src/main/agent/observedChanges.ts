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
 * ## 赛跑判定为什么写成一场 Promise.race
 *
 * 要问的是「基线真的赶在第一条命令之前拍完了吗」,这是个**先后**问题。所以两边
 * 各自在自己的自然时刻登记一个反应 —— 快照那边在发起时登记,命令那边在命令到达
 * 时 resolve —— 交给 `Promise.race` 去比:先 settle 的一方,回调先进微任务队列
 * (FIFO,规范保证),race 就采信它。判据落在两者真实的 settle 先后上,而不是某个
 * 布尔量在「探针恰好排到第几层微任务」时的取值,后者会随任何一方多绕一层微任务
 * 而翻转。
 *
 * ## 一条需要更正的说法
 *
 * 别把「同步读 flag」写成线上故障。生产里 `noteShellStarted` 由事件流回调触发,
 * 离 `beginObservedChanges` 隔着许多个宏任务,那时快照的回调早跑完了;陈旧窗口只在
 * 「与 promise settle 处于同一个同步块」时才观察得到,而只有测试里瞬间 resolve 的
 * 假快照会造出这种情形。改用 race 不是在修一个正在发生的线上故障,而是为了让判据
 * 不再依赖回调排在第几层。
 *
 * 失败方向始终是安全的:命令到达时基线若仍是 pending(真在跑 fs,或被人包了一层
 * async 转发),这一轮判为不可信 —— 结果是**不给**,而不是拿脏基线**给错**。
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
  let sawShell = false

  let resolveFirstShell: () => void = () => {}
  const firstShell = new Promise<void>((r) => {
    resolveFirstShell = r
  })

  // 不 await:回合开始不该为此多等。失败收敛成 null,由 finish 统一作废。
  const snapshotting = deps.snapshot(roots)
  const baseline: Promise<Snapshot | null> = snapshotting.then(
    (snap) => snap,
    () => null,
  )

  // 抛错也算「拍完了」:那份基线可不可信由 finish 的 before === null 认定,与先后无关。
  // 两个分支都给 true,免得失败路径靠「赛跑输了」这个错误的理由被作废。
  const baselineWon: Promise<boolean> = Promise.race([
    snapshotting.then(() => true, () => true),
    firstShell.then(() => false),
  ])

  return {
    noteShellStarted(): void {
      sawShell = true
      // 只有第一条命令能改变判定:基线一旦赶在任何命令之前拍完,后面的命令再多也
      // 弄不脏一份已经拍好的快照。resolve 本身幂等,不需要额外的「只认第一条」开关。
      resolveFirstShell()
    },
    async finish(reportedPaths: Set<string>): Promise<FileChange[]> {
      if (!sawShell) return []
      if (!(await baselineWon)) return []

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
