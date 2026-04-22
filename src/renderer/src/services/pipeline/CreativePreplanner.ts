/**
 * CreativePreplanner — LLM 驱动的创意前规划器
 *
 * 职责：在 DirectorPipeline 的 taskPlanning pass 之前，
 * 用一次 LLM 调用对用户的模糊中文 brief 进行智能理解和拆解，
 * 输出英文结构化创意方向供后续确定性管线使用。
 *
 * 设计原则：
 * - 可选步骤：通过 `enableCreativePreplanner` 配置开关控制
 * - 不阻塞：如果规划失败，fallback 到原始 brief
 * - 增强而非替换：输出作为增强的 sceneDescription + styleInstructions
 * - 环境安全：纯 LLM invoke，无 Node.js fs / os 依赖
 *
 * 注意：不使用 `deepagents` SDK，因为它依赖 `node:os`，
 * 无法在 Electron renderer 进程中运行。
 * 使用 @langchain/core 的 ChatModel.invoke 即可。
 */

import { z } from 'zod'

export interface CreativeDirection {
  enhancedBrief: string
  styleDirection: string
  narrativeArc: string
  moodKeywords: string[]
  referenceNotes: string
}

export interface PreplannerInput {
  userBrief: string
  styleInstructions?: string
  template?: string
  panelCount?: number
  hasReferenceImages?: boolean
  model?: any
}

export interface PreplannerResult {
  success: boolean
  direction: CreativeDirection | null
  elapsed: number
  error?: string
}

const CreativeDirectionSchema = z.object({
  enhancedBrief: z.string(),
  styleDirection: z.string(),
  narrativeArc: z.string(),
  moodKeywords: z.array(z.string()),
  referenceNotes: z.string(),
})

const SYSTEM_PROMPT = `You are a creative director's pre-production assistant specializing in visual storytelling.

Your job: Take a user's creative brief (which may be in Chinese, vague, or abstract) and transform it into a structured English creative direction that a film director AI can execute.

## Output Format
You MUST output ONLY a valid JSON object (no markdown fencing, no extra text) with these fields:
- enhancedBrief: A detailed English description expanding the user's intent (2-4 sentences)
- styleDirection: Specific visual style keywords and direction (medium, palette, mood)
- narrativeArc: How the story should flow across panels (tension, pacing, climax)
- moodKeywords: Array of 3-6 mood/atmosphere keywords
- referenceNotes: Notes about how reference images should guide the output

## Rules
- ALWAYS output in English regardless of input language
- Be specific and actionable — not generic
- Respect the user's intent — expand it, don't replace it
- If the brief is already detailed, preserve its specificity
- If the brief is minimal ("a girl in rain"), enrich with cinematic direction`

export class CreativePreplanner {
  private _model: any

  constructor(model?: any) {
    this._model = model
  }

  async plan(input: PreplannerInput): Promise<PreplannerResult> {
    const t0 = Date.now()

    if (!input.userBrief?.trim()) {
      return { success: false, direction: null, elapsed: Date.now() - t0, error: 'No user brief provided' }
    }

    if (!this._model) {
      return { success: false, direction: null, elapsed: Date.now() - t0, error: 'No LLM model provided' }
    }

    try {
      const userMessage = this.buildUserMessage(input)

      const response = await this._model.invoke([
        { role: 'system' as const, content: SYSTEM_PROMPT },
        { role: 'user' as const, content: userMessage },
      ])

      const content = typeof response.content === 'string'
        ? response.content
        : JSON.stringify(response.content)

      const direction = this.parseDirection(content)
      const elapsed = Date.now() - t0
      console.log(`[CreativePreplanner] completed in ${elapsed}ms`)

      if (direction) {
        return { success: true, direction, elapsed }
      }
      return { success: false, direction: null, elapsed, error: 'Failed to parse creative direction from LLM response' }
    } catch (err: unknown) {
      const elapsed = Date.now() - t0
      const errorMsg = err instanceof Error ? err.message : String(err)
      console.warn(`[CreativePreplanner] failed (${elapsed}ms):`, errorMsg)
      return { success: false, direction: null, elapsed, error: errorMsg }
    }
  }

  private buildUserMessage(input: PreplannerInput): string {
    const parts: string[] = [
      `## User Creative Brief`,
      input.userBrief,
      '',
    ]

    if (input.styleInstructions) {
      parts.push(`## Style Preset: ${input.styleInstructions}`)
    }
    if (input.template && input.template !== 'default') {
      parts.push(`## Template: ${input.template}`)
    }
    if (input.panelCount) {
      parts.push(`## Target Panels: ${input.panelCount}`)
    }
    if (input.hasReferenceImages) {
      parts.push(`## Reference Images: Yes (will be analyzed in next phase)`)
    }

    parts.push(
      '',
      'Transform this into a structured creative direction JSON. Be specific to this brief.',
      'Output ONLY the JSON object, no markdown fencing.',
    )

    return parts.join('\n')
  }

  private parseDirection(content: string): CreativeDirection | null {
    try {
      const cleaned = content
        .replace(/```json\s*/gi, '')
        .replace(/```\s*/g, '')
        .trim()

      const jsonMatch = cleaned.match(/\{[\s\S]*\}/)
      if (!jsonMatch) return null

      const parsed = JSON.parse(jsonMatch[0])
      const validated = CreativeDirectionSchema.safeParse(parsed)
      if (validated.success) return validated.data

      return {
        enhancedBrief: parsed.enhancedBrief || '',
        styleDirection: parsed.styleDirection || '',
        narrativeArc: parsed.narrativeArc || '',
        moodKeywords: Array.isArray(parsed.moodKeywords) ? parsed.moodKeywords : [],
        referenceNotes: parsed.referenceNotes || '',
      }
    } catch {
      return null
    }
  }
}

/**
 * 将 CreativeDirection 融合到管线输入中
 */
export function mergeCreativeDirection(
  originalInput: { sceneDescription?: string; styleInstructions?: string },
  direction: CreativeDirection,
): { sceneDescription: string; styleInstructions: string } {
  const enhancedScene = [
    direction.enhancedBrief,
    '',
    `Narrative Arc: ${direction.narrativeArc}`,
    `Mood: ${direction.moodKeywords.join(', ')}`,
    direction.referenceNotes ? `Reference Notes: ${direction.referenceNotes}` : '',
    '',
    `Original Brief: ${originalInput.sceneDescription || ''}`,
  ].filter(Boolean).join('\n')

  const enhancedStyle = [
    direction.styleDirection,
    originalInput.styleInstructions || '',
  ].filter(Boolean).join('; ')

  return {
    sceneDescription: enhancedScene,
    styleInstructions: enhancedStyle,
  }
}
