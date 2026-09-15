/**
 * useMediaCandidates — 沿着一条候选源链把缩略图画出来,画不出来就换下一条,
 * 换完了也不放弃。
 *
 * 与 `useResolvedMediaSrc` 的分工:那个 hook 只负责「一条源 → 可渲染 URL」
 * (本地路径经 IPC 读成 blob:,远端原样透传)。这里在它之上管**失败之后怎么办**:
 *
 *  - 主源(数据万象缩略 URL)**始终为主**。远端加载失败先原地指数退避重试
 *    (默认 4 次:0.8 / 1.6 / 3.2 / 6.4 s,约 12 s)—— 代理抖动、COS 偶发超时
 *    都是这个量级内能自愈的,不能失败两次就撒手;
 *  - 重试用尽、或本地副本读不到(IPC 回 null:文件被 7 天清理、换了机器),
 *    换下一条候选;
 *  - 全链耗尽 → `exhausted`,调用方画占位卡。但占位卡不是终点:每隔
 *    `rearmIntervalMs`(默认 30 s)自动从**主源**重来一轮,最多 `maxRearms`
 *    轮(默认 10 轮 ≈ 5 分钟)—— 切个代理节点、网络恢复后图自己就回来了;
 *    `retry()` 是手动「重载」,立刻重来并把自动轮数归零。
 *
 * 候选链本身由 `buildMediaCandidates` 事先整理好(去重、丢过期签名链接),
 * 这里不再做判断。
 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { isRemoteHttpUrl } from './mediaFallback'
import {
  acquireMediaSrc,
  releaseMediaSrc,
  toOsPathIfLocal,
  type MediaKindHint,
  type UseResolvedMediaSrcOptions,
} from './useResolvedMediaSrc'

/** 同一条远端链接的原地重试次数。测试与调用方都引用这个常量,别各写一个数。 */
export const DEFAULT_REMOTE_RETRIES = 4
export const DEFAULT_RETRY_BASE_DELAY_MS = 800
/** 全链耗尽后自动从头再试的间隔与轮数。 */
export const DEFAULT_REARM_INTERVAL_MS = 30_000
export const DEFAULT_MAX_REARMS = 10

export interface UseMediaCandidatesOptions extends UseResolvedMediaSrcOptions {
  /** 同一条远端链接原地重试次数(默认 {@link DEFAULT_REMOTE_RETRIES})。本地副本读失败不重试,直接换下一条。 */
  maxRetries?: number
  /** 首次重试等待(默认 {@link DEFAULT_RETRY_BASE_DELAY_MS}),之后翻倍。 */
  baseDelayMs?: number
  /** 全链耗尽后多久自动从主源重来(默认 {@link DEFAULT_REARM_INTERVAL_MS});0 = 关掉自动重来,只留手动。 */
  rearmIntervalMs?: number
  /** 自动重来的最多轮数(默认 {@link DEFAULT_MAX_REARMS}),用完只剩手动「重载」。 */
  maxRearms?: number
}

export interface MediaCandidatesState {
  /** 当前候选的可渲染 URL;解析中或链已耗尽时为 null。 */
  src: string | null
  /** 每次重试 +1,挂到 `<img key>` 上强制浏览器重新发请求。 */
  reloadKey: number
  /** 挂到 `<img onError>` / `<video onError>`。 */
  onError: () => void
  /** 所有候选都失败了(或一开始就没有候选)。 */
  exhausted: boolean
  /** 正在展示的那条候选(占位卡 tooltip / 调试用)。 */
  current: string | null
  /** 回到第一条候选重来一遍 —— 给占位卡上的「重载」;同时把自动重来的轮数归零。 */
  retry: () => void
}

/** 远端 / blob / data 透传源可以同步给出,不必等 effect —— 首帧就有图。 */
function syncSrc(candidate: string | null): string | null {
  if (!candidate) return null
  return toOsPathIfLocal(candidate) === null ? candidate : null
}

export function useMediaCandidates(
  candidates: readonly string[],
  hint: MediaKindHint = 'auto',
  opts: UseMediaCandidatesOptions = {},
): MediaCandidatesState {
  const {
    maxRetries = DEFAULT_REMOTE_RETRIES,
    baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    rearmIntervalMs = DEFAULT_REARM_INTERVAL_MS,
    maxRearms = DEFAULT_MAX_REARMS,
    fullFidelity,
    thumbSize,
  } = opts
  // 候选链按内容比较:调用方每次 render 传新数组是常态,不能按引用重置。
  const chainKey = candidates.join('\n')

  const [index, setIndex] = useState(0)
  const [reloadKey, setReloadKey] = useState(0)
  const [exhausted, setExhausted] = useState(candidates.length === 0)
  const attemptsRef = useRef(0)
  const rearmsRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // 链变了(换图 / 热切到 COS 永久链接)→ 同步归零,别让旧链的失败态盖住新链。
  const [trackedChain, setTrackedChain] = useState(chainKey)
  if (chainKey !== trackedChain) {
    setTrackedChain(chainKey)
    setIndex(0)
    setExhausted(candidates.length === 0)
    attemptsRef.current = 0
    rearmsRef.current = 0
  }

  const current = index < candidates.length ? candidates[index] : null
  const [src, setSrc] = useState<string | null>(() => syncSrc(current))
  const [trackedCurrent, setTrackedCurrent] = useState(current)
  if (current !== trackedCurrent) {
    setTrackedCurrent(current)
    setSrc(syncSrc(current))
  }

  const clearTimer = useCallback(() => {
    if (timerRef.current === undefined) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])
  useEffect(() => clearTimer, [clearTimer])

  const advance = useCallback(() => {
    clearTimer()
    attemptsRef.current = 0
    setIndex((i) => {
      const next = i + 1
      if (next >= candidates.length) setExhausted(true)
      return next
    })
  }, [candidates.length, clearTimer])

  // 解析当前候选。本地路径经共享 blob 缓存读盘;读不到(null)直接换下一条。
  useEffect(() => {
    if (!current) return
    if (toOsPathIfLocal(current) === null) {
      setSrc(current)
      return
    }
    let cancelled = false
    const resolveOpts: UseResolvedMediaSrcOptions = { fullFidelity, thumbSize }
    acquireMediaSrc(current, hint, resolveOpts)
      .then((url) => {
        if (cancelled) return
        if (url === null) advance()
        else setSrc(url)
      })
      .catch(() => {
        if (!cancelled) advance()
      })
    return () => {
      cancelled = true
      releaseMediaSrc(current, hint, resolveOpts)
    }
  }, [current, hint, fullFidelity, thumbSize, advance])

  const onError = useCallback(() => {
    if (!current) return
    if (isRemoteHttpUrl(current) && attemptsRef.current < maxRetries) {
      const delay = baseDelayMs * 2 ** attemptsRef.current
      attemptsRef.current += 1
      clearTimer()
      timerRef.current = setTimeout(() => {
        timerRef.current = undefined
        setReloadKey((k) => k + 1)
      }, delay)
      return
    }
    advance()
  }, [current, maxRetries, baseDelayMs, clearTimer, advance])

  const restart = useCallback(() => {
    clearTimer()
    attemptsRef.current = 0
    setIndex(0)
    setExhausted(candidates.length === 0)
    setReloadKey((k) => k + 1)
  }, [candidates.length, clearTimer])

  const retry = useCallback(() => {
    rearmsRef.current = 0
    restart()
  }, [restart])

  // 占位卡不是终点:耗尽后定时从主源再来一轮,直到轮数用完。链变了会重新计数。
  useEffect(() => {
    if (!exhausted || candidates.length === 0 || rearmIntervalMs <= 0) return
    if (rearmsRef.current >= maxRearms) return
    const timer = setTimeout(() => {
      rearmsRef.current += 1
      restart()
    }, rearmIntervalMs)
    return () => clearTimeout(timer)
  }, [exhausted, candidates.length, rearmIntervalMs, maxRearms, restart])

  return { src: exhausted ? null : src, reloadKey, onError, exhausted, current, retry }
}
