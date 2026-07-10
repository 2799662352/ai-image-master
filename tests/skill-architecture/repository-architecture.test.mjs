import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { test } from 'node:test'

const repoRoot = path.resolve(import.meta.dirname, '..', '..')

async function read(relativePath) {
  return readFile(path.join(repoRoot, ...relativePath.split('/')), 'utf8')
}

test('repository Skill architecture satisfies the deterministic contract', async () => {
  const orchestratorPath =
    'resources/plugins/catimation-director/skills/director-orchestrator/SKILL.md'
  const routerPath =
    'resources/plugins/catimation-director/skills/catimation-video-director-router/SKILL.md'
  const hookPath = 'resources/plugins/catimation-video/hooks/session-start'
  const firstPartySourcePath = 'resources/first-party-skills'
  const firstPartyGeneratedPath = 'src/main/agent/generated/firstPartySkills.generated.ts'
  const [orchestrator, router, hook] = await Promise.all([
    read(orchestratorPath),
    read(routerPath),
    read(hookPath),
  ])
  const diagnostics = []

  if (/MUST\b[^\n]{0,80}\bEVERY\s+time/i.test(orchestrator)) {
    diagnostics.push(
      `DESCRIPTION_FORBIDDEN_TRIGGER ${orchestratorPath}: broad "MUST ... EVERY time" trigger`,
    )
  }
  if (
    orchestrator.includes('catimation-video-director-router') &&
    router.includes('director-orchestrator')
  ) {
    diagnostics.push(
      'DEPENDENCY_CYCLE director-orchestrator -> catimation-video-director-router -> director-orchestrator',
    )
  }
  if (/\bcat\b[^\n]*SKILL\.md/.test(hook)) {
    diagnostics.push(`HOOK_CATS_SKILL ${hookPath}: SessionStart injects an entire SKILL.md`)
  }
  for (const requiredPath of [firstPartySourcePath, firstPartyGeneratedPath]) {
    try {
      await read(requiredPath)
    } catch (error) {
      if (error?.code === 'EISDIR') continue
      diagnostics.push(`FIRST_PARTY_PARITY_INPUT_MISSING ${requiredPath}`)
    }
  }
  if (!/<!--\s*skill-budget:\s*(fast|standard|pro|studio)\s*-->/i.test(orchestrator)) {
    diagnostics.push(`BUDGET_MARKER_MISSING ${orchestratorPath}`)
  }

  assert.deepEqual(diagnostics, [], `Skill architecture violations:\n${diagnostics.join('\n')}`)
})
