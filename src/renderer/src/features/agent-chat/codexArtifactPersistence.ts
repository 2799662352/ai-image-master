/**
 * Persistence for codex-generated image bubbles.
 *
 * The agent chat timeline is rehydrated from the codex thread (app-server DB)
 * on reload / thread switch. Images produced by our in-app `generate_image`
 * tool are rendered as *renderer-synthetic* artifact bubbles that never enter
 * that thread, so they vanish on reload. We bridge that gap WITHOUT bloating
 * storage: instead of caching base64, we persist a tiny anchor that points at
 * the already-cloud-persisted history record (the "history bucket"). On thread
 * load we re-resolve each anchor to the history item's current URLs (which are
 * R2/COS URLs once the async upload settles) and rebuild the bubble.
 *
 * Storage shape (localStorage, JSON):
 *   { "<threadId>": [ { id, createdAt, prompt?, historyId } , ... ] }
 */

import type { AttachmentRef, Message, TimelineItem } from '../../../../types/agent-timeline'

export interface CodexArtifactAnchor {
  /** Stable id for the rebuilt assistant message (dedupes re-merges). */
  id: string
  /** Epoch ms; used to order the rebuilt bubble within the timeline. */
  createdAt: number
  /** Prompt that produced the image (shown if the history record is gone). */
  prompt?: string
  /** History record id — the source of truth for the durable image URLs. */
  historyId: number | string
  /**
   * Media kind of the generated artifacts. Drives the rebuilt AttachmentRef's
   * kind/mime/name so video bubbles re-render as playable videos instead of
   * broken <img> tags. Absent (legacy anchors) means image.
   */
  kind?: 'image' | 'video'
  /**
   * Local saved file paths returned by the generate_image MCP tool. These are
   * tiny strings but make reload/edit resilient while the history record still
   * contains `pending:*` placeholders or when async R2/COS upload has not
   * settled yet.
   */
  paths?: string[]
}

const STORAGE_KEY = 'catimation:codex-artifacts:v1'
/** Cap per-thread anchors so a long-lived thread can't grow unbounded. */
const MAX_PER_THREAD = 100

type Store = Record<string, CodexArtifactAnchor[]>

function readStore(): Store {
  try {
    const raw = globalThis.localStorage?.getItem(STORAGE_KEY)
    if (!raw) return {}
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as Store) : {}
  } catch {
    return {}
  }
}

function writeStore(store: Store): void {
  try {
    globalThis.localStorage?.setItem(STORAGE_KEY, JSON.stringify(store))
  } catch {
    // Quota / unavailable: persistence is best-effort, never throw into the
    // generation path.
  }
}

/** Append an anchor for `threadId`, keeping only the newest `MAX_PER_THREAD`. */
export function recordCodexArtifact(threadId: string, anchor: CodexArtifactAnchor): void {
  if (!threadId) return
  const store = readStore()
  const existing = store[threadId] ?? []
  // Replace on id collision so a re-record updates in place.
  const next = existing.filter((a) => a.id !== anchor.id)
  next.push(anchor)
  store[threadId] = next.slice(-MAX_PER_THREAD)
  writeStore(store)
}

/** Anchors for `threadId`, oldest-first. */
export function getCodexArtifacts(threadId: string): CodexArtifactAnchor[] {
  if (!threadId) return []
  const store = readStore()
  return store[threadId] ?? []
}

/** Drop all anchors for `threadId` (e.g. when the thread is deleted). */
export function clearCodexArtifacts(threadId: string): void {
  if (!threadId) return
  const store = readStore()
  if (!(threadId in store)) return
  delete store[threadId]
  writeStore(store)
}

/** Resolves a history record id to its current (durable) image URLs. */
export type ResolveHistoryUrls = (historyId: number | string) => string[] | undefined

/**
 * Injected at app bootstrap (where the history service is constructed) so the
 * chat store can rehydrate bubbles WITHOUT statically importing the service
 * layer — that import graph pulls in `window.addEventListener` side-effects
 * that break minimal test environments. Null until wired (and in unit tests).
 */
let historyUrlResolver: ResolveHistoryUrls | null = null

export function setHistoryUrlResolver(resolver: ResolveHistoryUrls | null): void {
  historyUrlResolver = resolver
}

/**
 * Re-merge codex image bubbles persisted for `threadId` into the server-loaded
 * timeline, resolving durable URLs via the injected resolver. No-op passthrough
 * when no resolver is wired (e.g. before bootstrap, or in tests).
 */
export function rehydrateCodexArtifacts(threadId: string, messages: Message[]): Message[] {
  if (!historyUrlResolver) return messages
  try {
    return mergeCodexArtifacts(threadId, messages, historyUrlResolver)
  } catch {
    return messages
  }
}

function toFileUrl(filePath: string): string {
  // Avoid importing node:url into the renderer bundle; this is enough for local
  // Windows paths and keeps the stored anchor as plain filesystem strings.
  return `file:///${filePath.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1:')}`
}

function resolveAnchorUrls(anchor: CodexArtifactAnchor, resolveUrls: ResolveHistoryUrls): string[] {
  const urls = (resolveUrls(anchor.historyId) ?? []).filter(
    (u) => typeof u === 'string' && u.length > 0 && !u.startsWith('pending:'),
  )
  if (urls.length > 0) return urls

  return (anchor.paths ?? [])
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .map(toFileUrl)
}

function toArtifactRefs(anchor: CodexArtifactAnchor, urls: string[]): AttachmentRef[] {
  const isVideo = anchor.kind === 'video'
  return urls.map((uri, i) => ({
    id: `${anchor.id}-${i}`,
    kind: isVideo ? ('video' as const) : ('image' as const),
    name: isVideo ? `codex-video-${i + 1}.mp4` : `codex-image-${i + 1}.png`,
    mime: isVideo ? 'video/mp4' : 'image/png',
    size: uri.startsWith('data:') ? uri.length : 0,
    uri,
  }))
}

/**
 * Rebuild persisted codex image bubbles for `threadId` and merge them into the
 * server-loaded `serverMessages` by position. Anchors whose history record no
 * longer resolves to any URL are skipped (record deleted / cleared).
 *
 * Pure given `resolveUrls`, so it can be unit-tested without the service layer.
 */
export function mergeCodexArtifacts(
  threadId: string,
  serverMessages: Message[],
  resolveUrls: ResolveHistoryUrls,
): Message[] {
  const anchors = getCodexArtifacts(threadId)
  if (anchors.length === 0) return serverMessages

  const rebuilt: Message[] = []
  for (const anchor of anchors) {
    const urls = resolveAnchorUrls(anchor, resolveUrls)
    if (urls.length === 0) continue
    const item: TimelineItem = {
      type: 'artifact',
      id: anchor.id,
      startedAt: anchor.createdAt,
      endedAt: anchor.createdAt,
      artifacts: toArtifactRefs(anchor, urls),
      status: 'done',
      prompt: anchor.prompt,
    }
    rebuilt.push({
      id: `msg-${anchor.id}`,
      role: 'assistant',
      createdAt: anchor.createdAt,
      items: [item],
    })
  }
  if (rebuilt.length === 0) return serverMessages

  // Append rebuilt image bubbles AFTER the server messages, ordered only among
  // themselves by createdAt.
  //
  // Why not interleave by createdAt against the server timeline? The two
  // timestamps come from different clocks/lifecycle points and can't be
  // ordered reliably against each other:
  //   - A server assistant message is persisted at `turn_completed`.
  //   - The image anchor is the renderer `Date.now()` from when the tool
  //     resolved — which is BEFORE the turn completes.
  // So a chronological merge always sorts the image ABOVE that turn's assistant
  // text, even though live the bubble was appended at the BOTTOM of the turn.
  // That mismatch is the "image drifts up after reopening" bug. During the live
  // session `beginImageGeneration` simply pushes the bubble to the end, so the
  // faithful, drift-free reconstruction is to put it back at the end too.
  const ordered = rebuilt.slice().sort((a, b) => a.createdAt - b.createdAt)
  return [...serverMessages, ...ordered]
}
