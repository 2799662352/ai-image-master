import { describe, expect, it } from 'vitest'
import type { AgentSendMessagePayload } from '../../../../types/agent'

describe('agent IPC types', () => {
  it('accepts a text message with attachments', () => {
    const payload: AgentSendMessagePayload = {
      content: '生成一张 cyberpunk cat',
      attachments: [{ name: 'ref.png', mime: 'image/png', size: 1024 }],
    }
    expect(payload.attachments[0].mime).toBe('image/png')
  })
})
