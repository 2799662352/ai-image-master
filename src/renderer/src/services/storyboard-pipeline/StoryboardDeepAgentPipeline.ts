import { StateGraph, START, END, MemorySaver, interrupt, Command } from '@langchain/langgraph'
import { z } from 'zod'
import { BasePipeline } from '../pipeline/BasePipeline'
import {
  StoryboardSceneSchema,
  StoryboardObjSchema,
} from '../LangChainStoryboardService'
import type { StoryboardResponse } from '../LangChainStoryboardService'
import { VerifySchema } from '../pipeline/schemas/director-schemas'
import type {
  PipelineConfig,
  PipelineSkill,
  PipelineProgress,
  PassCardData,
  PipelineExecuteOptions,
} from '../pipeline/types'
import { storyboardCodeVerify } from './storyboard-verify'
import { getStoryboardPromptTemplate, renderTemplate, getStoryboardSkills } from './storyboard-prompt-loader'

// ==================== Schemas ====================

const ShotDesignOutputSchema = z.object({
  seq: z.array(z.object({
    id: z.string().describe('Shot number e.g. S1, S2'),
    desc: z.string().describe('Shot type, character action, key dialogue, camera movement'),
    act: z.string().optional().describe('Performance action: what the character physically does'),
    fx: z.nullable(z.string()).optional().describe('Visual effects: wind, smoke, light, particles. Null if none'),
    motive: z.string().optional().describe('Character motivation: what psychological state drives this action'),
    audio: z.string().optional().describe('Audio layers: score, SFX, voice'),
  })),
  cont: z.string().describe('Cross-shot continuity anchors'),
  notes: z.string().describe('Verification summary and pacing rhythm curve'),
})

const SimpleShotDesignSchema = z.object({
  seq: z.array(z.object({
    id: z.string(),
    desc: z.string(),
  })),
  cont: z.string().default(''),
  notes: z.string().default(''),
})

export const FlatSceneSchema = z.object({
  d: z.string().describe('Narrative arc: A(initial state) → B(trigger event) → C(end state)'),
  cap: z.string().describe('Structured caption: subject performing action in environment'),
  env: z.string().describe('Environment description: lighting direction, color palette, atmosphere, weather'),
  bgm: z.string().default('').describe('Sound design layers: ambient, music, SFX, voice'),
  shotCount: z.number().default(4).describe('Number of distinct shots identified in the scene'),
})

export const CharIdentitySchema = z.object({
  objs: z.array(z.object({
    n: z.string().describe('Character or object name'),
    f: z.string().describe('Visual appearance: hair, face, outfit, distinguishing features'),
    t: z.string().describe('Cross-shot consistency anchor'),
  })),
})

export const CharSpatialSchema = z.object({
  objs: z.array(z.object({
    n: z.string().describe('Character name (must match identity anchor)'),
    s: z.string().describe('Spatial position: fg/mg/bg | horizontal | Z-occlusion order'),
    p: z.string().describe('Physical type: rigid/artic/fluid/cloth + motion constraints'),
    a: z.string().describe('Multi-granularity detail'),
    m: z.string().describe('Motion intensity per body part'),
  })),
})

export const CharNarrativeSchema = z.object({
  objs: z.array(z.object({
    n: z.string().describe('Character name (must match identity anchor)'),
    act: z.string().describe('Performance action: pure physical action'),
    fx: z.nullable(z.string()).describe('Visual effects. Null if none'),
    motive: z.string().describe('Psychological externalization'),
    tc: z.string().describe('Transition continuity between shots'),
  })),
})

// ==================== Shared State ====================

type SharedFiles = {
  'scene.json'?: string
  'char-anchors.json'?: string
  'char-spatial.json'?: string
  'char-narrative.json'?: string
  'task-plan.txt'?: string
}

const DeepAgentStateSchema = z.object({
  inputImages: z.array(z.object({ data: z.string(), mimeType: z.string() })).default([]),
  userContext: z.string().default(''),
  taskPlan: z.string().default(''),
  sharedFiles: z.record(z.string()).default({}),
  objs: z.array(StoryboardObjSchema).nullable().default(null),
  scene: StoryboardSceneSchema.nullable().default(null),
  seq: z.array(z.object({
    id: z.string(),
    desc: z.string(),
    act: z.string().optional(),
    fx: z.nullable(z.string()).optional(),
    motive: z.string().optional(),
    audio: z.string().optional(),
  })).nullable().default(null),
  cont: z.string().default(''),
  notes: z.string().default(''),
  report: VerifySchema.nullable().default(null),
})

export type DeepAgentState = z.infer<typeof DeepAgentStateSchema>

// ==================== Subagent Functions ====================
// Each subagent maintains its own isolated message array (no shared state pollution).
// This achieves the same context-isolation as Deep Agents' Subagent + StateBackend model.

export async function sceneAnalyzerSubAgent(opts: {
  inputImages: { data: string; mimeType: string }[]
  userContext: string
  taskPlan: string
  llm: any
  systemPrompt: string
}): Promise<{ scene: z.infer<typeof FlatSceneSchema>; sharedFileContent: string }> {
  const messages = [
    { role: 'system' as const, content: opts.systemPrompt },
    {
      role: 'user' as const,
      content: [
        ...BasePipeline.buildImageContent(opts.inputImages, 'low'),
        {
          type: 'text' as const,
          text: [
            'Analyze the scene structure from the images above.',
            opts.taskPlan ? `\nDIRECTOR PLAN (use as guidance for scene focus):\n${opts.taskPlan}` : '',
            opts.userContext ? `\nAdditional context: ${opts.userContext}` : '',
          ].filter(Boolean).join(''),
        },
      ],
    },
  ]

  const structuredLLM = opts.llm.withStructuredOutput(FlatSceneSchema)
  const scene = await structuredLLM.invoke(messages)
  const sharedFileContent = JSON.stringify(scene)
  return { scene, sharedFileContent }
}

export async function charIdentitySubAgent(opts: {
  inputImages: { data: string; mimeType: string }[]
  taskPlan: string
  llm: any
  systemPrompt: string
}): Promise<{ anchors: Array<{ n: string; f: string; t: string }>; sharedFileContent: string }> {
  const messages = [
    { role: 'system' as const, content: opts.systemPrompt },
    {
      role: 'user' as const,
      content: [
        ...BasePipeline.buildImageContent(opts.inputImages, 'high'),
        {
          type: 'text' as const,
          text: [
            'Extract identity anchors for all characters and significant objects from the images above.',
            opts.taskPlan ? `\nDIRECTOR PLAN (use as guidance):\n${opts.taskPlan}` : '',
          ].filter(Boolean).join(''),
        },
      ],
    },
  ]

  const structuredLLM = opts.llm.withStructuredOutput(CharIdentitySchema)
  const result = await structuredLLM.invoke(messages)
  const anchors = (result.objs || []).map((o: any) => ({ n: o.n || '', f: o.f || '', t: o.t || '' }))
  return { anchors, sharedFileContent: JSON.stringify({ objs: anchors }) }
}

export async function charSpatialSubAgent(opts: {
  inputImages: { data: string; mimeType: string }[]
  anchors: Array<{ n: string; f: string; t: string }>
  llm: any
  systemPrompt: string
}): Promise<{ spatialData: any[]; sharedFileContent: string }> {
  const anchorNameList = opts.anchors.map(a => `"${a.n}"`).join(', ')
  const anchorList = opts.anchors.map(a => `- ${a.n}: ${a.f}`).join('\n')
  const messages = [
    {
      role: 'system' as const,
      content: `${opts.systemPrompt}\n\nKNOWN CHARACTERS:\n${anchorList}\n\nOutput MUST use the exact character names from the list above.`,
    },
    {
      role: 'user' as const,
      content: [
        ...BasePipeline.buildImageContent(opts.inputImages, 'low'),
        {
          type: 'text' as const,
          text: `Character names you MUST use exactly: ${anchorNameList}\n\nDescribe spatial position, physical type, multi-granularity detail, and motion intensity for each character.`,
        },
      ],
    },
  ]

  const structuredLLM = opts.llm.withStructuredOutput(CharSpatialSchema)
  const result = await structuredLLM.invoke(messages)
  const spatialData = (result.objs || []).map((o: any) => ({
    n: o.n || '', s: o.s || '', p: o.p || '', a: o.a || '', m: o.m || '',
  }))
  return { spatialData, sharedFileContent: JSON.stringify({ objs: spatialData }) }
}

export async function charNarrativeSubAgent(opts: {
  inputImages: { data: string; mimeType: string }[]
  anchors: Array<{ n: string; f: string; t: string }>
  llm: any
  systemPrompt: string
}): Promise<{ narrativeData: any[]; sharedFileContent: string }> {
  const anchorNameList = opts.anchors.map(a => `"${a.n}"`).join(', ')
  const anchorList = opts.anchors.map(a => `- ${a.n}: ${a.f}`).join('\n')
  const messages = [
    {
      role: 'system' as const,
      content: `${opts.systemPrompt}\n\nKNOWN CHARACTERS:\n${anchorList}\n\nOutput MUST use the exact character names from the list above.`,
    },
    {
      role: 'user' as const,
      content: [
        ...BasePipeline.buildImageContent(opts.inputImages, 'high'),
        {
          type: 'text' as const,
          text: `Character names you MUST use exactly: ${anchorNameList}\n\nDescribe performance actions, visual effects, psychological motivation, and transition continuity for each character.`,
        },
      ],
    },
  ]

  const structuredLLM = opts.llm.withStructuredOutput(CharNarrativeSchema)
  const result = await structuredLLM.invoke(messages)
  const narrativeData = (result.objs || []).map((o: any) => ({
    n: o.n || '', act: o.act || '', fx: o.fx ?? null, motive: o.motive || '', tc: o.tc || '',
  }))
  return { narrativeData, sharedFileContent: JSON.stringify({ objs: narrativeData }) }
}

// 必须 import 一次再 re-export:`export { x } from '...'` **不会**把 x 带进本模块
// 作用域,而 charMergeNode(Pass 5)在下面直接调用它 —— 少了这行,那一关运行时
// 就是 `ReferenceError: charMergeSubAgent is not defined`。
//
// 测试没能挡住,因为它们从本模块 import 这个函数(re-export 对外部消费者有效),
// 测的是被转发的函数本身,不是调用它的那个流水线节点。
import { charMergeSubAgent } from './storyboard-char-merge'

export { charMergeSubAgent }

// ==================== Pipeline Class ====================

export class StoryboardDeepAgentPipeline extends BasePipeline<DeepAgentState, StoryboardResponse> {
  private _graph: any = null
  private _graphBuilder: any = null
  private _checkpointer: MemorySaver | null = null
  _currentThreadId: string | null = null
  private _pauseRequested = false
  private _lastTotalPasses = 8
  readonly totalPasses = 8

  constructor(config: PipelineConfig) {
    super(config)
  }

  requestPause(): void {
    this._pauseRequested = true
  }

  clearPauseRequest(): void {
    this._pauseRequested = false
  }

  get isPauseRequested(): boolean {
    return this._pauseRequested
  }

  get currentThreadId(): string | null {
    return this._currentThreadId
  }

  get pipelineSkills(): PipelineSkill[] {
    return getStoryboardSkills()
  }

  private static formatSummary(nodeName: string, output: any): string {
    switch (nodeName) {
      case 'sceneAnalyze': {
        const s = output?.scene
        if (!s) return '(empty)'
        return `场景弧线: ${(s.d || '?').slice(0, 40)}，环境: ${(s.env || '?').slice(0, 30)}`
      }
      case 'charIdentify': {
        const anchors = output?.anchors
        if (!anchors?.length) return '(empty)'
        return `提取 ${anchors.length} 个角色/物体`
      }
      case 'charSpatial': {
        const data = output?.spatialData
        if (!data?.length) return '(empty)'
        return `${data.length} 个角色空间/运动`
      }
      case 'charNarrative': {
        const data = output?.narrativeData
        if (!data?.length) return '(empty)'
        return `${data.length} 个角色动作/叙事`
      }
      case 'charMerge': {
        const objs = output?.objs
        if (!objs?.length) return '(empty)'
        return `合并 ${objs.length} 个角色 (11字段)`
      }
      case 'shotDesign': {
        const seq = output?.seq
        if (!seq?.length) return '(empty)'
        return `${seq.length} 个镜头已设计`
      }
      case 'codeVerify': {
        const r = output?.report
        if (!r) return '(empty)'
        return `快检 ${r.score}/10，${r.issues?.length || 0} 个问题`
      }
      default:
        return ''
    }
  }

  private static buildPassCardData(
    nodeName: string,
    passInfo: { pass: number; label: string },
    output: any,
    elapsed: number,
    appliedSkills: string[] = [],
  ): PassCardData {
    return {
      pass: passInfo.pass,
      passName: nodeName,
      label: passInfo.label,
      summary: StoryboardDeepAgentPipeline.formatSummary(nodeName, output),
      appliedSkills,
      raw: output,
      elapsed,
    }
  }

  protected resolveSystemPrompt(
    passName: string,
    vars: Record<string, string>,
    context: Record<string, unknown>,
    inlineFallback: string,
  ): string {
    const tpl = getStoryboardPromptTemplate(passName)
    const basePrompt = tpl
      ? renderTemplate(tpl.template, vars)
      : inlineFallback
    return this.buildSystemPrompt(passName, basePrompt, context)
  }

  buildGraph() {
    const self = this

    const writer = (config: any) => config?.writer

    const checkPauseAndInterrupt = (nodeName: string, config: any) => {
      if (self._pauseRequested) {
        writer(config)?.({ type: 'paused', node: nodeName })
        interrupt({ reason: 'user_pause', node: nodeName })
      }
    }

    function emitError(config: any, pass: number, label: string, nodeName: string, message: string, elapsed: number) {
      console.error(`[StoryboardDeepAgentPipeline] Pass ${pass} (${nodeName}) failed: ${message}`)
      writer(config)?.({
        type: 'pass_complete', pass,
        label: `${label}失败: ${message.slice(0, 80)}`,
        elapsed,
        passData: StoryboardDeepAgentPipeline.buildPassCardData(nodeName, { pass, label }, { error: message }, elapsed),
      })
    }

    const systemFor = (phase: string, fallback: string[]) =>
      self.resolveSystemPrompt(phase, {}, {}, fallback.join('\n'))

    // ===== Pass 0: Task Planning (text-only, fast) =====
    const taskPlanningNode = async (state: DeepAgentState, config: any) => {
      const t0 = Date.now()
      try {
        const llm = self.createLLM()
        const userContent: any[] = [
          ...BasePipeline.buildImageContent(state.inputImages, 'low'),
          {
            type: 'text' as const,
            text: [
              `Context: ${state.userContext || '(free creation)'}`,
              '',
              'Create a brief storyboard plan in English covering:',
              '1. Scene setting — core environment and atmosphere',
              '2. Key characters — who appears, distinguishing visual features',
              '3. Visual style — medium (photo/anime/3D), palette, lighting mood',
              '4. Narrative arc — how the story flows across shots',
              'Keep the plan under 150 words.',
            ].join('\n'),
          },
        ]

        const response = await llm.invoke(
          [
            { role: 'system' as const, content: 'You are a professional storyboard director. Create a brief shooting plan based on the provided reference images. Write in English only.' },
            { role: 'user' as const, content: userContent },
          ],
          { signal: config?.signal },
        )

        const planText = typeof response.content === 'string' ? response.content : JSON.stringify(response.content)
        const elapsed = Date.now() - t0
        writer(config)?.({
          type: 'pass_complete', pass: 0,
          label: `规划完成 (${(elapsed / 1000).toFixed(1)}s)`,
          elapsed,
          passData: StoryboardDeepAgentPipeline.buildPassCardData('taskPlanning', { pass: 0, label: '规划' }, { planText }, elapsed),
        })
        return { taskPlan: planText, sharedFiles: { ...state.sharedFiles, 'task-plan.txt': planText } }
      } catch (err: unknown) {
        const elapsed = Date.now() - t0
        console.warn('[StoryboardDeepAgentPipeline] taskPlanning failed:', err instanceof Error ? err.message : String(err))
        writer(config)?.({
          type: 'pass_complete', pass: 0,
          label: `规划完成 (${(elapsed / 1000).toFixed(1)}s)`,
          elapsed,
          passData: StoryboardDeepAgentPipeline.buildPassCardData('taskPlanning', { pass: 0, label: '规划' }, { planText: '' }, elapsed),
        })
        return { taskPlan: '' }
      }
    }

    // ===== Pass 1: Scene Analysis (subagent) =====
    const sceneAnalyzeNode = async (state: DeepAgentState, config: any) => {
      checkPauseAndInterrupt('sceneDecompose', config)
      const t0 = Date.now()
      try {
        const llm = self.createLLM()
        const systemPrompt = systemFor('sceneDecompose', [
          'You are a professional film storyboard scene analyst.',
          'From the provided images, extract the SCENE structure:',
          '- d: Narrative arc in format A(initial state) → B(trigger event) → C(end state)',
          '- cap: Structured caption (subject performing action in environment)',
          '- env: Environment description (lighting direction, color palette, atmosphere, weather)',
          '',
          'REFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH.',
          'Write in English.',
        ])

        const { scene, sharedFileContent } = await sceneAnalyzerSubAgent({
          inputImages: state.inputImages,
          userContext: state.userContext,
          taskPlan: state.taskPlan,
          llm,
          systemPrompt,
        })

        const fullScene = { ...scene, timeline: [] }
        const elapsed = Date.now() - t0
        const passData = StoryboardDeepAgentPipeline.buildPassCardData('sceneAnalyze', { pass: 1, label: '场景分析' }, { scene: fullScene }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 1, label: `场景分析完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { scene: fullScene, sharedFiles: { ...state.sharedFiles, 'scene.json': sharedFileContent } }
      } catch (err: unknown) {
        emitError(config, 1, '场景分析', 'sceneAnalyze', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { scene: null }
      }
    }

    // ===== Pass 2: Character Identity (subagent, parallel with sceneAnalyze) =====
    const charIdentifyNode = async (state: DeepAgentState, config: any) => {
      checkPauseAndInterrupt('charIdentity', config)
      const t0 = Date.now()
      try {
        const llm = self.createLLM()
        const systemPrompt = systemFor('charIdentity', [
          'You are a professional character analyst for film storyboards.',
          'From the provided images, extract ALL characters and significant objects.',
          'For each, provide ONLY identity anchors:',
          '- n: Character or object name',
          '- f: Visual appearance (hair, face, outfit, distinguishing features)',
          '- t: Cross-shot consistency anchor',
          '',
          'REFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH.',
          'Write in English.',
        ])

        const { anchors, sharedFileContent } = await charIdentitySubAgent({
          inputImages: state.inputImages,
          taskPlan: state.taskPlan,
          llm,
          systemPrompt,
        })

        const elapsed = Date.now() - t0
        const passData = StoryboardDeepAgentPipeline.buildPassCardData('charIdentify', { pass: 2, label: '身份锚点' }, { anchors }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 2, label: `身份锚点完成 (${anchors.length} 角色, ${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { sharedFiles: { ...state.sharedFiles, 'char-anchors.json': sharedFileContent } }
      } catch (err: unknown) {
        emitError(config, 2, '身份锚点', 'charIdentify', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { sharedFiles: { ...state.sharedFiles, 'char-anchors.json': JSON.stringify({ objs: [] }) } }
      }
    }

    // ===== Pass 3: Character Spatial (subagent, after charIdentify) =====
    const charSpatialNode = async (state: DeepAgentState, config: any) => {
      checkPauseAndInterrupt('charSpatial', config)
      const t0 = Date.now()
      try {
        const anchors = JSON.parse(state.sharedFiles['char-anchors.json'] || '{"objs":[]}').objs || []
        const llm = self.createLLM()
        const systemPrompt = systemFor('charSpatial', [
          'You are a spatial and motion analyst for film storyboards.',
          'Describe spatial and physical properties for EACH character.',
          'Write in English.',
        ])

        const { sharedFileContent } = await charSpatialSubAgent({
          inputImages: state.inputImages, anchors, llm, systemPrompt,
        })

        const elapsed = Date.now() - t0
        writer(config)?.({ type: 'pass_complete', pass: 3, label: `空间/运动完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData: null })
        return { sharedFiles: { ...state.sharedFiles, 'char-spatial.json': sharedFileContent } }
      } catch (err: unknown) {
        emitError(config, 3, '空间/运动', 'charSpatial', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { sharedFiles: { ...state.sharedFiles, 'char-spatial.json': JSON.stringify({ objs: [] }) } }
      }
    }

    // ===== Pass 4: Character Narrative (subagent, parallel with charSpatial) =====
    const charNarrativeNode = async (state: DeepAgentState, config: any) => {
      checkPauseAndInterrupt('charNarrative', config)
      const t0 = Date.now()
      try {
        const anchors = JSON.parse(state.sharedFiles['char-anchors.json'] || '{"objs":[]}').objs || []
        const llm = self.createLLM()
        const systemPrompt = systemFor('charNarrative', [
          'You are a narrative and performance analyst for film storyboards.',
          'Describe actions and narrative properties for EACH character.',
          'Write in English.',
        ])

        const { sharedFileContent } = await charNarrativeSubAgent({
          inputImages: state.inputImages, anchors, llm, systemPrompt,
        })

        const elapsed = Date.now() - t0
        writer(config)?.({ type: 'pass_complete', pass: 4, label: `动作/叙事完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData: null })
        return { sharedFiles: { ...state.sharedFiles, 'char-narrative.json': sharedFileContent } }
      } catch (err: unknown) {
        emitError(config, 4, '动作/叙事', 'charNarrative', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { sharedFiles: { ...state.sharedFiles, 'char-narrative.json': JSON.stringify({ objs: [] }) } }
      }
    }

    // ===== Pass 5: Character Merge (code-only, no LLM) =====
    const charMergeNode = (state: DeepAgentState, config: any) => {
      const t0 = Date.now()
      const anchors = JSON.parse(state.sharedFiles['char-anchors.json'] || '{"objs":[]}').objs || []
      const spatialData = JSON.parse(state.sharedFiles['char-spatial.json'] || '{"objs":[]}').objs || []
      const narrativeData = JSON.parse(state.sharedFiles['char-narrative.json'] || '{"objs":[]}').objs || []

      const objs = charMergeSubAgent(anchors, spatialData, narrativeData)
      const elapsed = Date.now() - t0
      const passData = StoryboardDeepAgentPipeline.buildPassCardData('charMerge', { pass: 5, label: '角色合并' }, { objs }, elapsed)
      writer(config)?.({ type: 'pass_complete', pass: 5, label: `角色合并完成 (${objs.length} 角色, ${elapsed}ms)`, elapsed, passData })
      return { objs }
    }

    // ===== Pass 6: Shot Design (L1/L2 error recovery, migrated from StoryboardProPipeline) =====
    const shotDesignNode = async (state: DeepAgentState, config: any) => {
      checkPauseAndInterrupt('shotDesign', config)
      const t0 = Date.now()
      const appliedSkills = self.getSkillsForPhase('shotDesign', state as Record<string, unknown>)

      const sceneSummary = state.scene
        ? `弧线: ${state.scene.d}\n环境: ${state.scene.env}\n标题: ${state.scene.cap}`
        : '(场景数据缺失)'
      const characterSummary = state.objs?.length
        ? state.objs.map(o => `${o.n}: ${o.t} [${o.act}]`).join('\n')
        : '(角色数据缺失)'

      const vars: Record<string, string> = {
        scene_summary: sceneSummary,
        character_summary: characterSummary,
        user_context: state.userContext || '',
        task_plan: state.taskPlan || '',
      }
      const systemPrompt = self.resolveSystemPrompt(
        'shotDesign', vars,
        state as Record<string, unknown>,
        [
          `You are a professional film director designing a shot sequence.`,
          ``,
          `Scene:\n${sceneSummary}`,
          ``,
          `Characters:\n${characterSummary}`,
          state.taskPlan ? `\nDIRECTOR PLAN (use as guidance):\n${state.taskPlan}` : '',
          `\nDesign shots with id, desc, act, fx, motive, audio. Also provide cont (cross-shot continuity) and notes (verification summary).`,
          state.userContext ? `\n${state.userContext}` : '',
        ].filter(Boolean).join('\n'),
      )

      const userText = (() => {
        const parts: string[] = []
        if (state.taskPlan) parts.push(`STORYBOARD PLAN:\n${state.taskPlan}`)
        parts.push(`Based on the scene and character analysis above, design a complete shot sequence.${state.userContext ? `\nAdditional context: ${state.userContext}` : ''}`)
        return parts.join('\n\n')
      })()

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userText },
      ]

      const emitSuccess = (seq: any[], cont: string, notes: string, level: string) => {
        const elapsed = Date.now() - t0
        const passData = StoryboardDeepAgentPipeline.buildPassCardData('shotDesign', { pass: 6, label: '镜头设计' }, { seq, cont, notes }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 6, label: `镜头设计完成 [${level}] (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
      }

      // --- Level 1: Full schema with includeRaw + regex fallback ---
      try {
        const structuredWithRaw = self.createStructuredLLMWithRaw(ShotDesignOutputSchema)
        const response = await structuredWithRaw.invoke(messages, { signal: config?.signal })

        let parsed = (response as any)?.parsed
        if (!parsed?.seq?.length) {
          const rawText = typeof (response as any)?.raw?.content === 'string'
            ? (response as any).raw.content
            : JSON.stringify((response as any)?.raw?.content ?? '')
          try {
            const jsonMatch = rawText.match(/\{[\s\S]*"seq"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
            if (jsonMatch) {
              const fallback = JSON.parse(jsonMatch[0])
              if (fallback?.seq?.length) parsed = fallback
            }
          } catch { /* regex extraction failed */ }
        }

        if (parsed?.seq?.length) {
          emitSuccess(parsed.seq, parsed.cont || '', parsed.notes || '', 'L1')
          return { seq: parsed.seq, cont: parsed.cont || '', notes: parsed.notes || '' }
        }
        console.warn('[StoryboardDeepAgentPipeline] L1 failed: full schema + raw extraction both empty')
      } catch (e: unknown) {
        console.warn('[StoryboardDeepAgentPipeline] L1 error:', e instanceof Error ? e.message : String(e))
      }

      // --- Level 2: Simplified schema (just id + desc) ---
      writer(config)?.({ type: 'pass_complete', pass: 6, label: '镜头设计格式降级重试...', elapsed: Date.now() - t0, passData: null })
      try {
        const simpleStructured = self.createStructuredLLM(SimpleShotDesignSchema)
        const simpleResult = await simpleStructured.invoke(messages, { signal: config?.signal })
        if (simpleResult?.seq?.length) {
          emitSuccess(simpleResult.seq, simpleResult.cont || '', simpleResult.notes || '', 'L2-simple')
          return { seq: simpleResult.seq, cont: simpleResult.cont || '', notes: simpleResult.notes || '' }
        }
        console.warn('[StoryboardDeepAgentPipeline] L2 failed: SimpleShotDesignSchema returned empty seq')
      } catch (e: unknown) {
        console.warn('[StoryboardDeepAgentPipeline] L2 error:', e instanceof Error ? e.message : String(e))
      }

      emitError(config, 6, '镜头设计', 'shotDesign', 'L1 and L2 recovery both failed', Date.now() - t0)
      return { seq: null, cont: '', notes: '' }
    }

    // ===== Pass 7: Code Verify (code-level, instant) =====
    const codeVerifyNode = (state: DeepAgentState, config: any) => {
      const t0 = Date.now()
      const result = storyboardCodeVerify(state as any)
      const elapsed = Date.now() - t0
      const passData = StoryboardDeepAgentPipeline.buildPassCardData('codeVerify', { pass: 7, label: '快速校验' }, { report: result }, elapsed)
      writer(config)?.({
        type: 'pass_complete', pass: 7,
        label: `快速校验完成 (score: ${result.score}, ${elapsed}ms)`,
        elapsed, passData,
      })
      return { report: result }
    }

    // ===== Graph Assembly =====
    //                            ┌→ sceneAnalyze ───────────────────────┐
    // [START] → taskPlanning ────┤                                      ├→ shotDesign → codeVerify → END
    //                            └→ charIdentify ──┬→ charSpatial ──┐   │
    //                                              └→ charNarrative ┼→ charMerge ─┘
    const graph = new StateGraph(DeepAgentStateSchema)
      .addNode('taskPlanning', taskPlanningNode)
      .addNode('sceneAnalyze', sceneAnalyzeNode)
      .addNode('charIdentify', charIdentifyNode)
      .addNode('charSpatial', charSpatialNode)
      .addNode('charNarrative', charNarrativeNode)
      .addNode('charMerge', charMergeNode)
      .addNode('shotDesign', shotDesignNode)
      .addNode('codeVerify', codeVerifyNode)
      .addEdge(START, 'taskPlanning')
      .addEdge('taskPlanning', 'sceneAnalyze')
      .addEdge('taskPlanning', 'charIdentify')
      .addEdge('charIdentify', 'charSpatial')
      .addEdge('charIdentify', 'charNarrative')
      .addEdge('charSpatial', 'charMerge')
      .addEdge('charNarrative', 'charMerge')
      .addEdge('sceneAnalyze', 'shotDesign')
      .addEdge('charMerge', 'shotDesign')
      .addEdge('shotDesign', 'codeVerify')
      .addEdge('codeVerify', END)

    this._graphBuilder = graph
    this._checkpointer = new MemorySaver()
    this._graph = graph.compile({ checkpointer: this._checkpointer })
    return graph
  }

  assembleResult(state: DeepAgentState): StoryboardResponse {
    return {
      scene: state.scene || { d: '', cap: '', env: '', bgm: '', timeline: [] },
      objs: state.objs || [],
      seq: (state.seq || []).map(s => ({
        id: s.id,
        desc: s.desc,
        ...(s.act !== undefined && { act: s.act }),
        ...(s.fx !== undefined && { fx: s.fx }),
        ...(s.motive !== undefined && { motive: s.motive }),
        ...(s.audio !== undefined && { audio: s.audio }),
      })),
      cont: state.cont || '',
      notes: state.notes || '',
    }
  }

  postProcess(result: StoryboardResponse): StoryboardResponse {
    return result
  }

  async execute(
    input: Partial<DeepAgentState>,
    onProgress?: (progress: PipelineProgress) => void,
    options?: PipelineExecuteOptions,
  ): Promise<StoryboardResponse> {
    if (!this._graph) this.buildGraph()

    if (this._graphBuilder) {
      this._checkpointer = new MemorySaver()
      this._graph = this._graphBuilder.compile({ checkpointer: this._checkpointer })
    }

    this._pauseRequested = false
    const threadId = crypto.randomUUID()
    this._currentThreadId = threadId
    const totalPasses = 8
    this._lastTotalPasses = totalPasses
    let finalState: DeepAgentState = { ...input } as DeepAgentState

    const config: any = {
      streamMode: ['updates', 'custom'],
      signal: options?.signal,
      configurable: { thread_id: threadId },
    }

    const pipelineStart = Date.now()
    let currentPass = 0

    const compiledGraph = this._graph
    if (!compiledGraph) {
      throw new Error('Storyboard graph is not initialized')
    }

    try {
      const stream = await compiledGraph.stream(input, config)
      for await (const event of stream) {
        if (Array.isArray(event)) {
          const [mode, data] = event
          if (mode === 'custom' && data?.type === 'paused') {
            continue
          }
          if (mode === 'custom' && data?.type === 'pass_complete') {
            currentPass = typeof data.pass === 'number' ? data.pass : currentPass
            onProgress?.({
              pass: data.pass,
              totalPasses,
              label: data.label,
              status: 'completed',
              elapsed: data.elapsed,
              passData: data.passData,
            })
          } else if (mode === 'custom') {
            const inferredPass = typeof data?.pass === 'number' ? data.pass : currentPass
            currentPass = inferredPass
            onProgress?.({
              pass: inferredPass,
              totalPasses,
              label: data?.label || '处理中...',
              status: 'running',
              data,
            })
          } else if (mode === 'updates') {
            const updatesData = data && typeof data === 'object' ? data : {}
            for (const [, output] of Object.entries(updatesData)) {
              if (output && typeof output === 'object') {
                finalState = { ...finalState, ...(output as any) }
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return this.postProcess(this.assembleResult(finalState))
      }
      throw err
    }

    const totalElapsed = Date.now() - pipelineStart
    console.log(`[StoryboardDeepAgentPipeline] 管线完成 (${totalPasses} passes)，总耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
    const result = this.postProcess(this.assembleResult(finalState))
    ;(result as any).__paused = this._pauseRequested
    return result
  }

  async resume(
    onProgress?: (progress: PipelineProgress) => void,
    options?: PipelineExecuteOptions,
  ): Promise<StoryboardResponse> {
    if (!this._currentThreadId || !this._graph) {
      throw new Error('没有可恢复的暂停状态')
    }
    this._pauseRequested = false

    const config: any = {
      streamMode: ['updates', 'custom'],
      signal: options?.signal,
      configurable: { thread_id: this._currentThreadId },
    }

    const pipelineStart = Date.now()
    let finalState: DeepAgentState = {} as DeepAgentState
    let currentPass = 0

    try {
      const stream = await this._graph.stream(new Command({ resume: true }), config)
      for await (const event of stream) {
        if (Array.isArray(event)) {
          const [mode, data] = event
          if (mode === 'custom' && data?.type === 'paused') continue
          if (mode === 'custom' && data?.type === 'pass_complete') {
            currentPass = typeof data.pass === 'number' ? data.pass : currentPass
            onProgress?.({
              pass: data.pass,
              totalPasses: data.totalPasses || this._lastTotalPasses,
              label: data.label,
              status: 'completed',
              elapsed: data.elapsed,
              passData: data.passData,
            })
          } else if (mode === 'custom') {
            const inferredPass = typeof data?.pass === 'number' ? data.pass : currentPass
            currentPass = inferredPass
            onProgress?.({
              pass: inferredPass,
              totalPasses: this._lastTotalPasses,
              label: data?.label || '处理中...',
              status: 'running',
              data,
            })
          } else if (mode === 'updates') {
            for (const [, output] of Object.entries(data)) {
              if (output && typeof output === 'object') {
                finalState = { ...finalState, ...(output as any) }
              }
            }
          }
        }
      }
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        const result = this.postProcess(this.assembleResult(finalState))
        ;(result as any).__paused = false
        ;(result as any).__cancelled = true
        return result
      }
      throw err
    }

    const result = this.postProcess(this.assembleResult(finalState))
    ;(result as any).__paused = this._pauseRequested
    return result
  }
}
