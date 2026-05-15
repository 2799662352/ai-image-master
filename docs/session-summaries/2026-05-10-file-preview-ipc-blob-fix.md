# File Preview Fix — `local-file://` → IPC + Blob URL

**Date**: 2026-05-10
**Affected files**: `src/main/file-explorer/fsIpc.ts`, `src/main/file-explorer/protocolHandler.ts`, `src/preload/index.ts`, `src/renderer/src/features/file-explorer/{ImageViewer,VideoViewer,useFileUrl,store}.{ts,tsx}`

## Symptom

PNG / JPEG images and MP4 / WEBM videos opened from the File Explorer rendered as a blank pane in dev mode. The renderer console showed:
- `[ImageViewer] tab.path … → src: local-file:///D%3A/…` (correct URI generated)
- **No** `img onLoad` / `onError` / `fetch` events
- **No** `[local-file]` logs in the main process — protocol handler was never invoked

CSP errors were also seen earlier:
```
Loading media from '<URL>' violates CSP directive: "media-src 'self' data: blob: https: file:"
```

## Root Cause (Phase 1–2)

1. **Renderer is loaded from `http://localhost:5173`** in dev mode (Vite dev server).
2. **`local-file://` is a registered privileged custom scheme** but Chromium treats requests from `http://localhost` to `local-file://` as cross-site / untrusted.
3. Even after fixing CSP `media-src` and the Windows drive-colon URL encoding, the browser silently refuses to dispatch the request. **The main-process `protocol.handle('local-file', …)` callback was never called** — confirmed by absence of diagnostic logs after multiple restarts.
4. Symptom-level fixes had been attempted 3 times (CSP, URI encoding, hostname-fallback in `resolveOsPathFromRequest`). Per systematic-debugging Phase 4.5 — *3+ failed fixes ⇒ question the architecture*.

## Pattern Reference (Phase 2)

VSCode handles webview local resources by **reading the file in the main process and pushing bytes to the renderer**, never by exposing files via a custom URL scheme that the renderer fetches directly. This avoids origin/scheme trust issues entirely.

## Fix (Phase 3–4)

Switch from `local-file://` URLs to **IPC-read → blob URL**.

### Layers

| Layer | Change |
| --- | --- |
| Main `fsIpc.ts` | New `handleReadBinary(p)` → `{ ok: true, base64, mime }`. Registered as IPC `fs:read-binary`. Reuses existing `assertContained` allowlist guard. |
| Main `fsIpc.ts` | MIME map extended with `avif`, `ico`, `mp4`, `webm`, `ogg`, `mov`, `m4v`. |
| Preload `index.ts` | Channel constant `READ_BINARY` + `electronAPI.fs.readBinary(p)` typed wrapper. |
| Renderer `useFileUrl.ts` | New hook. `readBinary` → `Blob` → `URL.createObjectURL` → auto-`revokeObjectURL` on unmount / path change. Returns `{status:'loading'|'ready'|'error'}`. |
| Renderer `ImageViewer.tsx` | Uses `useFileUrl(tab.path)`. Loading / error / ready states with cyan-themed UI. |
| Renderer `VideoViewer.tsx` | Same hook; `<video>` `src` is the blob URL. |

### Cleanup

- All diagnostic `console.log` removed from `protocolHandler.ts` and `store.openTab`.
- `local-file://` protocol registration is **kept** — still safe to leave installed even though unused for previews.

## Why This Works

- **Blob URLs are same-origin** with the document; no cross-scheme guard ever fires.
- **No CSP entries for custom schemes** are required (`blob:` is already in `img-src` / `media-src`).
- **Memory is bounded**: `URL.revokeObjectURL` runs on every effect cleanup, and switching tabs frees the previous blob.
- **MIME comes from the main process**, so videos correctly trigger streaming `<video>` element behaviour without needing `protocol.registerSchemesAsPrivileged({ stream: true })`.

## Trade-offs

- For very large files we read the entire buffer into base64 then a Blob. For images/videos opened ad-hoc this is acceptable; if multi-GB previews become a use-case, switch to a streaming path (e.g. `fs:open-handle` + chunked reads or `protocol.handle` with proper origin).
- We pay the base64 round-trip cost in IPC. A future optimisation: return a `Uint8Array` directly via `ipcRenderer.invoke` (Electron supports transferable typed arrays now). Not done yet because IPC infra in this repo is uniformly base64-string-shaped.

## Validation

User confirmed images and videos load correctly after restart on Windows with paths under `D:\curosr消费\` (Chinese characters in path) — i.e. `URL` encoding hazards are gone.

## Lessons / Compounding

1. **Custom URL schemes from `http://localhost` dev origin are unreliable.** Use IPC + blob for any local file the renderer needs to display in dev mode. This applies to PDFs and any future `embed`/`<iframe>` of local content too.
2. **`protocol.handle` not being called is silent** — no error, no log. Always add diagnostic logs at the protocol entry point before assuming the registration worked.
3. **Phase 4.5 (architecture question) saved time here.** Three symptom-level fixes had each been plausible; without stepping back to ask *"is this scheme even reaching us?"* we would have continued patching CSP / encoding / fallbacks indefinitely.

## Follow-ups

- `FileExplorerPanel.tsx` PDF case still uses `local-file:///${tab.path}` — may break with the same root cause. Migrate to `useFileUrl` if PDF preview is actually exercised.
- Consider deleting `protocolHandler.ts` entirely if no other consumer needs `local-file://`.
