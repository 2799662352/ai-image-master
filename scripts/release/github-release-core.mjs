export function selectUniqueReleaseByTag(releases, tag) {
  if (!Array.isArray(releases)) {
    throw new Error('GitHub Releases listing must be an array')
  }

  const matches = releases.filter((release) => release?.tag_name === tag)
  if (matches.length > 1) {
    throw new Error(`Multiple GitHub Releases found for tag ${tag}`)
  }
  return matches[0] ?? null
}
