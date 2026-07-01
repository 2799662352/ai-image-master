import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  EXTRA_ROOT_DOC_MAX_BYTES,
  buildExtraRootsDeveloperInstructions,
} from '../projectDocs'

describe('buildExtraRootsDeveloperInstructions (multi-repo AGENTS.md → developer_instructions)', () => {
  let base: string
  const dirs: string[] = []

  function mkRepo(name: string, files: Record<string, string> = {}): string {
    const dir = path.join(base, name)
    mkdirSync(dir, { recursive: true })
    for (const [file, content] of Object.entries(files)) {
      writeFileSync(path.join(dir, file), content, 'utf8')
    }
    dirs.push(dir)
    return dir
  }

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'projdocs-'))
  })
  afterEach(() => {
    try { rmSync(base, { recursive: true, force: true }) } catch { /* ignore */ }
  })

  it('returns undefined when there are no roots or no extra docs', () => {
    expect(buildExtraRootsDeveloperInstructions(undefined, undefined)).toBeUndefined()
    expect(buildExtraRootsDeveloperInstructions('/x', [])).toBeUndefined()
    const cwd = mkRepo('primary', { 'AGENTS.md': 'primary rules' })
    // Only the cwd → nothing EXTRA to inject.
    expect(buildExtraRootsDeveloperInstructions(cwd, [cwd])).toBeUndefined()
  })

  it('injects an extra repo AGENTS.md but not the primary cwd doc', () => {
    const cwd = mkRepo('primary', { 'AGENTS.md': 'PRIMARY RULES' })
    const extra = mkRepo('libs', { 'AGENTS.md': 'LIB RULES' })
    const out = buildExtraRootsDeveloperInstructions(cwd, [cwd, extra])
    expect(out).toBeDefined()
    expect(out).toContain('LIB RULES')
    expect(out).not.toContain('PRIMARY RULES')
    expect(out).toContain(extra)
    expect(out).toContain('AGENTS.md')
  })

  it('prefers AGENTS.override.md over AGENTS.md over CLAUDE.md over GEMINI.md', () => {
    const cwd = mkRepo('primary')
    const extra = mkRepo('multi', {
      'AGENTS.override.md': 'OVERRIDE WINS',
      'AGENTS.md': 'agents loses',
      'CLAUDE.md': 'claude loses',
      'GEMINI.md': 'gemini loses',
    })
    const out = buildExtraRootsDeveloperInstructions(cwd, [cwd, extra]) ?? ''
    expect(out).toContain('OVERRIDE WINS')
    expect(out).not.toContain('agents loses')
    expect(out).toContain('AGENTS.override.md')
  })

  it('falls back to CLAUDE.md / GEMINI.md when no AGENTS.md', () => {
    const cwd = mkRepo('primary')
    const claudeRepo = mkRepo('claude-only', { 'CLAUDE.md': 'CLAUDE DOC' })
    const geminiRepo = mkRepo('gemini-only', { 'GEMINI.md': 'GEMINI DOC' })
    const out = buildExtraRootsDeveloperInstructions(cwd, [cwd, claudeRepo, geminiRepo]) ?? ''
    expect(out).toContain('CLAUDE DOC')
    expect(out).toContain('GEMINI DOC')
  })

  it('skips ancestors of the cwd (already loaded by the engine root→cwd walk)', () => {
    const parent = mkRepo('workspace', { 'AGENTS.md': 'PARENT RULES' })
    const cwd = path.join(parent, 'sub', 'project')
    mkdirSync(cwd, { recursive: true })
    // parent is an ancestor of cwd → must NOT be injected (engine covers it).
    const out = buildExtraRootsDeveloperInstructions(cwd, [cwd, parent])
    expect(out).toBeUndefined()
  })

  it('dedupes repeated roots and ignores missing directories', () => {
    const cwd = mkRepo('primary')
    const extra = mkRepo('shared', { 'AGENTS.md': 'SHARED RULES' })
    const missing = path.join(base, 'does-not-exist')
    const out = buildExtraRootsDeveloperInstructions(cwd, [cwd, extra, extra, missing]) ?? ''
    // SHARED RULES appears exactly once despite the duplicate root.
    expect(out.split('SHARED RULES').length - 1).toBe(1)
  })

  it('truncates an oversized doc to the byte budget with a marker', () => {
    const cwd = mkRepo('primary')
    const huge = 'x'.repeat(EXTRA_ROOT_DOC_MAX_BYTES + 5_000)
    const extra = mkRepo('big', { 'AGENTS.md': huge })
    const out = buildExtraRootsDeveloperInstructions(cwd, [cwd, extra]) ?? ''
    expect(out).toContain('truncated to project_doc_max_bytes')
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThan(
      EXTRA_ROOT_DOC_MAX_BYTES + 2_000,
    )
  })
})
