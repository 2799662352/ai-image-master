import type { Editor } from 'tldraw'
import type { CanvasStatePayload } from '../../../../../types/canvas'
import { createHolder, createImageVersion, insertImageIntoHolder, readCanvasState } from './shapeOps'
import { parseAnnotations } from './annotationParser'
import { editPrompt, findPreferredHolder, generationPrompt, holderSize } from './promptBuilders'

type AttachmentsApi = { readThumb: (p: string) => Promise<{ ok: true; base64: string; mime: string } | { ok: false; reason: string }> }

const BASE_STATE: CanvasStatePayload = {
  canvasId: 'catimation-canvas',
  metadata: { canvasId: 'catimation-canvas', name: 'CATIMATION Canvas', createdAt: '', updatedAt: '', workspaceRoot: '', activePageId: 'page:main', appVersion: '1' },
  storagePath: '',
  selection: { canvasId: 'catimation-canvas', pageId: 'page:main', selectedShapeIds: [], shapes: [] },
  shapes: [],
}

class CanvasBridge {
  private editor: Editor | null = null
  private waiters: Array<(editor: Editor) => void> = []

  setEditor(editor: Editor | null): void {
    this.editor = editor
    if (editor) {
      const pending = this.waiters
      this.waiters = []
      for (const resolve of pending) resolve(editor)
    }
  }

  /** Resolve once the Canvas tab has mounted its tldraw editor (or reject on timeout). */
  waitForEditor(timeoutMs = 8000): Promise<Editor> {
    if (this.editor) return Promise.resolve(this.editor)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== onReady)
        reject(new Error('Canvas did not open in time. Open the Canvas tab in Agent Workspace and retry.'))
      }, timeoutMs)
      const onReady = (editor: Editor): void => {
        clearTimeout(timer)
        resolve(editor)
      }
      this.waiters.push(onReady)
    })
  }

  private requireEditor(): Editor {
    if (!this.editor) throw new Error('Canvas is not open. Ask the user to open the Canvas tab, or call canvas_open first.')
    return this.editor
  }

  private state(): CanvasStatePayload {
    return readCanvasState(this.requireEditor(), BASE_STATE)
  }

  /** Resolve a local file path (or data/http URL) to a browser-loadable src. */
  private async toLoadable(pathOrUrl: string): Promise<string> {
    if (pathOrUrl.startsWith('data:') || pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) return pathOrUrl
    const api = (window as Window & { electronAPI?: { attachments?: AttachmentsApi } }).electronAPI?.attachments
    if (!api?.readThumb) throw new Error('attachments API unavailable to load image')
    const res = await api.readThumb(pathOrUrl)
    if (!res.ok) throw new Error(`Cannot read image ${pathOrUrl}: ${res.reason}`)
    return `data:${res.mime};base64,${res.base64}`
  }

  async handle(toolName: string, params: Record<string, unknown>): Promise<unknown> {
    switch (toolName) {
      case 'canvas_open':
        return { opened: true }
      case 'prepare_image_generation': {
        const editor = this.requireEditor()
        const aspectRatio = String(params.aspectRatio ?? '5:7')
        let holder = findPreferredHolder(this.state())
        if (!holder) {
          const size = holderSize(aspectRatio)
          const created = createHolder(editor, { label: params.label, aspectRatio, ...size })
          holder = this.state().shapes.find((s) => s.id === created.shapeId)
        }
        return {
          readyToGenerate: true,
          holderShapeId: holder?.id,
          holderBounds: holder?.bounds,
          aspectRatio: holder?.aspectRatio ?? aspectRatio,
          suggestedPrompt: generationPrompt({ request: String(params.request ?? ''), aspectRatio: holder?.aspectRatio ?? aspectRatio, intendedUse: params.intendedUse as string | undefined }),
        }
      }
      case 'create_image_holder':
        return createHolder(this.requireEditor(), params)
      case 'insert_image_into_holder': {
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return insertImageIntoHolder(this.requireEditor(), { holderShapeId: String(params.holderShapeId), assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined })
      }
      case 'collect_annotations':
        return parseAnnotations({ state: this.state(), targetShapeId: params.targetShapeId as string | undefined, radius: Number(params.radius ?? 420) })
      case 'prepare_annotation_edit': {
        const plan = parseAnnotations({ state: this.state(), targetShapeId: params.targetShapeId as string | undefined, radius: Number(params.radius ?? 420) })
        return { ...plan, editPrompt: editPrompt({ userRequest: params.userRequest as string | undefined, annotations: plan.annotationPlan }) }
      }
      case 'create_image_version': {
        const assetUrl = await this.toLoadable(String(params.imagePath))
        return createImageVersion(this.requireEditor(), { sourceShapeId: String(params.sourceShapeId), assetUrl, assetPath: String(params.imagePath), title: params.title as string | undefined })
      }
      case 'save_snapshot':
        // tldraw persistenceKey already persists; reading state is enough to flush listeners.
        this.state()
        return { ok: true }
      default:
        throw new Error(`Unknown canvas tool: ${toolName}`)
    }
  }

  /** Build + submit an edit request from the current annotations (button click). */
  buildEditRequest(targetShapeId: string | undefined): { ok: boolean; reason?: string; requestPayload?: Record<string, unknown> } {
    const state = this.state()
    const plan = parseAnnotations({ state, targetShapeId, radius: 420 })
    const target = state.shapes.find((s) => s.id === plan.targetShapeId)
    if (!plan.targetShapeId || !target) return { ok: false, reason: plan.clarificationReason ?? '没有可修改的 AI 图片。' }
    const prompt = editPrompt({ annotations: plan.annotationPlan })
    return {
      ok: true,
      requestPayload: {
        targetShapeId: plan.targetShapeId,
        targetImagePath: target.assetPath,
        annotationPlan: plan.annotationPlan,
        needsClarification: plan.needsClarification,
        clarificationReason: plan.clarificationReason,
        storagePath: '',
        editPrompt: prompt,
        readyToEdit: !plan.needsClarification,
        canAutoEdit: !plan.needsClarification,
        source: 'canvas_button',
        codexInstruction: prompt,
      },
    }
  }
}

export const canvasBridge = new CanvasBridge()
