import assert from 'node:assert/strict'
import test from 'node:test'

import { selectUniqueReleaseByTag } from './github-release-core.mjs'

test('recovers an authenticated draft release from the release listing', () => {
  const draft = {
    id: 353476039,
    tag_name: 'v4.3.96',
    draft: true,
  }

  assert.equal(
    selectUniqueReleaseByTag(
      [
        { id: 1, tag_name: 'v4.3.95', draft: false },
        draft,
      ],
      'v4.3.96',
    ),
    draft,
  )
})

test('returns null when the release listing does not contain the tag', () => {
  assert.equal(
    selectUniqueReleaseByTag(
      [{ id: 1, tag_name: 'v4.3.95', draft: false }],
      'v4.3.96',
    ),
    null,
  )
})

test('rejects ambiguous duplicate releases for the same tag', () => {
  assert.throws(
    () =>
      selectUniqueReleaseByTag(
        [
          { id: 1, tag_name: 'v4.3.96', draft: true },
          { id: 2, tag_name: 'v4.3.96', draft: true },
        ],
        'v4.3.96',
      ),
    /Multiple GitHub Releases found for tag v4\.3\.96/,
  )
})
