import { z } from 'zod'
import { ChatOpenAI } from '@langchain/openai'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

// ==================== Zod Schemas (演出导向) ====================

export const StoryboardObjSchema = z.object({
  n: z.string().describe('角色/物体名'),
  f: z.string().describe('外观特征→心理动机映射(生理描述,禁用情绪标签)'),
  s: z.string().optional().describe('空间位置: fg/mg/bg|位置(L1/3,R2/3)|Z遮挡序'),
  p: z.string().optional().describe('物理类型: rigid/artic/fluid/cloth + 运动约束'),
  t: z.string().describe('跨镜头一致性锚点(发色/伤疤/服装纹理/道具)'),
  tc: z.string().optional().describe('镜头衔接延续: S?→S?: 姿态/运动向量/视线方向'),
  act: z.string().describe('演出动作(纯动作,不含特效)'),
  fx: z.string().nullable().optional().describe('特效: 风/烟/光/粒子,与act时间对齐. Null if none'),
  motive: z.string().optional().describe('动机: 这个动作/道具外化了什么心理'),
  a: z.string().optional().describe('多粒度: 粗(构图%)→中(动作链)→细(遮挡/高光delta)'),
  m: z.string().optional().describe('运动强度: 部位→角度°/位移cm/H-M-L. 格式: head:pan-R25°|M,torso:lean10°|L'),
})

export const StoryboardTimelineEntrySchema = z.object({
  t: z.string().describe('时间范围 e.g. 0-3s'),
  dur: z.string().describe('持续时长 e.g. 3s'),
  tempo: z.string().describe('节奏: slow/accelerating/urgent/sudden-stop'),
  trans: z.string().describe('转场: cut/match-cut/whip-pan/smash-cut')
})

export const StoryboardSceneSchema = z.object({
  d: z.string().describe('叙事弧线: A(初始)→B(触发)→C(终态)'),
  cap: z.string().describe('结构化标题: 主体-动作-环境'),
  env: z.string().describe('环境: [mm]f/[stop]|光源+阴影%+对比|主色hex+点缀色hex|风格'),
  bgm: z.string().describe('4层声画对位: 层1(绑定S?)|层2(绑定S?)|层3(绑定S?)|层4'),
  timeline: z.array(StoryboardTimelineEntrySchema.extend({
    id: z.string().describe('镜头编号 e.g. S1, S2, S1-S3')
  }))
})

export const StoryboardResponseSchema = z.object({
  scene: StoryboardSceneSchema,
  objs: z.array(StoryboardObjSchema),
  seq: z.array(z.object({
    id: z.string().describe('镜头编号 e.g. S1'),
    desc: z.string().describe('景别|动作|台词精华|心理→外化|运镜'),
    act: z.string().optional().describe('演出动作(纯动作,不含特效)'),
    fx: z.nullable(z.string()).optional().describe('特效: 风/烟/光/粒子. Null if none'),
    motive: z.string().optional().describe('动机: 这个动作外化了什么心理'),
    audio: z.string().optional().describe('三层音频: score | sfx | voice')
  })),
  cont: z.string().describe('跨镜头连续性锚点,格式: S1-S2:锚点;S2-S3:锚点'),
  notes: z.string().describe('验证总结 + 节奏呼吸曲线: 总Xs(慢→渐快→急促→骤停)')
})

export type StoryboardResponse = z.infer<typeof StoryboardResponseSchema>
export type StoryboardObj = z.infer<typeof StoryboardObjSchema>

// ==================== Service Types ====================

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface StoryboardInput {
  images: ImageInput[]
  rolePrompt: string
  context?: string
  signal?: AbortSignal
}

// ==================== Service ====================

export class LangChainStoryboardService {
  private llm: ChatOpenAI
  private structuredLlm: any

  constructor(config: { apiKey: string; baseURL: string; model?: string }) {
    const modelName = config.model || 'gemini-3-pro-preview'
    const cleanBaseURL = config.baseURL.replace(/\/v1\/?$/, '')

    this.llm = new ChatOpenAI({
      model: modelName,
      apiKey: config.apiKey,
      maxRetries: 2,
      maxTokens: 8192,
      configuration: { baseURL: `${cleanBaseURL}/v1` }
    })

    this.structuredLlm = this.llm.withStructuredOutput(StoryboardResponseSchema)
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

  async analyze(input: StoryboardInput): Promise<StoryboardResponse> {
    const systemPrompt = `你是专业的电影分镜师和AI视频预生产专家。一切为了演出，不要为描述而描述。
每个字段必须服务于演出：道具→外化动机，声效→绑定动作，台词→嵌入镜头。
输出严格遵循JSON schema。`

    let userPrompt = input.rolePrompt
    if (input.context) {
      userPrompt += `\n\n--- 剧本/附加要求 ---\n${input.context}`
    }

    const systemMsg = new SystemMessage(systemPrompt)
    const humanMsg = new HumanMessage({
      content: this.buildImageContent(input.images, userPrompt)
    })

    return await this.structuredLlm.invoke([systemMsg, humanMsg], {
      signal: input.signal,
    }) as StoryboardResponse
  }

  toJSON(response: StoryboardResponse): string {
    return JSON.stringify(response, null, 2)
  }

  toCompactJSON(response: StoryboardResponse): string {
    return JSON.stringify(response)
  }
}
