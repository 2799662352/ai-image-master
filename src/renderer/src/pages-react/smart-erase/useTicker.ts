import { useState, useEffect } from 'react'

export function useTicker(active: boolean, intervalMs = 1000): number {
  const [now, setNow] = useState(Date.now)

  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [active, intervalMs])

  return now
}
