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

  it('wrapSystemPrompt injects Skills System section', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'Skill A desc', rules: 'body', appliesTo: ['design'], priority: 1 },
    ])
    const wrapped = mw.wrapSystemPrompt('You are a director.', 'design')
    expect(wrapped).toContain('You are a director.')
    expect(wrapped).toContain('## Skills System')
    expect(wrapped).toContain('read_file')
    expect(wrapped).toContain('/skills/a/SKILL.md: Skill A desc')
    expect(wrapped).not.toContain('loadSkill')
    expect(wrapped).not.toContain('requestedSkills')
  })

  it('wrapSystemPrompt returns base prompt when no skills match', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'A', rules: 'body', appliesTo: ['verify'], priority: 1 },
    ])
    const wrapped = mw.wrapSystemPrompt('Base prompt.', 'design')
    expect(wrapped).toBe('Base prompt.')
  })
})

describe('VirtualSkillsBackend', () => {
  let VirtualSkillsBackend: any

  beforeAll(async () => {
    const mod = await import('../SkillsMiddleware')
    VirtualSkillsBackend = mod.VirtualSkillsBackend
  })

  it('maps skills to /skills/{id}/SKILL.md paths', () => {
    const backend = new VirtualSkillsBackend(
      [{ id: 'lighting', description: 'Lighting rules', rules: 'Use rim light', appliesTo: ['design'], priority: 1 }],
      'design',
    )
    const files = backend.ls()
    expect(files).toEqual(['/skills/lighting/SKILL.md'])
  })

  it('read() returns SKILL.md content with frontmatter', () => {
    const backend = new VirtualSkillsBackend(
      [{ id: 'lighting', description: 'Lighting rules', rules: 'Use rim light', appliesTo: ['design'], priority: 1 }],
      'design',
    )
    const content = backend.read('/skills/lighting/SKILL.md')
    expect(content).toContain('---')
    expect(content).toContain('name: lighting')
    expect(content).toContain('description: Lighting rules')
    expect(content).toContain('Use rim light')
  })

  it('read() returns error for unknown path', () => {
    const backend = new VirtualSkillsBackend([], 'design')
    const result = backend.read('/skills/nope/SKILL.md')
    expect(result).toContain('not found')
  })

  it('filters by phase', () => {
    const backend = new VirtualSkillsBackend(
      [
        { id: 'a', description: 'A', rules: 'body', appliesTo: ['design'], priority: 1 },
        { id: 'b', description: 'B', rules: 'body', appliesTo: ['verify'], priority: 2 },
      ],
      'design',
    )
    expect(backend.ls()).toEqual(['/skills/a/SKILL.md'])
    expect(backend.fileCount).toBe(1)
  })

  it('triggers lazy loading of _rawBody', () => {
    const backend = new VirtualSkillsBackend(
      [{ id: 'lazy', description: 'Lazy', rules: '', appliesTo: ['design'], priority: 1, _rawBody: 'Lazy body', _bodyLoaded: false }],
      'design',
    )
    const content = backend.read('/skills/lazy/SKILL.md')
    expect(content).toContain('Lazy body')
  })

  it('evaluates function rules with context', () => {
    const backend = new VirtualSkillsBackend(
      [{ id: 'dynamic', description: 'Dynamic', rules: (ctx: any) => `Style: ${ctx.style}`, appliesTo: ['design'], priority: 1 }],
      'design',
      { style: 'anime' },
    )
    const content = backend.read('/skills/dynamic/SKILL.md')
    expect(content).toContain('Style: anime')
  })
})

describe('SkillsMiddleware.createReadFileTool', () => {
  let SkillsMiddleware: any

  beforeAll(async () => {
    const mod = await import('../SkillsMiddleware')
    SkillsMiddleware = mod.SkillsMiddleware
  })

  it('returns a tool named read_file', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'A desc', rules: 'body A', appliesTo: ['design'], priority: 1 },
    ])
    const tool = mw.createReadFileTool('design')
    expect(tool).not.toBeNull()
    expect(tool.name).toBe('read_file')
  })

  it('tool.invoke returns SKILL.md content', async () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'A desc', rules: 'body A', appliesTo: ['design'], priority: 1 },
    ])
    const t = mw.createReadFileTool('design')
    const result = await t.invoke({ file_path: '/skills/a/SKILL.md' })
    expect(result).toContain('name: a')
    expect(result).toContain('body A')
  })

  it('tool.invoke returns error for bad path', async () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'A desc', rules: 'body A', appliesTo: ['design'], priority: 1 },
    ])
    const t = mw.createReadFileTool('design')
    const result = await t.invoke({ file_path: '/skills/nope/SKILL.md' })
    expect(result).toContain('not found')
  })

  it('returns null when no skills match phase', () => {
    const mw = new SkillsMiddleware([
      { id: 'a', description: 'A', rules: 'body', appliesTo: ['verify'], priority: 1 },
    ])
    const tool = mw.createReadFileTool('design')
    expect(tool).toBeNull()
  })

  it('tool description lists available file paths', () => {
    const mw = new SkillsMiddleware([
      { id: 'x', description: 'X', rules: 'body', appliesTo: ['design'], priority: 1 },
      { id: 'y', description: 'Y', rules: 'body', appliesTo: ['design'], priority: 2 },
    ])
    const t = mw.createReadFileTool('design')
    expect(t.description).toContain('/skills/x/SKILL.md')
    expect(t.description).toContain('/skills/y/SKILL.md')
  })
})
