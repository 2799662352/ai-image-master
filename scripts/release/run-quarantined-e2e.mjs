#!/usr/bin/env node

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'

import { validateQuarantineManifest } from './validate-e2e-quarantine.mjs'

const repoRoot = process.cwd()
const entries = JSON.parse(
  readFileSync(path.join(repoRoot, 'e2e', 'quarantine.json'), 'utf8'),
)
const validated = validateQuarantineManifest(entries, { repoRoot })

if (validated.length === 0) {
  console.log('No quarantined E2E tests are registered')
  process.exit(0)
}

const result = spawnSync(
  'pnpm',
  ['exec', 'playwright', 'test', '--project=electron-quarantine'],
  {
    cwd: repoRoot,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  },
)
process.exit(result.status ?? 1)
