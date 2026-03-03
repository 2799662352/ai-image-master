import { z } from 'zod'

export const SceneAnalysisSchema = z.object({
  env: z.string().describe('Scene environment in English first: location + time + atmosphere + weather. Optional concise Japanese notes in parentheses.'),
  subjects: z.array(z.string()).describe('Main subjects list, short English phrases first.'),
  style: z.string().describe('Visual style in English first: medium + art style + palette + lighting + mood. Optional concise Japanese notes in parentheses.'),
  story: z.string().optional().describe('Narrative context in English first. Optional concise Japanese notes in parentheses.'),
})

export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>

export const CharacterAnchorSchema = z.object({
  characters: z.array(z.object({
    name: z.string().describe('Character name or identifier, English first.'),
    anchor: z.string().describe('Consistency anchor in English first: appearance + outfit + signature traits for cross-shot identity stability.'),
  })),
})

export type CharacterAnchors = z.infer<typeof CharacterAnchorSchema>


export const DesignAndAssembleSchema = z.object({
  panels: z.array(z.object({
    id: z.number().describe('Panel number'),
    shot: z.string().describe('Shot type + angle + transition from previous panel, e.g. "cut to medium eye-level, 50mm"'),
    desc: z.string().describe('Subject action + composition, one sentence'),
    lighting: z.string().describe('Key light direction + quality + color temperature, e.g. "warm side-light from left, soft, 3500K golden hour"'),
    characterAction: z.string().describe('Character-specific actions + expressions + interactions with other characters'),
    background: z.string().describe('Background continuity note: spatial relationship to previous panel'),
    prompt: z.string().describe('Full English image generation prompt using [char1] [char2] tags for character references'),
    negativePrompt: z.string().describe('English negative prompt for this panel'),
  })),
})

export type DesignAndAssemble = z.infer<typeof DesignAndAssembleSchema>

export const SimplePanelSchema = z.object({
  panels: z.array(z.object({
    id: z.number().describe('Panel number'),
    prompt: z.string().describe('Full English image generation prompt'),
  })),
})

export type SimplePanel = z.infer<typeof SimplePanelSchema>

export const SkillSelectionSchema = z.object({
  selectedSkills: z.array(z.string()).describe('选中的 skill ID 列表'),
  reasoning: z.string().describe('选择理由，一句话说明为什么选这些 skills'),
})

export type SkillSelection = z.infer<typeof SkillSelectionSchema>

export const VerifySchema = z.object({
  score: z.number().describe('一致性评分 0-10'),
  ok: z.boolean().describe('是否通过'),
  issues: z.array(z.string()).describe('问题列表，每项一句话'),
  characterConsistency: z.boolean().optional().describe('All panels maintain consistent character appearance'),
  lightingContinuity: z.boolean().optional().describe('Light direction and color temperature are coherent across panels'),
  narrativeFlow: z.boolean().optional().describe('Story progresses logically with clear panel-to-panel transitions'),
  spatialCoherence: z.boolean().optional().describe('Background and spatial relationships are consistent'),
})

export type VerifyReport = z.infer<typeof VerifySchema>
