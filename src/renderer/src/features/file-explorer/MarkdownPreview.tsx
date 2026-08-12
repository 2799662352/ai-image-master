/**
 * Markdown 预览 —— 文件查看器里 `.md` 的渲染视图。
 *
 * 排版度量搬自 VS Code 内置预览(见 markdownPreview.css 顶部说明),渲染管线
 * 用我们自己已有的 react-markdown + remark-gfm:
 *
 *  - **不套 iframe**。VS Code 那道 webview 边界是给第三方扩展注入 HTML/CSS/JS
 *    用的安全闸,我们没有扩展这个概念;套上反而会弄坏本地链接跳文件树、选中
 *    拖到聊天栏,还得为本地图片另造一套资源协议。
 *  - **比 VS Code 多出 GFM**。VS Code 官方文档明说它只跟 CommonMark、不支持
 *    GFM;remark-gfm 把表格、删除线、任务列表都带上了,换成 markdown-it 是降级。
 *
 * 每个块级元素带 `data-line`(源码行号)+ `.code-line` 类,滚动同步靠它对齐 ——
 * 类名沿用 VS Code 的叫法。同一个 document 里做同步不需要 postMessage。
 */

import { memo, useMemo, useState, type ReactNode } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { useFileExplorerStore } from './store'
import { useFileUrl } from './useFileUrl'
import { isDirectHref, resolveDocRelativePath } from './markdownDocLinks'
import './markdownPreview.css'

type ShellBridge = { openExternal?: (url: string) => Promise<unknown> }

function openExternal(url: string): void {
  const shell = (window as Window & { electronAPI?: { shell?: ShellBridge } }).electronAPI?.shell
  void shell?.openExternal?.(url)
}

/** hast 节点 → 滚动同步锚点属性。位置信息缺失(合成节点)时不加锚点。 */
function lineAnchor(node: unknown): { className: string; 'data-line'?: number } {
  const line = (node as { position?: { start?: { line?: number } } } | undefined)?.position?.start?.line
  return typeof line === 'number' ? { className: 'code-line', 'data-line': line } : { className: '' }
}

/**
 * 本地图片。渲染端不能把磁盘路径直接塞进 `<img src>` —— Windows 上盘符会在自定义
 * 协议解析时被吞掉(electron#49073,详见 useFileUrl 模块注释),所以统一经 IPC
 * 读字节转 blob:。
 */
function LocalImage({ path, alt }: { path: string; alt: string }) {
  const file = useFileUrl(path)
  if (file.status === 'loading') {
    return <span className="fx-md-img-placeholder">载入图片…</span>
  }
  if (file.status === 'error') {
    return (
      <span className="fx-md-img-placeholder" title={`${path}\n${file.reason}`}>
        图片打不开:{alt || path}
      </span>
    )
  }
  return <img src={file.url} alt={alt} />
}

function CodeBlock({ children }: { children: ReactNode }) {
  const [copied, setCopied] = useState(false)
  const text = useMemo(() => extractText(children), [children])

  const copy = async () => {
    try {
      await navigator.clipboard?.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1200)
    } catch {
      setCopied(false)
    }
  }

  return (
    <pre>
      <button
        type="button"
        onClick={() => void copy()}
        className="fx-md-copy"
        aria-label="复制代码"
      >
        {copied ? '已复制' : '复制'}
      </button>
      {children}
    </pre>
  )
}

/** 递归取出 children 的纯文本(复制按钮要原文,不要 JSX)。 */
function extractText(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractText).join('')
  const props = (node as { props?: { children?: ReactNode } }).props
  return props ? extractText(props.children) : ''
}

function MarkdownPreviewImpl({ source, docPath }: { source: string; docPath: string }) {
  const revealPath = useFileExplorerStore((s) => s.revealPath)

  const components = useMemo<Components>(() => {
    const block = (Tag: 'p' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'blockquote' | 'ul' | 'ol' | 'hr' | 'table') =>
      ({ node, children }: { node?: unknown; children?: ReactNode }) => {
        const anchor = lineAnchor(node)
        return Tag === 'hr' ? <hr {...anchor} /> : <Tag {...anchor}>{children}</Tag>
      }

    return {
      p: block('p'),
      h1: block('h1'),
      h2: block('h2'),
      h3: block('h3'),
      h4: block('h4'),
      h5: block('h5'),
      h6: block('h6'),
      blockquote: block('blockquote'),
      ul: block('ul'),
      ol: block('ol'),
      hr: block('hr'),
      table: block('table'),
      a: ({ href, children }) => (
        <a
          href={href}
          draggable={false}
          onClick={(e) => {
            if (!href) return
            const local = resolveDocRelativePath(docPath, href)
            if (local) {
              e.preventDefault()
              void revealPath(local)
              return
            }
            if (isDirectHref(href)) {
              e.preventDefault()
              openExternal(href)
            }
            // 纯锚点交给浏览器默认行为(文档内跳转)
          }}
        >
          {children}
        </a>
      ),
      img: ({ src, alt }) => {
        const raw = typeof src === 'string' ? src : ''
        const local = resolveDocRelativePath(docPath, raw)
        if (local) return <LocalImage path={local} alt={alt ?? ''} />
        return <img src={raw} alt={alt ?? ''} />
      },
      // 代码块的复制按钮挂在 <pre> 上;行内 code 走 CSS,不需要组件覆盖。
      pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
    }
  }, [docPath, revealPath])

  return (
    <div className="fx-md" data-testid="fx-md-preview">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  )
}

// 单一字符串 prop + 稳定的 docPath:默认浅比较就够。react-markdown 每次渲染都会
// 整份重解析,不 memo 的话编辑器每敲一个字都要重解析整篇(而分栏模式下编辑器
// 本来就在逐字符更新)。
export const MarkdownPreview = memo(MarkdownPreviewImpl)
