import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { resolveCodexBinary } from '../paths'

describe('codex runtime smoke', () => {
  it('documents binary presence requirement', () => {
    const resourceRoot = process.resourcesPath ?? path.join(process.cwd(), 'resources')
    const bin = resolveCodexBinary(resourceRoot)
    expect(typeof bin).toBe('string')

    if (!fs.existsSync(bin)) {
      console.warn(`Codex binary not present at ${bin}; run npm run codex:fetch before integration smoke.`)
    }
  })
})
