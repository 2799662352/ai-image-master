import { createDeepAgent, type SubAgent } from 'deepagents'
import { MemorySaver } from '@langchain/langgraph'
import { z } from 'zod'
import { tool } from '@langchain/core/tools'
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
import { createViewImagesTool, type ImageInput } from './storyboard-image-tool'

const ORCHESTRATOR_PROMPT = `You are a professional storyboard analysis orchestrator.

You coordinate multiple specialized analysis subagents to produce a complete storyboard from reference images.

## Workflow (FOLLOW THIS ORDER STRICTLY)

1. **Plan**: Use write_todos to create the task list:
   - Analyze scene structure
   - Extract character identity anchors
   - Analyze character spatial properties
   - Analyze character narrative properties
   - Merge character data
   - Design shot sequence
   - Verify storyboard

2. **Scene Analysis**: task(subagent_type="scene-analyzer", description="Analyze scene structure from reference images")

3. **Character Identity**: task(subagent_type="char-identity", description="Extract character identities from reference images")

4. **Character Spatial + Narrative** (in sequence):
   - task(subagent_type="char-spatial", description="Analyze spatial properties. Read /shared/char-anchors.json for character list.")
   - task(subagent_type="char-narrative", description="Analyze narrative properties. Read /shared/char-anchors.json for character list.")

5. **Merge**: Call merge_characters tool with the JSON from read_file on /shared/char-anchors.json, /shared/char-spatial.json, /shared/char-narrative.json

6. **Shot Design**: task(subagent_type="shot-designer", description="Design shot sequence. Read /shared/scene.json and /shared/merged-chars.json.")

7. **Verify**: Call verify_storyboard with data from /shared/scene.json, /shared/merged-chars.json, /shared/shots.json

8. **Write final result** to /final-result.json

## Rules
- Each subagent writes results to /shared/ as JSON files
- Subagents that need images have a view_images tool — they call it to see the images
- Update todo status after each step
- If a subagent fails, retry ONCE with simplified instructions
- All analysis must be in English
`

export class StoryboardDeepAgentV3Pipeline extends BasePipeline<any, StoryboardResponse> {
  private _agent: any = null

  constructor(config: PipelineConfig) {
    super(config)
  }

  get pipelineSkills(): PipelineSkill[] {
    return getStoryboardSkills()
  }

  private createModel() {
    return this.createLLM()
  }

  private buildSubagents(images: ImageInput[]): SubAgent[] {
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
      },
    ]
  }

  private buildAgent(images: ImageInput[]) {
    const model = this.createModel()
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

    this._agent = createDeepAgent({
      name: 'storyboard-orchestrator',
      model,
      tools: [mergeCharsTool, verifyTool],
      subagents,
      systemPrompt: ORCHESTRATOR_PROMPT,
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

    const userMessage = [
      'Analyze the following images and generate a complete storyboard.',
      input.userContext ? `Additional context: ${input.userContext}` : '',
      `Total ${images.length} reference image(s). Subagents have a view_images tool to see them.`,
    ].filter(Boolean).join('\n')

    const threadId = crypto.randomUUID()
    const totalPasses = 8
    let currentPass = 0

    const emitProgress = (pass: number, label: string, status: 'running' | 'completed' = 'completed') => {
      currentPass = pass
      onProgress?.({ pass, totalPasses, label, status })
    }

    try {
      const stream = await agent.stream(
        {
          messages: [{ role: 'user', content: userMessage }],
        },
        {
          streamMode: 'updates',
          subgraphs: true,
          configurable: { thread_id: threadId },
          signal: options?.signal,
        },
      )

      let finalState: any = {}

      for await (const chunk of stream) {
        const [ns, data] = Array.isArray(chunk) ? chunk : [[], chunk]

        if (Array.isArray(ns) && ns.length > 0) {
          emitProgress(currentPass, `Subagent executing...`, 'running')
        }

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

            if (nodeName === 'tools' && (nodeData as any)?.messages) {
              for (const msg of (nodeData as any).messages || []) {
                if (msg?.name === 'write_todos') {
                  emitProgress(0, '规划完成')
                } else if (msg?.name === 'task') {
                  const content = typeof msg.content === 'string' ? msg.content : ''
                  if (content.includes('scene')) emitProgress(1, '场景分析完成')
                  else if (content.includes('identity') || content.includes('char-identity'))
                    emitProgress(2, '身份锚点完成')
                  else if (content.includes('spatial')) emitProgress(3, '空间/运动完成')
                  else if (content.includes('narrative')) emitProgress(4, '动作/叙事完成')
                  else if (content.includes('shot')) emitProgress(6, '镜头设计完成')
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
      throw err
    }
  }

  async resume(): Promise<StoryboardResponse> {
    throw new Error('V3 pipeline does not support resume — Deep Agent handles retries internally')
  }
}
