/**
 * 万相 3.0 的「文档 / 网页链接」槽 —— 类型与纯分类逻辑。
 *
 * 放 `src/shared/` 是因为两端都要用:渲染层的槽位 UI 要按用户粘进来的地址即时
 * 判断显示成「文档」还是「链接」,主进程组包要把它追加进 `media[]`。
 *
 * ## 没有手动切换,全靠后缀
 *
 * 用户只有一个输入框(或一次本地上传)。粘一个 `.pdf` 地址就是 `file`,粘一篇文章
 * 地址就是 `link` —— 多给一个 file/link 单选框只会让人停下来想「我该选哪个」,而
 * 这个判断计算机做得比人准。
 *
 * 判据是 **pathname 的扩展名**,不是整串地址:`…/a.pdf?token=x#p2` 的 query 和
 * hash 都不算数,否则一个带 `?type=pdf` 的普通文章会被误判成文档。
 *
 * ## 本地上传恒为 file
 *
 * 上传完拿到的是 COS 地址,后缀未必还在(对象键可能被改写)。本地上传的语义本来
 * 就是「我给你一份文档」,不必再去猜。
 */

/** 官方接受的文档扩展名。与网关侧的白名单同一份口径。 */
export const WAN3_DOCUMENT_EXTS: ReadonlySet<string> = new Set([
  'pdf',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'txt',
  'md',
  'key',
  'pages',
  'numbers',
])

/** 文档 / 网页链接槽。`displayName` 只进 UI 与任务记录，**不上行**。 */
export interface Wan3DocumentOrLink {
  type: 'file' | 'link'
  url: string
  displayName?: string
}

/** `…/dir/a.tar.gz` → `gz`;没有扩展名返回空串。 */
function pathnameExtension(pathname: string): string {
  const last = pathname.split('/').pop() ?? ''
  const dot = last.lastIndexOf('.')
  return dot > 0 ? last.slice(dot + 1).toLowerCase() : ''
}

/**
 * 地址 → `file` / `link`；不是 http(s) 返回 `null`（调用方据此不写入）。
 */
export function classifyWan3DocumentOrLink(rawUrl: string): 'file' | 'link' | null {
  const trimmed = (rawUrl ?? '').trim()
  if (!trimmed) return null
  let parsed: URL
  try {
    parsed = new URL(trimmed)
  } catch {
    return null
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
  return WAN3_DOCUMENT_EXTS.has(pathnameExtension(parsed.pathname)) ? 'file' : 'link'
}

/** 地址末段（已解码）作为展示名；取不到时退回主机名。 */
export function displayNameFromUrl(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl.trim())
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (last) {
      try {
        return decodeURIComponent(last)
      } catch {
        return last
      }
    }
    return parsed.hostname
  } catch {
    return rawUrl.trim()
  }
}

/** 用户粘进来的地址 → 槽位值；不是 http(s) 返回 `null`。 */
export function documentOrLinkFromUrl(rawUrl: string): Wan3DocumentOrLink | null {
  const type = classifyWan3DocumentOrLink(rawUrl)
  if (!type) return null
  const url = rawUrl.trim()
  return { type, url, displayName: displayNameFromUrl(url) }
}

/** 本地上传完成 → 槽位值。恒为 `file`，展示名用原始文件名。 */
export function documentOrLinkFromLocalUpload(
  fileName: string,
  publicUrl: string,
): Wan3DocumentOrLink {
  const url = publicUrl.trim()
  return { type: 'file', url, displayName: fileName.trim() || displayNameFromUrl(url) }
}

/**
 * 卡片上存成 JSON 字符串。
 *
 * 与参考实现同一个取舍:槽位是个小对象,直接进卡片模型意味着持久化 schema 要跟着
 * 加一层嵌套并做迁移;存成字符串则「有/无」两态就够了,空串即未设置。
 */
export function serializeDocumentOrLink(value: Wan3DocumentOrLink | null | undefined): string {
  if (!value) return ''
  return JSON.stringify(value)
}

/**
 * 「序列化 JSON」与「裸 URL」两种写法都认。
 *
 * 两个入口写进来的形状不同：UI / 持久化存的是 `serializeDocumentOrLink` 的 JSON，
 * 而 MCP 工具收的是一个普通 http(s) 地址（让 agent 自己拼 `{type,url}` 只会多出
 * 一处可能与实际不符的输入 —— type 本来就该由后缀判定）。
 *
 * 不归一的后果是静默的：agent 写进去一个裸 URL，`parseDocumentOrLink` 返回 null，
 * 槽位被当成「没设置」直接丢掉，而 agent 收到的是一次成功的写卡片回执。
 */
export function coerceDocumentOrLink(raw: string | undefined | null): Wan3DocumentOrLink | null {
  return parseDocumentOrLink(raw) ?? documentOrLinkFromUrl(raw ?? '')
}

export function parseDocumentOrLink(raw: string | undefined | null): Wan3DocumentOrLink | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  try {
    const parsed = JSON.parse(raw) as Partial<Wan3DocumentOrLink>
    if (parsed?.type !== 'file' && parsed?.type !== 'link') return null
    if (typeof parsed.url !== 'string' || !parsed.url.trim()) return null
    return {
      type: parsed.type,
      url: parsed.url,
      ...(typeof parsed.displayName === 'string' && parsed.displayName
        ? { displayName: parsed.displayName }
        : {}),
    }
  } catch {
    // 坏数据(手改过的持久化 / 旧版本格式)当没设置,不让一张卡因此打不开。
    return null
  }
}
