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
import { getStoryboardSkills } from './storyboard-prompt-loader'
import { mergeCharactersFromJSON, verifyStoryboardFromJSON } from './storyboard-tools'
import { createImageInjectionMiddleware, type ImageInput } from './storyboard-image-tool'

const ORCHESTRATOR_PROMPT = `You are a storyboard orchestrator. Coordinate subagents. Do NOT analyze images yourself.

RULES: Call max tools IN PARALLEL per turn. Be terse. 3 turns only. English output.

Turn 1 — call BOTH tasks IN PARALLEL:
  task(subagent_type="scene-analyzer", description="Analyze scene from reference images. Write JSON {d,cap,env,bgm} to /shared/scene.json.")
  task(subagent_type="char-identity", description="Extract characters from reference images. Write JSON {objs:[{n,f,t}]} to /shared/char-anchors.json.")

Turn 2 — call BOTH tasks IN PARALLEL, then merge:
  task(subagent_type="char-spatial", description="Read /shared/char-anchors.json, analyze spatial from images. Write {objs:[{n,s,p,a,m}]} to /shared/char-spatial.json.")
  task(subagent_type="char-narrative", description="Read /shared/char-anchors.json, analyze narrative from images. Write {objs:[{n,act,fx,motive,tc}]} to /shared/char-narrative.json.")
  Then read all 3 char files and call merge_characters(anchorsJSON=..., spatialJSON=..., narrativeJSON=...)

Turn 3 — shot design + verify:
  task(subagent_type="shot-designer", description="Read /shared/scene.json + /shared/merged-chars.json. Design 4-8 shots. Write {seq:[{id,desc,act,fx,motive,audio}],cont,notes} to /shared/shots.json.")
  Then read all 3 files and call verify_storyboard(sceneJSON=..., mergedCharsJSON=..., shotsJSON=...)

Subagents get images automatically — no extra tool call needed.
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
    const imgMw = () => {
      const mw = createImageInjectionMiddleware(images)
      return mw ? [mw] : []
    }

    return [
      {
        name: 'scene-analyzer',
        description: 'Analyzes scene structure from reference images: narrative arc (A→B→C), environment, atmosphere, lighting',
        systemPrompt: [
          'You are a professional film storyboard scene analyst.',
          'Reference images are provided in your task message — analyze them directly.',
          'Extract: d (narrative arc A→B→C), cap (structured caption), env (environment description), bgm (sound design).',
          'Write result as JSON to /shared/scene.json.',
          'Return a brief summary of your analysis.',
          'REFERENCE IMAGE FIDELITY: Describe ONLY what is visually present. DO NOT hallucinate.',
          'Write in English.',
        ].join('\n'),
        tools: [],
        middleware: imgMw(),
      },
      {
        name: 'char-identity',
        description: 'Extracts character identity anchors from images: name, visual appearance, cross-shot consistency features',
        systemPrompt: [
          'You are a professional character analyst for film storyboards.',
          'Reference images are provided in your task message — analyze them directly.',
          'For each character/object: n (name), f (visual appearance), t (cross-shot consistency anchor).',
          'Write result as JSON {objs: [{n,f,t}]} to /shared/char-anchors.json.',
          'Return summary: how many characters found and their names.',
          'Write in English.',
        ].join('\n'),
        tools: [],
        middleware: imgMw(),
      },
      {
        name: 'char-spatial',
        description: 'Analyzes character spatial positions, physical types, and motion intensity from images',
        systemPrompt: [
          'You are a spatial and motion analyst for film storyboards.',
          'Reference images are provided in your task message — analyze them directly.',
          'First read /shared/char-anchors.json to get the character list.',
          'For each character: n (exact name from anchors), s (spatial position), p (physical type), a (multi-granularity), m (motion intensity).',
          'CRITICAL: Use EXACT character names from char-anchors.json.',
          'Write result as JSON {objs: [{n,s,p,a,m}]} to /shared/char-spatial.json.',
          'Write in English.',
        ].join('\n'),
        tools: [],
        middleware: imgMw(),
      },
      {
        name: 'char-narrative',
        description: 'Analyzes character performance actions, visual effects, psychological motivation, and transition continuity',
        systemPrompt: [
          'You are a narrative and performance analyst for film storyboards.',
          'Reference images are provided in your task message — analyze them directly.',
          'First read /shared/char-anchors.json to get the character list.',
          'For each character: n (exact name from anchors), act (physical action), fx (visual effects or null), motive (psychological state), tc (transition continuity).',
          'CRITICAL: Use EXACT character names from char-anchors.json.',
          'Write result as JSON {objs: [{n,act,fx,motive,tc}]} to /shared/char-narrative.json.',
          'Write in English.',
        ].join('\n'),
        tools: [],
        middleware: imgMw(),
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
    const subagents = this.buildSubagents(images)

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

    const mergeCharsTool = tool(
      async ({ anchorsJSON, spatialJSON, narrativeJSON }) => {
        return mergeCharactersFromJSON(anchorsJSON, spatialJSON, narrativeJSON)
      },
      {
        name: 'merge_characters',
        description: 'Merge character identity + spatial + narrative JSON into unified 11-field character list. Call after reading the 3 character files.',
        schema: z.object({
          anchorsJSON: z.string().describe('Content of /shared/char-anchors.json'),
          spatialJSON: z.string().describe('Content of /shared/char-spatial.json'),
          narrativeJSON: z.string().describe('Content of /shared/char-narrative.json'),
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
      `Total ${images.length} reference image(s). Images are injected directly into each subagent's task message.`,
    ].filter(Boolean).join('\n')

    const threadId = crypto.randomUUID()
    const totalPasses = 8
    let currentPass = 0
    const completedPasses = new Set<number>()
    const passStartTimes = new Map<number, number>()
    const pipelineStart = Date.now()

    const truncate = (s: string, max = 300) => s.length > max ? s.slice(0, max) + '…' : s

    const emitProgress = (pass: number, label: string, status: PipelineProgress['status'] = 'completed', content?: string) => {
      if (status === 'running') {
        if (completedPasses.has(pass)) return
        if (!passStartTimes.has(pass)) passStartTimes.set(pass, Date.now())
        if (pass >= currentPass) currentPass = pass
        onProgress?.({ pass, totalPasses, label, status })
        return
      }

      if (status === 'completed' || status === 'failed') {
        completedPasses.add(pass)
        if (pass >= currentPass) currentPass = pass + 1
      }

      const startTime = passStartTimes.get(pass) ?? pipelineStart
      const elapsed = Date.now() - startTime

      const passData: import('../pipeline/types').PassCardData = {
        pass,
        passName: `pass-${pass}`,
        label,
        summary: content ? truncate(content) : label,
        appliedSkills: [],
        raw: content ?? null,
        elapsed,
      }

      onProgress?.({ pass, totalPasses, label, status, elapsed, passData })
    }

    emitProgress(0, '导演规划', 'running')

    try {
      console.log('[V4Pipeline] Calling agent.stream()...', { threadId, imageCount: images.length })
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
      console.log('[V4Pipeline] agent.stream() returned, starting iteration...')

      let finalState: any = {}
      let chunkCount = 0

      const SUBAGENT_PASS: Record<string, { pass: number; runLabel: string; doneLabel: string }> = {
        'scene-analyzer': { pass: 1, runLabel: '场景分析中...', doneLabel: '场景分析完成' },
        'char-identity': { pass: 2, runLabel: '身份锚点提取中...', doneLabel: '身份锚点完成' },
        'char-spatial': { pass: 3, runLabel: '空间/运动分析中...', doneLabel: '空间/运动完成' },
        'char-narrative': { pass: 4, runLabel: '动作/叙事分析中...', doneLabel: '动作/叙事完成' },
        'shot-designer': { pass: 6, runLabel: '镜头设计中...', doneLabel: '镜头设计完成' },
      }
      const toolCallToPass = new Map<string, { pass: number; runLabel: string; doneLabel: string }>()

      const resolveFromArgs = (args: any): { pass: number; runLabel: string; doneLabel: string } | null => {
        const name = (typeof args === 'object' && args !== null)
          ? (args.subagent_type || args.agent || args.name || '') : ''
        for (const [key, info] of Object.entries(SUBAGENT_PASS)) {
          if (name.includes(key)) return info
        }
        const str = typeof args === 'string' ? args : JSON.stringify(args || '')
        for (const [key, info] of Object.entries(SUBAGENT_PASS)) {
          if (str.includes(key)) return info
        }
        return null
      }

      for await (const chunk of stream) {
        chunkCount++
        if (chunkCount <= 5 || chunkCount % 10 === 0) {
          console.log(`[V4Pipeline] chunk #${chunkCount}`, Array.isArray(chunk) ? `ns=${JSON.stringify(chunk[0]).slice(0, 100)}` : 'no-ns')
        }
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
                const agentText = typeof msg?.content === 'string' ? msg.content : ''
                const toolCalls = msg?.tool_calls || msg?.additional_kwargs?.tool_calls || []
                const dispatches: string[] = []
                for (const tc of toolCalls) {
                  const fnName = tc?.function?.name || tc?.name || ''
                  if (fnName === 'task') {
                    const rawArgs = tc.args || tc?.function?.arguments || ''
                    const callId = tc.id || tc?.function?.id || ''
                    const agentName = (typeof rawArgs === 'object' && rawArgs !== null)
                      ? (rawArgs.subagent_type || rawArgs.agent || rawArgs.name || '') : ''
                    const desc = (typeof rawArgs === 'object' && rawArgs !== null)
                      ? (rawArgs.description || rawArgs.instruction || '') : ''
                    dispatches.push(desc || agentName || String(rawArgs).slice(0, 120))
                    console.log('[V4Pipeline] task dispatch:', agentName, 'callId:', callId)
                    const info = resolveFromArgs(rawArgs)
                    if (info) {
                      if (callId) toolCallToPass.set(callId, info)
                      emitProgress(info.pass, info.runLabel, 'running')
                    }
                  }
                }
                if (dispatches.length > 0 && !completedPasses.has(0)) {
                  const planSummary = [agentText, ...dispatches.map((d, i) => `${i + 1}. ${d}`)].filter(Boolean).join('\n')
                  emitProgress(0, '规划完成', 'completed', planSummary)
                }
              }
            }

            if (nodeName === 'tools' && (nodeData as any)?.messages) {
              for (const msg of (nodeData as any).messages || []) {
                if (msg?.name === 'write_todos') {
                  const todosContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
                  emitProgress(0, '规划完成', 'completed', todosContent)
                } else if (msg?.name === 'task') {
                  if (!completedPasses.has(0)) {
                    emitProgress(0, '规划完成', 'completed', '任务规划已完成，子代理开始执行')
                  }
                  const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
                  const callId = msg.tool_call_id || ''
                  const info = callId ? toolCallToPass.get(callId) ?? null : null
                  console.log('[V4Pipeline] task done:', info?.doneLabel ?? 'unknown', 'callId:', callId)
                  if (info) {
                    const hasError = content.toLowerCase().includes('error') || content.toLowerCase().includes('failed')
                    emitProgress(info.pass, hasError ? `${info.doneLabel} (有错误)` : info.doneLabel,
                      hasError ? 'failed' : 'completed', content)
                  }
                } else if (msg?.name === 'merge_characters') {
                  const mergeContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
                  emitProgress(5, '角色合并完成', 'completed', mergeContent)
                } else if (msg?.name === 'verify_storyboard') {
                  const verifyContent = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content || '')
                  emitProgress(7, '校验完成', 'completed', verifyContent)
                }
              }
            }
          }
        }
      }

      console.log(`[V4Pipeline] Stream finished. Total chunks: ${chunkCount}`, Object.keys(finalState.files || {}))
      return this.postProcess(this.assembleResult(finalState))
    } catch (err: unknown) {
      console.error('[V4Pipeline] Execute error:', err)
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
