# Fix: Codex chat image attachment lag

## Why

Dragging images into the Codex chat composer freezes the renderer for hundreds of milliseconds to several seconds per image. The on-disk attachment contract (`openai/codex#21108`) is already correct — the lag lives **entirely in the thumbnail rendering path**:

1. `MediaThumbnail` → `useResolvedMediaSrc('local-file:///...')`
2. → `attachments:read-thumb` IPC reads the **full file** (up to 100 MB) into a Node `Buffer`
3. → `Buffer.toString('base64')` (~1.33× size inflate)
4. → IPC `structuredClone` of the resulting string (multi-MB serialization)
5. → renderer's `atob()` + per-byte `for` loop into `ArrayBuffer` (**main-thread sync**)
6. → `Blob` + `URL.createObjectURL`
7. → `<img>` decodes the **full-resolution** image (a 4000×3000 photo is ~48 MB of RGBA after decode)

For a single 5 MB phone photo the renderer main thread blocks for ~400 ms; three at once compounds. Every surface that uses `<MediaThumbnail>` (composer chips, `AttachmentCard`, `EvidenceStack`, `Lightbox`, file-explorer `ReferencePreview`) shares this path.

### Real-world evidence

| Upstream | Issue | Their fix | Applies to us? |
|---|---|---|---|
| OpenAI Codex | [#13508](https://github.com/openai/codex/issues/13508) (134 MB PNG freezes thread), [#15270](https://github.com/openai/codex/issues/15270) (3.6 MB JPEG also freezes Windows) | [PR #21108](https://github.com/openai/codex/pull/21108) — keep **path-based attachment contract**, stage remote bytes via SFTP-over-WS to `$CODEX_HOME/uploads/` | Path contract: already done. Remote staging is for Codex Cloud, not us. |
| VSCode Copilot Chat | [#295334](https://github.com/microsoft/vscode/issues/295334) (image bytes serialized as `{"0":137,"1":80,…}` byte-index dict crashes renderer) | commit [`5e112a5`](https://github.com/microsoft/vscode/commit/5e112a523fcc5da44a434222fed0ef5f39bbcac2) — store `URI` references, lazy `resizeImage` on demand | Yes — we should never base64 >64 KB over IPC for display |
| VSCode Copilot Chat | [#305184](https://github.com/microsoft/vscode/issues/305184), [#308609](https://github.com/microsoft/vscode/issues/308609) | Anthropic API rejects images with any dimension > 8000 px or size > 5 MB → client-side resize before send | Yes — same provider, same hard limit |
| OpenCode (sst) | [#4668](https://github.com/sst/opencode/issues/4668), [#18107](https://github.com/anomalyco/opencode/issues/18107) | TUI: detect dropped path → read bytes from disk before passing to LLM | Inverse case; confirms path-only is industry default |
| Cursor | forum reports + [claude-code#34529](https://github.com/anthropics/claude-code/issues/34529) (PTY paste freeze is **Cursor's renderer**, not Claude) | Private upload endpoint + JSON-on-SQLite history (not open source) | Validates the diagnosis: heavy main-thread work blocks Electron renderers |
| Electron canonical | [docs](https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler), [docs](https://www.electronjs.org/docs/latest/api/native-image#nativeimagecreatethumbnailfrompathpath-size-maxsize) | `protocol.handle` + `net.fetch` for direct file → `<img>`; `nativeImage.createThumbnailFromPath` for OS-level downscaling | Yes — both used in this proposal |

## What Changes

Three PRs, mergeable in order. Each is independently shippable.

### PR-A — Renderer hot path: native thumbnails (no bucket, ~150 lines)

- **New IPC `media:thumb`** in main process. Given an OS path, returns a downscaled PNG (`maxSize: { width: 512, height: 512 }`) via `nativeImage.createThumbnailFromPath` (Electron built-in; no `sharp` boot cost; uses platform-native APIs — `QLThumbnail` on macOS, `IThumbnailProvider` on Windows, `ffmpeg`-style fallback on Linux). Falls back to `sharp` for formats Electron can't thumbnail.
- **`useResolvedMediaSrc` switches default path** to `media:thumb` instead of full-file `attachments:read-thumb`. Thumbnail bytes are typically 10–40 KB (vs 5–100 MB) — IPC `structuredClone` becomes microseconds, base64 decode becomes a single short loop.
- **Fix `local-file://` Windows drive letter encoding** in `toRenderableUri`. After fixing, `<img src="local-file:///D%3A/...">` works natively in Chromium 142 and `<img>` skips IPC entirely. The base64 path remains only for the rare cases where this still misbehaves.
- **Decode hint everywhere**: add `loading="lazy" decoding="async" fetchpriority="low"` on every thumbnail `<img>`. Already done in `MediaThumbnail` — verify and propagate.

Effect: a 5 MB JPEG drop renders its chip in ≤ 200 ms p99 (down from 1.5–3 s) with zero main-thread block > 50 ms.

### PR-B — Optional COS staged upload (~300 lines)

- **Schema migration**: `AgentAttachment.remoteUrl String?`, `AgentAttachment.remoteKey String?`, `AgentAttachment.uploadStatus String` (`pending` | `uploading` | `done` | `failed`).
- **`AttachmentUploader` (main process)** subscribes to `attachment-added` from `AttachmentService`, picks the eligible files (image/video over a configurable size floor — default 256 KB), and uploads them to COS via the existing `uploadStream` (multipart for ≥ 5 MB, `putObject` otherwise). Updates the row's `uploadStatus` + `remoteUrl` when done. Failures keep the row at `failed` and never block the agent turn — `localPath` is still authoritative for Codex CLI.
- **Renderer prefers `remoteUrl`** when available: `<MediaThumbnail src={remoteUrl ?? localUri}>` in `AttachmentCard` / `EvidenceStack` / `Lightbox`. For COS-hosted images, append `?imageView2/2/w/512` to the URL for CDN-side downscaling — Chromium fetches ~20 KB instead of the full original.
- **Renderer never holds the SecretKey.** Uploads happen entirely in main process. If we later expose direct-from-renderer uploads, switch to **presigned PUT URLs** minted in main process (Tencent COS supports this via existing `getPresignedUrl({ method: 'PUT', expireSeconds: 900 })`).
- **STS-ready credential layer**: introduce a `CosCredentialProvider` interface in `services/tencent/`. Default impl reads `safeStorage`-decrypted long-lived SecretKey (current behavior). New impl `StsCredentialProvider` calls Tencent STS `GetFederationToken` (via `qcloud-cos-sts` package) on demand for time-bounded (≤ 1 h) tokens scoped to `cos:PutObject` on a per-thread key prefix `agent-attachments/<threadId>/`. This unblocks future scenarios (multi-user, embedded SDK), but for the desktop binary we keep the long-lived key as default.
- **Feature flag**: `CATIMATION_ATTACHMENT_REMOTE_UPLOAD=0` disables the whole pipeline for offline / air-gapped users (and is the rollback switch).

### PR-C — Pre-send client-side resize (~80 lines)

- **`AgentManager.send`** runs each image attachment through `sharp` in main process before assembling the JSON-RPC payload to Codex. Rule: if any dimension > 8000 px or filesize > 5 MB, resize to fit 8000 × 8000 and re-encode at 90 % JPEG / lossless WEBP. Resized output goes to `<userData>/agent/uploads/<sha>.resized.<ext>` and **that** path is sent to Codex. Original is preserved.
- **Skip rule**: only apply to image MIMEs the Anthropic / OpenAI image endpoints actually consume (`png` / `jpeg` / `webp` / `gif`). PDFs, videos, and other docs pass through.
- **Why**: Anthropic's vision API rejects > 8000 px / > 5 MB ([vscode#305184](https://github.com/microsoft/vscode/issues/305184), [vscode#308609](https://github.com/microsoft/vscode/issues/308609)). Without this, users will hit silent 400s at the provider edge for any modern phone photo (most are > 4000 px on the long edge and 8–12 MP).

## Impact

| Area | Effect |
|---|---|
| `codex-chat-attachments` capability | Modified: thumbnail rendering, remote upload pipeline, pre-send resize. Existing path-only contract preserved. |
| `media-rendering` capability (implicit, lives in `components/shared/media/`) | Modified: default IPC switches to `media:thumb`; `local-file://` fast path enabled. Affects `BatchItemRow`, `PunkResultGrid`, `BatchResultGrid`, `ResultGrid` consumers. |
| `cos-uploads` capability | Modified: adds `AttachmentUploader` consumer; adds `StsCredentialProvider`; renames `cosClient` direct usage to flow through `CosCredentialProvider`. |
| DB schema | Migration adds three nullable columns to `AgentAttachment`. No data loss. |
| Disk usage | Unchanged for offline users (flag off). Online users see +~5 % traffic to COS. |
| Cost | New monthly COS traffic ≈ `users × turns/day × avg_image_size_after_resize × 30`. Estimate: 100 users × 5 turns/day × 800 KB × 30 = 12 GB/mo ≈ ¥1.8/mo at COS standard tier. |
| Security | Renderer never gains SecretKey access (already true; codified). `cos-credentials.json` stays main-process-only via existing `safeStorage` migration. STS path adds defense-in-depth without changing default. |
| Rollback | PR-A: revert. PR-B: `CATIMATION_ATTACHMENT_REMOTE_UPLOAD=0`. PR-C: feature flag `CATIMATION_ATTACHMENT_RESIZE=0`. |

## Out of scope

- Clipboard paste of images (separate change; the codebase deliberately excluded this in PR-1)
- Drag-drop of *folders* (deferred per `2026-05-21-codex-drag-drop-design.md`)
- Server-side image hosting outside Tencent COS (S3, R2 etc.)
- Replacing PGlite (covered by `2026-05-11-attachment-streaming-design.md` Phase C if needed)
- Replacing `cos-credentials.json` in repo with proper secret management (tracked separately; STS provider in PR-B is the long-term solution but does not gate PR-B)
