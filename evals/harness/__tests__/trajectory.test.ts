import { describe, expect, it } from 'vitest'
import type { ThreadEvent } from '../types'
import {
  agentMessages,
  assertToolArgs,
  assertToolNotUsed,
  assertToolOrder,
  assertToolUsed,
  errors,
  finalMessage,
  mcpToolCalls,
  toolNames,
  turnFailed,
} from '../trajectory'

function evt(type: string, extra: Record<string, unknown> = {}): ThreadEvent {
  return { type, ...extra }
}

function toolCompleted(tool: string, args: unknown = {}, opts: { id?: string; server?: string; status?: string } = {}): ThreadEvent {
  return evt('item.completed', {
    item: {
      id: opts.id ?? `i_${tool}`,
      type: 'mcp_tool_call',
      server: opts.server ?? 'catimation',
      tool,
      arguments: args,
      status: opts.status ?? 'completed',
    },
  })
}

function msg(text: string, id = `m_${text}`): ThreadEvent {
  return evt('item.completed', { item: { id, type: 'agent_message', text } })
}

describe('mcpToolCalls', () => {
  it('extracts tool calls from item.completed mcp_tool_call items', () => {
    const events = [evt('turn.started'), toolCompleted('ask_user', { question: 'q' }), evt('turn.completed')]
    const calls = mcpToolCalls(events)
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ tool: 'ask_user', server: 'catimation', completed: true, status: 'completed' })
    expect(calls[0].arguments).toEqual({ question: 'q' })
  })

  it('dedups a call that appears as both item.started and item.completed (by id), preferring completed', () => {
    const started = evt('item.started', { item: { id: 'dup', type: 'mcp_tool_call', server: 'catimation', tool: 'ask_user', status: 'in_progress' } })
    const done = toolCompleted('ask_user', { question: 'q' }, { id: 'dup' })
    const calls = mcpToolCalls([started, done])
    expect(calls).toHaveLength(1)
    expect(calls[0].completed).toBe(true)
    expect(calls[0].status).toBe('completed')
  })

  it('includes a started-only call (turn died before completion) as not completed', () => {
    const started = evt('item.started', { item: { id: 'x', type: 'mcp_tool_call', tool: 'ask_user', status: 'in_progress' } })
    const calls = mcpToolCalls([started])
    expect(calls).toHaveLength(1)
    expect(calls[0].completed).toBe(false)
    expect(calls[0].server).toBe('') // missing server defaults to ''
  })

  it('captures error message for failed calls', () => {
    const failed = toolCompleted('generate_image', {}, { status: 'failed' })
    ;(failed.item as { error?: unknown }).error = { message: 'boom' }
    const [call] = mcpToolCalls([failed])
    expect(call.status).toBe('failed')
    expect(call.error).toBe('boom')
  })

  it('ignores non-mcp items', () => {
    const events = [msg('hi'), evt('item.completed', { item: { id: 'c', type: 'command_execution', command: 'ls' } })]
    expect(mcpToolCalls(events)).toHaveLength(0)
  })
})

describe('toolNames', () => {
  it('returns tool names in call order', () => {
    const events = [toolCompleted('a'), toolCompleted('b'), toolCompleted('a', {}, { id: 'a2' })]
    expect(toolNames(events)).toEqual(['a', 'b', 'a'])
  })
})

describe('assertToolUsed', () => {
  it('passes when the tool was called', () => {
    expect(() => assertToolUsed([toolCompleted('ask_user')], 'ask_user')).not.toThrow()
  })
  it('throws a helpful message when the tool was never called', () => {
    expect(() => assertToolUsed([toolCompleted('generate_image')], 'ask_user')).toThrow(/ask_user/)
  })
})

describe('assertToolNotUsed', () => {
  it('passes when the tool was never called', () => {
    expect(() => assertToolNotUsed([toolCompleted('generate_image')], 'ask_user')).not.toThrow()
    expect(() => assertToolNotUsed([], 'ask_user')).not.toThrow()
  })
  it('throws when the tool WAS called (misroute)', () => {
    expect(() => assertToolNotUsed([toolCompleted('ask_user')], 'ask_user')).toThrow(/ask_user/)
  })
})

describe('assertToolOrder', () => {
  it('passes when names appear as a subsequence (gaps allowed)', () => {
    const events = [toolCompleted('a'), toolCompleted('x', {}, { id: 'x' }), toolCompleted('b')]
    expect(() => assertToolOrder(events, ['a', 'b'])).not.toThrow()
  })
  it('throws when the order is violated', () => {
    const events = [toolCompleted('b'), toolCompleted('a')]
    expect(() => assertToolOrder(events, ['a', 'b'])).toThrow()
  })
})

describe('assertToolArgs', () => {
  it('passes when at least one call to the tool matches the predicate', () => {
    const events = [toolCompleted('ask_user', { options: [1, 2, 3] })]
    expect(() =>
      assertToolArgs(events, 'ask_user', (a) => Array.isArray((a as { options?: unknown[] }).options) && (a as { options: unknown[] }).options.length >= 3),
    ).not.toThrow()
  })
  it('throws when no call matches', () => {
    const events = [toolCompleted('ask_user', { options: [1] })]
    expect(() =>
      assertToolArgs(events, 'ask_user', (a) => (a as { options: unknown[] }).options.length >= 3),
    ).toThrow()
  })
  it('throws when the tool was never called at all', () => {
    expect(() => assertToolArgs([], 'ask_user', () => true)).toThrow(/ask_user/)
  })
})

describe('agentMessages / finalMessage', () => {
  it('collects agent_message texts in order', () => {
    expect(agentMessages([msg('one'), toolCompleted('a'), msg('two')])).toEqual(['one', 'two'])
  })
  it('finalMessage returns the last agent message, or undefined', () => {
    expect(finalMessage([msg('one'), msg('two')])).toBe('two')
    expect(finalMessage([toolCompleted('a')])).toBeUndefined()
  })
})

describe('turnFailed / errors', () => {
  it('detects turn.failed and error events', () => {
    expect(turnFailed([evt('turn.completed')])).toBe(false)
    expect(turnFailed([evt('turn.failed', { error: { message: 'nope' } })])).toBe(true)
    expect(turnFailed([evt('error', { error: 'fatal' })])).toBe(true)
  })
  it('collects error messages from error/turn.failed events', () => {
    const events = [evt('turn.failed', { error: { message: 'a' } }), evt('error', { error: 'b' })]
    expect(errors(events)).toEqual(['a', 'b'])
  })
})
