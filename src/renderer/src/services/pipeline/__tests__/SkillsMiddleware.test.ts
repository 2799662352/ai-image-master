import { describe, expect, it, beforeAll } from 'vitest'

describe('SkillsMiddleware', () => {
  let SkillsMiddleware: any

  beforeAll(async () => {
    const mod = await import('../SkillsMiddleware')
    SkillsMiddleware = mod.SkillsMiddleware
  })

  it('can be instantiated with skills array', () => {
    const mw = new SkillsMiddleware([
      { id: 'test-skill', description: 'A test skill', rules: '', appliesTo: ['myPhase'], priority: 1 },
    ])
    expect(mw).toBeDefined()
    expect(mw.getSkillCount()).toBe(1)
  })

  it('buildSkillMenu returns only descriptions for a phase', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'Skill A desc', rules: 'body A', appliesTo: ['design'], priority: 1 },
      { id: 'b', description: 'Skill B desc', rules: 'body B', appliesTo: ['verify'], priority: 2 },
    ])
    const menu = mw.buildSkillMenu('design')
    expect(menu).toContain('a: Skill A desc')
    expect(menu).not.toContain('b: Skill B desc')
    expect(menu).not.toContain('body A')
  })

  it('loadSkill returns full body for matching skill', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'Skill A', rules: 'Full body of A', appliesTo: ['design'], priority: 1 },
    ])
    const result = mw.loadSkill('a', 'design')
    expect(result).toContain('Full body of A')
  })

  it('loadSkill returns error for unknown skill', () => {
    const mw = new SkillsMiddleware([])
    const result = mw.loadSkill('nonexistent', 'design')
    expect(result).toContain('not found')
  })

  it('loadSkill triggers lazy loading of _rawBody', () => {
    const mw = new SkillsMiddleware([
      { id: 'lazy', description: 'Lazy', rules: '', appliesTo: ['design'], priority: 1, _rawBody: 'Lazy body', _bodyLoaded: false },
    ])
    const result = mw.loadSkill('lazy', 'design')
    expect(result).toContain('Lazy body')
  })

  it('wrapSystemPrompt appends skill menu for phase', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'Skill A desc', rules: 'body', appliesTo: ['design'], priority: 1 },
    ])
    const wrapped = mw.wrapSystemPrompt('You are a director.', 'design')
    expect(wrapped).toContain('You are a director.')
    expect(wrapped).toContain('Available Skills')
    expect(wrapped).toContain('a: Skill A desc')
    expect(wrapped).toContain('loadSkill')
  })

  it('wrapSystemPrompt returns base prompt when no skills match', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'A', rules: 'body', appliesTo: ['verify'], priority: 1 },
    ])
    const wrapped = mw.wrapSystemPrompt('Base prompt.', 'design')
    expect(wrapped).toBe('Base prompt.')
  })
})
