import { ChatOpenAI } from '@langchain/openai'
import type { PipelineConfig, PipelineSkill, PipelineProgress } from './types'

export abstract class BasePipeline<TState, TResult> {
  protected config: PipelineConfig
  private sharedSkills: PipelineSkill[] = []

  constructor(config: PipelineConfig) {
    this.config = config
  }

  abstract get pipelineSkills(): PipelineSkill[]
  abstract buildGraph(): any
  abstract assembleResult(finalState: TState): TResult
  abstract postProcess(result: TResult): TResult

  registerSharedSkill(skill: PipelineSkill): void {
    this.sharedSkills.push(skill)
  }

  getSkillsForPhase(phase: string, context: Record<string, unknown>): string {
    const allSkills = [...this.sharedSkills, ...this.pipelineSkills]
    return allSkills
      .filter(s => s.appliesTo.includes(phase))
      .filter(s => !s.condition || s.condition(context))
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
    return new ChatOpenAI({
      model: m,
      apiKey: this.config.apiKey,
      temperature: 0,
      maxRetries: 1,
      maxTokens,
      streamUsage: false,
      timeout: 120000,
      configuration: {
        baseURL,
        timeout: 120000,
      },
    })
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
