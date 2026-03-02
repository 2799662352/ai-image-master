import { ChatOpenAI } from '@langchain/openai'
import { CallbackHandler } from 'langfuse-langchain'
import type { z } from 'zod'
import type { PipelineConfig, PipelineSkill, PipelineProgress } from './types'

export abstract class BasePipeline<TState, TResult> {
  protected config: PipelineConfig
  private sharedSkills: PipelineSkill[] = []
  protected langfuseHandler: CallbackHandler | null = null

  constructor(config: PipelineConfig) {
    this.config = config
    this.initLangfuse()
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
        })
      }
    } catch {
      // Langfuse is optional — silently skip if unavailable
    }
  }

  abstract get pipelineSkills(): PipelineSkill[]
  abstract buildGraph(): any
  abstract assembleResult(finalState: TState): TResult
  abstract postProcess(result: TResult): TResult

  registerSharedSkill(skill: PipelineSkill): void {
    this.sharedSkills.push(skill)
  }

  getSkillsForPhase(phase: string, context: Record<string, unknown>): string {
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
      .map(s => {
        const rules = typeof s.rules === 'function' ? s.rules(context) : s.rules
        if (!rules) return ''
        return `[Skill:${s.id}]\n${rules}`
      })
      .filter(Boolean)
      .join('\n\n')
  }

  buildSystemPrompt(passName: string, basePrompt: string, context: Record<string, unknown>): string {
    const skills = this.getSkillsForPhase(passName, context)
    if (!skills) return basePrompt
    return `${basePrompt}\n\n--- 领域规则 ---\n${skills}`
  }

  protected isGeminiModel(model: string): boolean {
    return model.toLowerCase().includes('gemini')
  }

  protected createLLM(model?: string, maxTokens = 4096) {
    const m = model || this.config.model
    const baseURL = this.config.baseURL.endsWith('/v1')
      ? this.config.baseURL
      : `${this.config.baseURL}/v1`
    const callbacks = this.langfuseHandler ? [this.langfuseHandler] : undefined
    return new ChatOpenAI({
      model: m,
      apiKey: this.config.apiKey,
      temperature: 0,
      maxRetries: 1,
      maxTokens,
      streamUsage: false,
      timeout: 120000,
      callbacks,
      configuration: {
        baseURL,
        timeout: 120000,
      },
    })
  }

  protected createStructuredLLM<T extends z.ZodType>(schema: T, model?: string, maxTokens = 4096) {
    const llm = this.createLLM(model, maxTokens)
    const m = model || this.config.model
    if (this.isGeminiModel(m)) {
      return llm.withStructuredOutput(schema, { method: 'functionCalling' })
    }
    return llm.withStructuredOutput(schema)
  }

  protected createStructuredLLMWithRaw<T extends z.ZodType>(schema: T, model?: string, maxTokens = 4096) {
    const llm = this.createLLM(model, maxTokens)
    const m = model || this.config.model
    const opts = this.isGeminiModel(m)
      ? { method: 'functionCalling' as const, includeRaw: true as const }
      : { includeRaw: true as const }
    return llm.withStructuredOutput(schema, opts)
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
