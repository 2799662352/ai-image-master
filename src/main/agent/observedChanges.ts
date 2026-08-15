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

import path from 'node:path'
import type { FileChange } from '../../types/agent-timeline'
import type { Snapshot } from './workspaceSnapshot'

/** 大小写不敏感的文件系统。在这些平台上 `A.md` 与 `a.md` 是同一个文件。 */
const CASE_INSENSITIVE_PLATFORMS = new Set<NodeJS.Platform>(['win32', 'darwin'])

/**
 * 把一个绝对路径压成可比较的键。
 *
 * 只用于**比较的那一瞬**,不改任何一侧存下来的原值 —— `parseChange` 透传的 wire
 * 路径同时被 fileEdit 卡片、`revealPath`、`openAiChange` 消费,归一化到它们身上
 * 会波及本功能之外的东西。
 *
 * 大小写:NTFS 与 APFS(默认配置)都不区分,`D:\W\A.md` 与 `d:\w\a.md` 是同一个
 * 文件 —— 不折叠就减不掉,同一个文件出两张卡,那是「给错的」。Linux 上绝不能折叠,
 * 那边大小写敏感,一折叠就会把两个不同的文件当成同一个、误杀掉本该显示的改动。
 *
 * `platform` 可注入的唯一理由是**可测**:仓库的单元测试跑在 ubuntu 上,而我们主要
 * 发行 Windows。不注入的话,谁把 `.toLowerCase()` 删掉 CI 都是绿的。
 */
export function comparableKey(absPath: string, platform: NodeJS.Platform = process.platform): string {
  const unified = path.resolve(absPath).replace(/\\/g, '/')
  return CASE_INSENSITIVE_PLATFORMS.has(platform) ? unified.toLowerCase() : unified
}

/**
 * apply_patch 报来的路径没有约定写法:仓库里的 codex fixture 是工作区相对的
 * (`src/a.ts`),线上也见过绝对的,分隔符还随平台走。快照键则一律是
 * `path.join(path.resolve(root), …)` 的原生绝对路径。所以相对路径要先按本回合的
 * roots 逐个还原成绝对候选。
 *
 * **一个相对写法会对所有 root 展开**,于是多 root 且同名时(两个工作区都有
 * `src/a.md`)会多减一个:root B 里那次真实的命令行改动被连带减掉,不显示。这是有意
 * 选的方向 —— 相对路径本身不携带「属于哪个 root」的信息,猜错的另一半是**多显示一条
 * 归错因的改动**,而本功能的纪律是宁可不给。多 root 同名本就少见,真要根治得让上游
 * 把路径发全。
 */
function comparableKeys(reportedPaths: Iterable<string>, roots: string[]): Set<string> {
  const keys = new Set<string>()
  for (const reported of reportedPaths) {
    if (path.isAbsolute(reported)) {
      keys.add(comparableKey(reported))
      continue
    }
    for (const root of roots) keys.add(comparableKey(path.resolve(root, reported)))
  }
  return keys
}

/**
 * 两次快照各自的上限。预算闸卡的是**体量**(文件数 / 字节数),卡不住**时间** ——
 * 一个挂在 SMB / 映射盘上的 root 可以在远没到 3000 个文件时就让一次扫描拖上几十秒。
 *
 * 这条线非划不可,因为结束快照是在**落库之前** await 的:拖住它就等于拖住这一轮
 * 助手消息的持久化。装饰性的卡片不能有这个权力。超时按不可信处理 —— 不给,而不是
 * 拿一份可能已经过时的快照去给错的。
 */
const DEFAULT_SNAPSHOT_DEADLINE_MS = 3000

const TIMED_OUT = Symbol('snapshot-timed-out')

function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined
  const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), ms)
    // 别让这个计时器把 Electron 主进程的事件循环钉住。
    timer.unref?.()
  })
  return Promise.race([work, deadline]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

export interface ObservedChangesDeps {
  roots: () => string[]
  snapshot: (roots: string[]) => Promise<Snapshot>
  diff: (before: Snapshot, after: Snapshot) => FileChange[]
  /** 单次快照的时间上限。省略时用 3s;测试用它把超时变成确定事件。 */
  deadlineMs?: number
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

  // 记忆化的不只是一次 IO,更是「结束时刻」本身:第二次 finish 会拍一份更晚的
  // 结束快照,把回合结束之后发生的改动算进这一轮 —— 那是「给错的」,不是浪费。
  // 首次调用传进来的 reportedPaths 即为准,本就每回合只调一次。
  let result: Promise<FileChange[]> | null = null

  /**
   * 作废是静默的,而这正是它的危险之处:用户只会看到「卡片没出来」,分不清是本轮
   * 真的没改动(常态,不该有日志)还是基线不可信被整轮丢掉了(异常,查起来无迹可寻)。
   * 所以只在**不可信**的四个出口记一行 —— 没跑过命令、以及「跑了但没改动」都不记。
   */
  function discard(reason: string): FileChange[] {
    console.warn(`[observedChanges] 本轮命令行改动不予显示:${reason}`)
    return []
  }

  const deadlineMs = deps.deadlineMs ?? DEFAULT_SNAPSHOT_DEADLINE_MS

  async function compute(reportedPaths: Set<string>): Promise<FileChange[]> {
    if (!sawShell) return []
    if (!(await baselineWon)) {
      return discard('第一条命令早于起始快照拍完,基线可能已被它自己污染')
    }

    // 起始快照不需要自己的时限:走到这里说明 baselineWon 已经为 true,而它为 true
    // 的唯一途径就是 snapshotting 先 settle 了 —— 这个 await 不会等。真挂住的起始
    // 快照会被上面的赛跑闸判负,理由也更准确(那时基线确实不可信)。
    const before = await baseline
    if (!before) return discard('起始快照抛错')
    if (!before.complete) return discard('起始快照超预算或有目录读不动')

    let after: Snapshot | typeof TIMED_OUT
    try {
      after = await withDeadline(deps.snapshot(roots), deadlineMs)
    } catch {
      return discard('结束快照抛错')
    }
    // 这一条守的是回合本身:结束快照是在落库前 await 的,拖住它就是拖住这轮消息。
    if (after === TIMED_OUT) return discard(`结束快照超过 ${deadlineMs}ms 仍未完成`)
    if (!after.complete) return discard('结束快照超预算或有目录读不动')

    const reportedKeys = comparableKeys(reportedPaths, roots)
    return deps.diff(before, after).filter((change) => !reportedKeys.has(comparableKey(change.path)))
  }

  return {
    noteShellStarted(): void {
      sawShell = true
      // 只有第一条命令能改变判定:基线一旦赶在任何命令之前拍完,后面的命令再多也
      // 弄不脏一份已经拍好的快照。resolve 本身幂等,不需要额外的「只认第一条」开关。
      resolveFirstShell()
    },
    finish(reportedPaths: Set<string>): Promise<FileChange[]> {
      result ??= compute(reportedPaths)
      return result
    },
  }
}
