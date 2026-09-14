import { useEffect, useCallback, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { classifyMediaKind } from '../../components/shared/media/MediaThumbnail'
import { useResolvedMediaSrc } from '../../components/shared/media/useResolvedMediaSrc'
import { toRenderableUri } from '../file-explorer/uri'
import { useAgentChatStore } from './store'
import {
  ANNOTATION_COLORS,
  RESIZE_PRESETS,
  annotatedFileName,
  buildImageFeedbackInstruction,
  composeAnnotatedImage,
  composeEraseMask,
  maskFileName,
  normalizePoint,
  renumberComments,
  strokeColor,
  summarizeStrokes,
  type AnnotationStroke,
  type ImageComment,
  type ImageToolAction,
  type ImageToolMode,
  type NormPoint,
} from './lightbox/imageTools'

let nextLocalId = 0
const localId = (prefix: string): string => `${prefix}_${Date.now().toString(36)}_${(nextLocalId++).toString(36)}`

/** jsdom's Blob has no arrayBuffer(); Response gives the same bytes everywhere. */
async function blobToArrayBuffer(blob: Blob): Promise<ArrayBuffer> {
  if (typeof blob.arrayBuffer === 'function') return blob.arrayBuffer()
  return new Response(blob).arrayBuffer()
}

/**
 * Full-screen media preview. Images additionally carry the D4 tool bar:
 * 标注 / 评论 / 移除背景 / 擦除 / 调整尺寸. Every tool ends the same way — an
 * annotated PNG copy is staged as an attachment and an instruction block is
 * appended to the composer, then the drawer takes over. That mirrors the
 * upstream Codex App browser-annotation model (screenshot + comments ride the
 * next turn) and needs no protocol change.
 */
export function Lightbox(): JSX.Element | null {
  const preview = useAgentChatStore((s) => s.preview)
  const closePreview = useAgentChatStore((s) => s.closePreview)
  const nextPreview = useAgentChatStore((s) => s.nextPreview)
  const prevPreview = useAgentChatStore((s) => s.prevPreview)

  // ---- tool state (reset whenever the shown image changes) ----
  const [mode, setMode] = useState<ImageToolMode | null>(null)
  // 标注颜色跨图记住(换图不重置):用户挑好一支笔,通常一整轮反馈都用它。
  const [annotateColor, setAnnotateColor] = useState<string>(ANNOTATION_COLORS[0].hex)
  const [strokes, setStrokes] = useState<AnnotationStroke[]>([])
  const [comments, setComments] = useState<ImageComment[]>([])
  const [draft, setDraft] = useState<{ at: NormPoint; text: string } | null>(null)
  const [resizeOpen, setResizeOpen] = useState(false)
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<string | null>(null)
  const drawingRef = useRef<AnnotationStroke | null>(null)
  const imgRef = useRef<HTMLImageElement>(null)
  const draftRef = useRef<HTMLTextAreaElement>(null)

  const currentMaybe = preview.images[preview.index]
  const currentUri = currentMaybe?.uri ?? ''

  useEffect(() => {
    setMode(null)
    setStrokes([])
    setComments([])
    setDraft(null)
    setResizeOpen(false)
    setSendError(null)
    drawingRef.current = null
  }, [currentUri, preview.open])

  useEffect(() => {
    if (draft) draftRef.current?.focus()
  }, [draft])

  const onKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (!preview.open) return
      // 视频聚焦时,把方向键留给视频自身的 seek/音量控制 —— 否则会出现
      // "ArrowLeft 同时倒退 5s + 切到上一张" 的双触发。Escape 仍由我们处理。
      const target = e.target as HTMLElement | null
      const targetIsVideo = target?.tagName === 'VIDEO'
      const typing = target?.tagName === 'TEXTAREA' || target?.tagName === 'INPUT'
      switch (e.key) {
        case 'Escape':
          if (draft) setDraft(null)
          else if (resizeOpen) setResizeOpen(false)
          else if (mode) setMode(null)
          else closePreview()
          break
        case 'ArrowLeft':
          if (!targetIsVideo && !typing) prevPreview()
          break
        case 'ArrowRight':
          if (!targetIsVideo && !typing) nextPreview()
          break
      }
    },
    [preview.open, closePreview, nextPreview, prevPreview, draft, resizeOpen, mode],
  )

  useEffect(() => {
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onKeyDown])

  // hook 必须 unconditional 在所有 early-return 之前 —— 用 ?? '' 让 hook 接受
  // 空 src 时优雅返回 null;empty/closed preview 走下面的 early return 不渲染。
  const rawSrc = currentUri.length > 0 ? toRenderableUri(currentUri) : ''
  const kindHint = (() => {
    if (!currentMaybe) return 'auto' as const
    const k = classifyMediaKind({
      kind: currentMaybe.kind,
      mime: currentMaybe.mime,
      name: currentMaybe.name,
    })
    return k ?? 'auto'
  })()
  // Same hook as MediaThumbnail — resolves local-file:// to a blob URL via
  // dedicated IPC (attachments:read-thumb), passes through everything else.
  // Without this the renderer fires GETs with the Windows drive letter
  // stripped (electron/electron#49073) and the protocol handler returns 500.
  //
  // `fullFidelity: true` skips the small-JPEG `media:thumb` hot path (which
  // is for chat thumbnails) and loads the original bytes. A 256px JPEG
  // would look obviously blurry at lightbox dimensions. See PR-A of
  // fix-codex-chat-image-attachment-lag for the routing contract.
  const resolvedSrc = useResolvedMediaSrc(rawSrc, kindHint, { fullFidelity: true })

  const hasMarks = strokes.length > 0 || comments.length > 0
  const instructionPreview = useMemo(
    () => (currentMaybe ? buildImageFeedbackInstruction({ imageName: currentMaybe.name, comments, strokes }) : ''),
    [currentMaybe, comments, strokes],
  )

  /**
   * The one exit every tool shares: stage the annotated copy + append the
   * instruction, hand over to the drawer. `action` adds the one-click intents
   * (移除背景 / 调整尺寸) that need no marks at all.
   */
  const sendToCodex = useCallback(
    async (action?: ImageToolAction) => {
      if (!currentMaybe) return
      if (!buildImageFeedbackInstruction({ imageName: currentMaybe.name, comments, strokes, action })) return
      setSending(true)
      setSendError(null)
      const store = useAgentChatStore.getState()
      // The copies are best-effort: if a canvas step fails (huge image, tainted
      // source) the instruction still goes — Codex can re-read the original
      // that is already in the thread by name.
      const img = imgRef.current
      const needsCopy = strokes.length > 0 || comments.length > 0 || Boolean(action)
      let maskName: string | undefined
      if (img && needsCopy) {
        try {
          const blob = await composeAnnotatedImage(img, strokes, comments)
          if (blob) {
            store.addAttachment({
              name: annotatedFileName(currentMaybe.name),
              mime: 'image/png',
              size: blob.size,
              buffer: await blobToArrayBuffer(blob),
            })
          }
        } catch (err) {
          setSendError(`标注副本生成失败,已只发送文字说明:${err instanceof Error ? err.message : String(err)}`)
        }
        // 擦除 → 真 inpainting 遮罩(OpenAI edits `mask`:alpha=0 = 重绘,尺寸同原图)。
        // 失败就回落到「红色区域」的文字描述,不阻塞发送。
        if (strokes.some((s) => s.kind === 'erase')) {
          try {
            const mask = await composeEraseMask(img, strokes)
            if (mask) {
              maskName = maskFileName(currentMaybe.name)
              store.addAttachment({
                name: maskName,
                mime: 'image/png',
                size: mask.size,
                buffer: await blobToArrayBuffer(mask),
              })
            }
          } catch (err) {
            setSendError(`遮罩生成失败,已改为文字描述擦除区域:${err instanceof Error ? err.message : String(err)}`)
          }
        }
      }
      const instruction = buildImageFeedbackInstruction({ imageName: currentMaybe.name, comments, strokes, action, maskName })
      store.appendInputText(instruction)
      useAgentChatStore.setState({ isOpen: true })
      setSending(false)
      closePreview()
    },
    [currentMaybe, comments, strokes, closePreview],
  )

  if (!preview.open || preview.images.length === 0) return null

  const current = currentMaybe
  if (!current) return null
  // Defensive: AttachmentCard already filters non-renderable items, but
  // a malformed entry would otherwise render <img src=""> which triggers
  // React's empty-src warning and breaks the layout.
  if (typeof current.uri !== 'string' || current.uri.length === 0) return null

  const kind = classifyMediaKind({ kind: current.kind, mime: current.mime, name: current.name })
  const totalCount = preview.images.length
  const hasMultiple = totalCount > 1
  const isImage = kind !== 'video'
  const drawingMode = mode === 'annotate' || mode === 'erase'

  // ---- pointer handlers on the image box ----
  const imageRect = (): DOMRect | null => imgRef.current?.getBoundingClientRect() ?? null

  const onImageClick = (e: React.MouseEvent<HTMLImageElement>): void => {
    e.stopPropagation()
    if (mode === 'comment') {
      const rect = imageRect()
      if (!rect) return
      setDraft({ at: normalizePoint(e.clientX, e.clientY, rect), text: '' })
      return
    }
    if (mode) return
    if (hasMultiple) nextPreview()
  }

  const onPointerDown = (e: React.PointerEvent<HTMLImageElement>): void => {
    if (!drawingMode) return
    e.preventDefault()
    e.stopPropagation()
    const rect = imageRect()
    if (!rect) return
    const stroke: AnnotationStroke = {
      id: localId('stroke'),
      kind: mode === 'erase' ? 'erase' : 'annotate',
      // 颜色钉在笔迹上:之后换色不影响已画的圈。
      ...(mode === 'erase' ? {} : { color: annotateColor }),
      points: [normalizePoint(e.clientX, e.clientY, rect)],
    }
    drawingRef.current = stroke
    setStrokes((prev) => [...prev, stroke])
    ;(e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId)
  }

  const onPointerMove = (e: React.PointerEvent<HTMLImageElement>): void => {
    const active = drawingRef.current
    if (!active) return
    const rect = imageRect()
    if (!rect) return
    const point = normalizePoint(e.clientX, e.clientY, rect)
    active.points = [...active.points, point]
    const snapshot = active
    setStrokes((prev) => prev.map((s) => (s.id === snapshot.id ? { ...snapshot } : s)))
  }

  const onPointerUp = (): void => {
    drawingRef.current = null
  }

  const commitDraft = (): void => {
    if (!draft) return
    const text = draft.text.trim()
    if (text) {
      setComments((prev) => renumberComments([...prev, { id: localId('c'), n: prev.length + 1, at: draft.at, text }]))
    }
    setDraft(null)
  }

  const removeComment = (id: string): void => {
    setComments((prev) => renumberComments(prev.filter((c) => c.id !== id)))
  }

  const toolButton = (
    label: string,
    active: boolean,
    onClick: () => void,
    icon: JSX.Element,
    extra = '',
  ): JSX.Element => (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={[
        'flex cursor-pointer items-center gap-1.5 rounded-full px-3 py-1.5 text-[12px] transition-colors',
        active ? 'bg-cyan-400/15 text-cyan-100' : 'text-zinc-300 hover:bg-zinc-800/80 hover:text-zinc-100',
        extra,
      ].join(' ')}
    >
      {icon}
      {label}
    </button>
  )

  const svg = (d: string): JSX.Element => (
    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={d} />
    </svg>
  )

  return (
    <div
      className="fixed inset-0 z-[50000] flex items-center justify-center bg-black/92"
      onClick={closePreview}
    >
      <div className="absolute left-4 right-4 top-4 flex items-center justify-between text-sm text-zinc-300">
        <span>
          {preview.index + 1} / {totalCount} · {current.name}
        </span>
        <button
          type="button"
          onClick={closePreview}
          className="text-zinc-400 hover:text-white text-xl"
          aria-label="Close preview"
        >
          ✕
        </button>
      </div>

      {isImage ? (
        <div
          className="absolute left-1/2 top-3 z-10 -translate-x-1/2"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="relative flex items-center gap-0.5 rounded-full border border-cyan-400/25 bg-zinc-950/80 px-1.5 py-1 backdrop-blur-md">
            {toolButton(
              '标注',
              mode === 'annotate',
              () => setMode((m) => (m === 'annotate' ? null : 'annotate')),
              mode === 'annotate' ? (
                // 激活时图标换成当前笔色的实心点,一眼知道下一笔是什么色。
                <span aria-hidden="true" className="inline-block h-3 w-3 rounded-full ring-1 ring-zinc-950/60" style={{ background: annotateColor }} />
              ) : (
                svg('M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z')
              ),
            )}
            {mode === 'annotate' ? (
              <span
                role="radiogroup"
                aria-label="标注颜色"
                className="mx-0.5 inline-flex items-center gap-1 rounded-full border border-cyan-400/20 bg-zinc-900/70 px-1.5 py-1"
              >
                {ANNOTATION_COLORS.map((c) => {
                  const checked = c.hex.toLowerCase() === annotateColor.toLowerCase()
                  return (
                    <button
                      key={c.hex}
                      type="button"
                      role="radio"
                      aria-label={c.label}
                      aria-checked={checked}
                      title={`${c.label}色圈注`}
                      onClick={(e) => {
                        e.stopPropagation()
                        setAnnotateColor(c.hex)
                      }}
                      className={[
                        'h-4 w-4 cursor-pointer rounded-full transition-transform hover:scale-110',
                        checked ? 'scale-110 ring-2 ring-cyan-300 ring-offset-1 ring-offset-zinc-950' : 'ring-1 ring-zinc-700/80',
                      ].join(' ')}
                      style={{ background: c.hex }}
                    />
                  )
                })}
              </span>
            ) : null}
            {toolButton('评论', mode === 'comment', () => setMode((m) => (m === 'comment' ? null : 'comment')), svg('M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2zM12 7v6M9 10h6'))}
            {toolButton('移除背景', false, () => void sendToCodex({ type: 'remove-bg' }), svg('M6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM20 4 8.12 15.88M14.47 14.48 20 20M8.12 8.12 12 12'))}
            {toolButton('擦除', mode === 'erase', () => setMode((m) => (m === 'erase' ? null : 'erase')), svg('m7 21-4.3-4.3c-1-1-1-2.5 0-3.4l9.6-9.6c1-1 2.5-1 3.4 0l5.6 5.6c1 1 1 2.5 0 3.4L13 21M22 21H7M5 11l9 9'))}
            {toolButton('调整尺寸', resizeOpen, () => setResizeOpen((v) => !v), svg('M21 3 9 15M21 3h-6M21 3v6M3 21l6-6M3 21h6M3 21v-6'))}
            <span className="mx-1 h-4 w-px bg-zinc-700" />
            {strokes.length > 0 ? (
              <button
                type="button"
                aria-label="撤销上一笔"
                onClick={() => setStrokes((prev) => prev.slice(0, -1))}
                className="cursor-pointer rounded-full px-2 py-1.5 text-[12px] text-zinc-400 hover:bg-zinc-800/80 hover:text-zinc-100"
              >
                撤销
              </button>
            ) : null}
            <button
              type="button"
              disabled={!hasMarks || sending}
              onClick={() => void sendToCodex()}
              className="cursor-pointer rounded-full bg-cyan-300 px-3 py-1.5 text-[12px] font-semibold text-zinc-950 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-zinc-700 disabled:text-zinc-400"
            >
              {sending ? '发送中…' : '发送给 Codex'}
            </button>
            {resizeOpen ? (
              <div
                role="menu"
                aria-label="目标尺寸"
                className="absolute right-0 top-[calc(100%+6px)] min-w-[220px] overflow-hidden rounded-lg border border-cyan-400/25 bg-zinc-950/95 py-1 text-[12px] text-zinc-200 shadow-2xl shadow-black/60 backdrop-blur-md"
              >
                {RESIZE_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    role="menuitem"
                    type="button"
                    onClick={() => {
                      setResizeOpen(false)
                      void sendToCodex({ type: 'resize', preset })
                    }}
                    className="flex w-full cursor-pointer items-center px-3 py-1.5 text-left hover:bg-cyan-400/10"
                  >
                    {preset.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      ) : null}

      {resolvedSrc == null ? (
        <div className="text-zinc-400 text-sm">Loading…</div>
      ) : kind === 'video' ? (
        <video
          src={resolvedSrc}
          controls
          autoPlay
          // 视频里点击 = 暂停/播放(浏览器原生行为),不走"下一张",
          // 否则用户连续点击播放区会变成翻页,违反直觉。
          // hasMultiple 时让用户用方向键 / 左右箭头切换。
          className="max-h-[80vh] max-w-[90vw] object-contain bg-black"
          onClick={(e) => e.stopPropagation()}
        />
      ) : (
        <div className="relative" onClick={(e) => e.stopPropagation()}>
          <img
            ref={imgRef}
            src={resolvedSrc}
            alt={current.name}
            draggable={false}
            className={[
              'max-h-[80vh] max-w-[90vw] object-contain select-none',
              comments.length > 0 || draft ? 'max-w-[62vw]' : '',
              drawingMode ? 'cursor-crosshair touch-none' : mode === 'comment' ? 'cursor-copy' : '',
            ].join(' ')}
            onClick={onImageClick}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerUp}
          />
          {strokes.length > 0 ? (
            <svg
              className="pointer-events-none absolute inset-0 h-full w-full"
              viewBox="0 0 1000 1000"
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {strokes.map((s) => (
                <polyline
                  key={s.id}
                  points={s.points.map((p) => `${p.x * 1000},${p.y * 1000}`).join(' ')}
                  fill="none"
                  stroke={strokeColor(s)}
                  strokeWidth={s.kind === 'erase' ? 14 : 6}
                  strokeOpacity={s.kind === 'erase' ? 0.85 : 1}
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  vectorEffect="non-scaling-stroke"
                />
              ))}
            </svg>
          ) : null}
          {comments.map((c) => (
            <button
              key={c.id}
              type="button"
              data-testid={`lightbox-pin-${c.n}`}
              title={c.text}
              onClick={(e) => {
                e.stopPropagation()
                removeComment(c.id)
              }}
              className="absolute flex h-6 w-6 -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full bg-cyan-300 font-mono text-[11px] font-semibold text-zinc-950 shadow ring-2 ring-zinc-950/60 hover:bg-red-300"
              style={{ left: `${c.at.x * 100}%`, top: `${c.at.y * 100}%` }}
            >
              {c.n}
            </button>
          ))}
          {draft ? (
            <div
              className="absolute z-10 w-[260px] rounded-lg border border-cyan-400/30 bg-zinc-950/95 p-2 shadow-2xl backdrop-blur-md"
              style={{ left: `min(${draft.at.x * 100}%, calc(100% - 270px))`, top: `calc(${draft.at.y * 100}% + 14px)` }}
              onClick={(e) => e.stopPropagation()}
            >
              <textarea
                ref={draftRef}
                aria-label="评论内容"
                rows={2}
                value={draft.text}
                placeholder="这里要改什么?Enter 确认 · Esc 取消"
                onChange={(e) => setDraft((d) => (d ? { ...d, text: e.target.value } : d))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    commitDraft()
                  } else if (e.key === 'Escape') {
                    e.preventDefault()
                    e.stopPropagation()
                    setDraft(null)
                  }
                }}
                className="w-full resize-none rounded-md border border-cyan-400/20 bg-black/40 px-2 py-1.5 text-[12px] text-cyan-50 outline-none placeholder:text-zinc-500 focus:border-cyan-300/50"
              />
              <div className="mt-1.5 flex justify-end gap-1.5">
                <button type="button" onClick={() => setDraft(null)} className="rounded px-2 py-0.5 text-[11px] text-zinc-400 hover:text-zinc-100">
                  取消
                </button>
                <button type="button" onClick={commitDraft} className="rounded bg-cyan-300 px-2 py-0.5 text-[11px] font-semibold text-zinc-950 hover:bg-cyan-200">
                  添加评论
                </button>
              </div>
            </div>
          ) : null}
          {mode ? (
            <div className="absolute bottom-3 left-1/2 -translate-x-1/2 whitespace-nowrap rounded-full border border-cyan-400/20 bg-zinc-950/80 px-3 py-1 text-[11px] text-zinc-400 backdrop-blur-md">
              {mode === 'comment' ? '点击图片放置评论钉 · Esc 退出' : mode === 'erase' ? '在要擦除的区域上涂红 · Esc 退出' : '在图上圈出要改的地方 · Esc 退出'}
            </div>
          ) : null}
        </div>
      )}

      {isImage && (comments.length > 0 || strokes.length > 0) ? (
        <aside
          className="absolute right-6 top-1/2 flex max-h-[72vh] w-[300px] -translate-y-1/2 flex-col rounded-xl border border-cyan-400/25 bg-zinc-950/90 backdrop-blur-md"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="border-b border-cyan-400/15 px-3 py-2.5">
            <div className="flex items-center justify-between">
              <span className="text-[12px] font-semibold text-cyan-50">
                评论 <span className="font-mono text-zinc-500">{comments.length}</span>
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] text-cyan-300/70">随下一条消息发送</span>
            </div>
            <p className="mt-1 text-[10px] leading-relaxed text-zinc-500">
              标注与评论会打包成「附加指令」,和这张图的带标注副本一起交给 Codex 做二次编辑。
            </p>
          </div>
          <ul className="flex-1 space-y-1 overflow-y-auto p-2 text-[12px]">
            {comments.map((c) => (
              <li key={c.id} className="group flex items-start gap-2 rounded-md px-2 py-1.5 hover:bg-zinc-800/60">
                <span className="mt-0.5 inline-flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-cyan-300 font-mono text-[10px] font-semibold text-zinc-950">
                  {c.n}
                </span>
                <span className="flex-1 leading-relaxed text-zinc-100">{c.text}</span>
                <button
                  type="button"
                  aria-label={`删除评论 ${c.n}`}
                  onClick={() => removeComment(c.id)}
                  className="text-zinc-600 opacity-0 transition group-hover:opacity-100 hover:text-red-300"
                >
                  ✕
                </button>
              </li>
            ))}
            {strokes.length > 0 ? (
              <li className="px-2 py-1.5 text-[11px] text-zinc-500">{summarizeStrokes(strokes)}</li>
            ) : null}
          </ul>
          {instructionPreview ? (
            <pre className="max-h-[120px] overflow-y-auto whitespace-pre-wrap border-t border-cyan-400/15 px-3 py-2 font-mono text-[10px] leading-relaxed text-zinc-500">
              {instructionPreview}
            </pre>
          ) : null}
          {sendError ? <p role="alert" className="px-3 pb-2 text-[11px] text-red-300">{sendError}</p> : null}
        </aside>
      ) : null}

      {hasMultiple && preview.index > 0 && (
        <button
          type="button"
          className="absolute left-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation()
            prevPreview()
          }}
          aria-label="Previous"
        >
          ‹
        </button>
      )}
      {hasMultiple && preview.index < totalCount - 1 && (
        <button
          type="button"
          className="absolute right-4 top-1/2 -translate-y-1/2 text-3xl text-zinc-400 hover:text-white"
          onClick={(e) => {
            e.stopPropagation()
            nextPreview()
          }}
          aria-label="Next"
        >
          ›
        </button>
      )}
    </div>
  )
}
