/**
 * 结果卡「↓ 下载」—— 从 BatchResultGrid 抽出来,生成页与批量页共用。
 * 先 fetch 成 blob 走 <a download>(同源 / CORS 允许时能真正另存);拿不到就退回
 * 直接打开链接(浏览器决定是下载还是预览)。
 */
export async function downloadImage(url: string, filename: string): Promise<void> {
  try {
    const res = await fetch(url, { mode: 'cors' })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const blob = await res.blob()
    const objUrl = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = objUrl
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
  } catch {
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.target = '_blank'
    a.rel = 'noreferrer'
    document.body.appendChild(a)
    a.click()
    a.remove()
  }
}

/** `<prefix>-001-<prompt 前 24 字>-<ts>.png` —— 文件名里去掉路径非法字符。 */
export function buildDownloadFilename(prefix: string, index: number, prompt: string): string {
  const slug =
    prompt
      .replace(/[\\/:*?"<>|\r\n]+/g, ' ')
      .trim()
      .slice(0, 24)
      .replace(/\s+/g, '_') || 'untitled'
  return `${prefix}-${String(index + 1).padStart(3, '0')}-${slug}-${Date.now()}.png`
}
