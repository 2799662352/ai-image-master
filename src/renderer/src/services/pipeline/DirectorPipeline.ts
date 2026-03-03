import { StateGraph, START, END } from '@langchain/langgraph'
import { z } from 'zod'
import { BasePipeline } from './BasePipeline'
import { sharedSkills } from './director-skills'
import { getPromptTemplate, renderTemplate, getDirectorSkillsFromConfig, initDirectorSkills } from './prompt-loader'
import {
  SceneAnalysisSchema,
  CharacterAnchorSchema,
  DesignAndAssembleSchema,
  SimplePanelSchema,
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
const MAX_ANALYSIS_RETRIES = 2

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
  analysisRetryCount: z.number().default(0),
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
  semanticOrientation: z.enum(['landscape', 'portrait']).default('landscape'),
  currentImageCount: z.number().default(1),
  skipVerify: z.boolean().default(false),
  scoreThreshold: z.number().min(0).max(10).default(SCORE_THRESHOLD),
  activeSkills: z.array(z.string()).default([]),
})

export type DirectorState = z.infer<typeof stateSchema>

// ==================== Template Variable Extractors ====================

function normalizePanels(input: unknown): Array<Record<string, unknown>> | null {
  if (Array.isArray(input)) return input as Array<Record<string, unknown>>
  if (input && typeof input === 'object' && Array.isArray((input as any).panels)) {
    return (input as any).panels as Array<Record<string, unknown>>
  }
  return null
}

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
  const panelItems = normalizePanels((state as any).panels)
  const characterAnchors = state.characters?.characters?.map((c: any) =>
    `- ${c.name}: ${c.anchor}`
  ).join('\n') || '(none)'

  const panelDetails = panelItems?.map((p: any, i: number) => {
    const prompt = state.prompts?.[i]?.prompt || ''
    return `Panel ${p.id} [${p.shot}]: ${p.desc}${p.lighting ? ` | Light: ${p.lighting}` : ''}${prompt ? `\n  Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '...' : ''}` : ''}`
  }).join('\n') || '(none)'

  return {
    scene_env: state.scene?.env || '(unknown)',
    character_anchors_summary: characterAnchors,
    panels_summary_short: panelDetails,
  }
}

function getPanelOrientation(ratio: string, rows: number, cols: number): { orientation: string; panelRatio: string } {
  const parts = ratio.split(':').map(Number)
  if (parts.length !== 2 || parts.some(isNaN)) return { orientation: 'square', panelRatio: '1:1' }
  const [rw, rh] = parts
  const pw = rw / cols
  const ph = rh / rows
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b))
  const g = gcd(Math.round(pw * 100), Math.round(ph * 100))
  const panelRatio = `${Math.round(pw * 100 / g)}:${Math.round(ph * 100 / g)}`
  const aspect = pw / ph
  const orientation = aspect > 1.05 ? 'landscape (horizontal)' : aspect < 0.95 ? 'portrait (vertical)' : 'square'
  return { orientation, panelRatio }
}

export function getSemanticOrientationInstruction(semanticOrientation?: string): string {
  if (semanticOrientation === 'portrait') {
    return 'SEMANTIC ORIENTATION PRIORITY: all panels must use portrait (vertical) composition and framing.'
  }
  if (semanticOrientation === 'landscape') {
    return 'SEMANTIC ORIENTATION PRIORITY: all panels must use landscape (horizontal) composition and framing.'
  }
  return 'SEMANTIC ORIENTATION PRIORITY: preserve horizontal composition unless user intent explicitly requests vertical framing.'
}

export function shouldRetryAnalysis(state: { scene: { env?: string } | null; characters: { characters?: unknown[] } | null; analysisRetryCount: number }): 'retry' | 'continue' | 'abort' {
  const sceneOk = state.scene && state.scene.env && state.scene.env !== '(analysis failed)'
  const charsOk = state.characters && Array.isArray(state.characters.characters)
  if (sceneOk || charsOk) return 'continue'
  if (state.analysisRetryCount >= MAX_ANALYSIS_RETRIES) return 'abort'
  return 'retry'
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

  const { orientation, panelRatio } = getPanelOrientation(
    state.ratio, state.layout.rows, state.layout.cols,
  )

  const userDirection = state.sceneDescription
    ? `\n\nUSER'S CREATIVE DIRECTION (highest priority): "${state.sceneDescription}"`
    : ''

  return {
    grid_rows: String(state.layout.rows),
    grid_cols: String(state.layout.cols),
    panel_count: String(state.layout.panelCount),
    overall_ratio: state.ratio,
    panel_ratio: panelRatio,
    panel_orientation: orientation,
    semantic_orientation_instruction: getSemanticOrientationInstruction(state.semanticOrientation),
    user_direction: userDirection,
    global_section: globalSection,
    character_anchor_line: characters.map((c: any) => c.anchor).join('. '),
    style_instructions: state.styleInstructions || '',
    panel_descriptions: `${globalSection}${userDirection}\n\nSTORYBOARD GRID ${state.layout.rows}x${state.layout.cols}:\n${perShotSection}`,
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
  private _graph: any = null

  constructor(config: PipelineConfig) {
    super(config)
    for (const skill of sharedSkills) {
      this.registerSharedSkill(skill)
    }
  }

  get pipelineSkills(): PipelineSkill[] {
    return getDirectorSkillsFromConfig()
  }

  private async runWithConcurrency<T>(
    count: number,
    concurrency: number,
    task: (index: number) => Promise<T>,
  ): Promise<T[]> {
    const total = Math.max(0, Math.floor(count))
    if (total === 0) return []

    const workerCount = Math.max(1, Math.min(Math.floor(concurrency) || 1, total))
    const results: T[] = new Array(total)
    let cursor = 0

    const worker = async () => {
      while (true) {
        const index = cursor
        cursor += 1
        if (index >= total) break
        results[index] = await task(index)
      }
    }

    await Promise.allSettled(Array.from({ length: workerCount }, () => worker()))
    return results
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
    appliedSkills: string[] = [],
  ): PassCardData {
    return {
      pass: passInfo.pass,
      passName: nodeName,
      label: passInfo.label,
      summary: DirectorPipeline.formatSummary(nodeName, output),
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
        const appliedSkills = self.getSkillsForPhase('analyzeScene', state as Record<string, unknown>)
        const structuredWithRaw = self.createStructuredLLMWithRaw(SceneAnalysisSchema)
        const systemPrompt = self.resolveSystemPrompt(
          'analyzeScene', {},
          state as Record<string, unknown>,
          'You are an expert scene analyst. Analyze the provided images and describe the scene in structured detail.',
        )
        const response = await structuredWithRaw.invoke([
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              { type: 'text' as const, text: state.sceneDescription
                ? `【用户创意方向】${state.sceneDescription}\n\n请基于用户的创意方向分析参考图片。用户描述的场景意图优先于图片中的细节。`
                : '分析这张图片的场景' },
            ],
          },
        ])

        let scene = (response as any)?.parsed
        if (!scene?.env) {
          const rawText = typeof (response as any)?.raw?.content === 'string'
            ? (response as any).raw.content : ''
          try {
            const match = rawText.match(/\{[\s\S]*"env"\s*:[\s\S]*\}/)
            if (match) scene = JSON.parse(match[0])
          } catch { /* fallback below */ }
        }
        if (!scene?.env) {
          scene = { env: '(analysis failed)', subjects: [], style: '', story: '' }
          console.warn('[DirectorPipeline] analyzeScene: structured + raw extraction both failed')
        }

        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('analyzeScene', { pass: 1, label: '场景分析' }, { scene }, elapsed, appliedSkills)
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
        const appliedSkills = self.getSkillsForPhase('extractCharacterAnchors', state as Record<string, unknown>)
        const structuredWithRaw = self.createStructuredLLMWithRaw(CharacterAnchorSchema)
        const systemPrompt = self.resolveSystemPrompt(
          'extractCharacterAnchors', {},
          state as Record<string, unknown>,
          'You are a character consistency expert. Extract character anchors from the provided images for image generation consistency.',
        )
        const response = await structuredWithRaw.invoke([
          { role: 'system', content: systemPrompt },
          {
            role: 'user',
            content: [
              ...BasePipeline.buildImageContent(state.inputImages, 'high'),
              { type: 'text' as const, text: '提取所有角色的一致性锚点描述' },
            ],
          },
        ])

        let characters = (response as any)?.parsed
        if (!characters?.characters?.length) {
          const rawText = typeof (response as any)?.raw?.content === 'string'
            ? (response as any).raw.content : ''
          try {
            const match = rawText.match(/\{[\s\S]*"characters"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
            if (match) {
              const parsed = JSON.parse(match[0])
              if (parsed?.characters?.length) characters = parsed
            }
          } catch { /* fallback below */ }
        }
        if (!characters?.characters?.length) {
          characters = { characters: [] }
          console.warn('[DirectorPipeline] extractCharacterAnchors: structured + raw extraction both failed')
        }

        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('extractCharacterAnchors', { pass: 2, label: '角色锚点提取' }, { characters }, elapsed, appliedSkills)
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
        const appliedSkills = self.getSkillsForPhase('selectSkills', state as Record<string, unknown>)
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
          'selectSkills', vars, state as Record<string, unknown>,
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
          passData: DirectorPipeline.buildPassCardData('selectSkills', { pass: 0, label: '技能选择' }, { selected, reasoning: result.reasoning }, elapsed, selected),
        })
        return { activeSkills: selected }
      } catch (err: unknown) {
        console.warn('[DirectorPipeline] selectSkills failed, using all skills as fallback:', err instanceof Error ? err.message : String(err))
        return { activeSkills: self.pipelineSkills.map(s => s.id) }
      }
    }

    // ===== Pass 3: 分镜设计 + 提示词组装 =====
    // 3-level error recovery (LangChain best practice):
    //   L1: includeRaw + regex extraction (0 extra LLM calls)
    //   L2: SimplePanelSchema fallback (+1 LLM call, simpler schema = higher success)
    //   L3: error feedback to LLM (+1 LLM call, LLM self-corrects)
    const designAndAssembleFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      const skillContext = { ...state, retryFeedback: state.retryFeedback } as Record<string, unknown>
      const appliedSkills = self.getSkillsForPhase('designAndAssemble', skillContext)
      const vars = extractVarsForDesignAndAssemble(state)
      const userDirective = state.sceneDescription
        ? [
            `## HIGHEST PRIORITY — User's Creative Direction (MUST FOLLOW)`,
            `"${state.sceneDescription}"`,
            `This is the user's explicit creative intent. Every panel MUST directly serve this direction.`,
            `If any AI-analyzed detail conflicts with the user's direction, the user's direction ALWAYS wins.`,
          ].join('\n')
        : ''
      const systemPrompt = self.resolveSystemPrompt(
        'designAndAssemble', vars,
        skillContext,
        `You are a professional storyboard artist and prompt engineer. Design shots and write prompts for ${vars.panel_count} panels.\nScene: ${vars.scene_env}${userDirective ? `\n\n${userDirective}` : ''}`,
      )
      const userText = state.sceneDescription
        ? `【最高优先级指令】用户明确要求："${state.sceneDescription}"\n\n请严格按照用户意图，为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词。每个分镜都必须服务于用户描述的场景和叙事。`
        : `为 ${state.layout.panelCount} 个分镜设计镜头并生成图像提示词`
      const designContent: Array<any> = []
      if (state.inputImages.length > 0) {
        designContent.push(...BasePipeline.buildImageContent(state.inputImages, 'low'))
      }
      designContent.push({ type: 'text' as const, text: userText })

      const messages = [
        { role: 'system' as const, content: systemPrompt },
        { role: 'user' as const, content: designContent },
      ]

      const makePanelsAndPrompts = (rawPanels: any[]) => {
        const panels = rawPanels.map((p: any) => ({
          id: p.id, shot: p.shot || '', desc: p.desc || '',
          lighting: p.lighting || '', characterAction: p.characterAction || '', background: p.background || '',
        }))
        const prompts: AssembledPrompt[] = rawPanels.map((p: any) => ({
          id: p.id,
          prompt: p.prompt || '',
          negativePrompt: p.negativePrompt || 'blurry, deformed, bad anatomy, watermark, signature, text',
        }))
        return { panels, prompts }
      }

      const emitSuccess = (panels: any[], prompts: any[], level: string) => {
        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('designAndAssemble', { pass: 3, label: '分镜设计+提示词' }, { panels, prompts }, elapsed, appliedSkills)
        writer(config)?.({ type: 'pass_complete', pass: 3, label: `分镜+提示词完成 [${level}] (${(elapsed / 1000).toFixed(1)}s)`, elapsed, passData })
      }

      // --- Level 1: Full schema with includeRaw + regex fallback ---
      try {
        const structuredWithRaw = self.createStructuredLLMWithRaw(DesignAndAssembleSchema)
        const response = await structuredWithRaw.invoke(messages)

        let parsedPanels = (response as any)?.parsed?.panels
        if (!parsedPanels?.length) {
          const rawText = typeof (response as any)?.raw?.content === 'string'
            ? (response as any).raw.content
            : JSON.stringify((response as any)?.raw?.content ?? '')
          try {
            const jsonMatch = rawText.match(/\{[\s\S]*"panels"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
            if (jsonMatch) {
              const fallback = JSON.parse(jsonMatch[0])
              if (fallback?.panels?.length) parsedPanels = fallback.panels
            }
          } catch { /* regex extraction failed */ }
        }

        if (parsedPanels?.length) {
          const { panels, prompts } = makePanelsAndPrompts(parsedPanels)
          emitSuccess(panels, prompts, 'L1')
          return { panels, prompts }
        }
        console.warn('[DirectorPipeline] L1 failed: full schema + raw extraction both empty')
      } catch (e: unknown) {
        console.warn('[DirectorPipeline] L1 error:', e instanceof Error ? e.message : String(e))
      }

      // --- Level 2: Simplified schema (just id + prompt) ---
      let lastError = ''
      writer(config)?.({ type: 'pass_complete', pass: 3, label: '分镜格式降级重试...', elapsed: Date.now() - t0, passData: null })
      try {
        const simpleStructured = self.createStructuredLLM(SimplePanelSchema)
        const simpleResult = await simpleStructured.invoke(messages)
        if (simpleResult?.panels?.length) {
          const { panels, prompts } = makePanelsAndPrompts(simpleResult.panels)
          console.log(`[DirectorPipeline] L2 success: ${panels.length} panels via SimplePanelSchema`)
          emitSuccess(panels, prompts, 'L2-simple')
          return { panels, prompts }
        }
        lastError = 'SimplePanelSchema returned empty panels array'
        console.warn('[DirectorPipeline] L2 failed:', lastError)
      } catch (e: unknown) {
        lastError = e instanceof Error ? e.message : String(e)
        console.warn('[DirectorPipeline] L2 error:', lastError)
      }

      // --- Level 3: Error feedback to LLM (LLM-recoverable pattern) ---
      // Pass the actual error so LLM knows exactly what went wrong
      writer(config)?.({ type: 'pass_complete', pass: 3, label: '分镜 LLM 自修正重试...', elapsed: Date.now() - t0, passData: null })
      try {
        const llm = self.createLLM()
        const feedbackResult = await llm.invoke([
          ...messages,
          { role: 'assistant' as const, content: `I attempted to generate panel data but the output failed validation. Error: ${lastError}` },
          { role: 'user' as const, content: `Your previous response failed with error: "${lastError}"\n\nPlease fix this and respond with ONLY a valid JSON object (no markdown, no code fences), exactly like:\n{"panels":[{"id":1,"prompt":"detailed english image prompt here"},{"id":2,"prompt":"..."}]}\n\nYou must generate exactly ${state.layout.panelCount} panels. Each panel needs an "id" (number) and a "prompt" (detailed English image generation prompt string).` },
        ])
        const text = typeof feedbackResult.content === 'string' ? feedbackResult.content : ''
        const jsonMatch = text.match(/\{[\s\S]*"panels"\s*:\s*\[[\s\S]*\][\s\S]*\}/)
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0])
          if (parsed?.panels?.length) {
            const { panels, prompts } = makePanelsAndPrompts(parsed.panels)
            console.log(`[DirectorPipeline] L3 success: ${panels.length} panels via error feedback`)
            emitSuccess(panels, prompts, 'L3-feedback')
            return { panels, prompts }
          }
        }
      } catch (e: unknown) {
        console.warn('[DirectorPipeline] L3 error:', e instanceof Error ? e.message : String(e))
      }

      // --- All levels failed ---
      emitError(config, 3, '分镜+提示词', 'designAndAssemble', 'All 3 recovery levels failed', Date.now() - t0)
      return { panels: null, prompts: null }
    }

    // ===== Pass 4: 一致性校验 (skippable) =====
    const verifyConsistencyFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      try {
        const appliedSkills = self.getSkillsForPhase('verifyConsistency', state as Record<string, unknown>)
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
          text: `Verify the following storyboard for consistency. Check all 4 dimensions (character, lighting, narrative, spatial) and score 0-10.\n\nScene: ${vars.scene_env}\n\nCharacter Anchors:\n${vars.character_anchors_summary}\n\nPanels:\n${vars.panels_summary_short}`,
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
        const passData = DirectorPipeline.buildPassCardData('verifyConsistency', { pass: 4, label: '一致性校验' }, { report: result }, elapsed, appliedSkills)
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

    // ===== Analysis Gate: 空数据拦截 =====
    const validateAnalysisFn = (state: DirectorState) => {
      console.log(`[DirectorPipeline] validateAnalysis: scene=${!!state.scene?.env}, chars=${!!state.characters?.characters?.length}, retries=${state.analysisRetryCount}`)
      return {}
    }

    const prepareAnalysisRetryFn = (state: DirectorState, config: any) => {
      const count = state.analysisRetryCount + 1
      console.warn(`[DirectorPipeline] Analysis data empty, retrying (${count}/${MAX_ANALYSIS_RETRIES})...`)
      writer(config)?.({
        type: 'pass_complete', pass: 1,
        label: `场景/角色数据为空，重试中 (${count}/${MAX_ANALYSIS_RETRIES})...`,
        elapsed: 0, passData: null,
      })
      return { analysisRetryCount: count, scene: null, characters: null }
    }

    const abortPipelineFn = (_state: DirectorState, config: any) => {
      const msg = '场景分析和角色锚点均失败（可能是网络问题），管线终止。请检查网络后重试。'
      console.error(`[DirectorPipeline] ${msg}`)
      writer(config)?.({
        type: 'pass_complete', pass: 1,
        label: msg, elapsed: 0, passData: null,
      })
      return { images: [] }
    }

    const routeAfterAnalysis = (state: DirectorState): 'continue' | 'retry' | 'abort' => {
      return shouldRetryAnalysis(state)
    }

    // ===== Pass 5: Contact Sheet 图像生成 =====
    const generateImagesFn = async (state: DirectorState, config: any) => {
      const t0 = Date.now()
      const passNum = state.skipVerify ? 4 : 5
      const appliedSkills = self.getSkillsForPhase('generateImages', state as Record<string, unknown>)
      try {
        const { getApiService } = await import('../api/ApiService')
        const apiService = getApiService()
        const prompts = state.prompts || []
        const imageCount = state.currentImageCount || 1

        writer(config)?.({
          type: 'image_generating',
          pass: passNum,
          label: '图像生成中...',
          index: 0,
          total: imageCount,
          prompt: 'Generating contact sheet...',
        })

        const vars = extractVarsForContactSheet(state)
        const tpl = getPromptTemplate('generateImages')
        const compositePrompt = tpl
          ? renderTemplate(tpl.template, vars)
          : [
              `Cinematic Contact Sheet, ONE single master image, ${vars.grid_rows} rows x ${vars.grid_cols} columns storyboard grid, ${vars.panel_count} panels total.`,
              `STRICT GRID: every panel EXACTLY ${vars.panel_ratio} (${vars.panel_orientation}), edge-to-edge, thin 1-2px dark dividers only.`,
              vars.semantic_orientation_instruction,
              'NO text, NO labels, NO captions, NO annotations, NO panel numbers.',
              vars.character_anchor_line,
              vars.style_instructions,
              `Panel descriptions:\n${vars.panel_descriptions}`,
            ].filter(Boolean).join(' ')

        const negativePrompt = prompts[0]?.negativePrompt ||
          'blurry, deformed, bad anatomy, watermark, signature, text, labels, captions, panel numbers, irregular panels, asymmetric grid, unequal panels'
        const referenceImages = state.inputImages.map(img => `data:${img.mimeType};base64,${img.data}`)
        const userConcurrency = Math.max(1, imageCount)
        const results = await self.runWithConcurrency(
          imageCount,
          userConcurrency,
          async (i) => {
            try {
              const result = await apiService.generateImage({
                prompt: compositePrompt,
                negativePrompt,
                ratio: state.ratio,
                resolution: state.resolution,
                referenceImages,
              })

              const url = result.success
                ? (result.images?.[0] || result.urls?.[0] || '')
                : ''

              const one = {
                id: i + 1,
                url,
                prompt: compositePrompt,
                error: result.success ? undefined : result.error,
              }

              writer(config)?.({
                type: 'image_generated',
                pass: passNum,
                label: '图像生成中...',
                index: i,
                total: imageCount,
                url,
                prompt: compositePrompt,
              })

              return one
            } catch (error: unknown) {
              const one = {
                id: i + 1,
                url: '',
                prompt: compositePrompt,
                error: error instanceof Error ? error.message : String(error),
              }

              writer(config)?.({
                type: 'image_generated',
                pass: passNum,
                label: '图像生成中...',
                index: i,
                total: imageCount,
                url: '',
                prompt: compositePrompt,
              })

              return one
            }
          },
        )

        const elapsed = Date.now() - t0
        const passData = DirectorPipeline.buildPassCardData('generateImages', { pass: passNum, label: '图像生成' }, { images: results }, elapsed, appliedSkills)
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
      const threshold = Number.isFinite(state.scoreThreshold)
        ? Math.max(0, Math.min(10, Math.round(state.scoreThreshold)))
        : SCORE_THRESHOLD
      if (state.report.score < threshold) return 'retry'
      return 'generate'
    }

    // ===== Graph Assembly =====
    const retryLLM = { maxAttempts: 2, initialInterval: 1.0 }
    const graph = new StateGraph(stateSchema)
      .addNode('selectSkills', selectSkillsFn)
      .addNode('analyzeScene', analyzeSceneFn, { retryPolicy: retryLLM })
      .addNode('extractCharacterAnchors', extractCharacterAnchorsFn, { retryPolicy: retryLLM })
      .addNode('validateAnalysis', validateAnalysisFn)
      .addNode('prepareAnalysisRetry', prepareAnalysisRetryFn)
      .addNode('abortPipeline', abortPipelineFn)
      .addNode('designAndAssemble', designAndAssembleFn)
      .addNode('verifyConsistency', verifyConsistencyFn)
      .addNode('prepareRetry', prepareRetryFn)
      .addNode('generateImages', generateImagesFn)
      .addEdge(START, 'selectSkills')
      .addEdge('selectSkills', 'analyzeScene')
      .addEdge('selectSkills', 'extractCharacterAnchors')
      .addEdge(['analyzeScene', 'extractCharacterAnchors'], 'validateAnalysis')
      .addConditionalEdges('validateAnalysis', routeAfterAnalysis, {
        continue: 'designAndAssemble',
        retry: 'prepareAnalysisRetry',
        abort: 'abortPipeline',
      })
      .addEdge('prepareAnalysisRetry', 'analyzeScene')
      .addEdge('prepareAnalysisRetry', 'extractCharacterAnchors')
      .addEdge('abortPipeline', END)
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
    const panelItems = normalizePanels((state as any).panels)

    const panels = panelItems
      ? {
          panels: panelItems.map((panel: any, index: number) => ({
            ...panel,
            prompt: state.prompts?.[index]?.prompt || '',
            negativePrompt: state.prompts?.[index]?.negativePrompt || '',
          })),
        }
      : null

    return {
      scene: state.scene,
      characters: state.characters,
      panels,
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
    await initDirectorSkills()
    if (!this._graph) this.buildGraph()
    const skipVerify = (input as Partial<DirectorState>).skipVerify ?? false
    const totalPasses = skipVerify ? 4 : 5
    let finalState: DirectorState = { ...input } as DirectorState

    const config: any = {
      streamMode: ['updates', 'custom'],
    }

    const pipelineStart = Date.now()
    let currentPass = 0
    const terminalPass = totalPasses
    let shouldExitAfterTerminalPass = false

    const compiledGraph = this._graph
    if (!compiledGraph) {
      throw new Error('Director graph is not initialized')
    }

    const stream = await compiledGraph.stream(input, config)
    for await (const event of stream) {
      if (Array.isArray(event)) {
        const [mode, data] = event
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
          if (typeof data.pass === 'number' && data.pass >= terminalPass) {
            shouldExitAfterTerminalPass = true
            const terminalImages = data?.passData?.raw?.images
            if (Array.isArray(terminalImages)) {
              finalState = { ...finalState, images: terminalImages }
              break
            }
          }
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
          const entries = Object.entries(updatesData)
          if (entries.length > 0) {
            const [, output] = entries[0] as [string, any]
            finalState = { ...finalState, ...output }
          }
          const hasGenerateImagesOutput = Object.prototype.hasOwnProperty.call(updatesData, 'generateImages')
          if (hasGenerateImagesOutput) {
            const generateImagesOutput = (updatesData as any).generateImages
            if (generateImagesOutput && typeof generateImagesOutput === 'object') {
              finalState = { ...finalState, ...generateImagesOutput }
            }
            break
          }
          if (shouldExitAfterTerminalPass) {
            break
          }
        }
      }
    }

    const totalElapsed = Date.now() - pipelineStart
    console.log(`[DirectorPipeline] 管线完成 (${totalPasses} passes)，总耗时 ${(totalElapsed / 1000).toFixed(1)}s`)
    return this.postProcess(this.assembleResult(finalState))
  }

  /**
   * 仅重新生成图片（跳过 pass 0-4，复用之前的分镜/角色/场景数据）
   */
  async regenerateImages(
    previousState: Partial<DirectorState>,
    imageCount: number,
    onProgress?: (progress: PipelineProgress) => void
  ): Promise<DirectorResult> {
    await initDirectorSkills()

    const { getApiService } = await import('../api/ApiService')
    const apiService = getApiService()

    const state = { ...previousState, currentImageCount: imageCount } as DirectorState
    const prompts = state.prompts || []
    const passNum = state.skipVerify ? 4 : 5
    const appliedSkills = this.getSkillsForPhase('generateImages', state as Record<string, unknown>)

    const t0 = Date.now()

    onProgress?.({
      pass: passNum,
      totalPasses: passNum + 1,
      label: `重新生成图片中 (0/${imageCount})...`,
      status: 'running',
    })

    const vars = extractVarsForContactSheet(state)
    const tpl = getPromptTemplate('generateImages')
    const compositePrompt = tpl
      ? renderTemplate(tpl.template, vars)
      : [
          `Cinematic Contact Sheet, ONE single master image, ${vars.grid_rows} rows x ${vars.grid_cols} columns storyboard grid, ${vars.panel_count} panels total.`,
          `STRICT GRID: every panel EXACTLY ${vars.panel_ratio} (${vars.panel_orientation}), edge-to-edge, thin 1-2px dark dividers only.`,
          vars.semantic_orientation_instruction,
          'NO text, NO labels, NO captions, NO annotations, NO panel numbers.',
          vars.character_anchor_line,
          vars.style_instructions,
          `Panel descriptions:\n${vars.panel_descriptions}`,
        ].filter(Boolean).join(' ')

    const negativePrompt = prompts[0]?.negativePrompt ||
      'blurry, deformed, bad anatomy, watermark, signature, text, labels, captions, panel numbers, irregular panels, asymmetric grid, unequal panels'
    const referenceImages = state.inputImages.map(img => `data:${img.mimeType};base64,${img.data}`)

    const results = await this.runWithConcurrency(
      imageCount,
      Math.max(1, imageCount),
      async (i) => {
        try {
          const result = await apiService.generateImage({
            prompt: compositePrompt,
            negativePrompt,
            ratio: state.ratio,
            resolution: state.resolution,
            referenceImages,
          })
          const url = result.success
            ? (result.images?.[0] || result.urls?.[0] || '')
            : ''

          onProgress?.({
            pass: passNum,
            totalPasses: passNum + 1,
            label: `重新生成图片中 (${i + 1}/${imageCount})...`,
            status: 'running',
            data: { type: 'image_generated', index: i, total: imageCount, url, prompt: compositePrompt },
          })

          return { id: i + 1, url, prompt: compositePrompt, error: result.success ? undefined : result.error }
        } catch (error) {
          return { id: i + 1, url: '', prompt: compositePrompt, error: error instanceof Error ? error.message : String(error) }
        }
      },
    )

    const elapsed = Date.now() - t0
    const passData = DirectorPipeline.buildPassCardData('generateImages', { pass: passNum, label: '重新生成图片' }, { images: results }, elapsed, appliedSkills)
    onProgress?.({
      pass: passNum,
      totalPasses: passNum + 1,
      label: `重新生成完成 (${(elapsed / 1000).toFixed(1)}s)`,
      status: 'completed',
      elapsed,
      passData,
    })

    const finalState = { ...state, images: results }
    console.log(`[DirectorPipeline] 重新生成图片完成，${imageCount} 张，耗时 ${(elapsed / 1000).toFixed(1)}s`)
    return this.postProcess(this.assembleResult(finalState))
  }
}
