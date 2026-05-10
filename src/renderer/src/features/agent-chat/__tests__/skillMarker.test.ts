import { describe, expect, it } from 'vitest'
import { extractSkillTokens } from '../store'
import { detectSkillTrigger } from '../MentionInput'

/**
 * Codex app-server's `$skill-name` marker rules (codex-rs/app-server/README.md):
 *   - `$` only counts at start of input or after whitespace.
 *   - The token name is `[\w-]+` (letters, digits, underscore, hyphen).
 *   - The token ends at the first non-`[\w-]` character.
 *
 * `extractSkillTokens` is used at send-time to attach `skill` input items.
 * `detectSkillTrigger` is used live as the user types to drive the popup.
 */

describe('extractSkillTokens (send-time) — codex $skill-name marker', () => {
  it('returns [] for plain text', () => {
    expect(extractSkillTokens('hello there')).toEqual([])
  })

  it('extracts a single $skill-name at start of input', () => {
    expect(extractSkillTokens('$skill-creator add a CI triage helper')).toEqual(['skill-creator'])
  })

  it('extracts $skill when preceded by whitespace', () => {
    expect(extractSkillTokens('please use $compactor on this thread')).toEqual(['compactor'])
  })

  it('extracts multiple distinct skills in order', () => {
    expect(extractSkillTokens('first $alpha then $beta-1')).toEqual(['alpha', 'beta-1'])
  })

  it('does NOT extract $name embedded in a word (no whitespace boundary)', () => {
    // jQuery-style $foo or shell heredocs like cat$VAR shouldn't trigger.
    expect(extractSkillTokens('cost is $42 and email me@x$.com')).toEqual([])
  })

  it('terminates the token at non-[\\w-] characters', () => {
    expect(extractSkillTokens('$skill-creator,please run')).toEqual(['skill-creator'])
    expect(extractSkillTokens('$skill-creator!')).toEqual(['skill-creator'])
  })

  it('is case-sensitive (codex skill names are case-sensitive on disk)', () => {
    expect(extractSkillTokens('$Foo $foo')).toEqual(['Foo', 'foo'])
  })
})

describe('detectSkillTrigger (live popup driver)', () => {
  it('returns null when caret is not after a $token', () => {
    expect(detectSkillTrigger('hello world', 11)).toBeNull()
  })

  it('returns the $ start offset and partial query while typing', () => {
    // "$ski" with caret at end (offset 4)
    expect(detectSkillTrigger('$ski', 4)).toEqual({ start: 0, query: 'ski' })
  })

  it('opens immediately after a bare `$` with empty query (so the popup shows ALL skills)', () => {
    expect(detectSkillTrigger('$', 1)).toEqual({ start: 0, query: '' })
  })

  it('does NOT trigger when $ is mid-word ($42, foo$bar)', () => {
    expect(detectSkillTrigger('cost is $42', 11)).toBeNull()
    expect(detectSkillTrigger('foo$bar', 7)).toBeNull()
  })

  it('triggers when $ follows whitespace mid-line', () => {
    expect(detectSkillTrigger('please use $sk', 14)).toEqual({ start: 11, query: 'sk' })
  })

  it('only considers text up to caret, not after it', () => {
    // Caret is right after `$sk` even though more text follows.
    expect(detectSkillTrigger('$skill rest of line', 3)).toEqual({ start: 0, query: 'sk' })
  })

  it('terminates when caret moves past a space — popup should close', () => {
    expect(detectSkillTrigger('$skill ', 7)).toBeNull()
  })
})
