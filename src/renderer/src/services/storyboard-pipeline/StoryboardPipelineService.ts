import { StateGraph, Annotation, START, END, MemorySaver } from '@langchain/langgraph'
import { ChatOpenAI } from '@langchain/openai'
import { ChatGoogle } from '@langchain/google'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'
import type { RunnableConfig } from '@langchain/core/runnables'
import {
  SceneAnalysisSchema, CharacterAnchorsSchema,
  ShotSequenceSchema, ConsistencyReportSchema,
  type SceneAnalysis, type CharacterAnchor, type ShotData, type ConsistencyReport,
  type PreviousShot
} from './schemas'
import { aggregateToStoryboardResponse } from './aggregate'
import { sanitizeStoryboardResponse } from './sanitizer'
import { buildRulesForPass, BUILTIN_SKILLS, type PromptSkill } from './prompt-skills'
import type { StoryboardResponse } from '../LangChainStoryboardService'

export interface ImageInput {
  base64: string
  mimeType: string
}

export interface PipelineConfig {
  apiKey: string
  baseURL: string
  model?: string
}

export interface PipelineInput {
  rolePrompt: string
  context?: string
  panelCount?: number | 'auto'
}

/**
 * Pipeline 进度事件。
 * 正常 pass 完成时 data 为该 pass 的结果对象。
 * 当 data.retry === true 时表示 prepareRetry 触发，UI 应切换到精修状态。
 */
export interface PipelineProgress {
  pass: 1 | 2 | 3 | 4
  label: string
  data: any
}

const PipelineState = Annotation.Root({
  scene: Annotation<SceneAnalysis | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  characters: Annotation<CharacterAnchor[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  shots: Annotation<ShotData[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  report: Annotation<ConsistencyReport | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
  retryCount: Annotation<number>({
    reducer: (_, y) => y,
    default: () => 0,
  }),
  retryFeedback: Annotation<string>({
    reducer: (_, y) => y,
    default: () => '',
  }),
  previousShots: Annotation<PreviousShot[] | null>({
    reducer: (_, y) => y,
    default: () => null,
  }),
})

const RETRY_SCORE_THRESHOLD = 10
const MAX_RETRY_COUNT = 2

export class StoryboardPipelineService {
  private llm: ChatOpenAI | ChatGoogle
  private skills: PromptSkill[]

  constructor(config: PipelineConfig, skills?: PromptSkill[]) {
    this.skills = skills || BUILTIN_SKILLS
    const modelName = config.model || 'gemini-3-pro-preview'
    const isGemini = modelName.toLowerCase().includes('gemini')
    const cleanBaseURL = config.baseURL.replace(/\/v1\/?$/, '')

    if (isGemini) {
      const hostname = cleanBaseURL.replace(/^https?:\/\//, '')
      this.llm = new ChatGoogle({
        model: modelName,
        apiKey: config.apiKey,
        endpoint: hostname,
        maxOutputTokens: 8192,
        maxRetries: 2
      })
    } else {
      this.llm = new ChatOpenAI({
        model: modelName,
        apiKey: config.apiKey,
        maxRetries: 2,
        maxTokens: 8192,
        configuration: { baseURL: `${cleanBaseURL}/v1` }
      })
    }
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

  async analyze(
    images: ImageInput[],
    input: PipelineInput,
    onProgress?: (progress: PipelineProgress) => void
  ): Promise<StoryboardResponse> {
    const llm = this.llm
    const buildImageContent = this.buildImageContent.bind(this)

    const sceneLlm = llm.withStructuredOutput(SceneAnalysisSchema)
    const characterLlm = llm.withStructuredOutput(CharacterAnchorsSchema)
    const shotLlm = llm.withStructuredOutput(ShotSequenceSchema)
    const reportLlm = llm.withStructuredOutput(ConsistencyReportSchema)

    const buildImageMsg = (text: string) =>
      new HumanMessage({ content: buildImageContent(images, text) })

    const skills = this.skills

    const scriptContext = input.context
      ? `\n\n--- 剧本原文(角色名和台词必须从此提取) ---\n${input.context}`
      : ''

    const domainKnowledge = input.rolePrompt
      ? `\n\n--- 分析指南(所有Pass共享) ---\n${input.rolePrompt}`
      : ''

    async function analyzeScene(_state: typeof PipelineState.State, config?: RunnableConfig) {
      let timelineHint = ''
      if (typeof input.panelCount === 'number') {
        timelineHint = `\n时间轴应规划 ${input.panelCount} 个镜头段(S1-S${input.panelCount})，每段2-4秒。`
      } else {
        timelineHint = '\n先观察图片：如果图片是多面板分镜图(如九宫格/六宫格)，数出面板数量作为镜头数。如果是单张场景图，根据剧本长度和场景复杂度自行决定(4-9个)。每段2-4秒。'
      }

      const systemMsg = new SystemMessage(
        `你是专业电影分镜师和AI视频预生产专家。分析图片的场景环境，输出叙事弧线、环境参数、音乐设计和时间轴。${timelineHint}\n${buildRulesForPass('scene', skills)}`
      )
      let userText = input.rolePrompt || '请分析这张图片的场景。'
      userText += scriptContext
      const result = await sceneLlm.invoke([systemMsg, buildImageMsg(userText)], config)
      return { scene: result }
    }

    async function extractCharacters(state: typeof PipelineState.State, config?: RunnableConfig) {
      const sceneContext = JSON.stringify(state.scene)
      const systemMsg = new SystemMessage(
        `你是专业电影分镜师。基于场景分析和剧本，提取所有角色/物体。
关键：如果剧本提供了角色名（如人名条），必须使用剧本原名，禁止根据画面风格猜测角色身份。
每个角色必须有跨镜头一致性锚点(发色/伤疤/服装纹理/道具)。
每个角色必须有motive字段：基于剧本和画面，用一句话描述该角色在此场景中想要达成什么。\n${buildRulesForPass('character', skills)}`
      )
      const userText = `场景分析结果:\n${sceneContext}${scriptContext}${domainKnowledge}\n\n请提取所有角色和关键物体，角色名从剧本中提取。`
      const result = await characterLlm.invoke([systemMsg, buildImageMsg(userText)], config)
      return { characters: result.characters }
    }

    async function generateShots(state: typeof PipelineState.State, config?: RunnableConfig) {
      const sceneContext = JSON.stringify(state.scene)
      const charContext = JSON.stringify(state.characters)
      const timelineCount = state.scene?.timeline?.length || 0

      let shotCountInstruction: string
      if (typeof input.panelCount === 'number') {
        shotCountInstruction = `生成恰好 ${input.panelCount} 个镜头(S1-S${input.panelCount})，每个2-4秒。`
      } else if (timelineCount > 0) {
        shotCountInstruction = `基于场景时间轴已规划的 ${timelineCount} 个时间段，生成 ${timelineCount} 个镜头。`
      } else {
        shotCountInstruction = `观察原图：如果是多面板分镜图(九宫格/六宫格等)，为每个面板生成一个镜头。如果是单张场景图，根据剧本长度自行决定(4-9个)。每个镜头2-4秒。`
      }

      const systemMsg = new SystemMessage(
        `你是专业电影分镜师。基于场景和角色数据生成分镜序列。
${shotCountInstruction}
每个镜头5段式: 景别|动作|台词精华|心理→外化|运镜。
台词规则：从剧本原文中逐字提取台词，格式"台词..."(表演方式)。禁止编造台词。无台词标注(无台词)或描写非语言声效。\n${buildRulesForPass('shot', skills, { retryFeedback: state.retryFeedback, previousShots: state.previousShots, characters: state.characters })}`
      )
      let userText = `场景:\n${sceneContext}\n\n角色:\n${charContext}${scriptContext}${domainKnowledge}\n\n请生成分镜序列，台词从剧本原文提取。`
      if (state.retryFeedback) {
        userText += `\n\n--- 校验反馈(增量修正) ---
以下是校验发现的问题，请仅修正被指出的问题，保留其他已通过校验的镜头不变：
${state.retryFeedback}

重要：
- 被指出有问题的镜头：修正该问题
- 如果建议拆分镜头（如S4a/S4b），可以增加镜头数量
- 未被提及的镜头：保持原样不变
- 修正后的台词必须从剧本原文提取`
      }
      const result = await shotLlm.invoke([systemMsg, buildImageMsg(userText)], config)
      return { shots: result.shots }
    }

    async function verifyConsistency(state: typeof PipelineState.State, config?: RunnableConfig) {
      const allData = JSON.stringify({
        scene: state.scene, characters: state.characters, shots: state.shots
      })
      const systemMsg = new SystemMessage(
        `你是电影连续性校验专家。对照原图和领域规则检查场景、角色、分镜之间的一致性：
1. 角色名是否与剧本一致（不是根据画面猜的）
2. 台词是否从剧本原文提取（不是编造的）
3. 角色锚点是否跨镜头保持（对照原图验证外观描述）
4. 物理参数是否自洽（对照原图验证光影/空间）
5. 时间轴是否连贯
6. 是否违反Hard Rules（如用了情绪形容词、缺少镜头参数、DOF与焦距矛盾等）
输出连续性锚点、节奏总结和评分(1-10)。如发现角色名或台词与剧本不符，评分不超过5。\n${buildRulesForPass('verify', skills)}`
      )
      const result = await reportLlm.invoke([
        systemMsg, buildImageMsg(`请校验以下分镜数据的一致性:\n${allData}${scriptContext}${domainKnowledge}`)
      ], config)
      return { report: result }
    }

    function shouldRetry(state: typeof PipelineState.State) {
      if (state.report && state.report.score < RETRY_SCORE_THRESHOLD && state.retryCount < MAX_RETRY_COUNT) {
        return 'retry'
      }
      return 'done'
    }

    function prepareRetry(state: typeof PipelineState.State) {
      const feedback = state.report?.issues
        ?.map(i => `[${i.shotId}] ${i.field}: ${i.problem} → ${i.suggestion}`)
        .join('\n') || ''

      const previousShots = state.shots?.map(s => ({ id: s.id, desc: s.desc })) || null

      return {
        retryFeedback: feedback,
        retryCount: state.retryCount + 1,
        previousShots,
        shots: null,
        report: null
      }
    }

    const graph = new StateGraph(PipelineState)
      .addNode('analyzeScene', analyzeScene, { retryPolicy: { maxAttempts: 3 } })
      .addNode('extractCharacters', extractCharacters, { retryPolicy: { maxAttempts: 3 } })
      .addNode('generateShots', generateShots, { retryPolicy: { maxAttempts: 3 } })
      .addNode('verifyConsistency', verifyConsistency, { retryPolicy: { maxAttempts: 2 } })
      .addNode('prepareRetry', prepareRetry)
      .addEdge(START, 'analyzeScene')
      .addEdge('analyzeScene', 'extractCharacters')
      .addEdge('extractCharacters', 'generateShots')
      .addEdge('generateShots', 'verifyConsistency')
      .addConditionalEdges('verifyConsistency', shouldRetry, {
        retry: 'prepareRetry',
        done: END
      })
      .addEdge('prepareRetry', 'generateShots')
      .compile({ checkpointer: new MemorySaver() })

    const threadId = `storyboard-${Date.now()}`
    const collected: {
      scene?: SceneAnalysis
      characters?: CharacterAnchor[]
      shots?: ShotData[]
      report?: ConsistencyReport
    } = {}

    for await (const chunk of await graph.stream({}, {
      streamMode: 'updates',
      configurable: { thread_id: threadId }
    })) {
      const entries = Object.entries(chunk)
      if (entries.length === 0) continue
      const [nodeName, nodeOutput] = entries[0] as [string, Record<string, unknown>]

      if (nodeName === 'analyzeScene') {
        collected.scene = nodeOutput.scene as SceneAnalysis
        if (onProgress) onProgress({ pass: 1, label: '场景分析完成', data: collected.scene })
      } else if (nodeName === 'extractCharacters') {
        collected.characters = nodeOutput.characters as CharacterAnchor[]
        if (onProgress) onProgress({ pass: 2, label: '角色提取完成', data: collected.characters })
      } else if (nodeName === 'generateShots') {
        collected.shots = nodeOutput.shots as ShotData[]
        if (onProgress) onProgress({ pass: 3, label: '分镜生成完成', data: collected.shots })
      } else if (nodeName === 'verifyConsistency') {
        collected.report = nodeOutput.report as ConsistencyReport
        if (onProgress) onProgress({ pass: 4, label: '一致性校验完成', data: collected.report })
      } else if (nodeName === 'prepareRetry') {
        if (onProgress) {
          const retryData = nodeOutput as Record<string, unknown>
          onProgress({
            pass: 3,
            label: '准备精修重试',
            data: { retry: true, retryCount: retryData.retryCount }
          })
        }
      }
    }

    if (!collected.scene || !collected.characters || !collected.shots || !collected.report) {
      throw new Error('Pipeline incomplete: missing pass results')
    }

    const raw = aggregateToStoryboardResponse(
      collected.scene, collected.characters, collected.shots, collected.report
    )
    return sanitizeStoryboardResponse(raw)
  }
}
