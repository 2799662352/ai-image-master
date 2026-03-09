import { ChatOpenAI } from '@langchain/openai'
import { CallbackHandler } from 'langfuse-langchain'
import type { z } from 'zod'
import type { PipelineConfig, PipelineSkill, PipelineProgress } from './types'
import { SkillsMiddleware } from './SkillsMiddleware'

export abstract class BasePipeline<TState, TResult> {
  protected config: PipelineConfig
  protected skillsMiddleware: SkillsMiddleware
  protected langfuseHandler: CallbackHandler | null = null

  constructor(config: PipelineConfig) {
    this.config = config
    this.skillsMiddleware = new SkillsMiddleware([])
    this.initLangfuse()
  }

  private get sharedSkills(): PipelineSkill[] {
    return this.skillsMiddleware.skills
  }

  private initLangfuse(): void {
    try {
      if (import.meta.env.DEV) return
      const secretKey = import.meta.env.VITE_LANGFUSE_SECRET_KEY || import.meta.env.LANGFUSE_SECRET_KEY
      const publicKey = import.meta.env.VITE_LANGFUSE_PUBLIC_KEY || import.meta.env.LANGFUSE_PUBLIC_KEY
      const baseUrl = import.meta.env.VITE_LANGFUSE_BASE_URL || import.meta.env.LANGFUSE_BASE_URL
      if (secretKey && publicKey) {
        this.langfuseHandler = new CallbackHandler({
          secretKey,
          publicKey,
          baseUrl: baseUrl || 'https://cloud.langfuse.com',
          // Renderer-side Langfuse media hashing can fail when crypto.createHash is unavailable.
          // Mask embedded base64 media to keep tracing stable without noisy SDK errors.
          mask: ({ data }: { data: unknown }) => this.maskLangfuseMediaPayload(data),
        })
      }
    } catch {
      // Langfuse is optional — silently skip if unavailable
    }
  }

  private maskLangfuseMediaPayload(data: unknown, depth = 0): unknown {
    if (depth > 8) return '<max-depth>'
    if (typeof data === 'string') {
      if (data.startsWith('data:')) return '<media:data-uri>'
      return data.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/g, '<media:data-uri>')
    }
    if (Array.isArray(data)) {
      return data.map((item) => this.maskLangfuseMediaPayload(item, depth + 1))
    }
    if (data && typeof data === 'object') {
      const source = data as Record<string, unknown>
      const output: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(source)) {
        output[k] = this.maskLangfuseMediaPayload(v, depth + 1)
      }
      return output
    }
    return data
  }

  abstract get pipelineSkills(): PipelineSkill[]
  abstract buildGraph(): any
  abstract assembleResult(finalState: TState): TResult
  abstract postProcess(result: TResult): TResult

  registerSharedSkill(skill: PipelineSkill): void {
    this.skillsMiddleware = new SkillsMiddleware([...this.skillsMiddleware.skills, skill])
  }

  protected matchSkillsForPhase(phase: string, context: Record<string, unknown>): PipelineSkill[] {
    const activeSkills = (context as any)?.activeSkills as string[] | undefined

    const sharedMatched = this.sharedSkills
      .filter(s => s.appliesTo.includes(phase))
      .filter(s => !s.condition || s.condition(context))

    const pipelineMatched = this.pipelineSkills
      .filter(s => s.appliesTo.includes(phase))
      .filter(s => !activeSkills?.length || activeSkills.includes(s.id))
      .filter(s => !s.condition || s.condition(context))

    return [...sharedMatched, ...pipelineMatched]
      .sort((a, b) => a.priority - b.priority)
  }

  getSkillsForPhase(phase: string, context: Record<string, unknown>): string[] {
    return this.matchSkillsForPhase(phase, context).map(s => s.id)
  }

  protected getSkillRulesForPhase(phase: string, context: Record<string, unknown>): string {
    return this.matchSkillsForPhase(phase, context)
      .map(s => {
        if (s._bodyLoaded === false && s._rawBody) {
          s.rules = s._rawBody
          s._bodyLoaded = true
        }
        const rules = typeof s.rules === 'function' ? s.rules(context) : s.rules
        if (!rules) return ''
        return `[Skill:${s.id}]\n${rules}`
      })
      .filter(Boolean)
      .join('\n\n')
  }

  buildSystemPrompt(
    passName: string,
    basePrompt: string,
    context: Record<string, unknown>,
    options?: { skipSkillInjection?: boolean },
  ): string {
    if (options?.skipSkillInjection) return basePrompt
    const skills = this.getSkillRulesForPhase(passName, context)
    if (!skills) return basePrompt
    return `${basePrompt}\n\n--- 领域规则 ---\n${skills}`
  }

  buildSkillMenuPrompt(passName: string, basePrompt: string, context: Record<string, unknown>): string {
    const allSkills = this.matchSkillsForPhase(passName, context)
    const mw = new SkillsMiddleware(allSkills)
    return mw.wrapSystemPrompt(basePrompt, passName, context)
  }

  getSkillBodiesById(ids: string[], passName: string, context: Record<string, unknown>): string {
    const allSkills = this.matchSkillsForPhase(passName, context)
    const mw = new SkillsMiddleware(allSkills)
    return mw.loadSkills(ids, passName, context)
  }

  get skills(): SkillsMiddleware {
    const allSkills = [...this.skillsMiddleware.skills, ...this.pipelineSkills]
    return new SkillsMiddleware(allSkills)
  }

  protected isGeminiModel(model: string): boolean {
    return model.toLowerCase().includes('gemini')
  }

  private isOpenAIJsonSchemaCapable(model: string): boolean {
    const m = model.toLowerCase()
    return m.includes('gpt-4o') || m.includes('gpt-4.1') || m.includes('gpt-5') || m.includes('o3') || m.includes('o4')
  }

  /**
   * Resolve the optimal structured output method for the given model.
   *
   * Only two viable methods exist -- they are mutually exclusive per call:
   * - jsonSchema: Uses response_format constrained decoding. 100% schema compliance.
   *   Supported by Gemini (via OpenAI-compat proxy) and OpenAI gpt-4o+.
   * - functionCalling: Uses tool-calling API. ~99%+ compliance, widest portability.
   *   Default for models that don't support jsonSchema.
   */
  protected resolveStructuredOutputMethod(
    model: string,
    explicit?: 'functionCalling' | 'jsonSchema',
  ): 'functionCalling' | 'jsonSchema' | undefined {
    if (explicit) return explicit
    if (this.isGeminiModel(model)) return 'jsonSchema'
    if (this.isOpenAIJsonSchemaCapable(model)) return 'jsonSchema'
    return undefined
  }

  protected resolveMaxTokens(model: string, explicit?: number): number {
    if (explicit !== undefined) return explicit
    if (this.isGeminiModel(model)) return 65536
    return 4096
  }

  protected createLLM(model?: string, maxTokens?: number) {
    const m = model || this.config.model
    const resolved = this.resolveMaxTokens(m, maxTokens)
    const baseURL = this.config.baseURL.endsWith('/v1')
      ? this.config.baseURL
      : `${this.config.baseURL}/v1`
    const callbacks = this.langfuseHandler ? [this.langfuseHandler] : undefined
    return new ChatOpenAI({
      model: m,
      apiKey: this.config.apiKey,
      temperature: 0,
      maxRetries: 1,
      maxTokens: resolved,
      streamUsage: false,
      timeout: 120000,
      callbacks,
      configuration: {
        baseURL,
        timeout: 120000,
      },
    })
  }

  protected createStructuredLLM<T extends z.ZodType>(
    schema: T,
    model?: string,
    maxTokens?: number,
    methodOverride?: 'functionCalling' | 'jsonSchema',
  ) {
    const llm = this.createLLM(model, maxTokens)
    const m = model || this.config.model
    const method = this.resolveStructuredOutputMethod(m, methodOverride)
    if (method) {
      return llm.withStructuredOutput(schema, { method: method as any })
    }
    return llm.withStructuredOutput(schema)
  }

  protected createStructuredLLMWithRaw<T extends z.ZodType>(
    schema: T,
    model?: string,
    maxTokens?: number,
    methodOverride?: 'functionCalling' | 'jsonSchema',
  ) {
    const llm = this.createLLM(model, maxTokens)
    const m = model || this.config.model
    const method = this.resolveStructuredOutputMethod(m, methodOverride)
    const opts = method
      ? { method: method as any, includeRaw: true as const }
      : { includeRaw: true as const }
    return llm.withStructuredOutput(schema, opts)
  }

  /**
   * Invoke structured LLM with automatic method fallback.
   * Tries the preferred method first; if it fails with a method-related error
   * (e.g., endpoint doesn't support json_schema), retries with functionCalling.
   */
  protected async invokeStructuredWithFallback<T extends z.ZodType>(
    schema: T,
    messages: any[],
    opts?: {
      model?: string
      maxTokens?: number
      includeRaw?: boolean
      methodOverride?: 'functionCalling' | 'jsonSchema'
      signal?: AbortSignal
    },
  ): Promise<any> {
    const m = opts?.model || this.config.model
    const method = this.resolveStructuredOutputMethod(m, opts?.methodOverride)
    const llm = this.createLLM(opts?.model, opts?.maxTokens)

    const buildStructured = (meth: typeof method) => {
      const o = meth
        ? opts?.includeRaw
          ? { method: meth as any, includeRaw: true as const }
          : { method: meth as any }
        : opts?.includeRaw
          ? { includeRaw: true as const }
          : undefined
      return o ? llm.withStructuredOutput(schema, o) : llm.withStructuredOutput(schema)
    }

    try {
      return await buildStructured(method).invoke(messages, { signal: opts?.signal })
    } catch (err: any) {
      const msg = String(err?.message || err || '')
      const isMethodError = msg.includes('response_format') ||
        msg.includes('json_schema') ||
        msg.includes('structured_output') ||
        msg.includes('Unsupported') ||
        (msg.includes('400') && method === 'jsonSchema')

      if (isMethodError && method === 'jsonSchema') {
        console.warn(`[BasePipeline] jsonSchema failed for ${m}, falling back to functionCalling: ${msg.slice(0, 120)}`)
        return await buildStructured('functionCalling').invoke(messages, { signal: opts?.signal })
      }
      throw err
    }
  }

  static buildImageContent(
    images: Array<{ data: string; mimeType: string }>,
    detail: 'low' | 'high' | 'auto' = 'auto',
  ): Array<{ type: 'image_url'; image_url: { url: string; detail: string } }> {
    return images.map((img) => ({
      type: 'image_url' as const,
      image_url: {
        url: `data:${img.mimeType};base64,${img.data}`,
        detail,
      },
    }))
  }
}
