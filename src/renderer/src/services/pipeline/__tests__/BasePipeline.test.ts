import { describe, it, expect } from 'vitest'
import './setup'
import { BasePipeline } from '../BasePipeline'
import type { PipelineConfig, PipelineSkill } from '../types'

class TestPipeline extends BasePipeline<any, any> {
  get pipelineSkills(): PipelineSkill[] { return [] }
  buildGraph() { return null }
  assembleResult(s: any) { return s }
  postProcess(r: any) { return r }
}

const config: PipelineConfig = {
  model: 'test-model',
  apiKey: 'test-key',
  baseURL: 'http://localhost:8080',
}

describe('BasePipeline', () => {
  it('returns base prompt when no skills match', () => {
    const pipeline = new TestPipeline(config)
    const result = pipeline.buildSystemPrompt('unknownPhase', 'base prompt', {})
    expect(result).toBe('base prompt')
  })

  it('appends matching skills to system prompt', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'test-skill',
      rules: 'Rule A\nRule B',
      appliesTo: ['myPhase'],
      priority: 1,
    })
    const result = pipeline.buildSystemPrompt('myPhase', 'base', {})
    expect(result).toContain('base')
    expect(result).toContain('[Skill:test-skill]')
    expect(result).toContain('Rule A')
  })

  it('respects condition on skills', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'conditional',
      rules: 'Dark mode rules',
      appliesTo: ['myPhase'],
      priority: 1,
      condition: (ctx) => ctx.dark === true,
    })
    expect(pipeline.buildSystemPrompt('myPhase', 'base', { dark: false })).toBe('base')
    expect(pipeline.buildSystemPrompt('myPhase', 'base', { dark: true })).toContain('Dark mode rules')
  })

  it('buildImageContent returns correct format', () => {
    const content = BasePipeline.buildImageContent(
      [{ data: 'abc123', mimeType: 'image/png' }],
      'high',
    )
    expect(content).toHaveLength(1)
    expect(content[0].type).toBe('image_url')
    expect(content[0].image_url.url).toBe('data:image/png;base64,abc123')
    expect(content[0].image_url.detail).toBe('high')
  })
})
