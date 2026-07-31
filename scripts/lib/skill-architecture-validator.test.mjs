import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, test } from 'node:test'

import {
  auditRepository,
  extractFirstPartySkillsFromTypeScript,
  formatDiagnostics,
  parseSkillMarkdown,
  validateArchitecture,
} from './skill-architecture-validator.mjs'

const temporaryRoots = []

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function temporaryRepository() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'catimation-skill-architecture-'))
  temporaryRoots.push(root)
  return root
}

async function put(root, relativePath, content) {
  const file = path.join(root, ...relativePath.split('/'))
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content, 'utf8')
  return file
}

function skill(name, description, body = '', budget = 'fast') {
  return `---
name: ${name}
description: >-
  ${description}
---
<!-- skill-budget: ${budget} -->
# ${name}
${body}
`
}

test('parseSkillMarkdown parses folded frontmatter and the body budget marker', () => {
  const parsed = parseSkillMarkdown(
    skill('example-skill', 'First line\n  second line', 'Use `helper-skill` when needed.', 'standard'),
    'C:\\repo\\skills\\example-skill\\SKILL.md',
  )

  assert.equal(parsed.name, 'example-skill')
  assert.equal(parsed.description, 'First line second line')
  assert.equal(parsed.budget, 'standard')
  assert.match(parsed.body, /helper-skill/)
  assert.equal(parsed.path, 'C:/repo/skills/example-skill/SKILL.md')
})

test('extractFirstPartySkillsFromTypeScript decodes escaped template literals', () => {
  const source = [
    'const SAMPLE_SKILL_CONTENT = `---',
    'name: sample',
    'description: sample description',
    '---',
    'Use \\`tool\\` at C:\\\\tmp. Keep \\${placeholder} literal.',
    '`',
  ].join('\n')

  const extracted = extractFirstPartySkillsFromTypeScript(source, 'src/main/agent/generated.ts')

  assert.equal(extracted.length, 1)
  assert.equal(extracted[0].name, 'sample')
  assert.match(extracted[0].content, /Use `tool` at C:\\tmp\. Keep \$\{placeholder\} literal\./)
})

test('detects broad implicit generation entry collisions and forbidden descriptions', () => {
  const diagnostics = validateArchitecture({
    skills: [
      {
        path: 'resources/plugins/core/skills/catimation-image/SKILL.md',
        content: skill(
          'catimation-image',
          'Trigger whenever the user asks to generate an image.',
        ),
      },
      {
        path: 'resources/plugins/director/skills/wide-router/SKILL.md',
        content: skill(
          'wide-router',
          'MUST be loaded EVERY time. Use whenever generating ANY image/video.',
        ),
      },
    ],
    hooks: [],
    firstParty: { sourceExists: true, generatedExists: true, sourceSkills: [], generatedSkills: [] },
  })
  const codes = diagnostics.map((item) => item.code)

  assert.ok(codes.includes('IMPLICIT_GENERATION_ENTRY_COLLISION'))
  assert.ok(codes.includes('DESCRIPTION_FORBIDDEN_TRIGGER'))
})

test('detects explicit dependency cycles with a readable route', () => {
  const diagnostics = validateArchitecture({
    skills: [
      { path: 'skills/a/SKILL.md', content: skill('a', 'Technique A.', 'Load `b`.') },
      { path: 'skills/b/SKILL.md', content: skill('b', 'Technique B.', 'Return to `a`.') },
    ],
    hooks: [],
    firstParty: { sourceExists: true, generatedExists: true, sourceSkills: [], generatedSkills: [] },
  })
  const cycle = diagnostics.find((item) => item.code === 'DEPENDENCY_CYCLE')

  assert.ok(cycle)
  assert.match(cycle.message, /a -> b -> a/)
})

test('detects a craft Skill mandatory back-edge to an orchestrator', () => {
  const diagnostics = validateArchitecture({
    skills: [
      {
        path: 'skills/director-orchestrator/SKILL.md',
        content: skill('director-orchestrator', 'Routes complex directing work.', '', 'pro'),
      },
      {
        path: 'skills/animation-craft/SKILL.md',
        content: skill(
          'animation-craft',
          'Animation timing craft.',
          'Before writing any prompt, MUST load `director-orchestrator`.',
        ),
      },
    ],
    hooks: [],
    firstParty: { sourceExists: true, generatedExists: true, sourceSkills: [], generatedSkills: [] },
  })

  assert.ok(diagnostics.some((item) => item.code === 'CRAFT_FORCED_ORCHESTRATOR_BACK_EDGE'))
})

test('detects whole-SKILL hook injection and oversized static context', () => {
  const diagnostics = validateArchitecture(
    {
      skills: [],
      hooks: [
        {
          path: 'resources/plugins/video/hooks/session-start',
          content:
            'skill=$(cat "${PLUGIN_ROOT}/skills/sd2-pe/SKILL.md")\n' +
            `session_context="${'x'.repeat(80)}\${skill}"\n`,
        },
      ],
      firstParty: {
        sourceExists: true,
        generatedExists: true,
        sourceSkills: [],
        generatedSkills: [],
      },
    },
    { maxHookInjectionChars: 32 },
  )
  const codes = diagnostics.map((item) => item.code)

  assert.ok(codes.includes('HOOK_CATS_SKILL'))
  assert.ok(codes.includes('HOOK_INJECTION_TOO_LARGE'))
})

test('enforces description length, broad-trigger phrases, and generic model-list tails', () => {
  const diagnostics = validateArchitecture(
    {
      skills: [
        {
          path: 'skills/verbose/SKILL.md',
          content: skill(
            'verbose',
            'MUST run EVERY time for ANY video. Applies to models: Sora, Veo, Runway, Kling, Seedance, Hailuo.',
          ),
        },
      ],
      hooks: [],
      firstParty: {
        sourceExists: true,
        generatedExists: true,
        sourceSkills: [],
        generatedSkills: [],
      },
    },
    { maxDescriptionChars: 60 },
  )
  const codes = diagnostics.map((item) => item.code)

  assert.ok(codes.includes('DESCRIPTION_TOO_LONG'))
  assert.ok(codes.includes('DESCRIPTION_FORBIDDEN_TRIGGER'))
  assert.ok(codes.includes('DESCRIPTION_MODEL_LIST_TAIL'))
})

test('enforces fast, standard, pro, and studio dependency budgets', () => {
  const skills = [
    {
      path: 'skills/fast-owner/SKILL.md',
      content: skill('fast-owner', 'Fast helper.', 'Use `a` and `b`.', 'fast'),
    },
    {
      path: 'skills/standard-owner/SKILL.md',
      content: skill('standard-owner', 'Standard helper.', 'Use `a`, `b`, `c`, and `d`.', 'standard'),
    },
    {
      path: 'skills/pro-owner/SKILL.md',
      content: skill('pro-owner', 'Pro helper.', 'Use `a`, `b`, `c`, `d`, `e`, `f`, and `g`.', 'pro'),
    },
    {
      path: 'skills/not-film/SKILL.md',
      content: skill('not-film', 'Wrong studio owner.', '', 'studio'),
    },
    ...['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((name) => ({
      path: `skills/${name}/SKILL.md`,
      content: skill(name, `Helper ${name}.`),
    })),
  ]
  const diagnostics = validateArchitecture({
    skills,
    hooks: [],
    firstParty: { sourceExists: true, generatedExists: true, sourceSkills: [], generatedSkills: [] },
  })
  const budgetCodes = diagnostics
    .filter((item) => item.code.startsWith('BUDGET_'))
    .map((item) => item.code)

  assert.equal(budgetCodes.filter((code) => code === 'BUDGET_FANOUT_EXCEEDED').length, 3)
  assert.ok(budgetCodes.includes('BUDGET_STUDIO_OWNER'))
})

test('reports missing first-party source/generated inputs and content parity drift', () => {
  const sourceContent = skill('catimation-image', 'Source copy.')
  const missing = validateArchitecture({
    skills: [],
    hooks: [],
    firstParty: {
      sourceExists: false,
      generatedExists: false,
      sourceSkills: [],
      generatedSkills: [],
    },
  })
  const drift = validateArchitecture({
    skills: [],
    hooks: [],
    firstParty: {
      sourceExists: true,
      generatedExists: true,
      sourceSkills: [{ path: 'resources/first-party-skills/catimation-image/SKILL.md', content: sourceContent }],
      generatedSkills: [
        { path: 'src/main/agent/generated/firstPartySkills.generated.ts', content: `${sourceContent}\nchanged` },
      ],
    },
  })

  assert.equal(
    missing.filter((item) => item.code === 'FIRST_PARTY_PARITY_INPUT_MISSING').length,
    2,
  )
  assert.ok(drift.some((item) => item.code === 'FIRST_PARTY_PARITY_MISMATCH'))
})

test('detects drift between duplicate plugin, codex, top-level, and inline copies', () => {
  const canonical = skill('shared-skill', 'Canonical copy.')
  const diagnostics = validateArchitecture({
    skills: [
      { path: 'resources/plugins/p/skills/shared-skill/SKILL.md', content: canonical },
      { path: 'resources/codex-skills/shared-skill/SKILL.md', content: canonical },
      { path: 'skills/shared-skill/SKILL.md', content: canonical.replace('Canonical', 'Drifted') },
    ],
    hooks: [],
    firstParty: { sourceExists: true, generatedExists: true, sourceSkills: [], generatedSkills: [] },
  })

  assert.ok(diagnostics.some((item) => item.code === 'SKILL_COPY_DRIFT'))
})

test('auditRepository scans all roots with Windows-compatible paths', async () => {
  const root = await temporaryRepository()
  const source = skill('catimation-image', 'Trigger whenever the user asks to generate an image.')
  await put(root, 'resources/plugins/core/skills/catimation-image/SKILL.md', source)
  await put(root, 'resources/codex-skills/catimation-image/SKILL.md', source)
  await put(root, 'skills/catimation-image/SKILL.md', source)
  await put(root, 'resources/first-party-skills/catimation-image/SKILL.md', source)
  await put(
    root,
    'src/main/agent/generated/firstPartySkills.generated.ts',
    `const CATIMATION_IMAGE_SKILL_CONTENT = \`${source.replaceAll('`', '\\`')}\`\n`,
  )
  await put(root, 'src/main/agent/firstPartySkills.ts', '// no legacy inline content\n')
  await put(root, 'resources/plugins/core/hooks/session-start', 'session_context="short summary"\n')

  const result = await auditRepository(root)

  assert.equal(result.inventory.skills.length, 4)
  assert.equal(result.inventory.hooks.length, 1)
  assert.equal(result.diagnostics.length, 0, formatDiagnostics(result.diagnostics))
})

test('semantic trigger goldens stay model-eval data, with broad boundary coverage', async () => {
  const fixturePath = path.resolve(
    import.meta.dirname,
    '..',
    '..',
    'tests',
    'skill-architecture',
    'fixtures',
    'trigger-goldens.json',
  )
  const fixture = JSON.parse(await (await import('node:fs/promises')).readFile(fixturePath, 'utf8'))
  const tags = new Set(fixture.cases.flatMap((item) => item.tags))

  assert.equal(fixture.evaluation, 'semantic-model')
  assert.ok(fixture.cases.length >= 20)
  for (const requiredTag of [
    'single-image',
    'single-shot',
    'cinematic',
    'multi-shot',
    'character-consistency',
    'full-production',
    'question-only',
    'transcode',
  ]) {
    assert.ok(tags.has(requiredTag), `missing semantic boundary tag: ${requiredTag}`)
  }
  assert.ok(
    fixture.cases.every(
      (item) =>
        typeof item.prompt === 'string' &&
        Array.isArray(item.expected.shouldTrigger) &&
        Array.isArray(item.expected.shouldNotTrigger) &&
        ['fast', 'standard', 'pro', 'studio'].includes(item.expected.budget),
    ),
  )
})
