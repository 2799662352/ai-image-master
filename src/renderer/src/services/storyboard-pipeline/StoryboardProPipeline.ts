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

const MAX_RETRIES = 1
const SCORE_THRESHOLD = 6

// ==================== Schemas ====================

const ShotDesignOutputSchema = z.object({
  seq: z.array(z.object({
    id: z.string().describe('镜头编号 e.g. S1'),
    desc: z.string().describe('景别|动作|台词精华|心理→外化|运镜'),
    act: z.string().optional().describe('演出动作'),
    fx: z.nullable(z.string()).optional().describe('特效'),
    motive: z.string().optional().describe('动机'),
    audio: z.string().optional().describe('三层音频'),
  })),
  cont: z.string().describe('跨镜头连续性锚点'),
  notes: z.string().describe('验证总结 + 节奏呼吸曲线'),
})

const SimpleShotDesignSchema = z.object({
  seq: z.array(z.object({
    id: z.string().describe('镜头编号'),
    desc: z.string().describe('镜头描述'),
  })),
  cont: z.string().default(''),
  notes: z.string().default(''),
})

const SimpleSceneSchema = z.object({
  d: z.string().describe('Narrative arc: A→B→C'),
  cap: z.string().describe('Structured caption'),
  env: z.string().describe('Environment description'),
})

const SimpleObjArraySchema = z.object({
  objs: z.array(z.object({
    n: z.string().describe('Character/object name'),
    f: z.string().describe('Appearance features'),
    t: z.string().describe('Cross-shot consistency anchor'),
    act: z.string().describe('Action'),
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
  analysisRetryCount: z.number().default(0),
  retryCount: z.number().default(0),
  retryFeedback: z.string().default(''),
  inputImages: z.array(z.object({
    data: z.string(),
    mimeType: z.string(),
  })).default([]),
  userContext: z.string().default(''),
})

export type StoryboardState = z.infer<typeof stateSchema>

const MAX_ANALYSIS_RETRIES = 2

export function shouldRetryStoryboardAnalysis(state: {
  scene: { d?: string } | null
  objs: Array<{ n?: string }> | null
  analysisRetryCount: number
}): 'continue' | 'retry' | 'abort' {
  const sceneOk = state.scene && state.scene.d && state.scene.d !== '(analysis failed)'
  const objsOk = state.objs && state.objs.length > 0
  if (sceneOk || objsOk) return 'continue'
  if (state.analysisRetryCount >= MAX_ANALYSIS_RETRIES) return 'abort'
  return 'retry'
}

// ==================== Pipeline ====================

export class StoryboardProPipeline extends BasePipeline<StoryboardState, StoryboardResponse> {
  private _graph: any = null
  private _graphBuilder: any = null
  private _checkpointer: MemorySaver | null = null
  _currentThreadId: string | null = null
  private _pauseRequested = false
  private _lastTotalPasses = 4

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

    // ===== Pass 1: 场景分解 (parallel with Pass 2) =====
    const sceneDecomposeFn = async (state: StoryboardState, config: any) => {
      checkPauseAndInterrupt('sceneDecompose', config)
      const t0 = Date.now()
      try {
        const appliedSkills = self.getSkillsForPhase('sceneDecompose', state as Record<string, unknown>)
        const vars: Record<string, string> = { user_context: state.userContext || '' }
        const systemPrompt = self.resolveSystemPrompt(
          'sceneDecompose', vars,
          state as Record<string, unknown>,
          'You are a professional film storyboard analyst. Decompose the scene from the provided images. Output structured data covering: narrative arc (d), structured caption (cap), environment with lighting params (env), 4-layer sound design (bgm), and timeline with shots.',
        )
        const userMessages = [
          { role: 'system' as const, content: systemPrompt },
          {
            role: 'user' as const,
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              {
                type: 'text' as const,
                text: state.userContext
                  ? `参考素材如上。附加要求/剧本:\n${state.userContext}\n\n请分析场景结构。`
                  : '请分析以上图片的场景结构。',
              },
            ],
          },
        ]

        // --- L1: Full schema + jsonMode + includeRaw + greedy regex ---
        let scene: any = null
        try {
          const structuredWithRaw = self.createStructuredLLMWithRaw(StoryboardSceneSchema, undefined, 4096, 'jsonMode')
          const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
          scene = (response as any)?.parsed
          if (!scene?.env && !scene?.d) {
            const rawText = typeof (response as any)?.raw?.content === 'string'
              ? (response as any).raw.content : ''
            try {
              const match = rawText.match(/\{[\s\S]*"d"\s*:[\s\S]*\}/)
              if (match) scene = JSON.parse(match[0])
            } catch { /* L2 below */ }
          }
        } catch (e: unknown) {
          console.warn('[StoryboardProPipeline] sceneDecompose L1 error:', e instanceof Error ? e.message : String(e))
        }

        // --- L2: Simplified schema fallback ---
        if (!scene?.d) {
          console.warn('[StoryboardProPipeline] sceneDecompose L1 failed, trying L2 SimpleSceneSchema')
          try {
            const simpleStructured = self.createStructuredLLM(SimpleSceneSchema)
            const simpleResult = await simpleStructured.invoke(userMessages, { signal: config?.signal })
            if (simpleResult?.d) {
              scene = { ...simpleResult, bgm: '', timeline: [] }
              console.log('[StoryboardProPipeline] sceneDecompose L2 success via SimpleSceneSchema')
            }
          } catch (e: unknown) {
            console.warn('[StoryboardProPipeline] sceneDecompose L2 error:', e instanceof Error ? e.message : String(e))
          }
        }

        if (!scene?.d) {
          scene = { d: '(analysis failed)', cap: '', env: '', bgm: '', timeline: [] }
          console.warn('[StoryboardProPipeline] sceneDecompose: all extraction levels failed')
        }

        const elapsed = Date.now() - t0
        const passData = StoryboardProPipeline.buildPassCardData('sceneDecompose', { pass: 1, label: '场景分解' }, { scene }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 1, label: `场景分解完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { scene }
      } catch (err: unknown) {
        emitError(config, 1, '场景分解', 'sceneDecompose', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { scene: null }
      }
    }

    // ===== Pass 2: 角色/物体提取 (parallel with Pass 1) =====
    const characterExtractFn = async (state: StoryboardState, config: any) => {
      checkPauseAndInterrupt('characterExtract', config)
      const t0 = Date.now()
      try {
        const appliedSkills = self.getSkillsForPhase('characterExtract', state as Record<string, unknown>)
        const vars: Record<string, string> = { user_context: state.userContext || '' }
        const systemPrompt = self.resolveSystemPrompt(
          'characterExtract', vars,
          state as Record<string, unknown>,
          'You are a character analysis expert for storyboard production. Extract ALL characters and significant objects from the provided images.',
        )
        const userMessages = [
          { role: 'system' as const, content: systemPrompt },
          {
            role: 'user' as const,
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              {
                type: 'text' as const,
                text: state.userContext
                  ? `参考素材如上。附加要求:\n${state.userContext}\n\n请提取所有角色和重要物体。`
                  : '请提取以上图片中所有角色和重要物体。',
              },
            ],
          },
        ]

        // --- L1: Full 11-field schema + jsonMode + includeRaw + greedy regex ---
        let parsed: any = null
        try {
          const ObjArraySchema = z.object({ objs: z.array(StoryboardObjSchema) })
          const structuredWithRaw = self.createStructuredLLMWithRaw(ObjArraySchema, undefined, 4096, 'jsonMode')
          const response = await structuredWithRaw.invoke(userMessages, { signal: config?.signal })
          parsed = (response as any)?.parsed
          if (!parsed?.objs?.length) {
            const rawText = typeof (response as any)?.raw?.content === 'string'
              ? (response as any).raw.content : ''
            try {
              const match = rawText.match(/\{[\s\S]*"objs"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
              if (match) {
                const fallback = JSON.parse(match[0])
                if (fallback?.objs?.length) parsed = fallback
              }
            } catch { /* L2 below */ }
          }
        } catch (e: unknown) {
          console.warn('[StoryboardProPipeline] characterExtract L1 error:', e instanceof Error ? e.message : String(e))
        }

        // --- L2: Simplified 4-field schema fallback ---
        if (!parsed?.objs?.length) {
          console.warn('[StoryboardProPipeline] characterExtract L1 failed, trying L2 SimpleObjArraySchema')
          try {
            const simpleStructured = self.createStructuredLLM(SimpleObjArraySchema)
            const simpleResult = await simpleStructured.invoke(userMessages, { signal: config?.signal })
            if (simpleResult?.objs?.length) {
              parsed = {
                objs: simpleResult.objs.map((o: any) => ({
                  n: o.n, f: o.f, t: o.t, act: o.act,
                  s: 'fg|center|Z1', p: 'artic', tc: '', fx: null,
                  motive: '', a: '', m: '',
                })),
              }
              console.log(`[StoryboardProPipeline] characterExtract L2 success: ${parsed.objs.length} objs via SimpleObjArraySchema`)
            }
          } catch (e: unknown) {
            console.warn('[StoryboardProPipeline] characterExtract L2 error:', e instanceof Error ? e.message : String(e))
          }
        }

        if (!parsed?.objs?.length) {
          parsed = { objs: [] }
          console.warn('[StoryboardProPipeline] characterExtract: all extraction levels failed')
        }

        const elapsed = Date.now() - t0
        const passData = StoryboardProPipeline.buildPassCardData('characterExtract', { pass: 2, label: '角色提取' }, { objs: parsed.objs }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 2, label: `角色提取完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { objs: parsed.objs }
      } catch (err: unknown) {
        emitError(config, 2, '角色提取', 'characterExtract', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { objs: null }
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

      let retryBlock = ''
      if (state.retryFeedback) {
        retryBlock = `\n\n--- 校验反馈 (增量修正) ---\n${state.retryFeedback}\n\n仅修正反馈中提到的问题，其他镜头保持不变。`
      }

      const vars: Record<string, string> = {
        scene_summary: sceneSummary,
        character_summary: characterSummary,
        retry_block: retryBlock,
        user_context: state.userContext || '',
      }
      const systemPrompt = self.resolveSystemPrompt(
        'shotDesign', vars,
        state as Record<string, unknown>,
        `You are a professional film director designing a shot sequence.\n\nScene:\n${sceneSummary}\n\nCharacters:\n${characterSummary}${retryBlock}\n\nDesign shots with id, desc, act, fx, motive, audio. Also provide cont (cross-shot continuity) and notes (verification summary).\n\n${state.userContext || ''}`,
      )

      const userContent: Array<any> = []
      if (state.inputImages.length > 0) {
        userContent.push(...BasePipeline.buildImageContent(state.inputImages, 'low'))
      }
      userContent.push({
        type: 'text' as const,
        text: state.userContext
          ? `基于以上场景和角色分析，结合参考素材，设计完整的镜头序列。\n附加要求: ${state.userContext}`
          : '基于以上场景和角色分析，设计完整的镜头序列。',
      })

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: userContent },
      ]

      const emitSuccess = (seq: any[], cont: string, notes: string, level: string) => {
        const elapsed = Date.now() - t0
        const passData = StoryboardProPipeline.buildPassCardData('shotDesign', { pass: 3, label: '镜头设计' }, { seq, cont, notes }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 3, label: `镜头设计完成 [${level}] (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
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
      writer(config)?.({ type: 'pass_complete', pass: 3, label: '镜头设计格式降级重试...', elapsed: Date.now() - t0, passData: null })
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

      // --- Level 3: Error feedback to LLM (self-correction) ---
      writer(config)?.({ type: 'pass_complete', pass: 3, label: '镜头设计 LLM 自修正重试...', elapsed: Date.now() - t0, passData: null })
      try {
        const llm = self.createLLM()
        const feedbackResult = await llm.invoke(
          [
            ...messages,
            {
              role: 'assistant' as const,
              content: `I attempted to generate shot sequence data but the output failed validation. Error: ${lastError}`,
            },
            {
              role: 'user' as const,
              content: `Your previous response failed with error: "${lastError}"\n\nPlease fix this and respond with ONLY a valid JSON object (no markdown, no code fences), exactly like:\n{"seq":[{"id":"S1","desc":"full shot description here"},{"id":"S2","desc":"..."}],"cont":"S1-S2:anchor;S2-S3:anchor","notes":"verification summary"}\n\nEach shot needs an "id" (string like S1, S2) and a "desc" (detailed shot description).`,
            },
          ],
          { signal: config?.signal },
        )
        const text = typeof feedbackResult.content === 'string' ? feedbackResult.content : ''
        const jsonMatch = text.match(/\{[\s\S]*"seq"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed?.seq?.length) {
            console.log(`[StoryboardProPipeline] L3 success: ${parsed.seq.length} shots via error feedback`)
            emitSuccess(parsed.seq, parsed.cont || '', parsed.notes || '', 'L3-feedback')
            return { seq: parsed.seq, cont: parsed.cont || '', notes: parsed.notes || '' }
          }
        }
      } catch (e: unknown) {
        console.warn('[StoryboardProPipeline] L3 error:', e instanceof Error ? e.message : String(e))
      }

      // --- All levels failed ---
      emitError(config, 3, '镜头设计', 'shotDesign', 'All 3 recovery levels failed', Date.now() - t0)
      return { seq: null, cont: '', notes: '' }
    }

    // ===== Pass 4a: 快速校验 (code-level, instant) =====
    const codeVerifyNode = (state: StoryboardState, config: any) => {
      const t0 = Date.now()
      const result = storyboardCodeVerify(state as any)
      const elapsed = Date.now() - t0
      const passData = StoryboardProPipeline.buildPassCardData('codeVerify', { pass: 4, label: '快速校验' }, { report: result }, elapsed)
      writer(config)?.({
        type: 'pass_complete', pass: 4,
        label: `快速校验完成 (score: ${result.score}, ${elapsed}ms)`,
        elapsed, passData,
      })
      return { report: result }
    }

    // ===== Pass 4b: 深度校验 (LLM text-only) =====
    const deepVerifyFn = async (state: StoryboardState, config: any) => {
      checkPauseAndInterrupt('deepVerify', config)
      const t0 = Date.now()
      try {
        const appliedSkills = self.getSkillsForPhase('deepVerify', state as Record<string, unknown>)
        const structured = self.createStructuredLLM(VerifySchema)

        const sceneSummary = state.scene
          ? `弧线: ${state.scene.d}\n环境: ${state.scene.env}`
          : '(缺失)'
        const characterSummary = state.objs?.length
          ? state.objs.map(o => `${o.n}: ${o.t}`).join('; ')
          : '(缺失)'
        const shotsSummary = state.seq?.length
          ? state.seq.map(s => `${s.id}: ${s.desc}`).join('\n')
          : '(缺失)'

        const vars: Record<string, string> = {
          scene_summary: sceneSummary,
          character_summary: characterSummary,
          shots_summary: shotsSummary,
          continuity: state.cont || '(缺失)',
        }
        const systemPrompt = self.resolveSystemPrompt(
          'deepVerify', vars,
          state as Record<string, unknown>,
          `You are a continuity supervisor for storyboard production. Verify consistency.\nScene: ${sceneSummary}\nCharacters: ${characterSummary}\nShots:\n${shotsSummary}\nContinuity: ${state.cont}`,
        )
        const raw = await structured.invoke(
          [
            { role: 'system', content: systemPrompt },
            {
              role: 'user',
              content: `Verify the storyboard for consistency. Check: character anchors, spatial continuity, timeline coherence, narrative arc, motion continuity. Score 0-10.`,
            },
          ],
          { signal: config?.signal },
        )
        const result = raw ?? { score: 7, ok: true, issues: [] }
        if (typeof result.score !== 'number') result.score = 7
        if (typeof result.ok !== 'boolean') result.ok = result.score >= 6
        if (!Array.isArray(result.issues)) result.issues = []

        const elapsed = Date.now() - t0
        const passData = StoryboardProPipeline.buildPassCardData('deepVerify', { pass: 4, label: '深度校验' }, { report: result }, elapsed, appliedSkills)
        writer(config)?.({
          type: 'pass_complete', pass: 4,
          label: `深度校验完成 (score: ${result.score}, ${(elapsed / 1000).toFixed(1)}s)`,
          elapsed, passData,
        })
        return { report: result }
      } catch (err: unknown) {
        emitError(config, 4, '深度校验', 'deepVerify', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { report: null }
      }
    }

    // ===== Retry 准备 =====
    const prepareRetryFn = (state: StoryboardState) => {
      const feedback = Array.isArray(state.report?.issues) && state.report!.issues.length > 0
        ? `校验分数: ${state.report!.score}/10\n问题:\n${state.report!.issues.join('\n')}`
        : `校验分数: ${state.report?.score ?? '?'}/10，进行软修正。`
      return {
        retryFeedback: feedback,
        retryCount: state.retryCount + 1,
        seq: null,
        cont: '',
        notes: '',
        report: null,
      }
    }

    // ===== Analysis Gate Nodes =====
    const validateAnalysisFn = (state: StoryboardState) => {
      console.log(`[StoryboardProPipeline] validateAnalysis: scene=${!!state.scene?.d}, objs=${!!state.objs?.length}, retries=${state.analysisRetryCount}`)
      return {}
    }

    const prepareAnalysisRetryFn = (state: StoryboardState, config: any) => {
      const count = state.analysisRetryCount + 1
      console.warn(`[StoryboardProPipeline] Analysis data empty, retrying (${count}/${MAX_ANALYSIS_RETRIES})...`)
      writer(config)?.({
        type: 'pass_complete', pass: 1,
        label: `场景/角色数据为空，重试中 (${count}/${MAX_ANALYSIS_RETRIES})...`,
        elapsed: 0, passData: null,
      })
      return { analysisRetryCount: count, scene: null, objs: null }
    }

    const abortPipelineFn = (_state: StoryboardState, config: any) => {
      const msg = '场景分解和角色提取均失败，管线终止。请检查网络或换用更强的模型后重试。'
      console.error(`[StoryboardProPipeline] ${msg}`)
      writer(config)?.({
        type: 'pass_complete', pass: 1,
        label: msg, elapsed: 0, passData: null,
      })
      return { seq: null }
    }

    // ===== Routing Functions =====
    const routeAfterCodeVerify = (state: StoryboardState): 'end' | 'deepVerify' => {
      const report = state.report
      if (!report) return 'deepVerify'
      if (report.score >= SCORE_THRESHOLD && report.ok) return 'end'
      return 'deepVerify'
    }

    const routeAfterDeepVerify = (state: StoryboardState): 'retry' | 'end' => {
      if (!state.report || state.retryCount >= MAX_RETRIES) return 'end'
      if (state.report.score < SCORE_THRESHOLD) return 'retry'
      return 'end'
    }

    // ===== Graph Assembly =====
    const retryLLM = { maxAttempts: 2, initialInterval: 1.0 }
    const graph = new StateGraph(stateSchema)
      .addNode('sceneDecompose', sceneDecomposeFn, { retryPolicy: retryLLM })
      .addNode('characterExtract', characterExtractFn, { retryPolicy: retryLLM })
      .addNode('validateAnalysis', validateAnalysisFn)
      .addNode('prepareAnalysisRetry', prepareAnalysisRetryFn)
      .addNode('abortPipeline', abortPipelineFn)
      .addNode('shotDesign', shotDesignFn)
      .addNode('codeVerify', codeVerifyNode)
      .addNode('deepVerify', deepVerifyFn)
      .addNode('prepareRetry', prepareRetryFn)
      // START → parallel sceneDecompose + characterExtract
      .addEdge(START, 'sceneDecompose')
      .addEdge(START, 'characterExtract')
      // Both converge → validateAnalysis (gate before shotDesign)
      .addEdge('sceneDecompose', 'validateAnalysis')
      .addEdge('characterExtract', 'validateAnalysis')
      // validateAnalysis → conditional: continue / retry / abort
      .addConditionalEdges('validateAnalysis', (state: StoryboardState) => {
        return shouldRetryStoryboardAnalysis(state)
      }, {
        continue: 'shotDesign',
        retry: 'prepareAnalysisRetry',
        abort: 'abortPipeline',
      })
      // prepareAnalysisRetry → retry both passes
      .addEdge('prepareAnalysisRetry', 'sceneDecompose')
      .addEdge('prepareAnalysisRetry', 'characterExtract')
      // abortPipeline → END
      .addEdge('abortPipeline', END)
      // shotDesign → codeVerify
      .addEdge('shotDesign', 'codeVerify')
      // codeVerify → conditional: end or deepVerify
      .addConditionalEdges('codeVerify', routeAfterCodeVerify, {
        end: END,
        deepVerify: 'deepVerify',
      })
      // deepVerify → conditional: end or retry
      .addConditionalEdges('deepVerify', routeAfterDeepVerify, {
        retry: 'prepareRetry',
        end: END,
      })
      // prepareRetry → shotDesign (loop back)
      .addEdge('prepareRetry', 'shotDesign')

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
    const totalPasses = 4
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
