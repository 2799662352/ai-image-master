import { z } from 'zod'

export const SceneAnalysisSchema = z.object({
  env: z.string().describe('场景环境描述：地点+时间+氛围+天气'),
  subjects: z.array(z.string()).describe('画面主体列表，每项为一句话描述'),
  style: z.string().describe('视觉风格：艺术风格+色调+光照+情绪'),
  story: z.string().optional().describe('叙事上下文'),
})

export type SceneAnalysis = z.infer<typeof SceneAnalysisSchema>

export const CharacterAnchorSchema = z.object({
  characters: z.array(z.object({
    name: z.string().describe('角色名或标识'),
    anchor: z.string().describe('一致性锚点：完整外貌+服装+特征描述，用于跨镜头一致'),
  })),
})

export type CharacterAnchors = z.infer<typeof CharacterAnchorSchema>


export const DesignAndAssembleSchema = z.object({
  panels: z.array(z.object({
    id: z.number().describe('Panel number'),
    shot: z.string().describe('Shot type + angle, e.g. medium eye-level'),
    desc: z.string().describe('Subject action + composition + lighting, one sentence'),
    prompt: z.string().describe('Full English image generation prompt for this panel'),
    negativePrompt: z.string().describe('English negative prompt for this panel'),
  })),
})

export type DesignAndAssemble = z.infer<typeof DesignAndAssembleSchema>

export const VerifySchema = z.object({
  score: z.number().describe('一致性评分 0-10'),
  ok: z.boolean().describe('是否通过'),
  issues: z.array(z.string()).describe('问题列表，每项一句话'),
})

export type VerifyReport = z.infer<typeof VerifySchema>
