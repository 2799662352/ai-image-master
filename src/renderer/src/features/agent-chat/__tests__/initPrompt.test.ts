import { describe, expect, it } from 'vitest'
import { INIT_AGENTS_MD_PROMPT } from '../initPrompt'

/**
 * `/init` sends codex's official prompt verbatim. These assertions lock in the
 * behavioral contract that matters (target file, no-overwrite guard, output
 * shape) so an accidental edit that breaks native parity fails loudly.
 */
describe('INIT_AGENTS_MD_PROMPT (codex /init native parity)', () => {
  it('targets AGENTS.md and instructs to generate it', () => {
    expect(INIT_AGENTS_MD_PROMPT).toContain('Generate a file named AGENTS.md')
  })

  it('keeps the non-destructive guard: do not overwrite an existing AGENTS.md', () => {
    expect(INIT_AGENTS_MD_PROMPT).toContain(
      'check whether AGENTS.md already exists',
    )
    expect(INIT_AGENTS_MD_PROMPT).toContain('do not overwrite or modify it')
  })

  it('requests the "Repository Guidelines" titled, concise doc', () => {
    expect(INIT_AGENTS_MD_PROMPT).toContain('Repository Guidelines')
    expect(INIT_AGENTS_MD_PROMPT).toContain('200-400 words')
  })

  it('is a non-trivial multi-section prompt', () => {
    expect(INIT_AGENTS_MD_PROMPT.length).toBeGreaterThan(500)
    expect(INIT_AGENTS_MD_PROMPT).toContain('Recommended Sections')
  })
})
