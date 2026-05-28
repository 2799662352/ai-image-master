# Design: Fix Codex chat image attachment lag

## Context

The Codex chat composer (`MentionInput.tsx`) feels frozen when a user drags images in. The path-only attachment contract (modelled on `openai/codex#21108`) is already in place and is **not** the problem — bytes never flow renderer → main as `arrayBuffer()`. The lag is in a **second** byte flow that the renderer triggers reflexively to draw thumbnails:

```
<img> ← blob: ← Uint8Array ← atob(base64) ← IPC(string) ← base64(Buffer) ← fs.readFile(fullFile, 100MB cap)
```

That chain runs synchronously on the renderer's main thread for **every** image-shaped reference in `pendingReferences`, every `EvidenceStack` item, every history `AttachmentCard`, and every `Lightbox` mount. Modern phones produce 8–12 MP JPEGs at 3–6 MB each; the moment three of them are visible the renderer blocks for >1 s of cumulative long-tasks.

`docs/superpowers/specs/2026-05-11-attachment-streaming-design.md` already fixed the **ingestion** side of the same coin (Phase A streaming, Phase B path-only picker). This change finishes the job on the **display** side and adds the two upstream-validated pieces (`vscode/5e112a5` lazy URI + `vscode#305184` pre-send resize, `codex#21108` staging path) that the prior design left as "post-merge".

## Goals

1. **Drop → thumbnail visible in ≤ 200 ms p99** for any image up to the 100 MB cap, on a 2020-class laptop, with zero main-thread long-tasks > 50 ms.
2. **Renderer never holds full-resolution image bytes for display.** Either it streams thumbnail-sized bytes (≤ 64 KB) over IPC, or it loads via `<img src="...">` directly (`local-file://` or `https://`).
3. **SecretKey is a main-process secret.** No code path lets the renderer reach the Tencent COS SecretId/SecretKey. Future upgrade path to STS is wired in but not the default.
4. **Provider compatibility.** Images shipped to Anthropic / OpenAI image endpoints respect each provider's documented size and dimension limits, so users do not silently lose context.
5. **Offline / air-gapped users keep working** unchanged via a single env flag.

## Non-goals

- Replacing the Codex CLI's own filesystem reads (out of scope — we ship paths, CLI reads bytes).
- Pixel-perfect parity with the Codex Desktop image preview (we aim for "Cursor-grade fast", not visual fidelity).
- Renderer-side WebWorker decoding of base64 (it's a valid alternative, but `nativeImage`-thumbed PNGs are small enough that the main-thread `atob` is sub-millisecond, so the Worker would be overkill).

## Key decisions

### D1. `nativeImage.createThumbnailFromPath` is the default thumbnail source

Electron's [`nativeImage.createThumbnailFromPath`](https://www.electronjs.org/docs/latest/api/native-image#nativeimagecreatethumbnailfrompathpath-size-maxsize) wraps the OS thumbnail provider (Quick Look on macOS, `IThumbnailProvider` on Windows, gnome-thumbnailer on Linux). This means:

- Zero cold-start cost (vs `sharp` which boots libvips on first call).
- Format coverage matches the OS — HEIC, RAW, PSD work on macOS for free.
- Returns a `NativeImage` we can `.toPNG()` capped at any size.

Failure modes we handle by falling back to `sharp`:

- Linux installations without a thumbnail backend (returns empty NativeImage).
- SVG files (NativeImage rasterizes inconsistently across versions).
- Animated GIF where we want a single frame.

### D2. Keep base64-over-IPC for `Lightbox` only (opt-in `fullFidelity`)

Lightbox is the only surface that genuinely needs the full-resolution image. Even there, when a `remoteUrl` exists the lightbox sets `<img src={remoteUrl}>` and the IPC base64 path stays dormant. So the `attachments:read-thumb` IPC's hot path shrinks to "Lightbox of a local file that hasn't uploaded yet" — rare and acceptable.

### D3. `local-file://` shortcut, base64 is the fallback (not the default)

The renderer can render `<img src="local-file:///D%3A/path/foo.png">` directly through the existing `installLocalFileHandler` (`net.fetch(pathToFileURL(...))`). Today `useResolvedMediaSrc` deliberately bypasses this because of a flaky Windows drive-letter encoding issue. The fix is purely string-level (`toRenderableUri` already encodes `%3A`; we just need to verify it's not getting decoded somewhere downstream).

We gate this behind a feature flag (`CATIMATION_LOCAL_FILE_DIRECT=1`) initially so we can ship PR-A even if the Playwright matrix turns up a Linux-only edge case. Once the flag has soaked for two weeks across mac/win/linux, flip the default and demote IPC to the fallback.

### D4. Remote upload is a side-effect, never a precondition

The `AttachmentUploader` runs **after** the attachment is already saved to disk and the renderer is already displaying it. The renderer optimistically shows the local thumbnail; when `attachment-uploaded` arrives, the URL swap is a no-op visually (same content) but unlocks the CDN-side `?imageView2/2/w/512` thumbnail for any future render. The Codex CLI still consumes `localPath` — it does not know or care that a `remoteUrl` exists.

Consequences:

- Network failure: zero impact on the agent turn. Just slower thumbnails on subsequent re-renders.
- Slow upload: thumbnails are *already* fast because of D1. Remote upload is a multiplier, not the foundation.
- Cancellation / app quit mid-upload: `uploadStatus` stays `uploading`, recovered on next boot if we add a sweep (out of scope; manual retry button is enough for v1).

### D5. STS provider is an interface, not a default

Long-lived `SecretKey` in `safeStorage` is acceptable for a single-user desktop binary. STS becomes mandatory if/when we ever:

- Ship credentials inside an installer for multiple users
- Add a "share thread to teammate via URL" feature
- Open a non-Electron client (web, mobile)

Wiring the interface now keeps that door open without forcing the rollout. The default `LongLivedCredentialProvider` is a one-line change to swap for `StsCredentialProvider` later.

### D6. Pre-send resize uses `sharp`, not `nativeImage`

`sharp` is the right tool here because:

- We need precise dimension control (provider says "max 8000 px") — `nativeImage` has only "thumbnail size" hint.
- We need control over output format (JPEG quality, PNG compression level) — `nativeImage` always emits PNG/JPEG with platform defaults.
- It's already a dependency.

The resize happens **once** per `<sha>.ext` (cached); resends use the cached `.resized.ext` file.

### D7. Schema is additive only

`AgentAttachment` gets three new nullable columns. Existing rows backfill to `uploadStatus = 'skipped'` so the uploader never retroactively uploads historical attachments. Forward compat: removing the columns later is a no-op since they're optional everywhere.

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| `nativeImage.createThumbnailFromPath` returns empty image on user's machine | `sharp` fallback (D1). Detected by `thumb.isEmpty()` and `thumb.getSize().width === 0`. |
| Tencent COS account hits rate limits during a bulk drop | `AttachmentUploader` caps at 2 concurrent uploads (B3.6). Bulk drops are 20 files max (existing quota). |
| User drops a 99 MB file → `nativeImage` OOMs trying to thumbnail | `media:thumb` IPC has the same 100 MB size cap as `attachments:read-thumb`. NativeImage internally caps thumbnail size to the `maxSize` we pass (512). |
| `local-file://` direct rendering regresses on Linux | Feature flag (D3) lets us turn it off without redeploy. |
| Anthropic / OpenAI change their size limits | Limits live as constants in `resizeForVision.ts`. Single-line change; we add a comment linking to provider docs so it's discoverable. |
| Resized images degrade visible quality | JPEG quality = 90 is visually lossless for vision-API consumption; the resize only fires when the original is already past provider limits, so quality is already capped. |
| User on flaky network spams uploads | `AttachmentUploader` is fire-and-forget; failures are logged and don't retry — acceptable for v1, retry button in v2. |
| Tasks order requires DB migration before code rollout in main branch | PR-B's migration goes into `prisma/migrations/` and `prisma/init.sql` in the same PR; rollback = revert the PR (Prisma migrate forward-only is the existing convention, no downgrade needed because columns are nullable). |

## Alternatives considered

### Alt-1: Move `useResolvedMediaSrc` to a Web Worker

Decode base64 → ArrayBuffer in a Worker via `postMessage` + Transferable. Keeps the renderer main thread idle. Rejected because: (a) it's strictly worse than not having the bytes in the renderer at all (D1+D3 achieve that); (b) the original 100 MB read on disk still happens in the main process and still blocks PGlite — D1 attacks that with the smaller thumbnail. Worth revisiting only if D3 turns out to be infeasible on some platforms.

### Alt-2: Stream bytes via `webContents.postMessage` with `Transferable`

Cleaner than base64-over-IPC. But this still moves the **full** file from main to renderer — we want the renderer to *not* receive the full file at all. Same reasoning as Alt-1.

### Alt-3: Use Cloudflare R2 / S3 instead of Tencent COS

R2/S3 have nicer SDKs and presigned URLs. Rejected because: (a) the project already ships and uses Tencent COS for `storyboardSplit` / `smartErase`; (b) the user base is in CN where COS has the latency advantage; (c) the abstraction we introduce (`CosCredentialProvider`) is small enough that a future R2 swap is a same-day PR.

### Alt-4: Build a Codex-style remote staging server (`codex#21108`)

Codex Cloud staged uploads through `$CODEX_HOME/uploads/` via SFTP over websocket because they have a *remote* Codex backend. We don't — our Codex backend is a local subprocess. The bytes are already on the user's disk; staging them somewhere else would just add work.

## Verification matrix

| Property | Measurement | Where |
|---|---|---|
| Drop 5 MB JPEG, time to thumbnail visible | Playwright + `performance.mark` | `e2e/codex-chat-image-drop.spec.ts` (new) |
| Main-thread long-task during drop | DevTools Performance trace asserted by `playwright-traces` | same |
| 100 MB file rejected | Vitest unit on `attachmentsIpc` | existing pattern |
| `remoteUrl` available within 5 s for 2 MB JPEG on 100 Mbps link | Integration test gated on `RUN_COS_E2E` | `src/main/agent/__tests__/AttachmentUploader.integration.test.ts` |
| Resized image fits provider limits | Real fixture, `sharp` metadata check | `src/main/agent/__tests__/resizeForVision.test.ts` |
| Renderer never holds SecretKey | Static check: `grep -r secretKey src/renderer` returns no matches | CI lint step |
| Offline (flag off) | Manual on a network-disabled VM | release checklist |

## References

- `openai/codex#13508`, `#15270`, PR `#21108` — upstream Codex attachment freeze + fix
- `microsoft/vscode#295334`, commit `5e112a5` — VSCode lazy URI attachment pivot
- `microsoft/vscode#305184`, `#308609` — Anthropic API size/dimension limits
- `anthropics/claude-code#34529` — Cursor renderer main-thread saturation confirmation
- `electron/electron#49073` — `local-file://` Windows drive letter parsing
- `docs/superpowers/specs/2026-05-11-attachment-streaming-design.md` — Phase A/B/C upstream context
- `docs/superpowers/specs/2026-05-21-codex-drag-drop-design.md` — Tier 2 / Tier 3 drop pipeline
- Electron docs: [`nativeImage.createThumbnailFromPath`](https://www.electronjs.org/docs/latest/api/native-image#nativeimagecreatethumbnailfrompathpath-size-maxsize), [`protocol.handle`](https://www.electronjs.org/docs/latest/api/protocol#protocolhandlescheme-handler)
- Tencent COS: [presigned URL](https://cloud.tencent.com/document/product/436/14116), [STS GetFederationToken](https://cloud.tencent.com/document/product/436/14048), [image processing](https://cloud.tencent.com/document/product/436/44880)
