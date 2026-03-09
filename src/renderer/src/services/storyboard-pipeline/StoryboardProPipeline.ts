import { StateGraph, START, END, MemorySaver, interrupt, Command } from '@langchain/langgraph'
import { z } from 'zod'
import { BasePipeline } from '../pipeline/BasePipeline'
import {
  StoryboardSceneSchema,
  StoryboardObjSchema,
  StoryboardResponseSchema,
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
  cont: z.string().describe('Cross-shot continuity anchors: what visual elements must stay consistent between shots'),
  notes: z.string().describe('Verification summary and pacing rhythm curve'),
})

const SimpleShotDesignSchema = z.object({
  seq: z.array(z.object({
    id: z.string().describe('镜头编号'),
    desc: z.string().describe('镜头描述'),
  })),
  cont: z.string().default(''),
  notes: z.string().default(''),
})

const FlatSceneSchema = z.object({
  d: z.string().describe('Narrative arc: A(initial state) → B(trigger event) → C(end state)'),
  cap: z.string().describe('Structured caption: subject performing action in environment'),
  env: z.string().describe('Environment description: lighting direction, color palette, atmosphere, weather'),
  bgm: z.string().default('').describe('Sound design layers: ambient, music, SFX, voice'),
  shotCount: z.number().default(4).describe('Number of distinct shots identified in the scene'),
})

const SimpleObjArraySchema = z.object({
  objs: z.array(z.object({
    n: z.string().describe('Character or object name'),
    f: z.string().describe('Visual appearance: hair, face, outfit, distinguishing features'),
    t: z.string().describe('Cross-shot consistency anchor: features that must remain identical across all shots'),
    act: z.string().describe('Current action: what the character is doing in the scene'),
  })),
})

const AnalyzeOutputSchema = z.object({
  scene: z.object({
    d: z.string().describe('Narrative arc: A(initial state) → B(trigger event) → C(end state)'),
    cap: z.string().describe('Structured caption: subject performing action in environment'),
    env: z.string().describe('Environment description: lighting direction, color palette, atmosphere, weather'),
  }),
  objs: z.array(z.object({
    n: z.string().describe('Character or object name'),
    f: z.string().describe('Visual appearance: hair, face, outfit, distinguishing features'),
    t: z.string().describe('Cross-shot consistency anchor: features that must remain identical across all shots'),
    act: z.string().describe('Current action: what the character is doing in the scene'),
  })),
})

// ==================== State ====================

const stateSchema = z.object({
  scene: StoryboardSceneSchema.nullable().default(null),
  objs: z.array(StoryboardObjSchema).nullable().default(null),
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
  inputImages: z.array(z.object({
    data: z.string(),
    mimeType: z.string(),
  })).default([]),
  userContext: z.string().default(''),
  taskPlan: z.string().default(''),
})

export type StoryboardState = z.infer<typeof stateSchema>

export function shouldRetryStoryboardAnalysis(state: {
  scene: { d?: string } | null
  objs: Array<{ n?: string }> | null
}): 'continue' | 'abort' {
  const sceneOk = state.scene && state.scene.d && state.scene.d !== '(analysis failed)'
  const objsOk = state.objs && state.objs.length > 0
  if (sceneOk || objsOk) return 'continue'
  return 'abort'
}

function unwrapScene(data: any): any {
  if (data?.scene && typeof data.scene === 'object' && typeof data.scene.d === 'string') return data.scene
  return data
}

// ==================== Pipeline ====================

export class StoryboardProPipeline extends BasePipeline<StoryboardState, StoryboardResponse> {
  private _graph: any = null
  private _graphBuilder: any = null
  private _checkpointer: MemorySaver | null = null
  _currentThreadId: string | null = null
  private _pauseRequested = false
  private _lastTotalPasses = 3

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
      case 'analyze': {
        const s = output?.scene
        const objs = output?.objs
        const scenePart = s?.d ? `弧线: ${s.d.slice(0, 30)}` : '(场景缺失)'
        const charPart = objs?.length ? `${objs.length} 个角色` : '(无角色)'
        return `${scenePart}，${charPart}`
      }
      case 'sceneDecompose': {
        const s = output?.scene
        if (!s) return '(empty)'
        return `场景弧线: ${(s.d || '?').slice(0, 40)}，环境: ${(s.env || '?').slice(0, 30)}`
      }
      case 'characterExtract': {
        const objs = output?.objs
        if (!objs?.length) return '(empty)'
        return `提取 ${objs.length} 个角色/物体`
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
      case 'deepVerify': {
        const r = output?.report
        if (!r) return '(empty)'
        return `评分 ${r.score}/10，${r.issues?.length || 0} 个问题`
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
      summary: StoryboardProPipeline.formatSummary(nodeName, output),
      appliedSkills,
      raw: output,
      elapsed,
    }
  }

  private resolveSystemPrompt(
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
      console.error(`[StoryboardProPipeline] Pass ${pass} (${nodeName}) failed: ${message}`)
      writer(config)?.({
        type: 'pass_complete', pass,
        label: `${label}失败: ${message.slice(0, 80)}`,
        elapsed,
        passData: StoryboardProPipeline.buildPassCardData(nodeName, { pass, label }, { error: message }, elapsed),
      })
    }

    // ===== Pass 0: 快速规划 (text-only, NO images) =====
    const taskPlanningFn = async (state: StoryboardState, config: any) => {
      const t0 = Date.now()
      try {
        const llm = self.createLLM()

        const userText = [
          `Context: ${state.userContext || '(free creation)'}`,
          '',
          'Create a brief storyboard plan in English covering:',
          '1. Scene setting — core environment and atmosphere',
          '2. Key characters — who appears, distinguishing visual features',
          '3. Visual style — medium (photo/anime/3D), palette, lighting mood',
          '4. Narrative arc — how the story flows across shots',
          'Keep the plan under 150 words.',
        ].join('\n')

        const response = await llm.invoke(
          [
            {
              role: 'system' as const,
              content: 'You are a professional storyboard director. Create a brief shooting plan. Write in English only.',
            },
            { role: 'user' as const, content: userText },
          ],
          { signal: config?.signal },
        )

        const planText = typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content)

        const elapsed = Date.now() - t0
        console.log(`[StoryboardProPipeline] taskPlanning: ${elapsed}ms`)
        writer(config)?.({
          type: 'pass_complete', pass: 0,
          label: `规划完成 (${(elapsed / 1000).toFixed(1)}s)`,
          elapsed,
          passData: StoryboardProPipeline.buildPassCardData('taskPlanning', { pass: 0, label: '规划' }, { planText }, elapsed),
        })
        return { taskPlan: planText }
      } catch (err: unknown) {
        console.warn('[StoryboardProPipeline] taskPlanning failed:', err instanceof Error ? err.message : String(err))
        const elapsed = Date.now() - t0
        writer(config)?.({
          type: 'pass_complete', pass: 0,
          label: `规划完成 (${(elapsed / 1000).toFixed(1)}s)`,
          elapsed,
          passData: StoryboardProPipeline.buildPassCardData('taskPlanning', { pass: 0, label: '规划' }, { planText: '' }, elapsed),
        })
        return { taskPlan: '' }
      }
    }

    // ===== Pass 1: 场景+角色分析 (merged single LLM call) =====
    const analyzeFn = async (state: StoryboardState, config: any) => {
      checkPauseAndInterrupt('analyze', config)
      const t0 = Date.now()
      try {
        const appliedSkills = self.getSkillsForPhase('sceneDecompose', state as Record<string, unknown>)
        const vars: Record<string, string> = {
          user_context: state.userContext || '',
          task_plan: state.taskPlan || '',
        }
        const systemPrompt = self.resolveSystemPrompt(
          'sceneDecompose', vars,
          state as Record<string, unknown>,
          [
            'You are a professional film storyboard analyst. From the provided images, output TWO things in a single structured response:',
            '1. SCENE: narrative arc (d), structured caption (cap), environment (env)',
            '2. CHARACTERS: extract ALL characters and significant objects with name (n), appearance (f), consistency anchor (t), current action (act)',
            '',
            'REFERENCE IMAGE FIDELITY: The attached images are the SINGLE SOURCE OF TRUTH. Describe ONLY what is visually present. DO NOT hallucinate.',
            'Write in English.',
            state.taskPlan ? `\nDIRECTOR PLAN (use as guidance):\n${state.taskPlan}` : '',
          ].filter(Boolean).join('\n'),
        )

        const userMessages = [
          { role: 'system' as const, content: systemPrompt },
          {
            role: 'user' as const,
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              {
                type: 'text' as const,
                text: state.taskPlan
                  ? `STORYBOARD PLAN:\n${state.taskPlan}\n\nBased on the plan above AND the reference images, analyze the scene structure and extract all characters.${state.userContext ? `\nAdditional context: ${state.userContext}` : ''}`
                  : `Analyze the scene structure and extract all characters from the images above.${state.userContext ? `\nAdditional context: ${state.userContext}` : ''}`,
              },
            ],
          },
        ]

        let scene: any = null
        let objs: any[] = []

        try {
          const structuredWithRaw = self.createStructuredLLMWithRaw(AnalyzeOutputSchema)
          const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
          const parsed = (response as any)?.parsed

          if (parsed?.scene?.d) {
            scene = parsed.scene
            if (!scene.timeline) scene.timeline = []
          }
          if (parsed?.objs?.length) {
            objs = parsed.objs
          }

          if ((!scene?.d || !objs.length) && (response as any)?.raw?.content) {
            const rawText = typeof (response as any).raw.content === 'string'
              ? (response as any).raw.content : ''
            try {
              const match = rawText.match(/\{[\s\S]*"scene"\s*:[\s\S]*"objs"\s*:[\s\S]*\}/)
              if (match) {
                const fallback = JSON.parse(match[0])
                if (!scene?.d && fallback?.scene?.d) {
                  scene = fallback.scene
                  if (!scene.timeline) scene.timeline = []
                }
                if (!objs.length && fallback?.objs?.length) {
                  objs = fallback.objs
                }
              }
            } catch { /* regex fallback failed */ }
          }
        } catch (e: unknown) {
          console.warn('[StoryboardProPipeline] analyze L1 error:', e instanceof Error ? e.message : String(e))
        }

        if (!scene?.d) {
          scene = { d: '(analysis failed)', cap: '', env: '', bgm: '', timeline: [] }
          console.warn('[StoryboardProPipeline] analyze: scene extraction failed')
        }

        const paddedObjs = objs.map((o: any) => ({
          n: o.n || '', f: o.f || '', t: o.t || '', act: o.act || '',
          s: o.s || 'fg|center|Z1', p: o.p || 'artic', tc: o.tc || '',
          fx: o.fx ?? null, motive: o.motive || '', a: o.a || '', m: o.m || '',
        }))

        const elapsed = Date.now() - t0
        const passData = StoryboardProPipeline.buildPassCardData('analyze', { pass: 1, label: '场景+角色分析' }, { scene, objs: paddedObjs }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 1, label: `场景+角色分析完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { scene, objs: paddedObjs }
      } catch (err: unknown) {
        emitError(config, 1, '场景+角色分析', 'analyze', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { scene: null, objs: null }
      }
    }

    // ===== Pass 3: 镜头设计 (L1/L2/L3 error recovery) =====
    const shotDesignFn = async (state: StoryboardState, config: any) => {
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
        const passData = StoryboardProPipeline.buildPassCardData('shotDesign', { pass: 2, label: '镜头设计' }, { seq, cont, notes }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 2, label: `镜头设计完成 [${level}] (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
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
        console.warn('[StoryboardProPipeline] L1 failed: full schema + raw extraction both empty')
      } catch (e: unknown) {
        console.warn('[StoryboardProPipeline] L1 error:', e instanceof Error ? e.message : String(e))
      }

      // --- Level 2: Simplified schema (just id + desc) ---
      let lastError = ''
      writer(config)?.({ type: 'pass_complete', pass: 2, label: '镜头设计格式降级重试...', elapsed: Date.now() - t0, passData: null })
      try {
        const simpleStructured = self.createStructuredLLM(SimpleShotDesignSchema)
        const simpleResult = await simpleStructured.invoke(messages, { signal: config?.signal })
        if (simpleResult?.seq?.length) {
          console.log(`[StoryboardProPipeline] L2 success: ${simpleResult.seq.length} shots via SimpleShotDesignSchema`)
          emitSuccess(simpleResult.seq, simpleResult.cont || '', simpleResult.notes || '', 'L2-simple')
          return { seq: simpleResult.seq, cont: simpleResult.cont || '', notes: simpleResult.notes || '' }
        }
        lastError = 'SimpleShotDesignSchema returned empty seq array'
        console.warn('[StoryboardProPipeline] L2 failed:', lastError)
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e)
        console.warn('[StoryboardProPipeline] L2 error:', lastError)
      }

      // --- All levels failed ---
      emitError(config, 2, '镜头设计', 'shotDesign', 'L1 and L2 recovery both failed', Date.now() - t0)
      return { seq: null, cont: '', notes: '' }
    }

    // ===== Pass 3: 快速校验 (code-level, instant) =====
    const codeVerifyNode = (state: StoryboardState, config: any) => {
      const t0 = Date.now()
      const result = storyboardCodeVerify(state as any)
      const elapsed = Date.now() - t0
      const passData = StoryboardProPipeline.buildPassCardData('codeVerify', { pass: 3, label: '快速校验' }, { report: result }, elapsed)
      writer(config)?.({
        type: 'pass_complete', pass: 3,
        label: `快速校验完成 (score: ${result.score}, ${elapsed}ms)`,
        elapsed, passData,
      })
      return { report: result }
    }

    // ===== Graph Assembly =====
    // taskPlanning → analyze → shotDesign → codeVerify → END
    const graph = new StateGraph(stateSchema)
      .addNode('taskPlanning', taskPlanningFn)
      .addNode('analyze', analyzeFn)
      .addNode('shotDesign', shotDesignFn)
      .addNode('codeVerify', codeVerifyNode)
      .addEdge(START, 'taskPlanning')
      .addEdge('taskPlanning', 'analyze')
      .addEdge('analyze', 'shotDesign')
      .addEdge('shotDesign', 'codeVerify')
      .addEdge('codeVerify', END)

    this._graphBuilder = graph
    this._checkpointer = new MemorySaver()
    this._graph = graph.compile({ checkpointer: this._checkpointer })
    return graph
  }

  assembleResult(state: StoryboardState): StoryboardResponse {
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
    input: Partial<StoryboardState>,
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
    const totalPasses = 3
    this._lastTotalPasses = totalPasses
    let finalState: StoryboardState = { ...input } as StoryboardState

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
            console.log(`[StoryboardProPipeline] 管线在 ${data.node} 处暂停`)
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
        console.log('[StoryboardProPipeline] 管线已取消')
        return this.postProcess(this.assembleResult(finalState))
      }
      throw err
    }

    const totalElapsed = Date.now() - pipelineStart
    if (this._pauseRequested) {
      console.log(`[StoryboardProPipeline] 管线暂停 (${(totalElapsed / 1000).toFixed(1)}s)`)
    } else {
      console.log(`[StoryboardProPipeline] 管线完成 (${totalPasses} passes)，总耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
    }
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
    let finalState: StoryboardState = {} as StoryboardState
    let currentPass = 0

    try {
      const stream = await this._graph.stream(
        new Command({ resume: true }),
        config,
      )

      for await (const event of stream) {
        if (Array.isArray(event)) {
          const [mode, data] = event

          if (mode === 'custom' && data?.type === 'paused') {
            console.log(`[StoryboardProPipeline] 管线在 ${data.node} 处再次暂停`)
            continue
          }

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
            const updatesData = data
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
        console.log('[StoryboardProPipeline] 恢复执行已取消')
        const result = this.postProcess(this.assembleResult(finalState))
        ;(result as any).__paused = false
        ;(result as any).__cancelled = true
        return result
      }
      throw err
    }

    const totalElapsed = Date.now() - pipelineStart
    if (this._pauseRequested) {
      console.log(`[StoryboardProPipeline] 管线在恢复后再次暂停 (${(totalElapsed / 1000).toFixed(1)}s)`)
    } else {
      console.log(`[StoryboardProPipeline] 管线恢复完成，耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
    }

    const result = this.postProcess(this.assembleResult(finalState))
    ;(result as any).__paused = this._pauseRequested
    return result
  }
}
