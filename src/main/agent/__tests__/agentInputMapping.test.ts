import { describe, expect, it } from 'vitest'
import { mapUserInput } from '../codexUserInput'
import type { AgentInput } from '../types'

describe('mapUserInput (AgentInput.items -> CodexUserInput[])', () => {
  it('maps a text item to Codex text with snake_case text_elements', () => {
    const items: AgentInput['items'] = [{ type: 'text', text: 'hello world' }]
    expect(mapUserInput(items)).toEqual([
      { type: 'text', text: 'hello world', text_elements: [] },
    ])
  })

  it('maps a localImage item to Codex localImage carrying the filesystem path verbatim', () => {
    const items: AgentInput['items'] = [{ type: 'localImage', path: '/tmp/cat.png' }]
    expect(mapUserInput(items)).toEqual([
      { type: 'localImage', path: '/tmp/cat.png' },
    ])
  })

  it('maps an image item to Codex image with `url` (not `imageUrl`)', () => {
    const items: AgentInput['items'] = [{ type: 'image', url: 'https://example.com/cat.png' }]
    const out = mapUserInput(items)
    expect(out).toEqual([{ type: 'image', url: 'https://example.com/cat.png' }])
    expect((out[0] as Record<string, unknown>).imageUrl).toBeUndefined()
  })

  it('preserves order across mixed text / localImage / image items', () => {
    const items: AgentInput['items'] = [
      { type: 'text', text: 'look at this:' },
      { type: 'localImage', path: '/tmp/cat.png' },
      { type: 'text', text: 'and also:' },
      { type: 'image', url: 'https://example.com/dog.png' },
    ]
    expect(mapUserInput(items)).toEqual([
      { type: 'text', text: 'look at this:', text_elements: [] },
      { type: 'localImage', path: '/tmp/cat.png' },
      { type: 'text', text: 'and also:', text_elements: [] },
      { type: 'image', url: 'https://example.com/dog.png' },
    ])
  })
})
