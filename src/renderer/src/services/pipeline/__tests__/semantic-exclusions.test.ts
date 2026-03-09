import { describe, expect, it, beforeAll } from 'vitest'

describe('buildSemanticExclusions', () => {
  let buildSemanticExclusions: any

  beforeAll(async () => {
    const mod = await import('../DirectorPipeline')
    buildSemanticExclusions = mod.buildSemanticExclusions
  })

  it('converts anime template exclusions into positive constraints', () => {
    const result = buildSemanticExclusions('anime', null)
    expect(result).toContain('avoid')
    expect(result).toContain('photorealistic')
    expect(result).not.toContain('anime')
    expect(result.length).toBeGreaterThan(20)
  })

  it('converts cinematic template exclusions into positive constraints', () => {
    const result = buildSemanticExclusions('cinematic', null)
    expect(result).toContain('avoid')
    expect(result).toContain('anime')
    expect(result).toContain('cartoon')
  })

  it('uses medium from styleAnchor when template has no exclusions', () => {
    const result = buildSemanticExclusions('custom-unknown', { medium: 'anime cel' })
    expect(result).toContain('avoid')
    expect(result).toContain('photorealistic')
  })

  it('returns empty string when no exclusions apply', () => {
    const result = buildSemanticExclusions('unknown', null)
    expect(result).toBe('')
  })

  it('always includes base quality constraints', () => {
    const result = buildSemanticExclusions('anime', null)
    expect(result).toContain('watermark')
    expect(result).toContain('text')
  })
})
