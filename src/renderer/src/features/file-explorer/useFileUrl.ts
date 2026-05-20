import { useState, useEffect } from 'react'

type ReadBinaryResult =
  | { ok: true; base64: string; mime: string }
  | { ok: false; reason: string }

type FileUrlState =
  | { status: 'loading' }
  | { status: 'ready'; url: string }
  | { status: 'error'; reason: string }

interface ElectronApiShape {
  fs?: { readBinary: (p: string) => Promise<ReadBinaryResult> }
  attachments?: { readThumb: (p: string) => Promise<ReadBinaryResult> }
}

function getApi(): ElectronApiShape | undefined {
  return (window as unknown as { electronAPI?: ElectronApiShape }).electronAPI
}

function base64ToBlob(b64: string, mime: string): Blob {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Blob([bytes], { type: mime })
}

/**
 * Read media bytes for ImageViewer / VideoViewer.
 *
 * Tries the dedicated `attachments:read-thumb` IPC first because it has the
 * mime+size whitelist suited to media display and — crucially — **no
 * workspace-allowed-roots gate**. This lets the file viewer tab open images
 * the user dragged in from arbitrary disk locations (e.g.
 * `D:/360MoveData/Users/.../Documents/foo.png`) that `fs:read-binary` will
 * refuse with `fs path outside allowed roots`.
 *
 * Falls back to `fs:read-binary` when the dedicated channel rejects on
 * mime/size whitelist (so non-media file types still get the workspace
 * sandbox path). Hard failures (file not found, EACCES) propagate as-is.
 */
async function readMediaBytes(
  api: ElectronApiShape,
  filePath: string,
): Promise<ReadBinaryResult> {
  if (api.attachments?.readThumb) {
    const res = await api.attachments.readThumb(filePath)
    if (res.ok) return res
    // Whitelist miss (mime/size) — try workspace sandbox path.
    if (!/whitelist|size|mime/i.test(res.reason)) return res
  }
  if (api.fs?.readBinary) return api.fs.readBinary(filePath)
  return { ok: false, reason: 'no IPC available' }
}

export function useFileUrl(filePath: string): FileUrlState {
  const [state, setState] = useState<FileUrlState>({ status: 'loading' })
  // Reset state SYNCHRONOUSLY when filePath changes. Otherwise React commits
  // one `<img src={old-blob-url}>` paint AFTER the effect cleanup revokes
  // that URL, and the browser reports `net::ERR_FILE_NOT_FOUND`. Same pattern
  // as useResolvedMediaSrc — see React's "Storing information from previous
  // renders": https://react.dev/reference/react/useState#storing-information-from-previous-renders
  const [trackedPath, setTrackedPath] = useState(filePath)
  if (filePath !== trackedPath) {
    setTrackedPath(filePath)
    setState({ status: 'loading' })
  }

  useEffect(() => {
    let cancelled = false
    // Hold the URL created by THIS effect run in a local closure variable
    // instead of a shared ref. With a shared ref the StrictMode mount →
    // cleanup → mount sequence makes effect B's cleanup revoke effect A's
    // URL (the ref is mutated by A's success handler). A local variable
    // means each effect run only revokes the URL it created.
    let createdBlobUrl: string | null = null
    setState({ status: 'loading' })

    const api = getApi()
    if (!api) {
      setState({ status: 'error', reason: 'electronAPI not available' })
      return
    }

    readMediaBytes(api, filePath)
      .then((res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', reason: res.reason })
          return
        }
        const blob = base64ToBlob(res.base64, res.mime)
        createdBlobUrl = URL.createObjectURL(blob)
        setState({ status: 'ready', url: createdBlobUrl })
      })
      .catch((err) => {
        if (cancelled) return
        setState({ status: 'error', reason: String(err) })
      })

    return () => {
      cancelled = true
      if (createdBlobUrl) URL.revokeObjectURL(createdBlobUrl)
    }
  }, [filePath])

  return state
}
