import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { resolveAppCreds } from '../env'

let tmpDir: string
let previousUserDataDir: string | undefined

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'eval-env-'))
  previousUserDataDir = process.env.CODEX_EVAL_USER_DATA_DIR
  process.env.CODEX_EVAL_USER_DATA_DIR = tmpDir
})

afterEach(async () => {
  if (previousUserDataDir === undefined) {
    delete process.env.CODEX_EVAL_USER_DATA_DIR
  } else {
    process.env.CODEX_EVAL_USER_DATA_DIR = previousUserDataDir
  }
  await fs.rm(tmpDir, { recursive: true, force: true })
})

describe('resolveAppCreds', () => {
  it('resolves persisted Right.Codes Grok through the shared Gateway key', async () => {
    await fs.writeFile(
      path.join(tmpDir, 'codex-providers.json'),
      JSON.stringify({
        version: 2,
        selectedGatewayId: 'rightcode',
        selectedModelId: 'grok-4.5',
        apiKeys: { rightcode: 'shared-key' },
        customProviders: [],
      }),
      'utf8',
    )

    expect(resolveAppCreds()).toEqual({
      apiKey: 'shared-key',
      provider: expect.objectContaining({
        id: 'rightcode-grok',
        gatewayId: 'rightcode',
        model: 'grok-4.5',
        baseUrl: 'https://rightapi.ai/grok/v1',
      }),
    })
  })
})
