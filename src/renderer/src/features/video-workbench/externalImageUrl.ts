// 外链图片素材 —— 把「从浏览器拖过来的图 / 粘贴的一条图片地址」变成素材。
//
// 卡片此前只认文件(拖文件、文件选择器、人像库),从浏览器拖一张图或者粘贴一条
// 地址都会被静默忽略,用户只能先另存到本地再拖进来。而缩略图这一侧本来就支持
// 外链:`materialThumbTarget` 对图片素材直接返回 src,`useResolvedMediaSrc` 对
// http(s) 是透传的 —— 缺的只是入口。
//
// 不按扩展名筛:真实图床地址常常没有扩展名(如
// `https://pbs.twimg.com/media/xxx?format=jpg&name=orig`),按后缀判会把它们全
// 挡在门外,而这正是用户要贴的那一类。贴错了也看得见 —— 缩略图出不来、随手删掉,
// 代价远小于「明明是图却加不进来」。

/** 从 URL 推一个像样的素材名:路径末段 → 主机名 → 兜底。 */
function nameFromUrl(url: string): string {
  try {
    const parsed = new URL(url)
    const last = parsed.pathname.split('/').filter(Boolean).pop()
    if (last) return decodeURIComponent(last).slice(0, 60)
    return parsed.hostname
  } catch {
    return '外链图片'
  }
}

/**
 * 从拖放/粘贴的文本里取出第一条 http(s) 地址。
 *
 * `text/uri-list` 规范允许用 `#` 开头的注释行,浏览器拖拽也常常一次给多行,
 * 所以逐行找而不是整段当 URL。
 */
export function externalImageUrlFromText(text: unknown): string | null {
  if (typeof text !== 'string') return null
  for (const rawLine of text.split(/[\r\n]+/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    if (/^https?:\/\/\S+$/i.test(line)) return line
  }
  return null
}

/**
 * 这次粘贴该被当成「加素材」吗?
 *
 * 卡片上的 onPaste 会收到从提示词输入框冒泡上来的事件 —— 在提示词里贴一条网址
 * 是完全正常的写作动作,不能把它劫走变成素材、还让文字进不去。所以只有粘贴发生
 * 在非输入区域(卡片空白处)时才当作加素材。
 */
export function pasteTargetAcceptsMaterial(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return true
  if (target.isContentEditable) return false
  const tag = target.tagName
  return tag !== 'INPUT' && tag !== 'TEXTAREA' && tag !== 'SELECT'
}

/** 文本 → 图片素材(取不出地址时返回 null)。 */
export function externalImageMaterialFromText(
  text: unknown,
): { name: string; src: string } | null {
  const url = externalImageUrlFromText(text)
  if (!url) return null
  return { name: nameFromUrl(url), src: url }
}
