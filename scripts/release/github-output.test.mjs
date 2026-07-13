import assert from 'node:assert/strict'
import test from 'node:test'

import { serializeGithubOutputs } from './github-output.mjs'

test('serializes untrusted multiline values without creating extra outputs', () => {
  const serialized = serializeGithubOutputs(
    {
      current_version: '4.3.95\rinjected=true',
      published_versions: '["4.3.95"]',
    },
    () => 'fixed',
  )

  assert.equal(
    serialized,
    [
      'current_version<<ghadelimiter_fixed',
      '4.3.95',
      'injected=true',
      'ghadelimiter_fixed',
      'published_versions<<ghadelimiter_fixed',
      '["4.3.95"]',
      'ghadelimiter_fixed',
      '',
    ].join('\n'),
  )
  assert.equal(serialized.match(/^injected<</gm), null)
})

test('rejects invalid output names', () => {
  assert.throws(
    () => serializeGithubOutputs({ 'bad-name': 'value' }),
    /Invalid GitHub output name/,
  )
})
