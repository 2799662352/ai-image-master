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
  label: z.string().describe('Panel label like 分镜1')
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
      configuration: { baseURL: `${config.baseURL}/v1` }
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
        li: shot.light
      })),
      x: constraints,
      ...(negative && { n: negative })
    }
    return JSON.stringify(compact)
  }
}
