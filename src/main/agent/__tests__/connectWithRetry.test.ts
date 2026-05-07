import { describe, expect, it, vi } from 'vitest'
import { connectWithRetry } from '../connectWithRetry'

describe('connectWithRetry', () => {
  it('retries until factory succeeds within timeout', async () => {
    let attempts = 0
    const result = await connectWithRetry({
      attempt: () => {
        attempts += 1
        if (attempts < 3) throw new Error('not ready')
        return Promise.resolve('ws')
      },
      timeoutMs: 2000,
      intervalMs: 10,
    })
    expect(result).toBe('ws')
    expect(attempts).toBe(3)
  })

  it('rejects after timeout with the last error', async () => {
    await expect(
      connectWithRetry({
        attempt: () => Promise.reject(new Error('boom')),
        timeoutMs: 50,
        intervalMs: 10,
      }),
    ).rejects.toThrow(/timed out.*boom/)
  })
})
