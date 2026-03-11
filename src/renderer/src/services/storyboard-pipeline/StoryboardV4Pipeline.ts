import { MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
import { getCreateDeepAgent } from '../../shims/deepagents-bridge'
import { BasePipeline } from '../pipeline/BasePipeline'
import type {
  PipelineConfig,
  PipelineSkill,
  PipelineProgress,
  PipelineExecuteOptions,
} from '../pipeline/types'
import type { StoryboardResponse } from '../LangChainStoryboardService'
import { getStoryboardSkills, buildSkillSeedFiles } from './storyboard-prompt-loader'
import { mergeCharactersFromJSON, verifyStoryboardFromJSON } from './storyboard-tools'
import { createViewImagesTool, type ImageInput } from './storyboard-image-tool'

const ORCHESTRATOR_PROMPT = `You are a professional storyboard analysis orchestrator.
You coordinate specialized subagents to produce a complete storyboard from reference images.

## SPEED RULES
- Do NOT call write_todos. The plan is fixed below.
- Call multiple tools IN PARALLEL within the same turn wherever indicated.
- Minimize your own text output between tool calls.

## Workflow — call multiple tools PER TURN

**Turn 1** — CALL BOTH IN PARALLEL (no dependencies between them):
  task(subagent_type="scene-analyzer", description="Analyze scene structure from reference images. Call view_images() first. Write JSON to /shared/scene.json.")
  task(subagent_type="char-identity", description="Extract character identities from reference images. Call view_images() first. Write JSON {objs:[{n,f,t}]} to /shared/char-anchors.json.")

**Turn 2** — CALL BOTH IN PARALLEL (both read char-anchors.json, independent of each other):
  task(subagent_type="char-spatial", description="Analyze spatial properties. Read /shared/char-anchors.json for character list, then call view_images(). Write JSON to /shared/char-spatial.json.")
  task(subagent_type="char-narrative", description="Analyze narrative properties. Read /shared/char-anchors.json for character list, then call view_images(). Write JSON to /shared/char-narrative.json.")

**Turn 3** — Read the 3 character files and call merge_characters:
  First read_file /shared/char-anchors.json, /shared/char-spatial.json, /shared/char-narrative.json
  Then call merge_characters(anchorsJSON=..., spatialJSON=..., narrativeJSON=...)

**Turn 4** — Shot design:
  task(subagent_type="shot-designer", description="Design shot sequence. Read /shared/scene.json and /shared/merged-chars.json. Write JSON to /shared/shots.json.")

**Turn 5** — Verify:
  Read /shared/scene.json, /shared/merged-chars.json, /shared/shots.json
  Call verify_storyboard(sceneJSON=..., mergedCharsJSON=..., shotsJSON=...)

## Rules
- Each subagent writes results to /shared/ as JSON files
- Subagents that need images have a view_images tool — they call it themselves
- If a subagent fails, retry ONCE with simplified instructions
- All analysis must be in English
`

export class StoryboardV4Pipeline extends BasePipeline<any, StoryboardResponse> {
  private _agent: any = null

  constructor(config: PipelineConfig) {
    super(config)
  }

  get pipelineSkills(): PipelineSkill[] {
    return getStoryboardSkills()
  }

  private buildSubagents(images: ImageInput[]): any[] {
    const viewTool = createViewImagesTool(images)

    return [
      {
        name: 'scene-analyzer',
        description: 'Analyzes scene structure from reference images: narrative arc (A→B→C), environment, atmosphere, lighting',
        systemPrompt: [
          'You are a professional film storyboard scene analyst.',
          'Call view_images() FIRST to see the reference images.',
          'Extract: d (narrative arc A→B→C), cap (structured caption), env (environment description), bgm (sound design).',
          'Write result as JSON to /shared/scene.json.',
          'Return a brief summary of your analysis.',
          'REFERENCE IMAGE FIDELITY: Describe ONLY what is visually present. DO NOT hallucinate.',
          'Write in English.',
        ].join('\n'),
        tools: [viewTool],
        skills: ['/skills/'],
      },
      {
        name: 'char-identity',
        description: 'Extracts character identity anchors from images: name, visual appearance, cross-shot consistency features',
        systemPrompt: [
          'You are a professional character analyst for film storyboards.',
          'Call view_images() FIRST to see the reference images.',
          'For each character/object: n (name), f (visual appearance), t (cross-shot consistency anchor).',
          'Write result as JSON {objs: [{n,f,t}]} to /shared/char-anchors.json.',
          'Return summary: how many characters found and their names.',
          'Write in English.',
        ].join('\n'),
        tools: [viewTool],
        skills: ['/skills/'],
      },
      {
        name: 'char-spatial',
        description: 'Analyzes character spatial positions, physical types, and motion intensity from images',
        systemPrompt: [
          'You are a spatial and motion analyst for film storyboards.',
          'First read /shared/char-anchors.json to get the character list.',
          'Then call view_images() to see the reference images.',
          'For each character: n (exact name from anchors), s (spatial position), p (physical type), a (multi-granularity), m (motion intensity).',
          'CRITICAL: Use EXACT character names from char-anchors.json.',
          'Write result as JSON {objs: [{n,s,p,a,m}]} to /shared/char-spatial.json.',
          'Write in English.',
        ].join('\n'),
        tools: [viewTool],
        skills: ['/skills/'],
      },
      {
        name: 'char-narrative',
        description: 'Analyzes character performance actions, visual effects, psychological motivation, and transition continuity',
        systemPrompt: [
          'You are a narrative and performance analyst for film storyboards.',
          'First read /shared/char-anchors.json to get the character list.',
          'Then call view_images() to see the reference images.',
          'For each character: n (exact name from anchors), act (physical action), fx (visual effects or null), motive (psychological state), tc (transition continuity).',
          'CRITICAL: Use EXACT character names from char-anchors.json.',
          'Write result as JSON {objs: [{n,act,fx,motive,tc}]} to /shared/char-narrative.json.',
          'Write in English.',
        ].join('\n'),
        tools: [viewTool],
        skills: ['/skills/'],
      },
      {
        name: 'shot-designer',
        description: 'Designs complete shot sequence based on scene and character data with continuity anchors',
        systemPrompt: [
          'You are a professional film director designing a shot sequence.',
          'Read /shared/scene.json and /shared/merged-chars.json.',
          'Design 4-8 shots. For each: id (S1..Sn), desc, act, fx, motive, audio.',
          'Also provide cont (cross-shot continuity anchors) and notes (pacing summary).',
          'Write result as JSON {seq: [{id,desc,act,fx,motive,audio}], cont, notes} to /shared/shots.json.',
          'Write in English.',
        ].join('\n'),
        tools: [],
        skills: ['/skills/'],
      },
    ]
  }

  private buildAgent(images: ImageInput[]) {
    const subagents = this.buildSubagents(images)

    const mergeCharsTool = tool(
      async ({ anchorsJSON, spatialJSON, narrativeJSON }) => {
        return mergeCharactersFromJSON(anchorsJSON, spatialJSON, narrativeJSON)
      },
      {
        name: 'merge_characters',
        description: 'Merge character identity + spatial + narrative JSON into unified 11-field character list. Call after char-identity, char-spatial, and char-narrative subagents complete.',
        schema: z.object({
          anchorsJSON: z.string().describe('Content of /shared/char-anchors.json'),
          spatialJSON: z.string().describe('Content of /shared/char-spatial.json'),
          narrativeJSON: z.string().describe('Content of /shared/char-narrative.json'),
        }),
      },
    )

    const verifyTool = tool(
      async ({ sceneJSON, mergedCharsJSON, shotsJSON }) => {
        return verifyStoryboardFromJSON(sceneJSON, mergedCharsJSON, shotsJSON)
      },
      {
        name: 'verify_storyboard',
        description: 'Verify storyboard data integrity. Returns score 0-10 and issues. Call after shot design.',
        schema: z.object({
          sceneJSON: z.string().describe('Content of /shared/scene.json'),
          mergedCharsJSON: z.string().describe('Content of /shared/merged-chars.json'),
          shotsJSON: z.string().describe('Content of /shared/shots.json'),
        }),
      },
    )

    const createDeepAgent = getCreateDeepAgent()
    this._agent = createDeepAgent({
      name: 'storyboard-v4-orchestrator',
      model: this.createLLM(),
      tools: [mergeCharsTool, verifyTool],
      subagents,
      systemPrompt: ORCHESTRATOR_PROMPT,
      skills: ['/skills/'],
      checkpointer: new MemorySaver(),
    })

    return this._agent
  }

  buildGraph() {
    this._agent = null
    return null
  }

  private resolveFileContent(fileEntry: any): string {
    if (!fileEntry) return '{}'
    if (typeof fileEntry === 'string') return fileEntry
    if (fileEntry.content) {
      if (Array.isArray(fileEntry.content)) return fileEntry.content.join('\n')
      if (typeof fileEntry.content === 'string') return fileEntry.content
    }
    return '{}'
  }

  assembleResult(state: any): StoryboardResponse {
    const files = state.files || {}
    const parseFile = (key: string) => {
      try { return JSON.parse(this.resolveFileContent(files[key])) }
      catch { return {} }
    }

    const scene = parseFile('/shared/scene.json')
    const chars = parseFile('/shared/merged-chars.json')
    const shots = parseFile('/shared/shots.json')

    return {
      scene: {
        d: scene.d || '', cap: scene.cap || '', env: scene.env || '',
        bgm: scene.bgm || '', timeline: [],
      },
      objs: (chars.objs || []).map((o: any) => ({
        n: o.n || '', f: o.f || '', t: o.t || '',
        s: o.s || '', p: o.p || '', a: o.a || '', m: o.m || '',
        act: o.act || '', fx: o.fx ?? null, motive: o.motive || '', tc: o.tc || '',
      })),
      seq: (shots.seq || []).map((s: any) => ({
        id: s.id || '', desc: s.desc || '',
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

  async execute(
    input: { inputImages?: Array<{ data: string; mimeType: string }>; userContext?: string },
    onProgress?: (progress: PipelineProgress) => void,
    options?: PipelineExecuteOptions,
  ): Promise<StoryboardResponse> {
    const images: ImageInput[] = input.inputImages || []
    const agent = this.buildAgent(images)
    const skillFiles = buildSkillSeedFiles()

    const userMessage = [
      'Analyze the following images and generate a complete storyboard.',
      input.userContext ? `Additional context: ${input.userContext}` : '',
      `Total ${images.length} reference image(s). Subagents have a view_images tool to see them.`,
    ].filter(Boolean).join('\n')

    const threadId = crypto.randomUUID()
    const totalPasses = 8
    let currentPass = 0
    const completedPasses = new Set<number>()

    const emitProgress = (pass: number, label: string, status: PipelineProgress['status'] = 'completed') => {
      if (status === 'completed') {
        completedPasses.add(pass)
        if (pass >= currentPass) currentPass = pass + 1
      } else if (status === 'running') {
        if (completedPasses.has(pass)) return
        if (pass >= currentPass) currentPass = pass
      }
      onProgress?.({ pass, totalPasses, label, status })
    }

    emitProgress(0, '导演规划', 'running')

    try {
      const stream = await agent.stream(
        {
          messages: [{ role: 'user', content: userMessage }],
          files: skillFiles,
        },
        {
          streamMode: 'updates',
          subgraphs: true,
          configurable: { thread_id: threadId },
          signal: options?.signal,
        },
      )

      let finalState: any = {}

      const SUBAGENT_PASS_MAP: Record<string, { pass: number; runLabel: string; doneLabel: string }> = {
        'scene-analyzer': { pass: 1, runLabel: '场景分析中...', doneLabel: '场景分析完成' },
        'scene': { pass: 1, runLabel: '场景分析中...', doneLabel: '场景分析完成' },
        'char-identity': { pass: 2, runLabel: '身份锚点提取中...', doneLabel: '身份锚点完成' },
        'identity': { pass: 2, runLabel: '身份锚点提取中...', doneLabel: '身份锚点完成' },
        'char-spatial': { pass: 3, runLabel: '空间/运动分析中...', doneLabel: '空间/运动完成' },
        'spatial': { pass: 3, runLabel: '空间/运动分析中...', doneLabel: '空间/运动完成' },
        'char-narrative': { pass: 4, runLabel: '动作/叙事分析中...', doneLabel: '动作/叙事完成' },
        'narrative': { pass: 4, runLabel: '动作/叙事分析中...', doneLabel: '动作/叙事完成' },
        'shot-designer': { pass: 6, runLabel: '镜头设计中...', doneLabel: '镜头设计完成' },
        'shot': { pass: 6, runLabel: '镜头设计中...', doneLabel: '镜头设计完成' },
      }

      const resolveSubagentPass = (text: string): { pass: number; runLabel: string; doneLabel: string } | null => {
        for (const [key, info] of Object.entries(SUBAGENT_PASS_MAP)) {
          if (text.includes(key)) return info
        }
        return null
      }

      for await (const chunk of stream) {
        const [ns, data] = Array.isArray(chunk) ? chunk : [[], chunk]

        if (data && typeof data === 'object') {
          for (const [nodeName, nodeData] of Object.entries(data as Record<string, any>)) {
            if (nodeData && typeof nodeData === 'object') {
              if (nodeData.files && finalState.files) {
                finalState = {
                  ...finalState,
                  ...nodeData,
                  files: { ...finalState.files, ...nodeData.files },
                }
              } else {
                finalState = { ...finalState, ...nodeData }
              }
            }

            if (nodeName === 'agent' && (nodeData as any)?.messages) {
              for (const msg of (nodeData as any).messages) {
                const toolCalls = msg?.tool_calls || msg?.additional_kwargs?.tool_calls || []
                for (const tc of toolCalls) {
                  const fnName = tc?.function?.name || tc?.name || ''
                  if (fnName === 'task') {
                    if (!completedPasses.has(0)) emitProgress(0, '规划完成')
                    const args = typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args || tc?.function?.arguments || '')
                    const info = resolveSubagentPass(args)
                    if (info) emitProgress(info.pass, info.runLabel, 'running')
                  }
                }
              }
            }

            if (nodeName === 'tools' && (nodeData as any)?.messages) {
              for (const msg of (nodeData as any).messages || []) {
                if (msg?.name === 'write_todos') {
                  emitProgress(0, '规划完成')
                } else if (msg?.name === 'task') {
                  if (!completedPasses.has(0)) emitProgress(0, '规划完成')
                  const content = typeof msg.content === 'string' ? msg.content : ''
                  const info = resolveSubagentPass(content)
                  if (info) {
                    emitProgress(info.pass, info.doneLabel)
                  }
                  if (content.toLowerCase().includes('error') || content.toLowerCase().includes('failed')) {
                    const failInfo = resolveSubagentPass(content)
                    if (failInfo) {
                      emitProgress(failInfo.pass, `${failInfo.doneLabel} (有错误)`, 'failed')
                    }
                  }
                } else if (msg?.name === 'merge_characters') {
                  emitProgress(5, '角色合并完成')
                } else if (msg?.name === 'verify_storyboard') {
                  emitProgress(7, '校验完成')
                }
              }
            }
          }
        }
      }

      return this.postProcess(this.assembleResult(finalState))
    } catch (err: unknown) {
      if (err instanceof DOMException && err.name === 'AbortError') {
        return this.postProcess(this.assembleResult({}))
      }
      onProgress?.({ pass: currentPass, totalPasses, label: '管线执行失败', status: 'failed' })
      throw err
    }
  }

  async resume(): Promise<StoryboardResponse> {
    throw new Error('V4 Deep Agents pipeline does not support resume — orchestrator handles retries internally')
  }
}
