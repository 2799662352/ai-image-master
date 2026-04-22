import { getJSZip } from '../../../utils/LazyLibraries'

export interface ZipProgress {
  phase: 'fetching' | 'zipping'
  percent: number
}

export async function zipDownload(
  urls: string[],
  baseName: string,
  onProgress?: (p: ZipProgress) => void,
): Promise<void> {
  if (!urls.length) return
  const JSZip = await getJSZip()
  const zip = new JSZip()
  const total = urls.length

  for (let i = 0; i < total; i++) {
    const url = urls[i]
    onProgress?.({ phase: 'fetching', percent: Math.round(((i + 1) / total) * 50) })
    try {
      const resp = await fetch(url, { mode: 'cors' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      const blob = await resp.blob()
      const ext = guessExt(resp.headers.get('content-type'))
      zip.file(`${baseName}-${String(i + 1).padStart(2, '0')}.${ext}`, blob)
    } catch (err: any) {
      zip.file(
        `_FAILED_${String(i + 1).padStart(2, '0')}.txt`,
        `URL: ${url}\nError: ${err.message}\n`,
      )
    }
  }

  const blob = await zip.generateAsync(
    { type: 'blob', compression: 'STORE' },
    (meta: { percent: number }) => {
      onProgress?.({ phase: 'zipping', percent: 50 + Math.round(meta.percent / 2) })
    },
  )

  const objUrl = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = objUrl
  a.download = `${baseName}-split.zip`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(objUrl), 1000)
}

function guessExt(contentType: string | null): string {
  if (!contentType) return 'jpg'
  if (contentType.includes('png')) return 'png'
  if (contentType.includes('webp')) return 'webp'
  return 'jpg'
}
