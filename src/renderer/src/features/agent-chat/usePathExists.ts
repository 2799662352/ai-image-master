/**
 * 「这个路径在磁盘上真的是个文件吗」—— 聊天里裸路径能否变成链接的唯一判据。
 *
 * 对应 VS Code Copilot Chat 的 `StatCache`。那边在
 * vscode-copilot-chat#4092 里专门做过一轮性能治理,标题就是「消除符号解析导致的
 * 流式卡顿」,拿到的三条经验这里都用上了:
 *
 *  1. **必须有缓存**。流式回复每来一个 delta 就整段重解析,同一个路径会被反复
 *     问到;没缓存就是每帧一串 IPC。
 *  2. **失败也要缓存**。绝大多数候选都不是文件(版本号、普通词),不缓存等于把
 *     最常见的那条路留成最贵的。
 *  3. **同一批并发发出去**,不要串行等。这里天然满足:每个候选各自 useEffect,
 *     浏览器会把它们并发派出去。
 *
 * 与 VS Code 的一处不同:它的缓存是**每次响应**一个,随响应结束整个丢掉;我们
 * 是模块级长活缓存,于是要自己处理「文件后来才被创建」——agent 说「我建好了
 * src/a.ts」时,那次 stat 很可能跑在写盘之前。所以**否定结果带 TTL**,肯定结果
 * 不带(文件被删了顶多留一个点开报错的链接,比反复 stat 划算)。
 */

import { useEffect, useState } from 'react'

type Verdict = boolean

interface Entry {
  verdict: Verdict
  at: number
}

/**
 * 否定结果的存活时间。取 15 秒:够短,agent 建完文件后用户回头再看那条消息就
 * 已经能点了;够长,一次流式回复里同一个不存在的 token 不会被反复问。
 */
const NEGATIVE_TTL_MS = 15_000

/** 缓存上限。超了整个清掉 —— 聊天里的路径基数很小,做 LRU 不值当。 */
const MAX_ENTRIES = 2000

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Verdict>>()

function cached(path: string): Verdict | undefined {
  const hit = cache.get(path)
  if (!hit) return undefined
  if (hit.verdict === false && Date.now() - hit.at > NEGATIVE_TTL_MS) {
    cache.delete(path)
    return undefined
  }
  return hit.verdict
}

function remember(path: string, verdict: Verdict): void {
  if (cache.size >= MAX_ENTRIES) cache.clear()
  cache.set(path, { verdict, at: Date.now() })
}

type FsBridge = {
  stat?: (p: string) => Promise<{ ok: boolean } | undefined>
}

function fsBridge(): FsBridge | undefined {
  return (window as Window & { electronAPI?: { fs?: FsBridge } }).electronAPI?.fs
}

/**
 * 问一次磁盘(带缓存与在途去重)。
 *
 * 走 `fs:stat` 而不是自己造一个新通道:它一并干了三件我们需要的事 —— 存在性、
 * **allowed-roots 校验**(越界返回 ok:false,不是抛错)、以及「是文件不是目录」。
 * 换句话说,能被标成链接的路径,必然是这个 app 本来就允许打开的路径。
 */
export function verifyPathExists(path: string): Promise<Verdict> {
  const hit = cached(path)
  if (hit !== undefined) return Promise.resolve(hit)

  const pending = inflight.get(path)
  if (pending) return pending

  const stat = fsBridge()?.stat
  if (!stat) return Promise.resolve(false)

  const task = stat(path)
    .then((res) => Boolean(res?.ok))
    .catch(() => false)
    .then((verdict) => {
      remember(path, verdict)
      inflight.delete(path)
      return verdict
    })

  inflight.set(path, task)
  return task
}

/**
 * `undefined` = 还不知道(未验证/在途)。调用方在这个阶段必须按「不是链接」渲染,
 * 绝不能先标蓝再回退 —— 那会让正文在流式过程中一闪一闪。
 */
export function usePathExists(path: string | undefined): Verdict | undefined {
  const [verdict, setVerdict] = useState<Verdict | undefined>(() =>
    path ? cached(path) : undefined,
  )

  useEffect(() => {
    if (!path) {
      setVerdict(undefined)
      return
    }
    const hit = cached(path)
    if (hit !== undefined) {
      setVerdict(hit)
      return
    }
    let alive = true
    setVerdict(undefined)
    void verifyPathExists(path).then((result) => {
      if (alive) setVerdict(result)
    })
    return () => {
      alive = false
    }
  }, [path])

  return verdict
}

/** 测试用:清空缓存,免得用例之间互相看见对方的结果。 */
export function __resetPathExistsCache(): void {
  cache.clear()
  inflight.clear()
}
