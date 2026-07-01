import { describe, expect, it } from 'vitest'
import {
  detectSlashTrigger,
  filterPaletteItems,
  buildPaletteSections,
  SLASH_COMMANDS,
} from '../MentionInput'
import type { CodexSkillSummary } from '../../../../../types/agent'

/**
 * `/` palette mirrors Cursor's slash palette. Per the user-supplied
 * reference image it contains Skills + Commands sections, gates strictly
 * on start-of-line, and does NOT swallow URL paths like `https://...` or
 * `/etc/hosts`.
 *
 * Codex's TUI ships `/clear`, `/init`, `/compact`, `/help`, `/quit`, `/model`.
 * In our Electron app we wire the ones that map to existing actions:
 * `/clear`, `/cancel`, `/help`, `/compact` (placeholder), and `/init` (sends
 * codex's official init prompt as a turn to generate AGENTS.md). `/quit` stays
 * off-platform (the app owns its own lifecycle) so we omit it.
 */

describe('detectSlashTrigger (whitespace-anchored, never mid-word)', () => {
  it('returns null on plain text', () => {
    expect(detectSlashTrigger('hello world', 11)).toBeNull()
  })

  it('opens immediately on bare `/` at offset 1', () => {
    expect(detectSlashTrigger('/', 1)).toEqual({ start: 0, query: '' })
  })

  it('captures partial query while typing', () => {
    expect(detectSlashTrigger('/cl', 3)).toEqual({ start: 0, query: 'cl' })
  })

  it('triggers when `/` follows a newline (multi-line message)', () => {
    expect(detectSlashTrigger('first line\n/cle', 15)).toEqual({ start: 11, query: 'cle' })
  })

  // Regression: previously `(?:^|\n)` blocked re-trigger after a skill commit.
  // Real workflow: user picks a skill from `/` palette → input becomes
  // "$deep-agents-orchestration " (trailing space), then they type `/` to
  // start another command. Detector MUST fire on a whitespace-preceded `/`,
  // mirroring how `$` and `@` triggers re-arm.
  it('re-triggers after a `$skill ` token followed by space (real regression case)', () => {
    expect(detectSlashTrigger('$deep-agents-orchestration /', 28)).toEqual({
      start: 27,
      query: '',
    })
  })

  it('re-triggers after any whitespace boundary, not just newline', () => {
    expect(detectSlashTrigger('hello /cl', 9)).toEqual({ start: 6, query: 'cl' })
    expect(detectSlashTrigger('hello\t/help', 11)).toEqual({ start: 6, query: 'help' })
  })

  it('does NOT trigger inside URLs / paths (no whitespace before `/`)', () => {
    // Caret at end of full text — `/` is not the last character, regex must
    // anchor on a whitespace-preceded `/`, so paths/URLs whose final `/` is
    // followed by more chars stay quiet.
    expect(detectSlashTrigger('see https://example.com', 23)).toBeNull()
    expect(detectSlashTrigger('path/to/file', 12)).toBeNull()
    // Even with caret right after a path-internal `/`, the preceding char is
    // a non-whitespace word char so the trigger is naturally excluded.
    expect(detectSlashTrigger('https:/', 7)).toBeNull()
    expect(detectSlashTrigger('a1/', 3)).toBeNull()
  })

  it('terminates at whitespace — popup closes after the user moves on', () => {
    expect(detectSlashTrigger('/clear ', 7)).toBeNull()
  })

  it('supports hyphenated command names (`/read-branch`)', () => {
    expect(detectSlashTrigger('/read-branch', 12)).toEqual({ start: 0, query: 'read-branch' })
  })
})

describe('SLASH_COMMANDS canon', () => {
  it('exposes /clear, /cancel, /help, /compact, /init at minimum (codex-tui parity subset)', () => {
    const ids = SLASH_COMMANDS.map((c) => c.id)
    for (const required of ['clear', 'cancel', 'help', 'compact', 'init']) {
      expect(ids).toContain(required)
    }
  })

  it('wires /init to the init action (generates AGENTS.md via codex prompt)', () => {
    const init = SLASH_COMMANDS.find((c) => c.id === 'init')
    expect(init).toBeDefined()
    expect(init?.action).toBe('init')
  })

  it('every command has a label, description, and a trigger handler', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(cmd.id.length).toBeGreaterThan(0)
      expect(cmd.label.length).toBeGreaterThan(0)
      expect(cmd.description.length).toBeGreaterThan(0)
      expect(cmd.action.length).toBeGreaterThan(0) // action key non-empty
    }
  })
})

describe('filterPaletteItems', () => {
  const skills: CodexSkillSummary[] = [
    { name: 'using-superpowers', scope: 'user', description: 'Process discipline guide', path: '/u' },
    { name: 'systematic-debugging', scope: 'user', description: 'Bug hunting', path: '/d' },
    { name: 'context7-mcp', scope: 'repo', description: 'Docs lookup', path: '/c' },
  ]

  it('returns all items when query is empty', () => {
    const out = filterPaletteItems('', skills)
    expect(out.commands.length).toBe(SLASH_COMMANDS.length)
    expect(out.skills.length).toBe(skills.length)
  })

  it('matches commands by id prefix', () => {
    const out = filterPaletteItems('cl', skills)
    expect(out.commands.map((c) => c.id)).toContain('clear')
    // /cancel shares no prefix with `cl` other than `c`; ensure clear ranks first
    expect(out.commands[0].id).toBe('clear')
  })

  it('matches skills by name substring case-insensitively', () => {
    const out = filterPaletteItems('DEBUG', skills)
    expect(out.skills.map((s) => s.name)).toEqual(['systematic-debugging'])
  })

  it('matches skills by description substring (e.g. user types description text)', () => {
    const out = filterPaletteItems('docs', skills)
    expect(out.skills.map((s) => s.name)).toEqual(['context7-mcp'])
  })

  it('returns up to the hard skill cap so power users see their full library', () => {
    // Earlier the section was hard-capped at 8 which truncated power users
    // who ship 20+ skills (the popup itself is scrollable, so 8 was a UX
    // bug, not an ergonomics win). Cap raised to 50 with internal scroll;
    // matching skills beyond that fold are deferred to refined queries.
    const many: CodexSkillSummary[] = Array.from({ length: 80 }, (_, i) => ({
      name: `skill-${i}`,
      scope: 'user',
      description: '',
      path: `/p/${i}`,
    }))
    const out = filterPaletteItems('skill', many)
    expect(out.skills.length).toBeGreaterThan(8)
    expect(out.skills.length).toBeLessThanOrEqual(50)
  })
})

describe('buildPaletteSections (flattened for keyboard nav)', () => {
  const skills: CodexSkillSummary[] = [
    { name: 'using-superpowers', scope: 'user', description: '', path: '/u' },
  ]

  it('flattens visible items in display order (commands before skills)', () => {
    const sections = buildPaletteSections('', skills)
    const flat = sections.flatMap((s) => s.items)
    // First item should be a command, last a skill (commands above skills in UI).
    expect(flat[0].kind).toBe('command')
    expect(flat[flat.length - 1].kind).toBe('skill')
  })

  it('omits empty sections so keyboard nav doesn’t land on a heading', () => {
    const sections = buildPaletteSections('xyz-no-match-anywhere', skills)
    for (const s of sections) {
      expect(s.items.length).toBeGreaterThan(0)
    }
  })
})
