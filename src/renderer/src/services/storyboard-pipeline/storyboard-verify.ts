import type { z } from 'zod'
import type { VerifySchema } from '../pipeline/schemas/director-schemas'

interface StoryboardState {
  scene: { d?: string; cap?: string; env?: string; timeline?: unknown[] } | null
  objs: Array<{ n?: string; t?: string }>
  seq: Array<{ id?: string; desc?: string }>
  cont: string
  notes: string
}

export function storyboardCodeVerify(state: StoryboardState): z.infer<typeof VerifySchema> {
  let score = 10
  const issues: string[] = []

  if (!state.scene?.d && !state.scene?.env) {
    issues.push('Missing scene decomposition (scene is null or empty)')
    score -= 3
  }

  if (!state.objs || state.objs.length === 0) {
    issues.push('No characters/objects extracted')
    score -= 2
  }

  if (!state.seq || state.seq.length === 0) {
    issues.push('No shot sequence generated')
    score -= 4
  }

  if (state.seq?.length > 0) {
    const emptyDescs = state.seq.filter(s => !s.desc?.trim())
    if (emptyDescs.length > 0) {
      issues.push(`${emptyDescs.length} shot(s) have empty descriptions`)
      score -= 2
    }
  }

  if (!state.cont?.trim()) {
    issues.push('Missing cross-shot continuity anchors (cont is empty)')
    score -= 1
  }

  if (state.objs?.length > 0 && state.seq?.length > 0) {
    for (const obj of state.objs) {
      if (!obj.n) continue
      const name = obj.n.toLowerCase()
      const mentioned = state.seq.some(s => s.desc?.toLowerCase().includes(name))
      if (!mentioned) {
        issues.push(`Character "${obj.n}" not mentioned in any shot description`)
        score -= 1
      }
    }
  }

  score = Math.max(0, score)
  return {
    score,
    ok: score >= 6,
    issues,
    characterConsistency: !issues.some(i => i.includes('Character') || i.includes('character')),
    narrativeFlow: state.seq?.length > 0,
    spatialCoherence: undefined,
    lightingContinuity: undefined,
  }
}
