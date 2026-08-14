/**
 * 聊天栏里「模型引用了一个文件」的目标解析。
 *
 * 为什么单独一个模块,而不是塞进 `revealInExplorer.ts`:那边的 `osPathFromHref`
 * 只回答「这个 href 是不是一个绝对本地路径」,是个窄函数,被预览侧也复用着。
 * 这里要回答的是更大的问题 —— **Codex 引用文件时到底会写成什么样**,答案有四五
 * 种形态,还带行号。
 *
 * ## 为什么必须认 `vscode://file/...`
 *
 * Codex 的 `file_opener` 配置项决定它把文件引用重写成哪种 URI scheme,
 * **默认值是 `vscode`**(官方 config 参考:`vscode | vscode-insiders | windsurf |
 * cursor | none`)。也就是说,只要不显式关掉,模型正文里的 `src/a.ts:42` 到了
 * 我们手上已经是 `[src/a.ts:42](vscode://file/D:/proj/src/a.ts:42)`。
 *
 * react-markdown 的默认 URL 清洗器只放行 http(s)/mailto 等少数 scheme,其余
 * 一律把 href 抹成空串 —— 于是链接照样渲染成蓝色带下划线,点下去却什么都不
 * 发生。这正是「有些高亮链接点不动」的根因,而且是**静默**的:打包版里
 * `setWindowOpenHandler` 对非 http(s) 直接 deny,连报错都没有。
 *
 * 我们同时钉死 `file_opener`(见 `codexLaunch.ts`)并在这里认下四种 scheme:
 * 钉死是为了不让默认值随 Codex 版本漂,认全四种是为了用户手改了配置也不会瞎。
 * 这些 URI 永远不出渲染进程 —— 我们自己就是那个编辑器。
 *
 * ## 为什么行号从末尾往回认
 *
 * VS Code 终端链接解析在 2023 年做过一次重构(microsoft/vscode#172930),结论是
 * **先认后缀再回扫路径**,反过来做会分不清哪一段是路径、哪一段是 `:10:5`。
 * Windows 上尤其致命:`D:/a/b.ts:42` 按第一个冒号切会得到 `D`。所以下面所有
 * 行号后缀都锚在字符串末尾匹配。
 *
 * `#L12` / `#L12-L20` 这种 GitHub 式锚点也认:VS Code 在
 * microsoft/vscode#296821 里专门支持了它,理由原话是「我们就是这么教 LLM 在
 * markdown 里写链接的」。
 *
 * 和这个仓库其它路径解析一样,**不用 `new URL()`** —— Chromium 对标准 scheme 会
 * 折叠 Windows 盘符(`new URL('file:///C:/x').pathname` → `/x`),会把路径悄悄
 * 改错。全部走纯字符串解析。
 */

/** 一次文件引用:绝对 OS 路径 + 可选的 1-based 行/列。 */
export interface FileCitation {
  path: string
  line?: number
  col?: number
}

/**
 * Codex `file_opener` 支持的全部编辑器 scheme。`none` 不在此列 —— 那个值表示
 * 不生成链接,正文里留的是裸路径,由下面的裸路径分支兜住。
 */
const EDITOR_SCHEME_RE = /^(?:vscode|vscode-insiders|cursor|windsurf):\/\/file(?=[/\\]|$)/i

const LOCAL_SCHEME_RE = /^(?:file:\/\/|local-file:\/\/)/i

/** 明确不是本地文件的 scheme,交回给调用方走默认行为(外部浏览器等)。 */
const FOREIGN_SCHEME_RE = /^(?:blob|data|https?|mailto|tel|ftp|about|javascript):/i

/** 末尾的 `:12` / `:12:5`。锚在末尾,免得吃掉 Windows 盘符的冒号。 */
const TRAILING_LINE_COL_RE = /:(\d+)(?::(\d+))?$/

/** GitHub 式锚点:`#L12`、`#L12-L20`、`#L12,5`,以及裸 `#12`。 */
const LINE_FRAGMENT_RE = /^#L?(\d+)(?:[,:](\d+))?(?:-L?\d+(?:[,:]\d+)?)?$/i

interface Suffix {
  body: string
  line?: number
  col?: number
}

/**
 * 把行号后缀从目标串上摘下来。锚点优先于冒号后缀:`a.ts#L3` 里的 `#L3` 是明确
 * 的锚点语义,而冒号形态要更小心(路径本身就可能含冒号)。
 */
function splitLineSuffix(raw: string): Suffix {
  const hashIdx = raw.lastIndexOf('#')
  if (hashIdx >= 0) {
    const fragment = raw.slice(hashIdx)
    const m = LINE_FRAGMENT_RE.exec(fragment)
    if (m) {
      return { body: raw.slice(0, hashIdx), line: Number(m[1]), col: m[2] ? Number(m[2]) : undefined }
    }
    // 不是行号锚点(`#some-heading`)—— 锚点不属于路径,丢掉。
    return { body: raw.slice(0, hashIdx) }
  }

  const m = TRAILING_LINE_COL_RE.exec(raw)
  if (m) {
    return { body: raw.slice(0, m.index), line: Number(m[1]), col: m[2] ? Number(m[2]) : undefined }
  }
  return { body: raw }
}

function decodeSafe(input: string): string {
  try {
    return decodeURIComponent(input)
  } catch {
    // 不是合法百分号编码就按原样当路径,总比整条丢掉强。
    return input
  }
}

function hasTraversal(input: string): boolean {
  return input.split(/[\\/]/).some((segment) => segment === '..')
}

/** 目标串 → 绝对 OS 路径;不是绝对本地路径时返回空串。 */
function absolutePathFrom(input: string): string {
  if (input.length === 0) return ''

  // `file:///C:/...` 解码后是 `/C:/...`,前导斜杠是 URL 的、不是路径的。
  // 允许多条:`vscode://file//D:/x` 这种 authority 后又带根斜杠的形态也见得到。
  const winLed = /^\/+([A-Za-z]:[\\/].*)$/.exec(input)
  if (winLed) return winLed[1]

  if (/^[A-Za-z]:[\\/]/.test(input)) return input
  if (input.startsWith('/') && !input.startsWith('//')) return input
  return ''
}

/** 压掉 `.` 段并按 root 的分隔符风格拼接。`..` 在调用前已被拒。 */
function joinWithRoot(root: string, relative: string): string {
  const sep = root.includes('\\') ? '\\' : '/'
  const trimmedRoot = root.replace(/[\\/]+$/, '')
  const segments = relative.split(/[\\/]/).filter((s) => s.length > 0 && s !== '.')
  if (segments.length === 0) return ''
  return `${trimmedRoot}${sep}${segments.join(sep)}`
}

function isWindowsRoot(root: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(root)
}

export interface ParseFileCitationOptions {
  /**
   * 当前工作区根目录。聊天栏没有「当前文档」的概念,所以相对路径一律以它为基准
   * —— 对齐 VS Code markdown 的语义(`/foo` 相对工作区根,`./foo` 相对当前文件),
   * 只是这里两者归一到同一个基准。缺省时相对路径解析不出来,直接放弃。
   */
  workspaceRoot?: string | null
}

/**
 * 把聊天里一个链接 href 解析成「要打开的文件 + 行号」。不是本地文件目标时返回
 * `null`,调用方据此走外部浏览器/灯箱/纯文本。
 *
 * 认这些形态:
 *   - `vscode://file/D:/proj/src/a.ts:42`(以及 cursor / windsurf / vscode-insiders)
 *   - `file:///D:/proj/src/a.ts`、`local-file:///C%3A/u/x.png`
 *   - 裸绝对路径 `D:\proj\src\a.ts`、`/home/me/a.ts`
 *   - 工作区相对路径 `src/a.ts`、`./src/a.ts`、`/src/a.ts`(需要 workspaceRoot)
 *   - 以上任意形态 + `:42` / `:42:7` / `#L42` / `#L42-L50`
 */
export function parseFileCitation(
  href: string | undefined | null,
  options: ParseFileCitationOptions = {},
): FileCitation | null {
  if (typeof href !== 'string') return null
  const raw = href.trim()
  if (raw.length === 0) return null
  // 纯锚点是文档内跳转,不是文件。
  if (raw.startsWith('#')) return null

  const editorScheme = EDITOR_SCHEME_RE.exec(raw)
  let target = editorScheme ? raw.slice(editorScheme[0].length) : raw

  if (!editorScheme) {
    const localScheme = LOCAL_SCHEME_RE.exec(raw)
    if (localScheme) {
      let rest = raw.slice(localScheme[0].length)
      // 丢掉 authority(`file://host/path`);常见的 `file:///path` 本来就以 `/` 开头。
      if (!rest.startsWith('/')) {
        const slash = rest.indexOf('/')
        rest = slash >= 0 ? rest.slice(slash) : ''
      }
      target = rest
    } else if (FOREIGN_SCHEME_RE.test(raw)) {
      return null
    }
  }

  const { body, line, col } = splitLineSuffix(target)
  if (body.length === 0) return null

  // 查询串不属于路径(`./a.png?v=2`)。锚点已在 splitLineSuffix 里摘掉。
  const decoded = decodeSafe(body.split('?')[0])
  if (decoded.length === 0) return null
  // 模型给的 href 不可信,`..` 一律当遍历挡掉 —— 与预览侧(用户自己写的文档,
  // `..` 是正常写法)刻意不同,理由见 markdownDocLinks.ts 的模块注释。
  if (hasTraversal(decoded)) return null

  const absolute = absolutePathFrom(decoded)
  const root = options.workspaceRoot ?? ''

  // Windows 工作区下的 POSIX 绝对路径(`/src/a.ts`)不可能是真路径,按 VS Code
  // markdown 的「前导斜杠 = 工作区根」语义解析。POSIX 主机上不做这个转换,
  // 那里 `/src/a.ts` 就是一条正经绝对路径。
  const posixLooksWorkspaceRelative =
    absolute !== '' && absolute.startsWith('/') && root !== '' && isWindowsRoot(root)

  if (absolute && !posixLooksWorkspaceRelative) {
    return { path: absolute, ...(line ? { line } : {}), ...(col ? { col } : {}) }
  }

  if (!root) return null
  const relative = posixLooksWorkspaceRelative ? decoded.replace(/^\/+/, '') : decoded
  const joined = joinWithRoot(root, relative)
  if (!joined) return null
  return { path: joined, ...(line ? { line } : {}), ...(col ? { col } : {}) }
}
