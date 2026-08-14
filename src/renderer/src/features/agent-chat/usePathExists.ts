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
 * 与 VS Code 的一处不同、以及由此欠下的债:它的缓存是**每次响应**一个,随响应
 * 结束整个丢掉 —— 那不是一个需要调参的 TTL,而是「生命周期恰好等于那次计算的
 * 作用域」。我们是模块级长活缓存(因为 React 会反复重渲染,不缓存就是每帧一串
 * IPC),于是「什么时候该重新验证」这个责任就落到了自己头上,两个方向都要管:
 *
 *  - **文件后来才被创建**:agent 说「我建好了 src/a.ts」时,那次 stat 很可能
 *    跑在写盘之前 → 否定结果必须过期。
 *  - **文件后来被删掉**:永久肯定缓存会让新消息里那个路径照样标蓝,点下去
 *    openTab 撞 stat 失败 → 肯定结果同样必须过期。这一条第一版漏了,那是**比
 *    VS Code 更松**的选择,而且松在了我们这轮正要消灭的失效模式上。
 *
 * 两侧都带 TTL 之后,缓存退回成纯粹的性能优化 —— 陈旧有界,语义上重新贴近
 * 「生命周期匹配作用域」。
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

/**
 * 肯定结果的存活时间。
 *
 * 一开始这里是「永不过期」,那是**比 VS Code 更松**的一个选择,而且松错了方向。
 * 它的 StatCache 每次响应一个、随响应丢掉,所以下一条消息提到一个已被删除的
 * 文件时会重新 stat、正确地渲染成纯文本;我们的长活缓存会一直复用那个 `true`,
 * 于是新消息里照样标蓝,点下去 openTab 撞 stat 失败 —— 又是一个「看起来能点、
 * 点了没反应」,只是成因从 sanitizer 换成了陈旧缓存。
 *
 * 加上 TTL 之后,缓存退回成纯粹的性能优化:两个方向的陈旧都有界。60 秒的取法是
 * 「一次对话里不会重复问,但换个话题回头看就已经重新核过」。
 *
 * 真删掉的那一刻仍有最长 60 秒的窗口 —— 那一下由 openTab 的「打不开」提示条兜住,
 * 用户至少知道发生了什么,而不是面对一个装死的链接。
 */
const POSITIVE_TTL_MS = 60_000

/** 缓存上限。超了整个清掉 —— 聊天里的路径基数很小,做 LRU 不值当。 */
const MAX_ENTRIES = 2000

const cache = new Map<string, Entry>()
const inflight = new Map<string, Promise<Verdict>>()

function cached(path: string): Verdict | undefined {
  const hit = cache.get(path)
  if (!hit) return undefined
  const ttl = hit.verdict ? POSITIVE_TTL_MS : NEGATIVE_TTL_MS
  if (Date.now() - hit.at > ttl) {
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
