import { describe, expect, it, vi } from 'vitest'
import { DirectorPipeline } from '../DirectorPipeline'
import type { PipelineConfig } from '../types'

vi.mock('../prompt-loader', () => ({
  initDirectorSkills: vi.fn().mockResolvedValue(undefined),
  getDirectorSkillsFromConfig: vi.fn(() => []),
  getPromptTemplate: vi.fn(() => null),
  renderTemplate: vi.fn((template: string) => template),
}))

describe('DirectorPipeline stream termination', () => {
  it('stream 不结束时，收到最终 pass 后 execute 也应返回', async () => {
    const pipeline = new DirectorPipeline({
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost',
    } satisfies PipelineConfig)

    const hangingStream = async function* () {
      yield ['custom', { type: 'pass_complete', pass: 5, label: '图像生成完成', elapsed: 1, passData: null }]
      yield ['updates', { generateImages: { images: [{ id: 1, url: 'x', prompt: 'p' }] } }]
      await new Promise(() => {})
    }

    ;(pipeline as any)._graph = { stream: vi.fn(hangingStream) }

    const executePromise = pipeline.execute({})
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 120)
    })

    const winner = await Promise.race([executePromise.then(() => 'done' as const), timeoutPromise])
    expect(winner).toBe('done')
  })

  it('仅 updates 包含 generateImages 且 stream 挂起时，execute 也应返回', async () => {
    const pipeline = new DirectorPipeline({
      model: 'test-model',
      apiKey: 'test-key',
      baseURL: 'http://localhost',
    } satisfies PipelineConfig)

    const updatesOnlyHangingStream = async function* () {
      yield ['updates', { generateImages: { images: [{ id: 1, url: 'u', prompt: 'p' }] } }]
      await new Promise(() => {})
    }

    ;(pipeline as any)._graph = { stream: vi.fn(updatesOnlyHangingStream) }

    const executePromise = pipeline.execute({})
    const timeoutPromise = new Promise<'timeout'>((resolve) => {
      setTimeout(() => resolve('timeout'), 120)
    })

    const winner = await Promise.race([executePromise.then(() => 'done' as const), timeoutPromise])
    expect(winner).toBe('done')
  })
})
