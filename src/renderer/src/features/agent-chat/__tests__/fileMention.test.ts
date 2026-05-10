import { describe, expect, it } from 'vitest'
import {
  detectAtTrigger,
  flattenWorkspaceFiles,
  scoreFileMatch,
} from '../MentionInput'
import type { FileNode } from '../../file-explorer/types'

describe('detectAtTrigger (live `@` mention popup driver)', () => {
  it('returns null when caret is not after an @token', () => {
    expect(detectAtTrigger('hello world', 11)).toBeNull()
  })

  it('opens immediately on bare `@` with empty query', () => {
    expect(detectAtTrigger('@', 1)).toEqual({ start: 0, query: '' })
  })

  it('captures partial query while typing', () => {
    expect(detectAtTrigger('@src', 4)).toEqual({ start: 0, query: 'src' })
    expect(detectAtTrigger('look at @src/foo', 16)).toEqual({ start: 8, query: 'src/foo' })
  })

  it('does NOT trigger when @ is mid-word (foo@bar.com email)', () => {
    expect(detectAtTrigger('me@example.com', 14)).toBeNull()
  })

  it('terminates at whitespace — popup should close after the space', () => {
    expect(detectAtTrigger('@src ', 5)).toBeNull()
  })

  it('does NOT trigger when @ is preceded by another @', () => {
    // Two @s in a row (e.g. typo) shouldn't recursively kick in.
    expect(detectAtTrigger('@@', 2)).toBeNull()
  })
})

describe('flattenWorkspaceFiles', () => {
  function file(path: string, name: string): FileNode {
    return { path, name, kind: 'file', source: 'workspace' }
  }
  function dir(path: string, name: string, children: FileNode[]): FileNode {
    return { path, name, kind: 'dir', source: 'workspace', children, childrenLoaded: true }
  }

  it('returns an empty list for empty input', () => {
    expect(flattenWorkspaceFiles([])).toEqual([])
  })

  it('skips directories and includes files only', () => {
    const tree: FileNode[] = [
      dir('/repo', 'repo', [
        file('/repo/a.ts', 'a.ts'),
        dir('/repo/sub', 'sub', [file('/repo/sub/b.ts', 'b.ts')]),
      ]),
    ]
    const out = flattenWorkspaceFiles(tree)
    expect(out.map((f) => f.path)).toEqual(['/repo/a.ts', '/repo/sub/b.ts'])
  })

  it('computes workspace-root-relative paths (the matching surface)', () => {
    const tree: FileNode[] = [
      dir('/repo', 'repo', [
        file('/repo/src/foo.ts', 'foo.ts'),
        file('/repo/README.md', 'README.md'),
      ]),
    ]
    const out = flattenWorkspaceFiles(tree)
    expect(out).toEqual([
      { path: '/repo/src/foo.ts', name: 'foo.ts', relPath: 'src/foo.ts' },
      { path: '/repo/README.md', name: 'README.md', relPath: 'README.md' },
    ])
  })

  it('handles multiple workspace roots independently', () => {
    const tree: FileNode[] = [
      dir('/a', 'a', [file('/a/x.ts', 'x.ts')]),
      dir('/b', 'b', [file('/b/y.ts', 'y.ts')]),
    ]
    const out = flattenWorkspaceFiles(tree)
    expect(out.map((f) => f.relPath)).toEqual(['x.ts', 'y.ts'])
  })
})

describe('scoreFileMatch', () => {
  it('returns 1 (everything visible) for empty query', () => {
    expect(scoreFileMatch('', 'src/foo.ts', 'foo.ts')).toBe(1)
  })

  it('exact name match scores highest', () => {
    expect(scoreFileMatch('foo.ts', 'src/foo.ts', 'foo.ts')).toBe(100)
  })

  it('name prefix scores second-highest, with shorter names winning ties', () => {
    const score = scoreFileMatch('foo', 'src/foo.ts', 'foo.ts')
    expect(score).toBeGreaterThan(50)
    expect(score).toBeLessThan(51)
    // Shorter name ranks above longer (within the prefix bucket).
    expect(scoreFileMatch('foo', 'src/foo.ts', 'foo.ts')).toBeGreaterThan(
      scoreFileMatch('foo', 'src/foosomethinglong.ts', 'foosomethinglong.ts'),
    )
  })

  it('substring match (not prefix) scores 10', () => {
    // Query "lib" appears mid-relPath but is NOT a prefix of name → substring bucket.
    expect(scoreFileMatch('lib', 'src/lib/foo.ts', 'foo.ts')).toBe(10)
  })

  it('returns 0 for no match', () => {
    expect(scoreFileMatch('xyz', 'src/foo.ts', 'foo.ts')).toBe(0)
  })

  it('matches case-insensitively', () => {
    // FOO vs foo.ts is a prefix match (not exact), but score should be the
    // same regardless of casing.
    const upper = scoreFileMatch('FOO', 'src/foo.ts', 'foo.ts')
    const lower = scoreFileMatch('foo', 'src/foo.ts', 'foo.ts')
    expect(upper).toBe(lower)
    expect(upper).toBeGreaterThan(50)
  })

  it('matches against relPath (so `src/foo` queries find `foo.ts` under src/)', () => {
    expect(scoreFileMatch('src/foo', 'src/foo.ts', 'foo.ts')).toBe(10)
  })
})
