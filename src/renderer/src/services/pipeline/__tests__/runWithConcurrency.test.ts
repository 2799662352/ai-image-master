import { describe, it, expect, vi } from 'vitest'

describe('runWithConcurrency with signal', () => {
  it('should stop processing tasks when signal is aborted', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = Object.create(DirectorPipeline.prototype)
    const runMethod = (pipeline as any).runWithConcurrency.bind(pipeline)

    const controller = new AbortController()
    const taskResults: number[] = []

    const task = async (i: number) => {
      if (i === 2) {
        controller.abort()
      }
      taskResults.push(i)
      return i
    }

    const results = await runMethod(5, 1, task, controller.signal)

    expect(taskResults.length).toBeLessThanOrEqual(3)
  })

  it('should run all tasks when signal is not aborted', async () => {
    const { DirectorPipeline } = await import('../DirectorPipeline')
    const pipeline = Object.create(DirectorPipeline.prototype)
    const runMethod = (pipeline as any).runWithConcurrency.bind(pipeline)

    const results = await runMethod(3, 1, async (i: number) => i * 2)
    expect(results).toEqual([0, 2, 4])
  })
})
