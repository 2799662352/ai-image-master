import { useState, useEffect, useRef } from 'react'

type ReadBinaryResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; reason: string }

type FileUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; reason: string }

function getApi() {
  return (window as any).electronAPI as
    | { fs: { readBinary: (p: string) => Promise<ReadBinaryResult> } }
    | undefined
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

export function useFileUrl(filePath: string): FileUrlState {
  const [state, setState] = useState<FileUrlState>({ status: 'loading' })
  const blobUrlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const prev = blobUrlRef.current
    if (prev) URL.revokeObjectURL(prev)
    blobUrlRef.current = null
    setState({ status: 'loading' })

    const api = getApi()
    if (!api) {
      setState({ status: 'error', reason: 'electronAPI not available' })
      return
    }

    api.fs.readBinary(filePath).then((res) => {
      if (cancelled) return
      if (!res.ok) {
        setState({ status: 'error', reason: res.reason })
        return
      }
      const blob = base64ToBlob(res.base64, res.mime)
      const url = URL.createObjectURL(blob)
      blobUrlRef.current = url
      setState({ status: 'ready', url })
    }).catch((err) => {
      if (cancelled) return
      setState({ status: 'error', reason: String(err) })
    })

    return () => {
      cancelled = true
      const u = blobUrlRef.current
      if (u) URL.revokeObjectURL(u)
      blobUrlRef.current = null
    }
  }, [filePath])

  return state
}
