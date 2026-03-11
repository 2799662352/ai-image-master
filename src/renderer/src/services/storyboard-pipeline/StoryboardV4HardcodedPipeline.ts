import { BasePipeline } from '../pipeline/BasePipeline'
import type {
  PipelineConfig,
  PipelineSkill,
  PipelineProgress,
  PipelineExecuteOptions,
} from '../pipeline/types'
import type { StoryboardResponse } from '../LangChainStoryboardService'
import { getStoryboardSkills } from './storyboard-prompt-loader'
import { mergeCharactersFromJSON, verifyStoryboardFromJSON } from './storyboard-tools'
import { HumanMessage, SystemMessage } from '@langchain/core/messages'

interface ImageInput {
  data: string
  mimeType: string
}

const PROMPTS = {
  scene: `You are a scene analyst for film storyboards.
Analyze the reference images and return JSON:
{d: "narrative arc A→B→C", cap: "structured caption", env: "environment", bgm: "sound design"}
Describe ONLY what is visually present. English only.`,

  identity: `You are a character identity analyst for film storyboards.
Analyze the reference images and return JSON:
{objs: [{n: "name", f: "visual appearance", t: "cross-shot anchor"}]}
One entry per distinct character/entity. English only.`,

  spatial: `You are a spatial/motion analyst for film storyboards.
You will receive a character list and reference images.
For each character, analyze: spatial position, physical type, multi-granularity action, motion intensity.
Return JSON: {objs: [{n: "exact name", s: "position", p: "physique", a: "action detail", m: "motion intensity"}]}
CRITICAL: Use EXACT character names from the provided list. English only.`,

  narrative: `You are a narrative/performance analyst for film storyboards.
You will receive a character list and reference images.
For each character, analyze: performance action, visual effects, psychological motive, transition continuity.
Return JSON: {objs: [{n: "exact name", act: "action", fx: "effects or null", motive: "psychology", tc: "transition"}]}
CRITICAL: Use EXACT character names from the provided list. English only.`,

  shots: `You are a film director designing a shot sequence.
You will receive scene data and merged character data.
Design 4-8 shots with continuity anchors.
Return JSON: {seq: [{id: "S1", desc: "...", act: "...", fx: "...", motive: "...", audio: "..."}], cont: "continuity notes", notes: "pacing summary"}
English only.`,
}

export class StoryboardV4HardcodedPipeline extends BasePipeline<any, StoryboardResponse> {
  constructor(config: PipelineConfig) {
    super(config)
  }

  get pipelineSkills(): PipelineSkill[] {
    return getStoryboardSkills()
  }

  buildGraph() {
    return null
  }

  private buildImageBlocks(images: ImageInput[]) {
    return BasePipeline.buildImageContent(images, 'high')
  }

  private enrichPrompt(passName: string, basePrompt: string): string {
    return this.buildSystemPrompt(passName, basePrompt, {})
  }

  private async callSubagent(
    passName: string,
    basePrompt: string,
    userContent: any[],
    signal?: AbortSignal,
  ): Promise<string> {
    const systemPrompt = this.enrichPrompt(passName, basePrompt)
    const llm = this.createLLM()
    const result = await llm.invoke(
      [new SystemMessage(systemPrompt), new HumanMessage({ content: userContent })],
      { signal },
    )
    return typeof result.content === 'string'
      ? result.content
      : JSON.stringify(result.content)
  }

  private extractJSON(text: string): any {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    if (fenced) {
      try { return JSON.parse(fenced[1].trim()) } catch { /* continue */ }
    }
    const candidates: string[] = []
    let depth = 0, start = -1
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '{') { if (depth === 0) start = i; depth++ }
      else if (text[i] === '}') { depth--; if (depth === 0 && start >= 0) { candidates.push(text.slice(start, i + 1)); start = -1 } }
    }
    candidates.sort((a, b) => b.length - a.length)
    for (const c of candidates) {
      try { return JSON.parse(c) } catch { /* next */ }
    }
    const arr = text.match(/\[[\s\S]*\]/)
    if (arr) { try { return JSON.parse(arr[0]) } catch { /* fall */ } }
    try { return JSON.parse(text) } catch { return {} }
  }

  async execute(
    input: { inputImages?: Array<{ data: string; mimeType: string }>; userContext?: string },
    onProgress?: (progress: PipelineProgress) => void,
    options?: PipelineExecuteOptions,
  ): Promise<StoryboardResponse> {
    const images: ImageInput[] = input.inputImages || []
    const imageBlocks = this.buildImageBlocks(images)
    const totalPasses = 8
    const signal = options?.signal

    const emit = (pass: number, label: string, status: 'running' | 'completed' = 'completed') => {
      onProgress?.({ pass, totalPasses, label, status })
    }

    const userTextParts = [
      {
        type: 'text' as const,
        text: `Analyze the following ${images.length} reference image(s).${input.userContext ? ' Context: ' + input.userContext : ''}`,
      },
    ]
    const imageUserContent = [...userTextParts, ...imageBlocks]

    emit(0, '导演规划', 'running')
    emit(0, '规划完成')

    emit(1, '场景分析中...', 'running')
    emit(2, '身份锚点提取中...', 'running')

    const [sceneResult, identityResult] = await Promise.allSettled([
      this.callSubagent('analyzeScene', PROMPTS.scene, imageUserContent, signal),
      this.callSubagent('extractCharacterAnchors', PROMPTS.identity, imageUserContent, signal),
    ])
    if (sceneResult.status === 'rejected') console.error('[V4] Scene analysis failed:', sceneResult.reason)
    if (identityResult.status === 'rejected') console.error('[V4] Identity extraction failed:', identityResult.reason)
    const sceneRaw = sceneResult.status === 'fulfilled' ? sceneResult.value : ''
    const identityRaw = identityResult.status === 'fulfilled' ? identityResult.value : ''

    const scene = this.extractJSON(sceneRaw)
    const chars = this.extractJSON(identityRaw)
    emit(1, '场景分析完成')
    emit(2, '身份锚点完成')

    emit(3, '空间/运动分析中...', 'running')
    emit(4, '动作/叙事分析中...', 'running')

    const charListText = {
      type: 'text' as const,
      text: `Character list from identity extraction:\n${JSON.stringify(chars, null, 2)}`,
    }
    const spatialNarrativeContent = [charListText, ...userTextParts, ...imageBlocks]

    const [spatialResult, narrativeResult] = await Promise.allSettled([
      this.callSubagent('charSpatial', PROMPTS.spatial, spatialNarrativeContent, signal),
      this.callSubagent('charNarrative', PROMPTS.narrative, spatialNarrativeContent, signal),
    ])
    if (spatialResult.status === 'rejected') console.error('[V4] Spatial analysis failed:', spatialResult.reason)
    if (narrativeResult.status === 'rejected') console.error('[V4] Narrative analysis failed:', narrativeResult.reason)
    const spatialRaw = spatialResult.status === 'fulfilled' ? spatialResult.value : ''
    const narrativeRaw = narrativeResult.status === 'fulfilled' ? narrativeResult.value : ''

    const spatial = this.extractJSON(spatialRaw)
    const narrative = this.extractJSON(narrativeRaw)
    emit(3, '空间/运动完成')
    emit(4, '动作/叙事完成')

    let merged: any = {}
    try {
      const mergedJSON = mergeCharactersFromJSON(
        JSON.stringify(chars),
        JSON.stringify(spatial),
        JSON.stringify(narrative),
      )
      merged = JSON.parse(mergedJSON)
    } catch {
      merged = { objs: chars.objs || [] }
    }
    emit(5, '角色合并完成')

    emit(6, '镜头设计中...', 'running')

    const shotContext = [
      {
        type: 'text' as const,
        text: `Scene data:\n${JSON.stringify(scene, null, 2)}\n\nCharacter data:\n${JSON.stringify(merged, null, 2)}`,
      },
    ]
    const shotsRaw = await this.callSubagent('designAndAssemble', PROMPTS.shots, shotContext, signal)
    const shots = this.extractJSON(shotsRaw)
    emit(6, '镜头设计完成')

    try {
      verifyStoryboardFromJSON(
        JSON.stringify(scene),
        JSON.stringify(merged),
        JSON.stringify(shots),
      )
    } catch {
      /* verification is best-effort */
    }
    emit(7, '校验完成')

    return this.postProcess(this.assembleResult({ scene, chars: merged, shots }))
  }

  assembleResult(state: { scene: any; chars: any; shots: any }): StoryboardResponse {
    const { scene = {}, chars = {}, shots = {} } = state
    return {
      scene: {
        d: scene.d || '',
        cap: scene.cap || '',
        env: scene.env || '',
        bgm: scene.bgm || '',
        timeline: [],
      },
      objs: (chars.objs || []).map((o: any) => ({
        n: o.n || '',
        f: o.f || '',
        t: o.t || '',
        s: o.s || '',
        p: o.p || '',
        a: o.a || '',
        m: o.m || '',
        act: o.act || '',
        fx: o.fx ?? null,
        motive: o.motive || '',
        tc: o.tc || '',
      })),
      seq: (shots.seq || []).map((s: any) => ({
        id: s.id || '',
        desc: s.desc || '',
        ...(s.act && { act: s.act }),
        ...(s.fx !== undefined && { fx: s.fx }),
        ...(s.motive && { motive: s.motive }),
        ...(s.audio && { audio: s.audio }),
      })),
      cont: shots.cont || '',
      notes: shots.notes || '',
    }
  }

  postProcess(result: StoryboardResponse): StoryboardResponse {
    return result
  }

  async resume(): Promise<StoryboardResponse> {
    throw new Error('V4 pipeline does not support resume')
  }
}
