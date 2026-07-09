import { describe, expect, it } from 'vitest'
import { mapUserInput } from '../codexUserInput'
import type { AgentInput } from '../types'

/**
 * `text_elements` write-side (app-server v2 UserInput):
 *
 *   { type: "text", text, text_elements: [{ byteRange: {start,end}, placeholder }] }
 *
 * "UI-defined spans within `text` used to render or persist special elements."
 * Minimal official-compat: mark each resolved `@mention` token's span so the
 * rollout carries where the plugin invocation sat in the text (byte offsets,
 * UTF-8 — the server is Rust and indexes the text buffer by BYTES, not JS
 * UTF-16 code units). Placeholder = the mention's display name.
 */

function byteLen(s: string): number {
  return Buffer.byteLength(s, 'utf8')
}

describe('mapUserInput text_elements for @mentions', () => {
  it('marks the byte range of a resolved @token with the mention display name as placeholder', () => {
    const text = 'please run @sample now'
    const items: AgentInput['items'] = [
      { type: 'text', text },
      { type: 'mention', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ]

    const [textItem] = mapUserInput(items)
    if (textItem.type !== 'text') throw new Error('expected text item first')

    const start = byteLen('please run ')
    const end = start + byteLen('@sample')
    expect(textItem.text_elements).toEqual([
      { byteRange: { start, end }, placeholder: 'Sample Plugin' },
    ])
  })

  it('uses UTF-8 byte offsets, not UTF-16 code units, when multibyte text precedes the token', () => {
    // '请运行 ' = 3 CJK chars (3 bytes each in UTF-8) + space = 10 bytes, 4 code units.
    const text = '请运行 @sample 谢谢'
    const items: AgentInput['items'] = [
      { type: 'text', text },
      { type: 'mention', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ]

    const [textItem] = mapUserInput(items)
    if (textItem.type !== 'text') throw new Error('expected text item first')

    const start = byteLen('请运行 ')
    const end = start + byteLen('@sample')
    expect(textItem.text_elements).toEqual([
      { byteRange: { start, end }, placeholder: 'Sample Plugin' },
    ])
    expect(start).toBe(10)
  })

  it('marks every occurrence of the token but not emails or mid-word @', () => {
    const text = '@sample first, mail me@sample.com, then @sample again'
    const items: AgentInput['items'] = [
      { type: 'text', text },
      { type: 'mention', name: 'Sample Plugin', path: 'plugin://sample@test' },
    ]

    const [textItem] = mapUserInput(items)
    if (textItem.type !== 'text') throw new Error('expected text item first')

    expect(textItem.text_elements).toHaveLength(2)
    const firstEnd = byteLen('@sample')
    expect(textItem.text_elements[0]).toEqual({
      byteRange: { start: 0, end: firstEnd },
      placeholder: 'Sample Plugin',
    })
    const secondStart = byteLen('@sample first, mail me@sample.com, then ')
    expect(textItem.text_elements[1]).toEqual({
      byteRange: { start: secondStart, end: secondStart + byteLen('@sample') },
      placeholder: 'Sample Plugin',
    })
  })

  it('emits empty text_elements when there are no mention items', () => {
    const items: AgentInput['items'] = [{ type: 'text', text: 'plain message' }]
    const [textItem] = mapUserInput(items)
    if (textItem.type !== 'text') throw new Error('expected text item first')
    expect(textItem.text_elements).toEqual([])
  })

  it('derives the token from an app:// mention path as the id segment', () => {
    const text = 'ask @demo-app for status'
    const items: AgentInput['items'] = [
      { type: 'text', text },
      { type: 'mention', name: 'Demo App', path: 'app://demo-app' },
    ]

    const [textItem] = mapUserInput(items)
    if (textItem.type !== 'text') throw new Error('expected text item first')

    const start = byteLen('ask ')
    expect(textItem.text_elements).toEqual([
      { byteRange: { start, end: start + byteLen('@demo-app') }, placeholder: 'Demo App' },
    ])
  })
})
