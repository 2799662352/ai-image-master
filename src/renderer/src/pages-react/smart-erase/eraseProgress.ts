// src/renderer/src/pages-react/smart-erase/eraseProgress.ts
import type { EraseTask } from '../../../../types/smartErase'

export function computeProcessingProgress(opts: {
  startedAt: number
  durationSeconds: number
  status: EraseTask['status']
  now: number
}): number {
  if (opts.status === 'finished') return 100
  if (opts.status !== 'processing') return 0
  if (!Number.isFinite(opts.startedAt) || !Number.isFinite(opts.now)) return 0

  const elapsedSec = Math.max(0, (opts.now - opts.startedAt) / 1000)
  const safeDuration =
    Number.isFinite(opts.durationSeconds) && opts.durationSeconds > 0
      ? opts.durationSeconds
      : 0
  const tau = Math.max(15, safeDuration * 2)
  return Math.round(95 * (1 - Math.exp(-elapsedSec / tau)))
}
