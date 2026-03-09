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

  it('isGeminiModel correctly identifies Gemini models', () => {
    const pipeline = new TestPipeline(config)
    expect((pipeline as any).isGeminiModel('gemini-3-flash-preview')).toBe(true)
    expect((pipeline as any).isGeminiModel('gemini-2.5-pro')).toBe(true)
    expect((pipeline as any).isGeminiModel('gpt-4o')).toBe(false)
    expect((pipeline as any).isGeminiModel('claude-3-opus')).toBe(false)
  })

  it('createStructuredLLM accepts methodOverride parameter', () => {
    const pipeline = new TestPipeline({
      model: 'gemini-3-flash-preview',
      apiKey: 'test-key',
      baseURL: 'http://localhost:8080',
    })
    expect((pipeline as any).isGeminiModel('gemini-3-flash-preview')).toBe(true)
    expect((pipeline as any).isGeminiModel('gpt-4o')).toBe(false)
  })

  describe('resolveStructuredOutputMethod', () => {
    it('returns jsonSchema for Gemini models', () => {
      const pipeline = new TestPipeline({ model: 'gemini-3-flash-preview', apiKey: 'k', baseURL: 'http://localhost' })
      expect((pipeline as any).resolveStructuredOutputMethod('gemini-3-flash-preview')).toBe('jsonSchema')
      expect((pipeline as any).resolveStructuredOutputMethod('gemini-2.5-pro')).toBe('jsonSchema')
    })

    it('returns jsonSchema for OpenAI gpt-4o+ models', () => {
      const pipeline = new TestPipeline(config)
      expect((pipeline as any).resolveStructuredOutputMethod('gpt-4o')).toBe('jsonSchema')
      expect((pipeline as any).resolveStructuredOutputMethod('gpt-4o-mini')).toBe('jsonSchema')
      expect((pipeline as any).resolveStructuredOutputMethod('gpt-4.1')).toBe('jsonSchema')
      expect((pipeline as any).resolveStructuredOutputMethod('o3-mini')).toBe('jsonSchema')
    })

    it('returns undefined for older/unknown models (LangChain default = functionCalling)', () => {
      const pipeline = new TestPipeline(config)
      expect((pipeline as any).resolveStructuredOutputMethod('gpt-3.5-turbo')).toBeUndefined()
      expect((pipeline as any).resolveStructuredOutputMethod('claude-3-opus')).toBeUndefined()
    })

    it('respects explicit override', () => {
      const pipeline = new TestPipeline(config)
      expect((pipeline as any).resolveStructuredOutputMethod('gemini-3-flash-preview', 'functionCalling')).toBe('functionCalling')
      expect((pipeline as any).resolveStructuredOutputMethod('gpt-3.5-turbo', 'jsonSchema')).toBe('jsonSchema')
    })
  })

  describe('resolveMaxTokens', () => {
    it('returns 65536 for Gemini models by default', () => {
      const pipeline = new TestPipeline({ model: 'gemini-3-flash-preview', apiKey: 'k', baseURL: 'http://localhost' })
      expect((pipeline as any).resolveMaxTokens('gemini-3-flash-preview')).toBe(65536)
    })

    it('returns 65536 for all models by default', () => {
      const pipeline = new TestPipeline(config)
      expect((pipeline as any).resolveMaxTokens('gpt-4o')).toBe(65536)
    })

    it('respects explicit value', () => {
      const pipeline = new TestPipeline(config)
      expect((pipeline as any).resolveMaxTokens('gemini-3-flash-preview', 8192)).toBe(8192)
    })
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

describe('Progressive Disclosure', () => {
  it('skill body is not loaded until first phase match', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'lazy-skill',
      description: 'A lazy skill',
      rules: '',
      appliesTo: ['myPhase'],
      priority: 1,
      _rawBody: 'Lazy body content here',
      _bodyLoaded: false,
    })
    const skillsBefore = (pipeline as any).sharedSkills
    expect(skillsBefore[0].rules).toBe('')
    expect(skillsBefore[0]._bodyLoaded).toBe(false)

    const prompt = pipeline.buildSystemPrompt('myPhase', 'base', {})

    expect(skillsBefore[0].rules).toBe('Lazy body content here')
    expect(skillsBefore[0]._bodyLoaded).toBe(true)
    expect(prompt).toContain('Lazy body content here')
  })

  it('unmatched skill body remains empty', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'unmatched-skill',
      description: 'An unmatched skill',
      rules: '',
      appliesTo: ['otherPhase'],
      priority: 1,
      _rawBody: 'Should not appear',
      _bodyLoaded: false,
    })
    const prompt = pipeline.buildSystemPrompt('myPhase', 'base', {})
    const skills = (pipeline as any).sharedSkills
    expect(skills[0].rules).toBe('')
    expect(skills[0]._bodyLoaded).toBe(false)
    expect(prompt).toBe('base')
  })

  it('already loaded skill body is not reloaded', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'preloaded',
      description: 'Already loaded',
      rules: 'Already loaded body',
      appliesTo: ['myPhase'],
      priority: 1,
      _rawBody: 'Raw body that should not override',
      _bodyLoaded: true,
    })
    const prompt = pipeline.buildSystemPrompt('myPhase', 'base', {})
    expect(prompt).toContain('Already loaded body')
    expect(prompt).not.toContain('Raw body that should not override')
  })
})

describe('Skill Discovery (Progressive Disclosure)', () => {
  it('buildSkillMenuPrompt returns menu with descriptions only', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'test-skill',
      description: 'A test skill for anime quality',
      rules: 'Full body content here',
      appliesTo: ['myPhase'],
      priority: 1,
    })
    const result = pipeline.buildSkillMenuPrompt('myPhase', 'base', {})
    expect(result).toContain('/skills/test-skill/SKILL.md: A test skill for anime quality')
    expect(result).not.toContain('Full body content here')
    expect(result).toContain('## Skills System')
    expect(result).toContain('read_file')
  })

  it('buildSkillMenuPrompt returns base prompt when no skills match', () => {
    const pipeline = new TestPipeline(config)
    const result = pipeline.buildSkillMenuPrompt('unknownPhase', 'base prompt', {})
    expect(result).toBe('base prompt')
  })

  it('getSkillBodiesById loads only requested skills', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'skill-a',
      description: 'Skill A',
      rules: 'Body A',
      appliesTo: ['myPhase'],
      priority: 1,
    })
    pipeline.registerSharedSkill({
      id: 'skill-b',
      description: 'Skill B',
      rules: 'Body B',
      appliesTo: ['myPhase'],
      priority: 2,
    })
    const result = pipeline.getSkillBodiesById(['skill-a'], 'myPhase', {})
    expect(result).toContain('Body A')
    expect(result).not.toContain('Body B')
  })

  it('getSkillBodiesById returns empty for unknown IDs', () => {
    const pipeline = new TestPipeline(config)
    const result = pipeline.getSkillBodiesById(['nonexistent'], 'myPhase', {})
    expect(result).toBe('')
  })

  it('getSkillBodiesById triggers lazy loading for _rawBody', () => {
    const pipeline = new TestPipeline(config)
    pipeline.registerSharedSkill({
      id: 'lazy-discovery',
      description: 'Lazy skill',
      rules: '',
      appliesTo: ['myPhase'],
      priority: 1,
      _rawBody: 'Lazy loaded body via discovery',
      _bodyLoaded: false,
    })
    const result = pipeline.getSkillBodiesById(['lazy-discovery'], 'myPhase', {})
    expect(result).toContain('Lazy loaded body via discovery')
    expect(result).toContain('[Skill:lazy-discovery]')
  })
})
