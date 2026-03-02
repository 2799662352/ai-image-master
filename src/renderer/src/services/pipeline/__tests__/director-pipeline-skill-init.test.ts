import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DirectorPipeline } from '../DirectorPipeline'
import { initDirectorSkills } from '../prompt-loader'
import type { PipelineConfig } from '../types'

vi.mock('../prompt-loader', () => ({
  initDirectorSkills: vi.fn(),
  getDirectorSkillsFromConfig: vi.fn(() => []),
  getPromptTemplate: vi.fn(() => null),
  renderTemplate: vi.fn((template: string) => template),
}))

describe('DirectorPipeline execute skill init', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('execute 会先调用并等待 initDirectorSkills', async () => {
    let resolveInit: (() => void) | null = null
    vi.mocked(initDirectorSkills).mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveInit = resolve
        }),
    )

    const streamSpy = vi.fn(async function* () {})
    const pipeline = new DirectorPipeline({
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost',
    } satisfies PipelineConfig)

    ;(pipeline as any)._graph = { stream: streamSpy }

    const executePromise = pipeline.execute({})
    await Promise.resolve()

    expect(initDirectorSkills).toHaveBeenCalledTimes(1)
    expect(streamSpy).not.toHaveBeenCalled()

    resolveInit?.()
    await executePromise

    expect(streamSpy).toHaveBeenCalledTimes(1)
  })
})
