import { describe, expect, it, vi } from 'vitest'
import { registerCanvasTools } from '../canvasTools'
import { editRequestRegistry } from '../../canvas/EditRequestRegistry'

function fakeServerAndRouter() {
  const tools = new Map<string, (params: any, ctx?: unknown) => Promise<unknown>>()
  const server = { registerTool: (name: string, _schema: unknown, handler: any) => tools.set(name, handler) } as any
  const mains = new Map<string, (params: any) => Promise<unknown>>()
  const router = {
    registerMain: (name: string, h: any) => mains.set(name, h),
    call: vi.fn(async () => ({ ok: true })),
  } as any
  return { tools, server, router, mains }
}

describe('registerCanvasTools', () => {
  it('registers renderer + queue tools', () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerCanvasTools(server, router)
    for (const name of ['canvas_open', 'canvas_snapshot', 'list_canvas_images', 'get_canvas_image', 'create_image_holder', 'insert_image_into_holder', 'insert_video', 'collect_annotations', 'create_image_version', 'save_snapshot', 'save_checkpoint', 'load_checkpoint', 'list_checkpoints', 'canvas_exec', 'canvas_search', 'watch_edit_requests', 'get_edit_request', 'update_edit_request']) {
      expect(tools.has(name)).toBe(true)
    }
  })

  it('routes create_image_holder to the renderer via router.call', async () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerCanvasTools(server, router)
    await tools.get('create_image_holder')!({ label: 'x', aspectRatio: '1:1' })
    expect(router.call).toHaveBeenCalledWith('create_image_holder', expect.objectContaining({ label: 'x' }), undefined)
  })

  it('watch_edit_requests returns a queued request from the registry', async () => {
    const { tools, server, router } = fakeServerAndRouter()
    registerCanvasTools(server, router)
    editRequestRegistry.enqueue({
      targetShapeId: 'shape:i', annotationPlan: [], needsClarification: false, storagePath: '',
      editPrompt: 'p', readyToEdit: true, canAutoEdit: true, source: 'canvas_button', codexInstruction: 'p',
    })
    const res: any = await tools.get('watch_edit_requests')!({ waitMs: 50 })
    expect(JSON.stringify(res)).toContain('requestId')
  })
})
