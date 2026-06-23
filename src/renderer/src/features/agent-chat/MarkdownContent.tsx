import { memo, useMemo, useState } from 'react'
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import type { Components } from 'react-markdown'
import { useFileExplorerStore } from '../file-explorer/store'
import { useAgentChatStore } from './store'
import { osPathFromHref, isImageHref } from '../file-explorer/revealInExplorer'
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
 * including `file://` and Windows drive paths (`C:\...`). That nukes the exact
 * links we want to make actionable (chat citations of generated images). Keep
 * local-file refs intact (osPathFromHref already blocks `..` traversal); defer
 * everything else to the default sanitizer so we don't widen the attack surface.
 */
function chatUrlTransform(url: string): string {
  if (osPathFromHref(url)) return url
  return defaultUrlTransform(url)
}

/**
 * A link click in an assistant message. We never want a chat citation of an
 * app-generated image to open an external browser tab:
 *  - LOCAL file (`file://` / `C:\...` / `/abs`) → reveal + open it in the left
 *    FILES panel (and its viewer).
 *  - Remote IMAGE url (R2/COS https) → open the in-chat lightbox, mirroring how
 *    chat image thumbnails behave ("点击后在聊天栏展示").
 *  - Anything else (real external links) → default browser behaviour.
 */
function handleChatLinkClick(e: React.MouseEvent<HTMLAnchorElement>, href: string | undefined): void {
  if (!href) return

  const osPath = osPathFromHref(href)
  if (osPath) {
    e.preventDefault()
    void useFileExplorerStore.getState().revealPath(osPath)
    return
  }

  if (/^https?:\/\//i.test(href) && isImageHref(href)) {
    e.preventDefault()
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
  const components = useMemo<Components>(
    () => ({
      // Disable raw HTML; default react-markdown already sanitises.
      a: ({ href, children, ...rest }) => (
        <a
          {...rest}
          href={href}
          target="_blank"
          rel="noreferrer"
          onClick={(e) => handleChatLinkClick(e, href)}
          className="text-cyan-300 underline-offset-2 hover:underline"
        >
          {children}
        </a>
      ),
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
    [],
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
