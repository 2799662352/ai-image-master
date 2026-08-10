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

/**
 * base64 → Blob,**交给浏览器原生解码**,不要在 JS 里逐字节抄。
 *
 * 原先是 `atob` + `for (i...) bytes[i] = bin.charCodeAt(i)`。一个 50MB 的 mp4 经
 * base64 膨胀成约 67MB,那个循环就是 6700 万次迭代,全在渲染进程主线程上跑 ——
 * 窗口在这期间完全停止绘制,用户看到的是「点一下视频整个应用卡死」。
 *
 * `fetch('data:…')` 把解码交给 Chromium 的原生实现,没有 JS 循环。
 *
 * 注意这里**没有**解决主进程侧的整份 readFile + toString('base64')。要解决它只有
 * 两条路,而且第二条是死路:
 *
 *  ① 把 IPC 的返回换成可转移的字节数组(structured clone 原生支持 Uint8Array,
 *     没有 4/3 膨胀也没有解码)。可行,但 `attachments:read-thumb` 的返回形状有
 *     四处消费者,是一次真改动。
 *
 *  ② 让渲染端直接 `<video src="local-file://…">` 流式读。**别再试了** ——
 *     Windows 上这条路被上游堵死:Chromium 的 standard-scheme 解析没有 `file://`
 *     才有的盘符处理,`D%3A` 会塌掉,GET 发出去时盘符已经没了
 *     (electron/electron#49073)。表现是 protocol.handle 根本不被调用、主进程
 *     一行日志都没有,极易被误判成 CSP 或权限问题。
 *
 *     这已经被独立踩过三次:2026-05-10 查了 CSP / 盘符编码 / hostname 兜底三轮后
 *     退回本方案(docs/session-summaries/2026-05-10-file-preview-ipc-blob-fix.md);
 *     useResolvedMediaSrc 顶部记着同一个上游 issue;2026-08-10 又试了一次,补上
 *     文档要求的 `stream` + `corsEnabled` 权限**仍然无效**,因为它们治的不是
 *     盘符被吞这个病。
 */
async function base64ToBlob(b64: string, mime: string): Promise<Blob> {
  const res = await fetch(`data:${mime};base64,${b64}`)
  return res.blob()
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
      .then(async (res) => {
        if (cancelled) return
        if (!res.ok) {
          setState({ status: 'error', reason: res.reason })
          return
        }
        const blob = await base64ToBlob(res.base64, res.mime)
        // 解码是异步的了,期间路径可能已经切走 —— 再查一次,否则会给新 tab 挂上旧
        // 文件的 URL,而且这个 blob 没人回收。
        if (cancelled) return
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
