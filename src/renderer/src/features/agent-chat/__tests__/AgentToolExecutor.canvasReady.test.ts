import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The self-heal contract only concerns the dispatch layer, not the tldraw
// bridge internals — mock the bridge singleton so we can flip editor presence.
vi.mock('../../agent-workspace/canvas/canvasBridge', () => ({
  canvasBridge: {
    hasEditor: vi.fn(() => false),
    waitForEditor: vi.fn(async () => ({}) as never),
    handle: vi.fn(async () => ({ ok: true })),
  },
}))

import { AgentToolExecutor } from '../AgentToolExecutor'
import { canvasBridge } from '../../agent-workspace/canvas/canvasBridge'
import { useFileExplorerStore } from '../../file-explorer/store'

const bridge = canvasBridge as unknown as {
  hasEditor: ReturnType<typeof vi.fn>
  waitForEditor: ReturnType<typeof vi.fn>
  handle: ReturnType<typeof vi.fn>
}

function callCanvas(toolName: string, params: Record<string, unknown> = {}): Promise<unknown> {
  const exec = new AgentToolExecutor() as unknown as {
    callCanvas: (t: string, p: Record<string, unknown>) => Promise<unknown>
  }
  return exec.callCanvas(toolName, params)
}

describe('callCanvas cold-start self-heal', () => {
  const openCanvasTab = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    useFileExplorerStore.setState({ openCanvasTab } as never)
  })

  afterEach(() => {
    useFileExplorerStore.setState(useFileExplorerStore.getInitialState(), true)
  })

  it('opens the canvas and waits for the editor when a write tool arrives with no editor', async () => {
    bridge.hasEditor.mockReturnValue(false)
    await callCanvas('create_image_holder', { label: 'x' })
    expect(openCanvasTab).toHaveBeenCalledTimes(1)
    expect(bridge.waitForEditor).toHaveBeenCalledTimes(1)
    // The tool still reaches the bridge after the heal.
    expect(bridge.handle).toHaveBeenCalledWith('create_image_holder', { label: 'x' })
  })

  it('does NOT touch the tab when the editor is already alive', async () => {
    bridge.hasEditor.mockReturnValue(true)
    await callCanvas('create_image_holder', {})
    expect(openCanvasTab).not.toHaveBeenCalled()
    expect(bridge.waitForEditor).not.toHaveBeenCalled()
    expect(bridge.handle).toHaveBeenCalled()
  })

  it('never yanks the active tab for editor-free tools (canvas_search / list_checkpoints)', async () => {
    bridge.hasEditor.mockReturnValue(false)
    await callCanvas('canvas_search', { code: 'return 1' })
    await callCanvas('list_checkpoints')
    expect(openCanvasTab).not.toHaveBeenCalled()
    expect(bridge.waitForEditor).not.toHaveBeenCalled()
    expect(bridge.handle).toHaveBeenCalledTimes(2)
  })

  it('canvas_open still opens + waits explicitly', async () => {
    bridge.hasEditor.mockReturnValue(false)
    const res = await callCanvas('canvas_open')
    expect(res).toEqual({ opened: true })
    expect(openCanvasTab).toHaveBeenCalledTimes(1)
    expect(bridge.waitForEditor).toHaveBeenCalledTimes(1)
    // canvas_open is answered by the executor itself, not the bridge.
    expect(bridge.handle).not.toHaveBeenCalled()
  })
})
