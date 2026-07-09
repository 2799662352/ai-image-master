/**
 * createImageInjectionMiddleware — V4 replaced the old `createViewImagesTool`
 * factory (subagents pulling images via a tool) with a middleware that
 * injects reference images into the first HumanMessage as multimodal
 * content blocks (commit 440c6b0). This suite tests the current surface.
 *
 * The module resolves `langchain` / `@langchain/core/messages` through a
 * runtime `require` (renderer nodeIntegration), so the test stubs
 * `globalThis.require` with minimal fakes.
 */
import { afterEach, describe, expect, it } from 'vitest'
import { createImageInjectionMiddleware } from '../storyboard-image-tool'

class FakeHumanMessage {
  content: unknown
  constructor(init: string | { content: unknown }) {
    this.content = typeof init === 'string' ? init : init.content
  }
  _getType(): string {
    return 'human'
  }
}

interface MiddlewareShape {
  name: string
  wrapModelCall: (
    request: { messages: unknown[] },
    handler: (request: { messages: unknown[] }) => unknown,
  ) => unknown
}

function stubRuntimeRequire(): void {
  ;(globalThis as unknown as { require: (id: string) => unknown }).require = (id: string) => {
    if (id === 'langchain') {
      // createMiddleware just brands its config in real langchain; the config
      // object itself (name + wrapModelCall) is all the middleware tests need.
      return { createMiddleware: (cfg: unknown) => cfg }
    }
    if (id === '@langchain/core/messages') {
      return { HumanMessage: FakeHumanMessage }
    }
    throw new Error(`unexpected require: ${id}`)
  }
}

afterEach(() => {
  delete (globalThis as unknown as { require?: unknown }).require
})

describe('createImageInjectionMiddleware', () => {
  it('returns null when there are no images (no middleware registered)', () => {
    expect(createImageInjectionMiddleware([])).toBeNull()
  })

  it('injects data-URL image blocks into the HumanMessage on the first model call', () => {
    stubRuntimeRequire()
    const mw = createImageInjectionMiddleware([
      { data: 'aGVsbG8=', mimeType: 'image/png' },
      { data: 'd29ybGQ=', mimeType: 'image/jpeg' },
    ]) as unknown as MiddlewareShape

    expect(mw.name).toBe('ImageInjectionMiddleware')

    let seen: { messages: unknown[] } | undefined
    mw.wrapModelCall(
      { messages: [new FakeHumanMessage('describe the scene')] },
      (req) => {
        seen = req
        return 'model-result'
      },
    )

    const human = seen?.messages[0] as FakeHumanMessage
    const blocks = human.content as Array<
      { type: 'text'; text: string } | { type: 'image_url'; image_url: { url: string } }
    >
    expect(blocks[0]).toMatchObject({ type: 'text' })
    expect((blocks[0] as { text: string }).text).toContain('describe the scene')
    expect((blocks[0] as { text: string }).text).toContain('2 reference image(s)')
    expect(blocks[1]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'data:image/png;base64,aGVsbG8=' },
    })
    expect(blocks[2]).toMatchObject({
      type: 'image_url',
      image_url: { url: 'data:image/jpeg;base64,d29ybGQ=' },
    })
  })

  it('injects only once — subsequent model calls pass through unchanged', () => {
    stubRuntimeRequire()
    const mw = createImageInjectionMiddleware([
      { data: 'aGVsbG8=', mimeType: 'image/png' },
    ]) as unknown as MiddlewareShape

    const first = { messages: [new FakeHumanMessage('first turn')] }
    mw.wrapModelCall(first, (req) => req)

    const second = { messages: [new FakeHumanMessage('second turn')] }
    let seen: { messages: unknown[] } | undefined
    mw.wrapModelCall(second, (req) => {
      seen = req
      return 'ok'
    })

    // Same request object, same untouched string content.
    expect(seen).toBe(second)
    expect((seen?.messages[0] as FakeHumanMessage).content).toBe('second turn')
  })
})
