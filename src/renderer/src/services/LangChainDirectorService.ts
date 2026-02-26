import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ==================== Zod Schemas ====================

export const ShotSchema = z.object({
  // Required fields
  kf: z.string().describe('KF number + shot type + duration'),
  lens: z.string().describe('Focal length + camera movement'),
  spatial: z.object({
    fg: z.string().describe('Foreground layer'),
    mg: z.string().describe('Midground layer'),
    bg: z.string().describe('Background layer')
  }),
  action: z.string().describe('Anchor verb + manner + body physics'),
  light: z.string().describe('Source + direction + quality + color temp'),
  label: z.string().describe('Panel label'),
  // Nullable fields (restored)
  micro_expression: z.nullable(z.string()).describe('Start -> transition -> end micro-arc. Null if N/A'),
  color_grade: z.nullable(z.string()).describe('Dominant color HEX + accent + film texture. Null if default'),
  atmosphere: z.nullable(z.string()).describe('Physical medium: fog/dust/rays. Null if clear'),
  body_physics: z.nullable(z.string()).describe('Body-environment force interaction. Null if static'),
  composition: z.nullable(z.string()).describe('Composition principle applied. Null if centered'),
  emotion_target: z.nullable(z.string()).describe('Target audience emotion. Null if neutral'),
  seq: z.nullable(z.string()).describe('Connection to neighboring shots. Null if standalone'),
  motion: z.nullable(z.string()).describe('Per-body-part intensity. Null if static')
})

export const BgmSchema = z.object({
  base: z.string().describe('Ambient foundation'),
  env: z.string().describe('Environment sounds'),
  action: z.string().describe('Action foley'),
  melody: z.string().describe('Melody or silence strategy')
})

export const SceneInfoSchema = z.object({
  d: z.string().describe('Narrative arc: A -> B -> C'),
  cap: z.string().describe('Title: subject-action-environment'),
  env: z.string().describe('Environment: lighting/space/style'),
  bgm: BgmSchema,
  tension: z.string().describe('Core dramatic tension'),
  shot_flow: z.string().describe('Sequence flow: S1 -> S2 -> ...')
})

export const SceneObjectSchema = z.object({
  n: z.string().describe('Object name'),
  f: z.string().describe('Visual features + physics + anchors'),
  s: z.string().describe('Spatial: FG/MG/BG + position'),
  psych: z.nullable(z.string()).describe('Appearance = inner state. Null if inanimate')
})

export const SceneResponseSchema = z.object({
  scene: SceneInfoSchema,
  objs: z.array(SceneObjectSchema),
  character_anchor: z.string().describe('Primary character appearance'),
  shots: z.array(ShotSchema),
  notes: z.nullable(z.string()).describe('Cross-shot verification. Null if none')
})

export type ShotData = z.infer<typeof ShotSchema>
export type ShotsResponse = z.infer<typeof SceneResponseSchema>
export type SceneInfo = z.infer<typeof SceneInfoSchema>
export type SceneObject = z.infer<typeof SceneObjectSchema>

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
        if (shot.color_grade) parts.push(shot.color_grade)
        if (shot.atmosphere) parts.push(shot.atmosphere)
        if (shot.body_physics) parts.push(shot.body_physics)
        if (shot.composition) parts.push(shot.composition)
        if (shot.emotion_target) parts.push(shot.emotion_target)
        if (shot.seq) parts.push(shot.seq)
        if (shot.motion) parts.push(shot.motion)
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
      scene: {
        ...response.scene,
        bgm: response.scene.bgm,
        tension: response.scene.tension,
        shot_flow: response.scene.shot_flow
      },
      objs: response.objs.map((o) => ({
        n: o.n,
        f: o.f,
        s: o.s,
        ...(o.psych && { psych: o.psych })
      })),
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
        ...(shot.color_grade && { cg: shot.color_grade }),
        ...(shot.atmosphere && { atm: shot.atmosphere }),
        ...(shot.body_physics && { bp: shot.body_physics }),
        ...(shot.composition && { comp: shot.composition }),
        ...(shot.emotion_target && { et: shot.emotion_target }),
        ...(shot.seq && { seq: shot.seq }),
        ...(shot.motion && { mot: shot.motion })
      })),
      x: constraints,
      ...(negative && { n: negative }),
      ...(response.notes && { notes: response.notes })
    }
    return JSON.stringify(compact)
  }
}
