import type { z } from 'zod'
import { VerifySchema } from '../pipeline/schemas/director-schemas'

interface StoryboardState {
  scene: { d?: string; cap?: string; env?: string; timeline?: unknown[] } | null
  objs: Array<{ n?: string; t?: string }>
  seq: Array<{ id?: string; desc?: string }>
  cont: string
  notes: string
}

/**
 * VerifySchema 是 LLM 的输出契约，要求逐项给出结论；代码级校验器看不到画面，
 * 无法评估空间/光影/风格，所以这三项一律缺席而不是硬给一个布尔。
 */
export const CodeVerifyReportSchema = VerifySchema.omit({
  spatialCoherence: true,
  lightingContinuity: true,
  styleConsistency: true,
})

export type CodeVerifyReport = z.infer<typeof CodeVerifyReportSchema>

export function storyboardCodeVerify(state: StoryboardState): CodeVerifyReport {
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
  }
}
