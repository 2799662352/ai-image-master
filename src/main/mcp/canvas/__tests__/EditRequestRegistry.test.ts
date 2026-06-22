import { describe, expect, it } from 'vitest'
import { EditRequestRegistry } from '../EditRequestRegistry'
import type { CanvasEditRequest } from '../../../../types/canvas'

function makeRequest(): Omit<CanvasEditRequest, 'requestId' | 'status' | 'attempts' | 'createdAt' | 'updatedAt'> {
  return {
    targetShapeId: 'shape:img1',
    targetImagePath: 'C:/tmp/img1.png',
    annotationPlan: [],
    needsClarification: false,
    storagePath: '',
    editPrompt: 'edit it',
    readyToEdit: true,
    canAutoEdit: true,
    source: 'canvas_button',
    codexInstruction: 'edit it',
  }
}

describe('EditRequestRegistry', () => {
  it('enqueues and returns a queued request via waitForNext', async () => {
    const reg = new EditRequestRegistry()
    const enqueued = reg.enqueue(makeRequest())
    const poll = await reg.waitForNext(50, { claim: true })
    expect(poll.request?.requestId).toBe(enqueued.requestId)
    expect(poll.timedOut).toBe(false)
  })

  it('times out when no request is queued', async () => {
    const reg = new EditRequestRegistry()
    const poll = await reg.waitForNext(30, { claim: true })
    expect(poll.request).toBeUndefined()
    expect(poll.timedOut).toBe(true)
  })

  it('marks claimed requests processing so they are not handed out twice', async () => {
    const reg = new EditRequestRegistry()
    reg.enqueue(makeRequest())
    const first = await reg.waitForNext(30, { claim: true })
    const second = await reg.waitForNext(30, { claim: true })
    expect(first.request).toBeDefined()
    expect(second.request).toBeUndefined()
  })

  it('updates status and is readable by id', () => {
    const reg = new EditRequestRegistry()
    const r = reg.enqueue(makeRequest())
    reg.update(r.requestId, 'completed', { ok: true })
    expect(reg.get(r.requestId)?.status).toBe('completed')
  })

  it('reports queue status counts and listener activity', async () => {
    const reg = new EditRequestRegistry()
    reg.enqueue(makeRequest())
    const status = reg.getStatus()
    expect(status.queuedCount).toBe(1)
    const wait = reg.waitForNext(40, { claim: true })
    expect(reg.getStatus().listenerActive).toBe(true)
    await wait
  })
})
