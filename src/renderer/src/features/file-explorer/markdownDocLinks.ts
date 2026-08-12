/**
 * Markdown 预览里的链接/图片目标解析。
 *
 * 文档里绝大多数图片是**相对**写的(`![](./img/a.png)`、`![](../assets/b.png)`),
 * 而 `osPathFromHref` 只认绝对路径 —— 它服务的是聊天栏,模型在那里给的一律是
 * 绝对路径,并且刻意把 `..` 当遍历攻击挡掉。预览这边不一样:相对路径是正常写法,
 * `..` 是作者自己写的,要按文档所在目录老实解析。
 *
 * 真正的安全闸不在这里,在主进程 —— 读字节要过 `fs:read-binary` 的
 * allowed-roots(或 `attachments:read-thumb` 的 mime/体积白名单)。这里只做纯
 * 字符串解析,解出界的路径下游自然会拒。
 *
 * 不用 `new URL()`:Chromium 对标准 scheme 会折叠 Windows 盘符
 * (`new URL('file:///C:/x').pathname` → `/x`),会把路径悄悄改错。同款理由见
 * `osPathFromHref` 的模块注释。
 */

import { osPathFromHref } from './revealInExplorer'

/** 该 href 是渲染端能直接加载的源吗(不需要经 IPC 读字节)。 */
export function isDirectHref(href: string): boolean {
  return /^(https?|data|blob):/i.test(href)
}

/** 文档路径 → 所在目录(保留原分隔符风格)。 */
function dirnameOf(docPath: string): string {
  const idx = Math.max(docPath.lastIndexOf('/'), docPath.lastIndexOf('\\'))
  return idx > 0 ? docPath.slice(0, idx) : ''
}

/** 压掉 `.` 与 `..` 段。`..` 多到越过根就停在根,不往上冒。 */
function normalizeSegments(segments: string[]): string[] {
  const out: string[] = []
  for (const seg of segments) {
    if (seg === '' || seg === '.') continue
    if (seg === '..') {
      out.pop()
      continue
    }
    out.push(seg)
  }
  return out
}

/**
 * 把 markdown 里的 href 解析成绝对 OS 路径;不是本地目标(http/data/blob/锚点/
 * mailto)时返回空串,调用方据此走「直接加载」或「交给系统浏览器」。
 *
 * @param docPath 该 markdown 文件自身的绝对路径,相对目标以它所在目录为基准。
 */
export function resolveDocRelativePath(docPath: string, href: string | undefined | null): string {
  if (typeof href !== 'string') return ''
  const raw = href.trim()
  if (raw.length === 0) return ''
  // 纯锚点(`#section`)是文档内跳转,不是文件。
  if (raw.startsWith('#')) return ''
  if (isDirectHref(raw)) return ''

  const absolute = osPathFromHref(raw)
  if (absolute) return absolute

  const baseDir = dirnameOf(docPath)
  if (!baseDir) return ''

  // 查询串/锚点不属于路径的一部分(`./a.png?v=2`、`./doc.md#top`)。
  let target = raw.split(/[?#]/)[0]
  try {
    target = decodeURIComponent(target)
  } catch {
    // 不是合法百分号编码就按原样当路径,总比整条丢掉强
  }
  if (target.length === 0) return ''
  // 绝对路径在上面已经处理过了;走到这里还带盘符/前导斜杠的是 osPathFromHref
  // 挡下来的形态(含 `..`),同样按相对解析会得出错的结果,直接放弃。
  if (/^[A-Za-z]:[\\/]/.test(target) || target.startsWith('/') || target.startsWith('\\')) return ''

  const sep = baseDir.includes('\\') ? '\\' : '/'
  const merged = normalizeSegments([...baseDir.split(/[\\/]/), ...target.split(/[\\/]/)])
  if (merged.length === 0) return ''
  const joined = merged.join(sep)
  // POSIX 根开头的绝对路径 split 后会丢掉前导斜杠,补回来。
  return baseDir.startsWith('/') ? `/${joined}` : joined
}
