import { useEffect, useState } from 'react'

/**
 * 从 `startedAt`(epoch ms)起每秒重算一次的已用秒数。`active=false`(卡片不在
 * 运行态)时不起定时器、返回 0 —— 一屏几十张完成卡不该各自挂一个 interval。
 */
export function useElapsedSeconds(startedAt: number | undefined, active: boolean): number {
  const compute = () => (startedAt && active ? Math.max(0, Math.floor((Date.now() - startedAt) / 1000)) : 0)
  const [seconds, setSeconds] = useState(compute)

  useEffect(() => {
    if (!active || !startedAt) {
      setSeconds(0)
      return
    }
    setSeconds(compute())
    const timer = setInterval(() => setSeconds(compute()), 1000)
    return () => clearInterval(timer)
    // compute 只依赖这两个入参
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [startedAt, active])

  return seconds
}

/** `'20s'` / `'~40s'` / `'1m'` / `'90'` → 秒;认不出返回 undefined。 */
export function parseExpectedSeconds(time: string | number | undefined): number | undefined {
  if (typeof time === 'number') return Number.isFinite(time) && time > 0 ? time : undefined
  if (typeof time !== 'string') return undefined
  const m = /(\d+(?:\.\d+)?)\s*(m|min|s|sec)?/i.exec(time.trim())
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n <= 0) return undefined
  return /^m/i.test(m[2] ?? '') ? n * 60 : n
}
