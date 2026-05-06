import { describe, expect, it } from 'vitest'

describe('agent IPC channel names', () => {
  it('uses stable channel names', () => {
    expect('agent:send-message').toBe('agent:send-message')
    expect('agent:tool-response').toBe('agent:tool-response')
  })
})
