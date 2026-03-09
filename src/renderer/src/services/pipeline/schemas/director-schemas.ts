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
    anchor: z.string().describe('Full visual consistency anchor combining face + outfit + markers into one paragraph.'),
    face: z.string().describe('Hair color + style + length, eye color, skin tone, face shape.'),
    outfit: z.string().describe('Clothing top-to-bottom with exact colors, patterns, and accessories.'),
    markers: z.string().optional().describe('Props, weapons, scars, tattoos, glasses, jewelry. Omit if none.'),
  })),
})

export type CharacterAnchors = z.infer<typeof CharacterAnchorSchema>


export const DesignAndAssembleSchema = z.object({
  panels: z.array(z.object({
    id: z.number().describe('Panel number'),
    shot: z.string().describe('Shot type + angle + transition from previous panel, e.g. "cut to medium eye-level, 50mm"'),
    desc: z.string().describe('Subject action + composition using [char1] [char2] tags, one sentence'),
    lighting: z.string().describe('Key light direction + quality + color temperature, e.g. "warm side-light from left, soft, 3500K golden hour"'),
    characterAction: z.string().describe('Per-character actions using [char1] [char2] tags: who does what, expressions, weapons, interactions. e.g. "[char1] swings folding fan defensively, [char2] lunges with sword"'),
    background: z.string().describe('Background continuity note: spatial relationship to previous panel'),
    prompt: z.string().describe('Full English image generation prompt. Use [char1] [char2] tags for character references as defined in the Character Identity Lock. Write detailed scene descriptions around the tags.'),
    negativePrompt: z.string().describe('English negative prompt for this panel'),
  })),
})

export type DesignAndAssemble = z.infer<typeof DesignAndAssembleSchema>

export const SimplePanelSchema = z.object({
  panels: z.array(z.object({
    id: z.number().describe('Panel number'),
    shot: z.string().optional().describe('Shot type + angle'),
    desc: z.string().optional().describe('Subject action + composition'),
    lighting: z.string().optional().describe('Key light direction + quality + color temperature'),
    characterAction: z.string().optional().describe('Per-character actions'),
    background: z.string().optional().describe('Background continuity note'),
    prompt: z.string().describe('Full English image generation prompt'),
    negativePrompt: z.string().optional().describe('English negative prompt'),
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
  styleConsistency: z.number().optional().describe('All panels share the same rendering medium, color temperature, and texture quality'),
})

export type VerifyReport = z.infer<typeof VerifySchema>

export const SkillDiscoverySchema = z.object({
  requestedSkills: z.array(z.string()).describe('List of skill IDs to read for this task'),
  designPlan: z.string().default('').describe('Brief plan for how to approach the storyboard design based on available information'),
})

export type SkillDiscovery = z.infer<typeof SkillDiscoverySchema>
