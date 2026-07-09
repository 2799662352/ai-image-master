export type AiCanvasRole =
  | 'image_holder'
  | 'ai_image'
  | 'annotation_text'
  | 'annotation_arrow'
  | 'annotation_mark'
  | 'version_group'

export interface Bounds {
  x: number
  y: number
  w: number
  h: number
}

export interface Point {
  x: number
  y: number
}

export interface CanvasMetadata {
  canvasId: string
  name: string
  createdAt: string
  updatedAt: string
  workspaceRoot: string
  activePageId: string
  appVersion: string
}

export interface AiCanvasShapeMeta {
  aiCanvasRole?: AiCanvasRole
  aspectRatio?: string
  acceptsGeneratedImage?: boolean
  holderId?: string
  sourceRunId?: string
  version?: number
  parentShapeId?: string
  assetPath?: string
  title?: string
}

export interface ShapeSummary {
  id: string
  type: string
  role?: AiCanvasRole
  bounds: Bounds
  text?: string
  color?: string
  assetPath?: string
  assetUrl?: string
  /** Origin URL for link-like shapes — a pasted web link becomes a bookmark/embed
   * whose `props.url` is surfaced here, so canvas_snapshot exposes the source the
   * same way `assetPath` exposes a dropped/generated file's disk path. */
  sourceUrl?: string
  /** tldraw asset id backing an image shape (for get_canvas_image addressing). */
  assetId?: string
  /** Natural (intrinsic) pixel dimensions of the backing image asset. */
  imageWidth?: number
  imageHeight?: number
  aspectRatio?: string
  version?: number
  parentShapeId?: string
  arrowStart?: Point
  arrowEnd?: Point
  meta?: AiCanvasShapeMeta
}

/**
 * One entry of `list_canvas_images` — a flat, focused index of the image shapes
 * on the canvas. Mirrors the sora-canvas-mcp / tldraw mcp-app "list then fetch"
 * pattern: Codex calls this first (cheap, read-only) to learn which shapeId to
 * pass to `get_canvas_image`, and whether a usable on-disk file already exists.
 */
export interface ImageShapeListItem {
  shapeId: string
  assetId: string | null
  /** On-canvas display size (rounded), not the intrinsic asset size. */
  w: number
  h: number
  role?: AiCanvasRole
  version?: number
  title?: string
  /** Absolute on-disk path when known (images WE inserted carry it in meta). */
  assetPath: string | null
  /** Backing asset src (may be an opaque `asset:<id>` ref for pasted images). */
  assetUrl: string | null
  /** True when `assetPath` points at a real file Codex can open directly. */
  hasFile: boolean
}

/**
 * Compact "blurry" view of one shape — modeled on the official tldraw Agent
 * Starter Kit's `BlurryShape` tier. Used by `canvas_snapshot` when the canvas
 * is large: shapes inside the viewport are sent in this reduced format (no
 * `meta` object, truncated text, integer bounds) so the model gets an overview
 * without the full per-shape payload blowing up its context. Full detail stays
 * available per-shape via `get_canvas_image` / `focusShapeIds` / `full:true`.
 */
export interface BlurryShape {
  id: string
  type: string
  role?: AiCanvasRole
  bounds: Bounds
  /** Truncated to a preview length; fetch the shape for the full text. */
  text?: string
  assetPath?: string
  assetId?: string
  sourceUrl?: string
}

/**
 * Group of shapes OUTSIDE the agent's viewport — the Agent Starter Kit's
 * `PeripheralShapeCluster` tier. Only the cluster's bounds, member count and a
 * type histogram are sent, giving the model awareness that content exists
 * elsewhere on the page without paying for its detail.
 */
export interface PeripheralShapeCluster {
  bounds: Bounds
  count: number
  /** Histogram of shape types in the cluster, e.g. { image: 3, text: 2 }. */
  types: Record<string, number>
}

export interface SelectionSnapshot {
  canvasId: string
  pageId: string
  selectedShapeIds: string[]
  shapes: ShapeSummary[]
}

export interface ImageGenerationRequest {
  prompt: string
  aspectRatio?: string
  width?: number
  height?: number
  referenceImages?: string[]
  outputDir: string
  outputName?: string
}

export interface ImageEditRequest {
  prompt: string
  inputImagePath: string
  annotatedScreenshotPath?: string
  annotations?: AnnotationInstruction[]
  maskPath?: string
  outputDir: string
  outputName?: string
}

export interface ImageResult {
  imagePath: string
  width: number
  height: number
  model: 'codex-image-2.0'
  raw?: unknown
}

export interface AnnotationInstruction {
  id: string
  instruction: string
  region: Bounds
  sourceShapeIds: string[]
  confidence: number
  kind: 'arrow_text' | 'circle_text' | 'box_text' | 'draw_mark' | 'text_near_image'
}

export interface AnnotationPlanResult {
  targetShapeId: string
  targetImagePath?: string
  annotationPlan: AnnotationInstruction[]
  screenshotPath?: string
  needsClarification: boolean
  clarificationReason?: string
}

export interface PreparedImageGeneration {
  readyToGenerate: boolean
  needsCanvasOpen: boolean
  message: string
  url: string
  canvasId: string
  storagePath: string
  holderShapeId?: string
  holderBounds?: Bounds
  aspectRatio: string
  outputDir: string
  suggestedPrompt: string
}

export interface PreparedAnnotationEdit extends AnnotationPlanResult {
  readyToEdit: boolean
  url?: string
  storagePath: string
  inputImagePath?: string
  editPrompt: string
}

export type EditRequestStatus =
  | 'queued'
  | 'processing'
  | 'completed'
  | 'failed'
  | 'needs_clarification'

export interface CanvasEditRequest extends PreparedAnnotationEdit {
  requestId: string
  status: EditRequestStatus
  canAutoEdit: boolean
  source: 'canvas_button' | 'codex'
  userRequest?: string
  codexInstruction: string
  attempts: number
  createdAt: string
  updatedAt: string
  claimedAt?: string
  completedAt?: string
  result?: Record<string, unknown>
  error?: string
}

export interface EditRequestPollResult {
  request?: CanvasEditRequest
  timedOut: boolean
  message: string
}

export interface EditRequestQueueStatus {
  listenerActive: boolean
  listenerLastSeenAt?: string
  listenerActiveWindowMs: number
  queuedCount: number
  processingCount: number
  latestRequest?: CanvasEditRequest
  updatedAt: string
}

export type RunType =
  | 'generate'
  | 'edit_from_annotations'
  | 'insert_image_into_holder'
  | 'create_image_version'
  | 'failed'

export interface RunRecord {
  runId: string
  type: RunType
  model: 'codex-image-2.0' | 'external' | 'local-placeholder'
  input: Record<string, unknown>
  annotationPlan?: AnnotationInstruction[]
  prompt?: string
  output?: Record<string, unknown>
  error?: string
  createdAt: string
}

export type CanvasPendingOperationType =
  | 'create_image_holder'
  | 'insert_image_into_holder'
  | 'create_image_version'

export interface CanvasPendingOperation {
  id: string
  type: CanvasPendingOperationType
  payload: Record<string, unknown>
  createdAt: string
}

export interface VersionMetadata {
  shapeId: string
  version: number
  parentShapeId?: string
  sourceRunId?: string
  assetPath: string
  createdAt: string
}

export interface CanvasStatePayload {
  canvasId: string
  metadata: CanvasMetadata
  storagePath: string
  snapshot?: unknown
  selection: SelectionSnapshot
  shapes: ShapeSummary[]
  pendingOperations?: CanvasPendingOperation[]
}
