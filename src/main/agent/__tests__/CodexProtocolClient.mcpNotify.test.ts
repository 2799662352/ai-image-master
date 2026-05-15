import { describe, it, expect } from 'vitest'
import { CodexNotificationRouter } from '../codexNotificationRouter'

describe('MCP notification routing', () => {
  it('routes mcpServer/startupStatus/updated to mcp_status_updated event', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('mcpServer/startupStatus/updated', {
      name: 'github',
      status: 'ready',
      error: null,
    })
    expect(event).toEqual({
      type: 'mcp_status_updated',
      name: 'github',
      status: 'ready',
      error: null,
    })
  })

  it('routes mcpServer/oauthLogin/completed to mcp_oauth_completed event', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('mcpServer/oauthLogin/completed', {
      name: 'my-server',
      success: true,
      error: null,
    })
    expect(event).toEqual({
      type: 'mcp_oauth_completed',
      name: 'my-server',
      success: true,
      error: null,
    })
  })

  it('routes mcpServer/startupStatus/updated with error', () => {
    const router = new CodexNotificationRouter()
    const event = router.route('mcpServer/startupStatus/updated', {
      name: 'broken',
      status: 'failed',
      error: 'spawn ENOENT',
    })
    expect(event).toEqual({
      type: 'mcp_status_updated',
      name: 'broken',
      status: 'failed',
      error: 'spawn ENOENT',
    })
  })
})
