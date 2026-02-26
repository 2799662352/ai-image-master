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

// Enhanced shot with sequence + alignment + motion fields
export const EnhancedShotSchema = ShotSchema.extend({
  seq: z.string().describe(
    'Sequence encoding: how this shot connects to neighbors. ' +
    'E.g. "S3: match-cut from S2 hand gesture → leads to S4 reaction close-up"'
  ),
  alignment: z.object({
    coarse: z.string().describe('Coarse grain: overall composition change from prev shot. E.g. "wide establishing → medium intimacy"'),
    medium: z.string().describe('Medium grain: action chain within this shot. E.g. "reach → grasp → pull back"'),
    fine: z.string().describe('Fine grain: occlusion/highlight/shadow micro-changes. E.g. "shadow crosses face L-to-R as head turns"')
  }),
  motion: z.nullable(z.string()).describe(
    'Per-body-part motion intensity as formatted string. E.g. "head:low-subtle nod, arms:high-reaching up, torso:medium-lean, legs:static". Null if fully static shot.'
  )
})

// BGM / Sound design
export const BgmSchema = z.object({
  base: z.string().describe('Ambient foundation: drone, silence, low hum, room tone'),
  env: z.string().describe('Environment sounds: rain, wind, crowd murmur, clock ticking'),
  action: z.string().describe('Action foley: footsteps, fabric rustle, glass shatter, breath'),
  melody: z.string().describe('Melody / silence strategy: sparse piano, crescendo strings, deliberate silence')
})

// Scene-level info (global narrative context)
export const SceneInfoSchema = z.object({
  d: z.string().describe('Narrative arc in A→B→C format. E.g. "confrontation → confession → silent acceptance"'),
  cap: z.string().describe('Structured title: subject-action-environment. E.g. "woman-discovers-letter-in-rain"'),
  env: z.string().describe('Environment: lighting/space/style. E.g. "dusk interior, warm practical lamps, neo-noir"'),
  bgm: BgmSchema,
  tension: z.string().describe('Core dramatic tension. E.g. "she knows the truth but cannot speak it"')
})

// Persistent scene objects with physics + cross-shot anchors
export const SceneObjectSchema = z.object({
  n: z.string().describe('Object name. E.g. "woman in red dress", "antique pocket watch"'),
  f: z.string().describe('Visual features for consistency. E.g. "black bob, pale skin, red silk qipao, gold trim"'),
  s: z.string().describe('Spatial position: FG/MG/BG + placement. E.g. "MG center, seated"'),
  p: z.string().describe('Physics type + constraints: rigid/articulated/fluid/cloth/near-rigid. E.g. "articulated biped, cloth skirt gravity drape"'),
  t: z.string().describe('Cross-shot anchors: invariant features across all shots. E.g. "hair style, dress color, scar = invariant S1-S9"'),
  psych: z.nullable(z.string()).describe('Appearance=psychology: how visuals reflect inner state. E.g. "clenched fist = suppressed anger". Null if inanimate.')
})

// Full scene response (3-layer)
export const SceneResponseSchema = z.object({
  scene: SceneInfoSchema,
  objs: z.array(SceneObjectSchema),
  character_anchor: z.string().describe('Primary character appearance (backward compat): gender, age, hair, eyes, skin, outfit, build'),
  shots: z.array(EnhancedShotSchema),
  notes: z.nullable(z.string()).describe('Cross-shot verification summary. E.g. "S1-S3: dress consistent, S4: lighting shift motivated by window". Null if no issues.')
})

// Legacy alias for backward compatibility
export const ShotsResponseSchema = SceneResponseSchema

export type ShotData = z.infer<typeof EnhancedShotSchema>
export type ShotsResponse = z.infer<typeof SceneResponseSchema>
export type SceneInfo = z.infer<typeof SceneInfoSchema>
export type SceneObject = z.infer<typeof SceneObjectSchema>

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
        if (shot.color_grade) parts.push(`Color: ${shot.color_grade.dominant}, accent ${shot.color_grade.accent}`)
        if (shot.emotion_target) parts.push(`Emotion: ${shot.emotion_target}`)
        parts.push(`[${shot.seq}]`)
        if (shot.motion) parts.push(`Motion(${shot.motion})`)
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
        d: response.scene.d,
        cap: response.scene.cap,
        env: response.scene.env,
        bgm: response.scene.bgm,
        tension: response.scene.tension
      },
      objs: response.objs.map(o => ({
        n: o.n, f: o.f, s: o.s, p: o.p, t: o.t,
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
        seq: shot.seq,
        align: shot.alignment,
        ...(shot.motion && { m: shot.motion }),
        ...(shot.micro_expression && { me: shot.micro_expression }),
        ...(shot.color_grade && { cg: shot.color_grade }),
        ...(shot.atmosphere && { atm: shot.atmosphere }),
        ...(shot.body_physics && { bp: shot.body_physics }),
        ...(shot.composition && { comp: shot.composition }),
        ...(shot.emotion_target && { em: shot.emotion_target })
      })),
      x: constraints,
      ...(negative && { n: negative }),
      ...(response.notes && { notes: response.notes })
    }
    return JSON.stringify(compact)
  }
}
