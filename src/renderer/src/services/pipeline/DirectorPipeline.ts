import { StateGraph, START, END } from '@langchain/langgraph'
import { z } from 'zod'
import { BasePipeline } from './BasePipeline'
import { sharedSkills } from './director-skills'
import { getPromptTemplate, renderTemplate, getDirectorSkillsFromConfig } from './prompt-loader'
import {
  SceneAnalysisSchema,
  CharacterAnchorSchema,
  DesignAndAssembleSchema,
  VerifySchema,
  SkillSelectionSchema,
} from './schemas/director-schemas'
import type {
  PipelineConfig,
  PipelineSkill,
  PipelineProgress,
  DirectorResult,
  AssembledPrompt,
  PassCardData,
} from './types'

const MAX_RETRIES = 1
const SCORE_THRESHOLD = 6

const stateSchema = z.object({
  scene: SceneAnalysisSchema.nullable().default(null),
  characters: CharacterAnchorSchema.nullable().default(null),
  panels: z.array(z.object({
    id: z.number(),
    shot: z.string(),
    desc: z.string(),
    lighting: z.string().default(''),
    characterAction: z.string().default(''),
    background: z.string().default(''),
  })).nullable().default(null),
  prompts: z.array(z.object({
    id: z.number(),
    prompt: z.string(),
    negativePrompt: z.string(),
  })).nullable().default(null),
  report: VerifySchema.nullable().default(null),
  images: z.array(z.object({
    id: z.number(),
    url: z.string(),
    prompt: z.string(),
    error: z.string().optional(),
  })).nullable().default(null),
  retryCount: z.number().default(0),
  retryFeedback: z.string().default(''),
  inputImages: z.array(z.object({
    data: z.string(),
    mimeType: z.string(),
  })).default([]),
  sceneDescription: z.string().default(''),
  layout: z.object({
    rows: z.number(),
    cols: z.number(),
    panelCount: z.number(),
  }).default({ rows: 2, cols: 3, panelCount: 6 }),
  template: z.string().default('default'),
  styleInstructions: z.string().default(''),
  ratio: z.string().default('3:2'),
  resolution: z.string().default('2K'),
  currentImageCount: z.number().default(1),
  skipVerify: z.boolean().default(false),
  activeSkills: z.array(z.string()).default([]),
})

export type DirectorState = z.infer<typeof stateSchema>

// ==================== Template Variable Extractors ====================

function extractVarsForDesignAndAssemble(state: DirectorState): Record<string, string> {
  let retryBlock = ''
  if (state.retryFeedback) {
    retryBlock = `\n\n--- Verification Feedback (incremental fix) ---\n${state.retryFeedback}\n\nIMPORTANT: Only modify panels mentioned in feedback. Keep all others unchanged.`
  }

  let previousPromptsRef = ''
  if (state.retryFeedback && state.prompts?.length) {
    previousPromptsRef = `\n\n--- Previous Prompts (reference only) ---\n${state.prompts.map(p => `[Panel ${p.id}] ${p.prompt}`).join('\n')}`
  }

  return {
    scene_env: state.scene?.env || '(none)',
    scene_description: state.sceneDescription || '',
    character_anchors_detail: state.characters?.characters?.map((c: any) =>
      `${c.name}: ${c.anchor}`
    ).join('\n') || '(none)',
    panel_count: String(state.layout.panelCount),
    grid_spec: `${state.layout.rows}x${state.layout.cols}`,
    style_instructions: state.styleInstructions || '(none)',
    retry_block: retryBlock,
    previous_prompts_ref: previousPromptsRef,
  }
}

function extractVarsForVerify(state: DirectorState): Record<string, string> {
  return {
    scene_env: state.scene?.env || '',
    character_anchors_summary: state.characters?.characters?.map((c: any) =>
      `${c.name}: ${c.anchor}`
    ).join('; ') || '',
    panels_summary_short: state.panels?.map((p: any) =>
      `${p.id}: ${p.shot} - ${p.desc}`
    ).join('; ') || '',
  }
}

function extractVarsForContactSheet(state: DirectorState): Record<string, string> {
  const prompts = state.prompts || []
  const characters = state.characters?.characters || []

  const globalSection = [
    `GLOBAL SCENE: ${state.scene?.env || '(unknown)'}`,
    characters.length > 0 ? 'CHARACTER DEFINITIONS:' : '',
    ...characters.map((c: any, i: number) => `  [char${i + 1}]: ${c.anchor}`),
  ].filter(Boolean).join('\n')

  const perShotSection = prompts
    .map(p => `  Panel ${p.id}: [shot cut] ${p.prompt}`)
    .join('\n')

  return {
    grid_rows: String(state.layout.rows),
    grid_cols: String(state.layout.cols),
    panel_count: String(state.layout.panelCount),
    global_section: globalSection,
    character_anchor_line: characters.map((c: any) => c.anchor).join('. '),
    style_instructions: state.styleInstructions || '',
    panel_descriptions: `${globalSection}\n\nSTORYBOARD GRID ${state.layout.rows}x${state.layout.cols}:\n${perShotSection}`,
  }
}

// ==================== Skill Menu ====================

function buildSkillMenu(skills: PipelineSkill[]): string {
  return skills
    .filter(s => s.description)
    .map(s => `- ${s.id}: ${s.description}`)
    .join('\n')
}

// ==================== Pipeline ====================

export class DirectorPipeline extends BasePipeline<DirectorState, DirectorResult> {
  private _graph: { stream: (input: unknown, config: unknown) => AsyncIterable<unknown> } | null = null

  constructor(config: PipelineConfig) {
    super(config)
    for (const skill of sharedSkills) {
      this.registerSharedSkill(skill)
    }
  }

  get pipelineSkills(): PipelineSkill[] {
    return getDirectorSkillsFromConfig()
  }

  private static formatSummary(nodeName: string, output: any): string {
    switch (nodeName) {
      case 'selectSkills': {
        const s = output?.selected
        return s ? `已选择 ${s.length} 个 skills` : '(fallback: all)'
      }
      case 'analyzeScene': {
        const s = output?.scene
        if (!s) return '(empty)'
        return `场景：${s.env || '?'}。主体 ${Array.isArray(s.subjects) ? s.subjects.length : 0} 个。`
      }
      case 'extractCharacterAnchors': {
        const c = output?.characters
        if (!c?.characters?.length) return '(empty)'
        return `角色 ${c.characters.length} 个`
      }
      case 'designAndAssemble': {
        const panels = output?.panels
        const prompts = output?.prompts
        if (!panels?.length) return '(empty)'
        return `${panels.length} 个分镜 + ${prompts?.length || 0} 条提示词`
      }
      case 'verifyConsistency': {
        const r = output?.report
        if (!r) return '(empty)'
        return `评分 ${r.score}/10，${r.issues?.length || 0} 个问题`
      }
      case 'generateImages': {
        const imgs = output?.images
        if (!imgs?.length) return '(empty)'
        const ok = imgs.filter((i: any) => i.url && !i.error).length
        return `生成 ${imgs.length} 张，成功 ${ok} 张`
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
  ): PassCardData {
    return {
      pass: passInfo.pass,
      passName: nodeName,
      label: passInfo.label,
      summary: DirectorPipeline.formatSummary(nodeName, output),
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
    const tpl = getPromptTemplate(passName)
    const basePrompt = tpl
      ? renderTemplate(tpl.template, vars)
      : inlineFallback
    return this.buildSystemPrompt(passName, basePrompt, context)
  }

  buildGraph() {
    const self = this

    const writer = (config: any) => config?.writer

    function emitError(config: any, pass: number, label: string, nodeName: string, message: string, elapsed: number) {
      console.error(`[DirectorPipeline] Pass ${pass} (${nodeName}) failed: ${message}`)
      writer(config)?.({
        type: 'pass_complete', pass,
        label: `${label}失败: ${message.slice(0, 80)}`,
        elapsed,
        passData: DirectorPipeline.buildPassCardData(nodeName, { pass, label }, { error: message }, elapsed),
      })
    }

    // ===== Pass 1: 场景分析 (parallel with Pass 2) =====
    const analyzeSceneFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const structured = self.createStructuredLLM(SceneAnalysisSchema)
        const systemPrompt = self.resolveSystemPrompt(
          'analyzeScene', {},
          state as Record<string, unknown>,
          'You are an expert scene analyst. Analyze the provided images and describe the scene in structured detail.',
        )
        const result = await structured.invoke([
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              { type: 'text' as const, text: state.sceneDescription || '分析这张图片的场景' },
            ],
          },
        ])
        const scene = result ?? { env: '(unknown)', subjects: [], style: '', story: '' }
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('analyzeScene', { pass: 1, label: '场景分析' }, { scene }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 1, label: `场景分析完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { scene }
      } catch (err: unknown) {
        emitError(config, 1, '场景分析', 'analyzeScene', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { scene: null }
      }
    }

    // ===== Pass 2: 角色锚点提取 (parallel with Pass 1) =====
    const extractCharacterAnchorsFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const structured = self.createStructuredLLM(CharacterAnchorSchema)
        const systemPrompt = self.resolveSystemPrompt(
          'extractCharacterAnchors', {},
          state as Record<string, unknown>,
          'You are a character consistency expert. Extract character anchors from the provided images for image generation consistency.',
        )
        const result = await structured.invoke([
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              { type: 'text' as const, text: '提取所有角色的一致性锚点描述' },
            ],
          },
        ])
        const characters = result ?? { characters: [] }
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('extractCharacterAnchors', { pass: 2, label: '角色锚点提取' }, { characters }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 2, label: `角色锚点提取完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { characters }
      } catch (err: unknown) {
        emitError(config, 2, '角色锚点', 'extractCharacterAnchors', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { characters: null }
      }
    }

    // ===== Pass 0: 技能选择 (parallel with Pass 1+2) =====
    const selectSkillsFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const allSkills = self.pipelineSkills
        if (allSkills.length === 0) return { activeSkills: [] as string[] }

        const structured = self.createStructuredLLM(SkillSelectionSchema)
        const vars = {
          scene_description: state.sceneDescription || '(none)',
          style_instructions: state.styleInstructions || '(none)',
          template: state.template || 'default',
          has_images: state.inputImages.length > 0 ? 'yes' : 'no',
          skill_menu: buildSkillMenu(allSkills),
        }
        const systemPrompt = self.resolveSystemPrompt(
          'selectSkills', vars, {},
          `You are a skill selector. Select relevant skills based on user input.\n\nAvailable:\n${vars.skill_menu}`,
        )
        // Skill selection is pure text classification — no images needed.
        // Sending images caused 43-44s latency; text-only reduces this to ~2-3s.
        const userContent: Array<any> = [{
          type: 'text' as const,
          text: `Scene: ${vars.scene_description}\nStyle: ${vars.style_instructions}\nTemplate: ${vars.template}\nHas reference images: ${vars.has_images}`,
        }]
        const result = await structured.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ])

        const elapsed = Date.now() - t0
        const validIds = new Set(allSkills.map(s => s.id))
        const selected = result.selectedSkills.filter(id => validIds.has(id))
        if (selected.length !== result.selectedSkills.length) {
          console.warn(`[DirectorPipeline] selectSkills: filtered ${result.selectedSkills.length - selected.length} invalid skill IDs`)
        }
        console.log(`[DirectorPipeline] selectSkills: ${selected.length}/${allSkills.length} skills selected in ${elapsed}ms: [${selected.join(', ')}]`)
        writer(config)?.({
          type: 'pass_complete', pass: 0,
          label: `技能选择完成 (${selected.length} skills, ${(elapsed / 1000).toFixed(1)}s)`,
          elapsed,
          passData: DirectorPipeline.buildPassCardData('selectSkills', { pass: 0, label: '技能选择' }, { selected, reasoning: result.reasoning }, elapsed),
        })
        return { activeSkills: selected }
      } catch (err: unknown) {
        console.warn('[DirectorPipeline] selectSkills failed, using all skills as fallback:', err instanceof Error ? err.message : String(err))
        return { activeSkills: self.pipelineSkills.map(s => s.id) }
      }
    }

    // ===== Pass 3: 分镜设计 + 提示词组装 (merged, saves one LLM round-trip) =====
    const designAndAssembleFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const structured = self.createStructuredLLM(DesignAndAssembleSchema)
        const vars = extractVarsForDesignAndAssemble(state)
        const userDirective = state.sceneDescription
          ? `User's creative direction: "${state.sceneDescription}"\nYou MUST incorporate this direction into the panel designs. The panels should depict what the user described.`
          : ''
        const systemPrompt = self.resolveSystemPrompt(
          'designAndAssemble', vars,
          { ...state, retryFeedback: state.retryFeedback } as Record<string, unknown>,
          `You are a professional storyboard artist and prompt engineer. Design shots and write prompts for ${vars.panel_count} panels.\nScene: ${vars.scene_env}${userDirective ? `\n\n${userDirective}` : ''}`,
        )
        const userText = state.sceneDescription
          ? `根据用户意图"${state.sceneDescription}"，为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词`
          : `为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词`
        const designContent: Array<any> = []
        if (state.inputImages.length > 0) {
          designContent.push(...BasePipeline.buildImageContent(state.inputImages, 'low'))
        }
        designContent.push({ type: 'text' as const, text: userText })
        const raw = await structured.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: designContent },
        ])
        if (!raw?.panels?.length) {
          throw new Error('LLM returned empty or malformed response (no panels)')
        }

        const panels = (raw.panels || []).map((p: any) => ({
          id: p.id, shot: p.shot, desc: p.desc,
          lighting: p.lighting || '', characterAction: p.characterAction || '', background: p.background || '',
        }))
        const prompts: AssembledPrompt[] = (raw.panels || []).map((p: any) => ({
          id: p.id,
          prompt: p.prompt,
          negativePrompt: p.negativePrompt || 'blurry, deformed, bad anatomy, watermark, signature, text',
        }))

        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('designAndAssemble', { pass: 3, label: '分镜设计+提示词' }, { panels, prompts }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: 3, label: `分镜+提示词完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { panels, prompts }
      } catch (err: unknown) {
        emitError(config, 3, '分镜+提示词', 'designAndAssemble', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { panels: null, prompts: null }
      }
    }

    // ===== Pass 4: 一致性校验 (skippable) =====
    const verifyConsistencyFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const structured = self.createStructuredLLM(VerifySchema)
        const vars = extractVarsForVerify(state)
        const systemPrompt = self.resolveSystemPrompt(
          'verifyConsistency', vars,
          state as Record<string, unknown>,
          `You are a continuity supervisor. Check panels for consistency.\nScene: ${vars.scene_env}`,
        )
        const userContent: Array<any> = []
        if (state.inputImages.length > 0) {
          userContent.push(...BasePipeline.buildImageContent(state.inputImages, 'low'))
        }
        userContent.push({
          type: 'text' as const,
          text: `检查以下分镜的角色一致性、镜头连续性和叙事流畅度，给出评分和问题列表。\n\n分镜详情:\n${vars.panels_summary_short}`,
        })
        const raw = await structured.invoke([
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent },
        ])
        const result = raw ?? { score: 7, ok: true, issues: [] }
        if (typeof result.score !== 'number') result.score = 7
        if (typeof result.ok !== 'boolean') result.ok = result.score >= 6
        if (!Array.isArray(result.issues)) result.issues = []
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('verifyConsistency', { pass: 4, label: '一致性校验' }, { report: result }, elapsed)
        writer(config)?.({
          type: 'pass_complete', pass: 4,
          label: `一致性校验完成 (score: ${result.score}, ${(elapsed / 1000).toFixed(1)}s)`,
          elapsed, passData,
        })
        return { report: result }
      } catch (err: unknown) {
        emitError(config, 4, '一致性校验', 'verifyConsistency', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { report: null }
      }
    }

    // ===== Retry准备 =====
    const prepareRetryFn = (state: DirectorState) => {
      const feedback = state.report?.issues?.join('\n') || ''
      return {
        retryFeedback: feedback,
        retryCount: state.retryCount + 1,
        prompts: null,
        panels: null,
        report: null,
      }
    }

    // ===== Pass 5: Contact Sheet 图像生成 =====
    const generateImagesFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      const passNum = state.skipVerify ? 4 : 5
      try {
        const { getApiService } = await import('../api/ApiService')
        const apiService = getApiService()
        const prompts = state.prompts || []

        writer(config)?.({ type: 'image_generating', index: 0, total: 1, prompt: 'Generating contact sheet...' })

        const vars = extractVarsForContactSheet(state)
        const tpl = getPromptTemplate('generateImages')
        const compositePrompt = tpl
          ? renderTemplate(tpl.template, vars)
          : [
              `Cinematic Contact Sheet, ONE single master image, ${vars.grid_rows}x${vars.grid_cols} storyboard grid with ${vars.panel_count} panels.`,
              'Symmetrical grid, hard borders, clean white dividing lines.',
              vars.character_anchor_line,
              vars.style_instructions,
              `Panel descriptions:\n${vars.panel_descriptions}`,
            ].filter(Boolean).join(' ')

        const negativePrompt = prompts[0]?.negativePrompt ||
          'blurry, deformed, bad anatomy, watermark, signature, text, irregular panels, asymmetric grid'

        const imageCount = state.currentImageCount || 1
        const results: Array<{ id: number; url: string; prompt: string; error?: string }> = []

        for (let i = 0; i < imageCount; i++) {
          const result = await apiService.generateImage({
            prompt: compositePrompt,
            negativePrompt,
            ratio: state.ratio,
            resolution: state.resolution,
            referenceImages: state.inputImages.map(img =>
              `data:${img.mimeType};base64,${img.data}`
            ),
          })

          const url = result.success
            ? (result.images?.[0] || result.urls?.[0] || '')
            : ''

          results.push({
            id: i + 1, url, prompt: compositePrompt,
            error: result.success ? undefined : result.error,
          })

          writer(config)?.({ type: 'image_generated', index: i, total: imageCount, url })
        }

        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('generateImages', { pass: passNum, label: '图像生成' }, { images: results }, elapsed)
        writer(config)?.({ type: 'pass_complete', pass: passNum, label: `图像生成完成 (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
        return { images: results }
      } catch (err: unknown) {
        emitError(config, passNum, '图像生成', 'generateImages', err instanceof Error ? err.message : String(err), Date.now() - t0)
        return { images: [] }
      }
    }

    // ===== Routing =====
    const routeAfterDesign = (state: DirectorState): 'verify' | 'generate' => {
      if (state.skipVerify) return 'generate'
      return 'verify'
    }

    const routeVerify = (state: DirectorState): 'retry' | 'generate' => {
      if (!state.report || state.retryCount >= MAX_RETRIES) return 'generate'
      if (state.report.score < SCORE_THRESHOLD) return 'retry'
      return 'generate'
    }

    // ===== Graph Assembly =====
    const graph = new StateGraph(stateSchema)
      .addNode('selectSkills', selectSkillsFn)
      .addNode('analyzeScene', analyzeSceneFn)
      .addNode('extractCharacterAnchors', extractCharacterAnchorsFn)
      .addNode('designAndAssemble', designAndAssembleFn)
      .addNode('verifyConsistency', verifyConsistencyFn)
      .addNode('prepareRetry', prepareRetryFn)
      .addNode('generateImages', generateImagesFn)
      .addEdge(START, 'selectSkills')
      .addEdge(START, 'analyzeScene')
      .addEdge(START, 'extractCharacterAnchors')
      .addEdge('selectSkills', 'designAndAssemble')
      .addEdge('analyzeScene', 'designAndAssemble')
      .addEdge('extractCharacterAnchors', 'designAndAssemble')
      .addConditionalEdges('designAndAssemble', routeAfterDesign, {
        verify: 'verifyConsistency',
        generate: 'generateImages',
      })
      .addConditionalEdges('verifyConsistency', routeVerify, {
        retry: 'prepareRetry',
        generate: 'generateImages',
      })
      .addEdge('prepareRetry', 'designAndAssemble')
      .addEdge('generateImages', END)

    this._graph = graph.compile()
    return graph
  }

  assembleResult(state: DirectorState): DirectorResult {
    return {
      scene: state.scene,
      characters: state.characters,
      panels: state.panels ? { panels: state.panels } : null,
      prompts: state.prompts || [],
      report: state.report,
      images: state.images || [],
    }
  }

  postProcess(result: DirectorResult): DirectorResult {
    return result
  }

  async execute(
    input: Partial<DirectorState>,
    onProgress?: (progress: PipelineProgress) => void
  ): Promise<DirectorResult> {
    if (!this._graph) this.buildGraph()
    const skipVerify = (input as Partial<DirectorState>).skipVerify ?? false
    const totalPasses = skipVerify ? 4 : 5
    let finalState: DirectorState = { ...input } as DirectorState

    const config: any = {
      streamMode: ['updates', 'custom'],
    }

    const pipelineStart = Date.now()

    const stream = await this._graph.stream(input, config)
    for await (const event of stream) {
      if (Array.isArray(event)) {
        const [mode, data] = event
        if (mode === 'custom' && data?.type === 'pass_complete') {
          onProgress?.({
            pass: data.pass,
            totalPasses,
            label: data.label,
            status: 'completed',
            elapsed: data.elapsed,
            passData: data.passData,
          })
        } else if (mode === 'custom') {
          onProgress?.({
            pass: data?.pass || 0,
            totalPasses,
            label: data?.label || '',
            status: 'running',
            data,
          })
        } else if (mode === 'updates') {
          const entries = Object.entries(data)
          if (entries.length > 0) {
            const [, output] = entries[0] as [string, any]
            finalState = { ...finalState, ...output }
          }
        }
      }
    }

    const totalElapsed = Date.now() - pipelineStart
    console.log(`[DirectorPipeline] 管线完成 (${totalPasses} passes)，总耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
    return this.postProcess(this.assembleResult(finalState))
  }
}
