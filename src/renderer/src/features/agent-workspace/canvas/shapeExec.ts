import { Box, type Editor, Mat, Vec, clamp, createBindingId, createShapeId, getArrowBindings, toRichText } from 'tldraw'
import { zoomToFitShapes } from './shapeOps'

/**
 * canvas_exec / canvas_search — the "escape hatch" pair, ported from tldraw's
 * official mcp-app (`src/tools/exec.ts`, `src/widget/exec-helpers.ts`,
 * `src/tools/search.ts`) and adapted to our renderer + ToolRouter plumbing.
 *
 * IMPORTANT — intentionally UNRESTRICTED: the official mcp-app sandboxes exec by
 * nulling `window.fetch`/`XMLHttpRequest`/timers while the model's code runs. The
 * product owner explicitly asked NOT to restrict it ("不需要限制他"), so we run the
 * code with full ambient capabilities (network, timers, DOM). We keep ONE
 * best-effort guard that is NOT a capability limit: a generous timeout that lets
 * an *async* runaway return an error to Codex instead of hanging the turn
 * forever (a purely synchronous infinite loop still blocks the single renderer
 * thread — accepted, given the no-restriction directive).
 *
 * We run via `AsyncFunction` (allowed by the renderer CSP `script-src
 * 'unsafe-eval'`), not blob-module import — blob: is not in our script-src and
 * AsyncFunction is also directly unit-testable. The model gets the RAW tldraw
 * `editor` (we don't ship the mcp-app "focused" Proxy), so it uses the real
 * tldraw Editor API; `canvas_search` documents that API surface.
 */

const EXEC_TIMEOUT_MS = 30_000

function ensureShapeId(id: string): string {
  return id.startsWith('shape:') ? id : `shape:${id}`
}

const BOX_SHAPES_MARGIN = 40

/** Build the helper bag injected into exec'd code (mirrors mcp-app exec-helpers). */
export function createExecHelpers(editor: Editor): Record<string, unknown> {
  const createArrowBetweenShapes = (
    fromId: string,
    toId: string,
    opts?: { bend?: number; text?: string },
  ): Editor => {
    const arrowId = createShapeId()
    editor.createShape({
      id: arrowId,
      type: 'arrow',
      props: {
        ...(opts?.text ? { richText: toRichText(opts.text) } : {}),
        ...(opts?.bend != null ? { bend: opts.bend } : {}),
      },
    } as never)
    editor.createBindings([
      { id: createBindingId(), type: 'arrow', fromId: arrowId, toId: ensureShapeId(fromId), props: { terminal: 'start', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } } },
      { id: createBindingId(), type: 'arrow', fromId: arrowId, toId: ensureShapeId(toId), props: { terminal: 'end', isPrecise: false, isExact: false, normalizedAnchor: { x: 0.5, y: 0.5 } } },
    ] as never)
    return editor
  }

  const boxShapes = (
    shapesOrIds: Array<string | { shapeId: string }>,
    opts?: { shapeId?: string; color?: string; fill?: string; text?: string; note?: string },
  ): Editor => {
    const ids = shapesOrIds.map((s) => ensureShapeId(typeof s === 'string' ? s : s.shapeId))
    const bounds = (editor as unknown as { getShapesPageBounds?: (ids: string[]) => { x: number; y: number; w: number; h: number } | undefined }).getShapesPageBounds?.(ids)
    if (!bounds) return editor
    const boxId = opts?.shapeId ? ensureShapeId(opts.shapeId) : createShapeId()
    editor.createShape({
      id: boxId,
      type: 'geo',
      x: bounds.x - BOX_SHAPES_MARGIN,
      y: bounds.y - BOX_SHAPES_MARGIN,
      props: {
        geo: 'rectangle',
        w: bounds.w + BOX_SHAPES_MARGIN * 2,
        h: bounds.h + BOX_SHAPES_MARGIN * 2,
        color: opts?.color ?? 'black',
        fill: opts?.fill ?? 'none',
        ...(opts?.text ? { richText: toRichText(opts.text) } : {}),
      },
      meta: { note: opts?.note ?? '' },
    } as never)
    ;(editor as unknown as { sendToBack?: (ids: string[]) => void }).sendToBack?.([boxId])
    ;(editor as unknown as { groupShapes?: (ids: string[]) => void }).groupShapes?.([...ids, boxId])
    return editor
  }

  return {
    createShapeId,
    createBindingId,
    Box,
    Vec,
    Mat,
    clamp,
    getArrowBindings,
    toRichText,
    createArrowBetweenShapes,
    boxShapes,
    zoomToFit: (ids: string[]) => zoomToFitShapes(editor, ids),
  }
}

function serializeResult(result: unknown): unknown {
  if (result === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(result))
  } catch {
    return String(result)
  }
}

// `new AsyncFunction(...)` — an async-capable Function constructor. Allowed by the
// renderer CSP (`script-src 'unsafe-eval'`); lets the model's snippet use
// top-level `return` and `await` naturally.
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...callArgs: unknown[]) => Promise<unknown>

export interface ExecResult {
  success: boolean
  result?: unknown
  error?: string
}

/**
 * Run arbitrary JS against the live tldraw `editor` + injected helpers. Returns a
 * structured `{ success, result?, error? }` — a thrown error is caught and
 * reported, never propagated (so a bad snippet can't crash the tldraw React tree
 * the way a raw validation throw did, see canvasBridge.safeWrite / gap §4.E).
 */
export async function executeCanvasCode(editor: Editor, code: string): Promise<ExecResult> {
  const helpers = createExecHelpers(editor)
  const helperNames = Object.keys(helpers)
  try {
    const fn = new AsyncFunction('editor', ...helperNames, code)
    const run = fn(editor, ...helperNames.map((n) => helpers[n]))
    const result = await Promise.race([
      run,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`canvas_exec timed out after ${EXEC_TIMEOUT_MS}ms`)), EXEC_TIMEOUT_MS),
      ),
    ])
    return { success: true, result: serializeResult(result) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}

// ---- canvas_search: curated tldraw Editor API spec -------------------------

interface SpecMember {
  name: string
  kind: 'method' | 'property'
  signature: string
  description: string
  category: string
}

/**
 * A curated, hand-maintained subset of the tldraw Editor API + our exec helpers.
 * The official mcp-app generates a full `EditorApiSpec` via TS reflection and
 * runs queries in a Cloudflare worker — we have neither, and a full reflection
 * pipeline is overkill, so this static spec gives the model enough to discover
 * the common surface it needs to drive `canvas_exec`. Extend as needed.
 */
export const EDITOR_API_SPEC: {
  members: SpecMember[]
  categories: string[]
  types: { shapeTypes: string[]; shapes: Array<{ shapeType: string; props: string[] }> }
  helpers: Array<{ name: string; description: string; example: string }>
} = {
  categories: ['shapes', 'selection', 'camera', 'bindings', 'assets', 'layout', 'reading'],
  members: [
    { name: 'createShape', kind: 'method', signature: 'createShape(partial: { id?, type, x?, y?, props?, meta? }): Editor', description: 'Create one shape. type is "geo"|"arrow"|"image"|"text"|"note"|"line"|"draw"|"frame". geo needs props.geo (e.g. "rectangle").', category: 'shapes' },
    { name: 'createShapes', kind: 'method', signature: 'createShapes(partials: Shape[]): Editor', description: 'Create multiple shapes at once.', category: 'shapes' },
    { name: 'updateShape', kind: 'method', signature: 'updateShape(partial: { id, type, x?, y?, props? }): Editor', description: 'Update an existing shape by id.', category: 'shapes' },
    { name: 'deleteShapes', kind: 'method', signature: 'deleteShapes(ids: string[]): Editor', description: 'Delete shapes by id. DESTRUCTIVE.', category: 'shapes' },
    { name: 'getShape', kind: 'method', signature: 'getShape(id): TLShape | undefined', description: 'Read one shape record by id.', category: 'reading' },
    { name: 'getCurrentPageShapes', kind: 'method', signature: 'getCurrentPageShapes(): TLShape[]', description: 'All shapes on the current page.', category: 'reading' },
    { name: 'getCurrentPageShapeIds', kind: 'method', signature: 'getCurrentPageShapeIds(): Set<TLShapeId>', description: 'Ids of all shapes on the current page.', category: 'reading' },
    { name: 'getShapePageBounds', kind: 'method', signature: 'getShapePageBounds(id): Box | undefined', description: 'Page-space bounds of one shape.', category: 'reading' },
    { name: 'getShapesPageBounds', kind: 'method', signature: 'getShapesPageBounds(ids): Box | undefined', description: 'Combined page-space bounds of several shapes.', category: 'reading' },
    { name: 'select', kind: 'method', signature: 'select(...ids): Editor', description: 'Set the selection to these shape ids.', category: 'selection' },
    { name: 'selectAll', kind: 'method', signature: 'selectAll(): Editor', description: 'Select every shape on the page.', category: 'selection' },
    { name: 'getSelectedShapeIds', kind: 'method', signature: 'getSelectedShapeIds(): TLShapeId[]', description: 'Currently selected shape ids.', category: 'selection' },
    { name: 'zoomToFit', kind: 'method', signature: 'zoomToFit(): Editor', description: 'Zoom/pan so all shapes fit the viewport.', category: 'camera' },
    { name: 'zoomToSelection', kind: 'method', signature: 'zoomToSelection(): Editor', description: 'Zoom/pan to the current selection.', category: 'camera' },
    { name: 'setCamera', kind: 'method', signature: 'setCamera(point: {x,y,z}, opts?): Editor', description: 'Move the camera. z is zoom.', category: 'camera' },
    { name: 'createBindings', kind: 'method', signature: 'createBindings(bindings: TLBinding[]): Editor', description: 'Create bindings (e.g. arrow→shape). Prefer the createArrowBetweenShapes helper.', category: 'bindings' },
    { name: 'getAsset', kind: 'method', signature: 'getAsset(assetId): TLAsset | undefined', description: 'Read an asset record (e.g. image src/dimensions) by id.', category: 'assets' },
    { name: 'alignShapes', kind: 'method', signature: "alignShapes(ids, operation: 'left'|'right'|'top'|'bottom'|'center-horizontal'|'center-vertical'): Editor", description: 'Align shapes.', category: 'layout' },
    { name: 'distributeShapes', kind: 'method', signature: "distributeShapes(ids, 'horizontal'|'vertical'): Editor", description: 'Evenly distribute shapes.', category: 'layout' },
    { name: 'stackShapes', kind: 'method', signature: "stackShapes(ids, 'horizontal'|'vertical', gap): Editor", description: 'Stack shapes with a gap.', category: 'layout' },
    { name: 'groupShapes', kind: 'method', signature: 'groupShapes(ids): Editor', description: 'Group shapes together.', category: 'layout' },
    { name: 'sendToBack', kind: 'method', signature: 'sendToBack(ids): Editor', description: 'Send shapes to the back.', category: 'layout' },
    { name: 'bringToFront', kind: 'method', signature: 'bringToFront(ids): Editor', description: 'Bring shapes to the front.', category: 'layout' },
    { name: 'run', kind: 'method', signature: 'run(fn, opts?): void', description: 'Run a batch of edits in one transaction (auto-rolls back if it throws).', category: 'shapes' },
  ],
  types: {
    shapeTypes: ['geo', 'arrow', 'image', 'video', 'text', 'note', 'line', 'draw', 'frame', 'group'],
    shapes: [
      { shapeType: 'geo', props: ['geo', 'w', 'h', 'color', 'fill', 'dash', 'size', 'richText', 'align', 'verticalAlign'] },
      { shapeType: 'arrow', props: ['start', 'end', 'color', 'size', 'arrowheadStart', 'arrowheadEnd', 'bend', 'richText'] },
      { shapeType: 'image', props: ['assetId', 'w', 'h', 'crop', 'flipX', 'flipY'] },
      { shapeType: 'video', props: ['assetId', 'w', 'h', 'time', 'playing', 'autoplay', 'altText'] },
      { shapeType: 'text', props: ['richText', 'color', 'size', 'font', 'textAlign', 'w', 'scale'] },
    ],
  },
  helpers: [
    { name: 'createShapeId', description: 'Create a fresh shape id (optionally from a string seed).', example: "const id = createShapeId('box1')" },
    { name: 'createBindingId', description: 'Create a fresh binding id.', example: 'const b = createBindingId()' },
    { name: 'createArrowBetweenShapes', description: 'Draw an arrow bound to two shapes by id; follows them when moved. opts: { bend?, text? }.', example: "createArrowBetweenShapes('box1','box2',{ text:'next' })" },
    { name: 'boxShapes', description: 'Draw a labelled rectangle around shapes and group them. opts: { color?, fill?, text?, note? }.', example: "boxShapes(['a','b'],{ text:'Group', color:'blue' })" },
    { name: 'zoomToFit', description: 'Pan/zoom the camera so the given shape ids are visible (never zooms past current level).', example: "zoomToFit(['box1'])" },
    { name: 'Box / Vec / Mat / clamp / getArrowBindings / toRichText', description: 'tldraw geometry + rich-text primitives injected for use in code.', example: 'const b = Box.Common([...])' },
  ],
}

/** Run a read-only query against EDITOR_API_SPEC. The snippet receives `spec`. */
export async function searchEditorApi(code: string): Promise<ExecResult> {
  try {
    const fn = new AsyncFunction('spec', code)
    const result = await fn(EDITOR_API_SPEC)
    return { success: true, result: serializeResult(result) }
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) }
  }
}
