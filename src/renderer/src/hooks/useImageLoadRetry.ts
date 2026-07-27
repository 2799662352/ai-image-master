import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * 让一张远端图在加载失败后自己重试,重试用尽再判死。
 *
 * 为什么要有:生成结果先以模型直出的临时 URL 展示、随后热切到 COS,历史页
 * 一屏又要拉几十张缩图。这些都是普通网络请求,一次抖动就让 `<img>` 永久停在
 * 裂图上 —— 图本身好好的,刷新页面又能看见。
 *
 * 重试的做法是**换 key 重新挂载**,而不是给 URL 加缓存穿透参数:模型直出与
 * COS 都是预签名地址,签名覆盖查询串,加一个 `?t=` 会把"也许还能加载"变成
 * 必定 403。
 *
 * 判死后不再重挂 —— 真 404 的图无限重试只会一直刷请求。
 */
export interface ImageLoadRetry {
  /** 挂到 `<img key={reloadKey}>`;变化即让浏览器重新取这张图。 */
  reloadKey: number
  /** 挂到 `<img onError={onError}>`。 */
  onError: () => void
  /** 重试已用尽,调用方该改显示占位。 */
  failed: boolean
}

export interface ImageLoadRetryOptions {
  maxRetries?: number
  baseDelayMs?: number
}

export function useImageLoadRetry(
  src: string | undefined,
  options: ImageLoadRetryOptions = {},
): ImageLoadRetry {
  const { maxRetries = 2, baseDelayMs = 800 } = options
  const [reloadKey, setReloadKey] = useState(0)
  const [failed, setFailed] = useState(false)
  const attemptsRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  const clearPending = useCallback(() => {
    if (timerRef.current === undefined) return
    clearTimeout(timerRef.current)
    timerRef.current = undefined
  }, [])

  // 换图即重新开始:热切到 COS 的那张不该继承临时 URL 的失败。
  useEffect(() => {
    clearPending()
    attemptsRef.current = 0
    setFailed(false)
  }, [src, clearPending])

  useEffect(() => clearPending, [clearPending])

  const onError = useCallback(() => {
    if (attemptsRef.current >= maxRetries) {
      setFailed(true)
      return
    }
    const delay = baseDelayMs * 2 ** attemptsRef.current
    attemptsRef.current += 1
    clearPending()
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined
      setReloadKey((k) => k + 1)
    }, delay)
  }, [baseDelayMs, clearPending, maxRetries])

  return { reloadKey, onError, failed }
}
