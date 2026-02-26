import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ==================== Zod Schemas (Optimized for token budget) ====================

export const ShotSchema = z.object({
  kf: z.string().describe('KF number + shot type + duration'),
  lens: z.string().describe('Focal length + camera movement'),
  spatial: z.object({
    fg: z.string().describe('Foreground layer'),
    mg: z.string().describe('Midground layer'),
    bg: z.string().describe('Background layer')
  }),
  action: z.string().describe('Anchor verb + manner + body physics interaction'),
  light: z.string().describe('Source + direction + quality + color temp + color grade hint'),
  label: z.string().describe('Panel label'),
  micro_expression: z.nullable(z.string()).describe('Start → transition → end micro-arc. Null if N/A'),
  atmosphere: z.nullable(z.string()).describe('Physical medium between camera and subject. Null if clear')
})

export const SceneInfoSchema = z.object({
  d: z.string().describe('Narrative arc: "A → B → C"'),
  cap: z.string().describe('Title: "subject-action-environment"'),
  env: z.string().describe('Environment: lighting/space/style'),
  shot_flow: z.string().describe('Sequence flow: "S1 establishing → S2 push-in → S3 reverse → ..."')
})

export const SceneObjectSchema = z.object({
  n: z.string().describe('Object name'),
  f: z.string().describe('Visual features + physics type + invariant anchors'),
  s: z.string().describe('Spatial: FG/MG/BG + position')
})

export const SceneResponseSchema = z.object({
  scene: SceneInfoSchema,
  objs: z.array(SceneObjectSchema),
  character_anchor: z.string().describe('Primary character appearance'),
  shots: z.array(ShotSchema)
})

export type ShotData = z.infer<typeof ShotSchema>
export type ShotsResponse = z.infer<typeof SceneResponseSchema>
export type SceneInfo = z.infer<typeof SceneInfoSchema>
export type SceneObject = z.infer<typeof SceneObjectSchema>

// Legacy alias
export const ShotsResponseSchema = SceneResponseSchema

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
      maxTokens: 8192,
      configuration: { baseURL: `${config.baseURL.replace(/\/v1\/?$/, '')}/v1` }
    })
    this.structuredLlm = this.llm.withStructuredOutput(SceneResponseSchema)
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
        return `${i + 1}. ${parts.filter(Boolean).join(', ')}`
      })
      .join('\n')
  }

  buildFinalPrompt(
    response: ShotsResponse,
    gridLayout: string,
    style: string,
    story: string,
    constraints: string,
    negative?: string
  ): string {
    const compact = {
      scene: response.scene,
      objs: response.objs,
      c: gridLayout,
      s: response.character_anchor,
      st: style,
      d: story,
      p: response.shots.map((shot, i) => ({
        i: i + 1,
        sh: shot.kf,
        l: shot.lens,
        sp: shot.spatial,
        a: shot.action,
        li: shot.light,
        ...(shot.micro_expression && { me: shot.micro_expression }),
        ...(shot.atmosphere && { atm: shot.atmosphere })
      })),
      x: constraints,
      ...(negative && { n: negative })
    }
    return JSON.stringify(compact)
  }
}
