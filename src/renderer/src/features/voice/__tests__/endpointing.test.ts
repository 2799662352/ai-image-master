import { describe, expect, it } from 'vitest'
import { MAX_COMMIT_DELAY_MS, commitDelayFor, soundsUnfinished } from '../asr/endpointing'

describe('endpointing', () => {
  it('treats a finished statement as done', () => {
    expect(soundsUnfinished('今天天气不错。')).toBe(false)
    expect(soundsUnfinished('帮我画一只猫')).toBe(false)
    expect(soundsUnfinished('Draw a cat.')).toBe(false)
    expect(soundsUnfinished('')).toBe(false)
  })

  it('hears trailing pauses and fillers as unfinished', () => {
    expect(soundsUnfinished('我想要一个红色的，')).toBe(true)
    expect(soundsUnfinished('先画背景，然后。')).toBe(true)
    expect(soundsUnfinished('就是那个。')).toBe(true)
    expect(soundsUnfinished('嗯……')).toBe(true)
    expect(soundsUnfinished('draw a cat and')).toBe(true)
    expect(soundsUnfinished('I want, um')).toBe(true)
  })

  it('does not mistake words that merely end in a filler', () => {
    expect(soundsUnfinished('Draw a band')).toBe(false)
    expect(soundsUnfinished('Hello also')).toBe(false)
  })

  it('doubles the wait when unfinished, capped at 8 seconds', () => {
    expect(commitDelayFor('好的。', 2000)).toBe(2000)
    expect(commitDelayFor('然后', 2000)).toBe(4000)
    expect(commitDelayFor('然后', 5000)).toBe(MAX_COMMIT_DELAY_MS)
    expect(commitDelayFor('然后', 0)).toBe(0)
  })
})
