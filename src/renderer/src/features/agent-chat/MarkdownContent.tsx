import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useFileExplorerStore } from '../file-explorer/store'
import { useAgentChatStore } from './store'
import { isImageHref } from '../file-explorer/revealInExplorer'
import { parseFileCitation, type FileCitation } from '../file-explorer/fileCitation'
import type { AttachmentRef } from '../../../../types/agent-timeline'

const IMAGE_MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
  avif: 'image/avif',
  bmp: 'image/bmp',
  svg: 'image/svg+xml',
}

function mimeFromHref(href: string): string {
  const ext = href.split(/[?#]/)[0].split('.').pop()?.toLowerCase() ?? ''
  return IMAGE_MIME_BY_EXT[ext] ?? 'image/png'
}

/**
 * react-markdown's default URL sanitizer strips every non-http(s) scheme,
 * including `file://`, Windows drive paths (`C:\...`) AND the editor citation
 * URIs Codex emits by default (`vscode://file/...` — see fileCitation.ts for
 * why those show up at all). A stripped href renders as a blue underlined link
 * whose click does nothing, which is the worst of both worlds. Keep anything we
 * can resolve to a real file; defer the rest to the default sanitizer so we
 * don't widen the attack surface.
 */
function chatUrlTransform(url: string): string {
  if (parseFileCitation(url, { workspaceRoot: currentWorkspaceRoot() })) return url
  return defaultUrlTransform(url)
}

function currentWorkspaceRoot(): string | null {
  return useFileExplorerStore.getState().workspaceRoot
}

type ChatHrefKind =
  | { kind: 'file'; citation: FileCitation }
  | { kind: 'image'; href: string }
  | { kind: 'external'; href: string }
  | { kind: 'dead' }

/**
 * What should a click on this href do? Resolved at RENDER time, not click time,
 * so we can refuse to render an anchor we know we cannot honour — a link that
 * looks clickable and silently does nothing is a bug report waiting to happen,
 * and in a packaged build that is exactly what happens: the renderer runs over
 * `file://`, so anything not http(s) is swallowed by the main process
 * `setWindowOpenHandler` deny with no feedback at all.
 */
function classifyChatHref(href: string | undefined, workspaceRoot: string | null): ChatHrefKind {
  if (!href) return { kind: 'dead' }

  const citation = parseFileCitation(href, { workspaceRoot })
  if (citation) return { kind: 'file', citation }

  if (/^https?:\/\//i.test(href)) {
    return isImageHref(href) ? { kind: 'image', href } : { kind: 'external', href }
  }
  // In-document anchors and mailto: keep working through the browser default.
  if (href.startsWith('#') || /^(mailto|tel):/i.test(href)) return { kind: 'external', href }

  return { kind: 'dead' }
}

/**
 * A link click in an assistant message. We never want a chat citation of an
 * app-generated file to open an external browser tab:
 *  - LOCAL file (`vscode://file/...` / `file://` / `C:\...` / `src/a.ts:42`) →
 *    reveal + open it in the left FILES panel, jumping to the cited line.
 *  - Remote IMAGE url (R2/COS https) → open the in-chat lightbox, mirroring how
 *    chat image thumbnails behave ("点击后在聊天栏展示").
 *  - Anything else (real external links) → default browser behaviour.
 */
function handleChatLinkClick(e: React.MouseEvent<HTMLAnchorElement>, target: ChatHrefKind): void {
  if (target.kind === 'file') {
    e.preventDefault()
    const { path, line, col } = target.citation
    void useFileExplorerStore.getState().revealPath(path, line ? { line, col } : undefined)
    return
  }

  if (target.kind === 'image') {
    e.preventDefault()
    const href = target.href
    const ref: AttachmentRef = {
      id: `chat-link-${Date.now()}`,
      kind: 'image',
      name: decodeURIComponent(href.split(/[?#]/)[0].split('/').pop() || 'image'),
      mime: mimeFromHref(href),
      size: 0,
      uri: href,
    }
    useAgentChatStore.getState().openPreview([ref], 0)
  }
}

/**
 * Renders an AI-emitted markdown blob with Cursor-style code blocks:
 * - All fenced code gets a `[Copy]` button.
 * - When the info string carries a path suffix (e.g. ```ts:src/foo.ts```),
 *   a `[Apply]` button shows up that routes through ConflictModal so the
 *   user always reviews the change before it touches disk.
 *
 * Rendered inline in the assistant TextCard. We deliberately keep markup
 * minimal (Tailwind only, no global CSS) so it nests correctly inside the
 * compact 13px chat layout.
 */
// Memoized on `source`: react-markdown + remark-gfm re-parse the FULL string on
// every render. Without memo, a delta on the streaming bubble re-parsed markdown
// for that bubble even when neighboring re-renders changed nothing. With memo,
// only a changed `source` triggers a reparse (the streaming bubble still
// reparses as it grows — coalescing bounds that to ~1/frame; settled bubbles
// never reparse). Single primitive prop → default shallow compare is exact.
function MarkdownContentImpl({ source }: { source: string }) {
  const workspaceRoot = useFileExplorerStore((s) => s.workspaceRoot)
  const components = useMemo<Components>(
    () => ({
      // Disable raw HTML; default react-markdown already sanitises.
      a: ({ href, children, ...rest }) => {
        const target = classifyChatHref(href, workspaceRoot)
        // Nothing we can do with it → render the label as plain text rather
        // than a blue link that eats the click. See classifyChatHref.
        if (target.kind === 'dead') return <>{children}</>
        return (
          // `draggable={false}` is load-bearing, not cosmetic: Chromium/Electron
          // makes every `<a href>` draggable by default, so dragging across the
          // link starts a NATIVE LINK DRAG instead of a text selection — the user
          // can never select/copy the blue text — and a click with the slightest
          // pointer movement is swallowed as a drag-start so `onClick` never fires
          // (= "can't jump"). Disabling drag restores both copy (drag → text
          // selection) and reliable clicks. `select-text` defends against any
          // ancestor `select-none` leaking in.
          <a
            {...rest}
            href={href}
            target="_blank"
            rel="noreferrer"
            draggable={false}
            title={target.kind === 'file' ? target.citation.path : undefined}
            onClick={(e) => handleChatLinkClick(e, target)}
            className="cursor-pointer select-text text-cyan-300 underline-offset-2 hover:underline"
          >
            {children}
          </a>
        )
      },
      h1: ({ children }) => (
        <div className="mt-3 text-[15px] font-semibold text-zinc-50">{children}</div>
      ),
      h2: ({ children }) => (
        <div className="mt-3 text-[14px] font-semibold text-zinc-50">{children}</div>
      ),
      h3: ({ children }) => (
        <div className="mt-2 text-[13px] font-semibold text-zinc-100">{children}</div>
      ),
      ul: ({ children }) => (
        <ul className="my-1 list-disc space-y-0.5 pl-5 marker:text-zinc-500">{children}</ul>
      ),
      ol: ({ children }) => (
        <ol className="my-1 list-decimal space-y-0.5 pl-5 marker:text-zinc-500">{children}</ol>
      ),
      li: ({ children }) => <li>{children}</li>,
      p: ({ children }) => <p className="my-1.5 leading-[1.55]">{children}</p>,
      blockquote: ({ children }) => (
        <blockquote className="my-2 border-l-2 border-cyan-500/40 bg-cyan-500/5 px-3 py-1 text-cyan-100/85">
          {children}
        </blockquote>
      ),
      table: ({ children }) => (
        <div className="my-2 overflow-x-auto rounded border border-zinc-800/80">
          <table className="min-w-full border-collapse text-[12px]">{children}</table>
        </div>
      ),
      thead: ({ children }) => (
        <thead className="bg-zinc-900/70 text-zinc-300">{children}</thead>
      ),
      th: ({ children }) => (
        <th className="border-b border-zinc-800/60 px-2 py-1 text-left font-medium">{children}</th>
      ),
      td: ({ children }) => (
        <td className="border-b border-zinc-900/40 px-2 py-1 align-top">{children}</td>
      ),
      // Inline code: `foo`
      // Block code: ```ts ... ``` or ```ts:path/to/file.ts ... ```
      code: ({ className, children }) => {
        const raw = String(children ?? '').replace(/\n$/, '')
        const info = parseLanguageInfo(className)
        if (!info.isBlock) {
          return (
            <code className="rounded bg-zinc-800/70 px-1 py-0.5 font-mono text-[12px] text-cyan-100">
              {children}
            </code>
          )
        }
        return <CodeBlock language={info.lang} path={info.path} content={raw} />
      },
      // react-markdown nests <code> inside <pre>; we already handle styling
      // in <code>, so make <pre> a transparent passthrough to avoid
      // double-padding/double-borders.
      pre: ({ children }) => <>{children}</>,
    }),
    [workspaceRoot],
  )

  return (
    <div className="markdown-content text-[13px] leading-[1.55] text-zinc-100">
      <ReactMarkdown remarkPlugins={[remarkGfm]} urlTransform={chatUrlTransform} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

export const MarkdownContent = memo(MarkdownContentImpl)

interface LanguageInfo {
  isBlock: boolean
  lang?: string
  path?: string
}

/**
 * Parses the `className` react-markdown puts on fenced code:
 *   ```ts            -> language-ts
 *   ```ts:src/x.ts   -> language-ts:src/x.ts  (CommonMark info-string)
 *
 * Inline code has no `language-*` prefix, so we use that as the block test.
 * The split on the FIRST colon lets paths contain colons on Windows
 * (`D:\foo`) without choking — they just won't be recognised as paths.
 */
export function parseLanguageInfo(className: string | undefined): LanguageInfo {
  if (!className) return { isBlock: false }
  const m = /language-([^\s]+)/.exec(className)
  if (!m) return { isBlock: false }
  const info = m[1]
  const colonIdx = info.indexOf(':')
  if (colonIdx === -1) return { isBlock: true, lang: info }
  return {
    isBlock: true,
    lang: info.slice(0, colonIdx),
    path: info.slice(colonIdx + 1) || undefined,
  }
}

function CodeBlock({
  language,
  path,
  content,
}: {
  language?: string
  path?: string
  content: string
}) {
  const [copied, setCopied] = useState(false)
  const [applyState, setApplyState] = useState<'idle' | 'applying' | 'error'>('idle')
  const requestApply = useFileExplorerStore((s) => s.requestApplyExternalContent)

  const handleCopy = async () => {
    try {
      await navigator.clipboard?.writeText(content)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  const handleApply = async () => {
    if (!path) return
    setApplyState('applying')
    const res = await requestApply(path, content)
    setApplyState(res.ok ? 'idle' : 'error')
  }

  return (
    <div className="my-2 overflow-hidden rounded-md border border-zinc-800/70 bg-zinc-950/70">
      <div className="flex items-center justify-between gap-2 border-b border-zinc-800/60 bg-zinc-900/70 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-zinc-400">
        <div className="flex min-w-0 items-center gap-2">
          {language && (
            <span className="rounded bg-zinc-800/80 px-1.5 py-0.5 text-[9px] text-cyan-200">
              {language}
            </span>
          )}
          {path && (
            <span className="truncate font-mono text-[10px] normal-case tracking-normal text-zinc-300" title={path}>
              {path}
            </span>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {path && (
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={applyState === 'applying'}
              className={
                'rounded px-1.5 py-0.5 text-[10px] tracking-normal transition ' +
                (applyState === 'error'
                  ? 'border border-red-500/40 text-red-200 hover:bg-red-500/10'
                  : 'border border-cyan-500/30 text-cyan-200 hover:bg-cyan-500/10 disabled:opacity-50')
              }
              title="Open this file and review the diff before saving"
            >
              {applyState === 'applying' ? 'Applying…' : applyState === 'error' ? 'Retry' : 'Apply'}
            </button>
          )}
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="rounded border border-zinc-700/60 px-1.5 py-0.5 text-[10px] tracking-normal text-zinc-200 transition hover:bg-zinc-700/40"
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      </div>
      <pre className="m-0 overflow-x-auto p-2.5 font-mono text-[12px] leading-[1.55] text-zinc-100">
        <code>{content}</code>
      </pre>
    </div>
  )
}
