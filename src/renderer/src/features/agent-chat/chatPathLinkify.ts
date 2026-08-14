/**
 * 把助手正文里**裸写**的文件路径变成候选链接。
 *
 * ## 为什么还需要这一层
 *
 * Codex 只重写一种东西:它的 `CITATION_REGEX` 是
 * `【F:([^†]+)†L(\d+)(?:-L(\d+|\?))?】`,只认模型显式写出的那个引用记号,按
 * `file_opener` 改写成 `vscode://file/...`(这条通道由 `fileCitation.ts` 接住)。
 * 正文里随手写的 `src/a.ts`、`latest.yml`、`见 D:\proj\x.md:42` 一律原样输出,
 * 在聊天里就是纯文本。
 *
 * VS Code Copilot Chat 的分层完全一样:模型给的规范链接走
 * `ModelFilePathLinkifier`,`FilePathLinkifier` 只是**兜底**,负责正文里的裸路径
 * 与行内代码。本模块就是那个兜底,候选形态也照它的正则取:
 *
 * ```js
 * /(?<!\[)`(?<inlineCodePath>[^`\s${}]+)`(?!\])/     // 行内代码
 * /(?<![\[`()<])(?<plainTextPath>[^\s`*${}()]+\.[^\s`*${}()]+)(?![\]`])/  // 纯文本
 * ```
 *
 * 两处刻意与它不同:
 *
 *  - **行内代码不用正则**。我们在 mdast 上工作,`inlineCode` 本来就是独立节点,
 *    不必从原始 markdown 里把反引号再抠一遍 —— 那正则要靠前后 `[` `]` 的
 *    lookaround 去避开 `` [`a`](url) ``,而我们跳过整棵 link 子树就完事了。
 *  - **要求扩展名像扩展名**。VS Code 只要求「含一个点」,那会把 `4.5.9`、`v1.2`
 *    这类版本号也收进来。我们额外要求最后一段是字母开头的 1–8 位,把版本号挡在
 *    外面 —— 它们在聊天里出现得比路径还频繁,每个都去 stat 一次纯属浪费。
 *
 * ## 这里只做语法提取,不做判定
 *
 * 本模块**不**决定某个候选到底是不是文件 —— 那要问磁盘,是异步的。它只把候选
 * span 包成一个带哨兵 scheme 的 link 节点,交给渲染层的 `PathCandidate`:验证
 * 通过才变成蓝色可点,验证不过原样退回纯文本。
 *
 * 顺序反过来(先标蓝再验证)就会造出一批点不动的蓝字 —— 那正是这一整轮工作要
 * 消灭的东西,不能在修它的过程中又造一批。
 */

/** 哨兵 scheme。`MarkdownContent` 的 `a` 覆写据此认出候选。 */
export const CHAT_PATH_SCHEME = 'chat-path:'

export function chatPathHref(raw: string): string {
  return `${CHAT_PATH_SCHEME}${encodeURIComponent(raw)}`
}

export function rawFromChatPathHref(href: string): string | null {
  if (!href.startsWith(CHAT_PATH_SCHEME)) return null
  try {
    return decodeURIComponent(href.slice(CHAT_PATH_SCHEME.length))
  } catch {
    return null
  }
}

/**
 * 候选 token 的边界字符。排除的都是 markdown 结构字符或标点 —— 它们绝不会出现
 * 在路径里,却经常紧贴着路径出现(`见 src/a.ts,然后`)。
 *
 * **半角逗号也排除**,这是中文正文特有的坑:中文不用空格分词,`src/a.ts,顺手看了`
 * 会一路吃到汉字里去。VS Code 那条正则靠空格断词,在英文里够用,在这里不够。
 * 代价是含逗号的文件名认不出来 —— 那种文件名基本不存在,而且这一层认错也只是
 * 白问一次磁盘、退回纯文本,不会留下坏链接。
 *
 * ASCII 冒号**不排除**:`src/a.ts:42` 的行号后缀要靠它。
 */
const TOKEN_RE = /[^\s`*${}()[\]<>"'|,，。、；：！？【】]+/gu

/** 结尾的句读不属于路径(`见 src/a.ts.` / `src/a.ts,`)。 */
const TRAILING_PUNCT_RE = /[.,;:!?]+$/

/** 已经是个 URL 的交给别处(remark-gfm 的 autolink / 我们的引用解析)。 */
const HAS_SCHEME_RE = /^[a-z][a-z0-9+.-]*:\/\//i

/**
 * 最后一段像不像扩展名:字母开头的 1–8 位字母数字。
 * `a.ts` `latest.yml` `x.tar.gz` 收;`4.5.9` `v1.2` `127.0.0.1` 不收。
 */
const EXTENSION_RE = /\.[A-Za-z][A-Za-z0-9]{0,7}$/

/** 行号后缀在判定扩展名之前要先摘掉,否则 `a.ts:42` 的末段是 `42`。 */
const LINE_SUFFIX_RE = /(?::\d+){1,2}$|#L\d+(?:-L?\d+)?$/i

/**
 * 这个 token 值不值得去问一次磁盘。纯语法判断,宁可漏不可滥 —— 每个 true 都是
 * 一次 IPC。
 */
export function looksLikePath(token: string): boolean {
  if (token.length === 0 || token.length > 260) return false
  if (HAS_SCHEME_RE.test(token)) return false

  const body = token.replace(LINE_SUFFIX_RE, '')
  if (body.length === 0) return false

  const hasSeparator = body.includes('/') || body.includes('\\')
  // 带分隔符的即使没扩展名也算(`src/a`);不带分隔符的必须像个文件名
  // (`latest.yml`),否则满屏普通词都会被收进来。
  return hasSeparator || EXTENSION_RE.test(body)
}

export interface PathSpan {
  start: number
  end: number
  raw: string
}

/** 从一段纯文本里挑出路径候选的位置。 */
export function extractPathSpans(text: string): PathSpan[] {
  const spans: PathSpan[] = []
  TOKEN_RE.lastIndex = 0
  for (const match of text.matchAll(TOKEN_RE)) {
    const index = match.index ?? 0
    const trimmed = match[0].replace(TRAILING_PUNCT_RE, '')
    if (trimmed.length === 0) continue
    if (!looksLikePath(trimmed)) continue
    spans.push({ start: index, end: index + trimmed.length, raw: trimmed })
  }
  return spans
}

// ── mdast ────────────────────────────────────────────────────────────────────
//
// 手写遍历而不是拉 `unist-util-visit`:它只是 react-markdown 的传递依赖,直接
// import 等于把没写进 package.json 的东西当自己的依赖用。要的逻辑就下面这些行。

interface MdNode {
  type: string
  value?: string
  url?: string
  title?: string | null
  children?: MdNode[]
}

/**
 * 不进去找候选的子树:
 *  - `link` / `linkReference` / `definition`:已经是链接了,再包一层没意义,
 *    而且会把 `[看这里](x.md)` 的**标签**也标成路径。
 *  - `image` / `imageReference`:alt 文本不是路径。
 *  - `code`:围栏代码块整块交给 CodeBlock(有 Copy / Apply),不逐词标链接。
 *  - `html`:我们本来就禁了原始 HTML。
 */
const OPAQUE_TYPES = new Set([
  'link',
  'linkReference',
  'definition',
  'image',
  'imageReference',
  'code',
  'html',
])

function wrap(child: MdNode, raw: string): MdNode {
  return { type: 'link', url: chatPathHref(raw), title: null, children: [child] }
}

function splitTextNode(node: MdNode): MdNode[] | null {
  const text = node.value ?? ''
  const spans = extractPathSpans(text)
  if (spans.length === 0) return null

  const out: MdNode[] = []
  let cursor = 0
  for (const span of spans) {
    if (span.start > cursor) {
      out.push({ type: 'text', value: text.slice(cursor, span.start) })
    }
    out.push(wrap({ type: 'text', value: span.raw }, span.raw))
    cursor = span.end
  }
  if (cursor < text.length) out.push({ type: 'text', value: text.slice(cursor) })
  return out
}

function transform(node: MdNode): void {
  const children = node.children
  if (!Array.isArray(children)) return

  const next: MdNode[] = []
  let changed = false

  for (const child of children) {
    if (OPAQUE_TYPES.has(child.type)) {
      next.push(child)
      continue
    }

    if (child.type === 'text') {
      const split = splitTextNode(child)
      if (split) {
        next.push(...split)
        changed = true
        continue
      }
      next.push(child)
      continue
    }

    if (child.type === 'inlineCode') {
      const raw = (child.value ?? '').trim()
      if (raw.length > 0 && looksLikePath(raw)) {
        // 包在 link 里而不是替换掉:行内代码该长什么样还长什么样,验证通过后
        // 只是外面多了一层可点的锚。
        next.push(wrap(child, raw))
        changed = true
        continue
      }
      next.push(child)
      continue
    }

    transform(child)
    next.push(child)
  }

  if (changed) node.children = next
}

/**
 * remark 插件。挂在 remark-gfm 之后 —— gfm 的 autolink 会先把 `https://…` 变成
 * link 节点,而 link 是我们的不透明类型,于是天然不会去动它。
 */
export function remarkChatPaths() {
  return (tree: MdNode): void => {
    transform(tree)
  }
}
