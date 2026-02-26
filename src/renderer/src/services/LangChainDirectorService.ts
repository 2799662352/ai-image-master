import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ==================== Zod Schemas ====================

export const ShotSchema = z.object({
  kf: z.string().describe('KF number + shot type + duration, e.g. "KF1 - CU - 2s"'),
  lens: z.string().describe('Focal length + camera movement, e.g. "85mm static"'),
  spatial: z.object({
    fg: z.string().describe('Foreground depth layer'),
    mg: z.string().describe('Midground depth layer (primary subject)'),
    bg: z.string().describe('Background depth layer')
  }),
  action: z.string().describe('One anchor verb + manner words, no verb stacking'),
  light: z.string().describe('Source + direction + quality + color temperature'),
  label: z.string().describe('Panel label like 分镜1'),
  micro_expression: z.nullable(z.string()).describe(
    'Physiological micro-action sequence (NOT emotion adjectives). Format: Start state -> Transition action -> End micro-expression. ' +
    'E.g. "maintains composure -> deep visible breath -> faint relieved smile slowly forms" or ' +
    '"eyes glisten -> lower lip trembles -> gaze drops to floor". For wider shots use body posture instead. Null if not applicable.'
  ),
  color_grade: z.nullable(z.object({
    dominant: z.string().describe('Primary color covering 80%+ of frame, with HEX code. E.g. "warm amber #CBBFA2"'),
    accent: z.string().describe('Secondary color in small accent areas only. E.g. "cool teal #003333 in shadows"'),
    texture: z.string().describe('Film stock / grading style. E.g. "bleach bypass, coarse grain, matte finish"')
  })).describe('Color grading with dominant/accent hierarchy (80/20 rule). Never mix warm and cool equally. Null if not specified.'),
  atmosphere: z.nullable(z.string()).describe(
    'Atmospheric medium between camera and subject. E.g. "thick dust motes catching backlight", ' +
    '"morning haze softening background 2 stops", "volumetric god rays through broken ceiling". ' +
    'Never write "atmospheric" alone - specify the physical medium. Null if clear air.'
  ),
  body_physics: z.nullable(z.string()).describe(
    'Physical interaction between body and environment forces. E.g. "15-degree forward lean against wind, coat flaring behind", ' +
    '"weight shifting to left foot on uneven ground", "chest heaving from exertion, steam from breath in cold air". Null if static pose.'
  ),
  composition: z.nullable(z.string()).describe(
    'Composition principle applied. E.g. "leading lines from train tracks converge on subject", ' +
    '"natural frame through doorway arch", "negative space on right implying loneliness", ' +
    '"rule of thirds with subject at left intersection point". Null if standard centered.'
  ),
  emotion_target: z.nullable(z.string()).describe(
    'Target emotion this shot conveys to audience (for shot-emotion consistency check). ' +
    'E.g. "isolation", "mounting tension", "quiet relief", "voyeuristic unease". Null if neutral.'
  )
})

export const ShotsResponseSchema = z.object({
  character_anchor: z
    .string()
    .describe('Precise character appearance: gender, age, hair, eyes, skin, outfit, build'),
  shots: z.array(ShotSchema)
})

export type ShotData = z.infer<typeof ShotSchema>
export type ShotsResponse = z.infer<typeof ShotsResponseSchema>

// ==================== Service Types ====================

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface ShotGenInput {
  imageAnalysis: string
  sceneDescription: string
  panelCount: number
  layoutRows: number
  layoutCols: number
  layoutRatio: string
  viewDistribution: string
  styleInstructions: string
  additionalRules: string
  images: ImageInput[]
  systemPrompt: string
}

// ==================== Service ====================

export class LangChainDirectorService {
  private llm: ChatOpenAI
  private structuredLlm: ReturnType<ChatOpenAI['withStructuredOutput']>

  constructor(config: { apiKey: string; baseURL: string; model?: string }) {
    this.llm = new ChatOpenAI({
      model: config.model || 'gpt-4o',
      apiKey: config.apiKey,
      maxRetries: 2,
      configuration: { baseURL: `${config.baseURL.replace(/\/v1\/?$/, '')}/v1` }
    })
    this.structuredLlm = this.llm.withStructuredOutput(ShotsResponseSchema)
  }

  private buildImageContent(images: ImageInput[], text: string) {
    const content: Array<
      | { type: 'text'; text: string }
      | { type: 'image_url'; image_url: { url: string; detail?: string } }
    > = [{ type: 'text', text }]
    for (const img of images) {
      content.push({
        type: 'image_url',
        image_url: { url: `data:${img.mimeType};base64,${img.base64}`, detail: 'high' }
      })
    }
    return content
  }

  async analyzeImage(images: ImageInput[], sceneHint?: string): Promise<string> {
    const text = sceneHint ||
      'Analyze this reference image. Identify all key subjects, spatial relationships, lighting conditions, color palette, and mood.'
    const message = new HumanMessage({ content: this.buildImageContent(images, text) })
    const res = await this.llm.invoke([message])
    return typeof res.content === 'string' ? res.content : JSON.stringify(res.content)
  }

  async generateShots(input: ShotGenInput): Promise<ShotsResponse> {
    const systemMsg = new SystemMessage(input.systemPrompt)
    const userPrompt = this.buildUserPrompt(input)
    const humanMsg = new HumanMessage({
      content: this.buildImageContent(input.images, userPrompt)
    })
    const result = await this.structuredLlm.invoke([systemMsg, humanMsg])
    return result as ShotsResponse
  }

  private buildUserPrompt(input: ShotGenInput): string {
    return `## 参考图分析结果
${input.imageAnalysis}

## 用户场景描述
${input.sceneDescription || '根据参考图生成连续的分镜画面'}

## 布局要求
- 分镜数量: ${input.panelCount}
- 布局: ${input.layoutRows}行 x ${input.layoutCols}列
- 画幅比例: ${input.layoutRatio}

## 视角分布要求
${input.viewDistribution}

## 风格要求
${input.styleInstructions}

请输出 ${input.panelCount} 个分镜。
${input.additionalRules}`
  }

  shotsToNaturalLanguage(shots: ShotData[]): string {
    return shots
      .map((shot, i) => {
        const parts = [shot.kf, shot.lens, shot.action]
        const sp = shot.spatial
        parts.push(`FG: ${sp.fg}, MG: ${sp.mg}, BG: ${sp.bg}`)
        parts.push(shot.light)
        if (shot.micro_expression) parts.push(shot.micro_expression)
        if (shot.atmosphere) parts.push(shot.atmosphere)
        if (shot.body_physics) parts.push(shot.body_physics)
        if (shot.composition) parts.push(shot.composition)
        return `${i + 1}. ${parts.filter(Boolean).join(', ')}`
      })
      .join('\n')
  }

  buildFinalPrompt(
    shots: ShotsResponse,
    composition: string,
    style: string,
    story: string,
    constraints: string,
    negative?: string
  ): string {
    const compact = {
      c: composition,
      s: shots.character_anchor,
      st: style,
      d: story,
      p: shots.shots.map((shot, i) => ({
        i: i + 1,
        sh: shot.kf,
        l: shot.lens,
        sp: shot.spatial,
        a: shot.action,
        li: shot.light,
        ...(shot.micro_expression && { me: shot.micro_expression }),
        ...(shot.color_grade && { cg: shot.color_grade }),
        ...(shot.atmosphere && { atm: shot.atmosphere }),
        ...(shot.body_physics && { bp: shot.body_physics }),
        ...(shot.composition && { comp: shot.composition }),
        ...(shot.emotion_target && { em: shot.emotion_target })
      })),
      x: constraints,
      ...(negative && { n: negative })
    }
    return JSON.stringify(compact)
  }
}
