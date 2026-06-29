import { describe, expect, it } from 'vitest'
import { parseJsonl, parseJsonlLine } from '../jsonl'

describe('parseJsonlLine', () => {
  it('parses a valid JSON object line', () => {
    expect(parseJsonlLine('{"type":"turn.started"}')).toEqual({ type: 'turn.started' })
  })

  it('returns null for blank lines and whitespace', () => {
    expect(parseJsonlLine('')).toBeNull()
    expect(parseJsonlLine('   ')).toBeNull()
    expect(parseJsonlLine('\t')).toBeNull()
  })

  it('returns null for non-JSON noise (codex streams human logs to stderr, but be safe)', () => {
    expect(parseJsonlLine('[codex] starting up...')).toBeNull()
    expect(parseJsonlLine('{ not json')).toBeNull()
  })

  it('returns null for JSON that is not an object (numbers, arrays, strings)', () => {
    expect(parseJsonlLine('42')).toBeNull()
    expect(parseJsonlLine('"hello"')).toBeNull()
    expect(parseJsonlLine('[1,2,3]')).toBeNull()
    expect(parseJsonlLine('null')).toBeNull()
  })

  it('requires a string `type` field', () => {
    expect(parseJsonlLine('{"foo":1}')).toBeNull()
    expect(parseJsonlLine('{"type":123}')).toBeNull()
  })
})

describe('parseJsonl', () => {
  it('parses a multi-line stream and skips noise/blank lines', () => {
    const stream = [
      '{"type":"thread.started","thread_id":"thr_1"}',
      '',
      '[codex] noise that should be ignored',
      '{"type":"turn.started"}',
      '{"type":"turn.completed"}',
    ].join('\n')
    const events = parseJsonl(stream)
    expect(events.map((e) => e.type)).toEqual([
      'thread.started',
      'turn.started',
      'turn.completed',
    ])
  })

  it('handles CRLF framing', () => {
    const stream = '{"type":"turn.started"}\r\n{"type":"turn.completed"}\r\n'
    expect(parseJsonl(stream).map((e) => e.type)).toEqual(['turn.started', 'turn.completed'])
  })

  it('accepts an array of lines as well as a single string', () => {
    const events = parseJsonl(['{"type":"turn.started"}', '{"type":"turn.completed"}'])
    expect(events).toHaveLength(2)
  })

  it('preserves nested item payloads verbatim', () => {
    const stream = JSON.stringify({
      type: 'item.completed',
      item: { id: 'i1', type: 'mcp_tool_call', server: 'catimation', tool: 'ask_user', arguments: { question: 'x' }, status: 'completed' },
    })
    const [evt] = parseJsonl(stream)
    expect(evt.item).toMatchObject({ type: 'mcp_tool_call', tool: 'ask_user' })
  })
})
