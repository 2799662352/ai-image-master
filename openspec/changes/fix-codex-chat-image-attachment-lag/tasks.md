# Tasks: Fix Codex chat image attachment lag

Each task maps to one commit or one small PR. Tick `[x]` as you finish. PR-A is independently shippable; PR-B depends on PR-A's `media:thumb` IPC for renderer-side rendering of remote URLs (we use the same `MediaThumbnail` codepath); PR-C depends on PR-A only (it touches `AgentManager.send`).

## PR-A — Renderer thumbnail hot path (≈150 lines)

### A1. Main-process `media:thumb` IPC

- [x] **A1.1** Create `src/main/file-explorer/mediaThumbIpc.ts` exporting `handleMediaThumb(path, opts)` and `registerMediaThumbIpc()`. — landed; co-located `mediaPathValidation.ts` keeps mime/traversal logic shared with `attachmentsIpc`.
- [x] **A1.2** Implementation validates path via shared `mediaPathValidation` (`hasTraversalSegment`, `ALLOWED_MIME_BY_EXT`, `MAX_ATTACHMENT_BYTES` mirror from `attachmentsIpc.ts`).
- [x] **A1.3** Uses `nativeImage.createThumbnailFromPath(realPath, { width: 256, height: 256 })` as the fast path; returns base64 JPEG (78 quality) so the renderer payload stays small.
- [x] **A1.4** Falls back to `sharp(realPath).resize({ width: 256, height: 256, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 78 }).toBuffer()` on NativeImage miss; SVG is short-circuited and returned as inline UTF-8 to avoid rasterization.
- [x] **A1.5** Registered in `src/main/index.ts` next to `registerAttachmentsThumbIpc()`; `attachments:read-thumb` remains for the lightbox/full-fidelity path.
- [x] **A1.6** Preload bridge: `electronAPI.attachments.readMediaThumb({ path, size? })` and `IPC_CHANNELS.ATTACHMENTS.MEDIA_THUMB = 'media:thumb'` exposed via `safeInvoke`.
- [x] **A1.7** Unit tests in `src/main/file-explorer/__tests__/mediaThumbIpc.test.ts` (10) + shared `mediaPathValidation.test.ts` (7) cover traversal, mime whitelist, size cap, NativeImage fast path, sharp fallback, SVG passthrough, explicit video reject.

### A2. Renderer wiring

- [x] **A2.1** `AttachmentsApi` in `src/renderer/src/components/shared/media/useResolvedMediaSrc.ts` now declares an optional `readMediaThumb` (keeps backward compat with older preloads).
- [x] **A2.2** `readBytes()` prefers `readMediaThumb` first, then falls back to `readThumb` for soft failures (e.g. "video thumbnail not yet supported") or whenever the caller opts into `fullFidelity: true`.
- [x] **A2.3** `useResolvedMediaSrc(src, hint, opts?: { fullFidelity?: boolean; thumbSize?: number })` plumbs the flag through to `readBytes`.
- [x] **A2.4** `Lightbox` calls the hook with `{ fullFidelity: true }` so full-resolution bytes are still produced for the modal/lightbox flow.
- [x] **A2.5** No update needed: existing `MediaThumbnail.test.tsx` mocks `readThumb` and the new tests in `useResolvedMediaSrc.test.tsx` cover the `readMediaThumb`-preferred routing.

### A3. `local-file://` Windows drive letter fix

- [ ] **A3.1** Audit `src/renderer/src/features/file-explorer/uri.ts` `toRenderableUri`: verify `%3A` encoding is applied unconditionally and survives downstream consumers (it currently is; add a regression test for `D:\path with space\foo.png`).
- [ ] **A3.2** Audit `src/main/file-explorer/protocolHandler.ts` `resolveOsPathFromRequest`: ensure `parsed.hostname` being a single drive letter still reconstructs the path (covered by existing test; add `D:` + spaces in basename case).
- [ ] **A3.3** Add Playwright smoke test in `e2e/` that loads a PNG via `<img src="local-file:///C%3A/...">` inside the renderer and asserts `naturalWidth > 0`.
- [ ] **A3.4** If the smoke test passes reliably across mac/win/linux, **shortcut `useResolvedMediaSrc`** to skip the IPC and just pass `src` through when `toRenderableUri(src)` produced a `local-file://` URL. Keep the IPC path as fallback (gated by `import.meta.env.DEV` and a feature flag `CATIMATION_LOCAL_FILE_DIRECT=1`).

### A4. Verification

- [ ] **A4.1** Add a vitest perf gate in `src/renderer/.../__tests__/MentionInput.lag.test.tsx`: render 3 chips with 5 MB JPEG paths (mocked IPC), assert wall time of the initial render < 100 ms in the test env (CI proxy for real-world < 200 ms).
- [ ] **A4.2** Manual: with dev tools Performance tab open, drop a 5 MB JPEG; record a profile. Main-thread long-tasks (> 50 ms) must be zero in the 2 s following the drop.
- [ ] **A4.3** Bisect the old behavior by temporarily forcing `readThumb` (full file) instead of `readMediaThumb`; confirm we can still reproduce the original lag (sanity check that we're measuring the right thing).

## PR-B — Optional COS staged upload (≈300 lines)

### B1. Prisma migration

- [ ] **B1.1** `prisma migrate dev --name agent_attachment_remote_url` adds three nullable columns to `AgentAttachment`: `remoteUrl String?`, `remoteKey String?`, `uploadStatus String @default("pending")`.
- [ ] **B1.2** Update `prisma/init.sql` to match (this file is the seed for fresh PGlite installs).
- [ ] **B1.3** Backfill: existing rows get `uploadStatus = 'skipped'` so they're never picked up by the uploader (no retroactive uploads of historic threads).

### B2. `CosCredentialProvider` abstraction

- [ ] **B2.1** Create `src/main/services/tencent/CosCredentialProvider.ts` with interface `{ getCredentials(scope?: { keyPrefix?: string }): Promise<TencentCreds> }` where `TencentCreds = { secretId, secretKey, securityToken?, expiresAt? }`.
- [ ] **B2.2** Implementation `LongLivedCredentialProvider` wraps existing `getCredentials()` — same behavior as today, no `securityToken`.
- [ ] **B2.3** Implementation `StsCredentialProvider` calls Tencent STS `GetFederationToken` via `qcloud-cos-sts` (add as devDep first; production wiring deferred — see B2.5). Scoped policy: `cos:PutObject` on `qcs::cos:<region>:uid/<uin>:<bucket>/<keyPrefix>*` with `effect: allow`. Caches token until `expiresAt - 60 s`.
- [ ] **B2.4** `cosClient.ts` swaps `getCredentials()` reads for `provider.getCredentials({ keyPrefix })` calls. When `securityToken` is present, pass it as `XCosSecurityToken` to the SDK.
- [ ] **B2.5** Default wiring keeps `LongLivedCredentialProvider`; `StsCredentialProvider` is registered but unused — flip via env `CATIMATION_COS_USE_STS=1` once we've validated the STS account setup. This decouples the provider refactor from credential type rollout.

### B3. `AttachmentUploader`

- [ ] **B3.1** Create `src/main/agent/AttachmentUploader.ts` exporting class `AttachmentUploader` with `start()` and `stop()`. Subscribes to `AttachmentService`'s `attachment-added` event.
- [ ] **B3.2** Decision policy in `shouldUpload(saved: SavedAttachment): boolean` — only when (mime starts with `image/` or `video/`) AND `size > 256 * 1024` AND `process.env.CATIMATION_ATTACHMENT_REMOTE_UPLOAD !== '0'`.
- [ ] **B3.3** Upload key: `agent-attachments/<threadId>/<sha>.<ext>`. Use `uploadBufferToBucket` for size < 5 MB; `uploadStream` for ≥ 5 MB. Wrap in try/catch — never throw upward.
- [ ] **B3.4** On success: `prisma.agentAttachment.update({ where: { id }, data: { uploadStatus: 'done', remoteUrl, remoteKey } })`. Emit `attachment-uploaded` for renderer IPC.
- [ ] **B3.5** On failure: update `uploadStatus: 'failed'` and `console.warn`. Keep going.
- [ ] **B3.6** Queue concurrency cap: 2 in-flight uploads max. Reuse `services/tencent/jobQueue.ts` if its shape fits, otherwise inline a simple semaphore.
- [ ] **B3.7** Wire `AttachmentUploader` into `AgentManager` init (alongside `AttachmentService`); call `stop()` on app quit.

### B4. Renderer prefers `remoteUrl`

- [ ] **B4.1** Extend `AttachmentRef` shape in `src/types/agent.ts` with `remoteUrl?: string`. Store reads it from the DB row when re-hydrating.
- [ ] **B4.2** `MediaThumbnail` in `AttachmentCard` / `EvidenceStack` / `Lightbox` reads `remoteUrl ?? toRenderableUri(localPath)`. For COS-hosted images append `?imageView2/2/w/<n>` where `<n>` is `512` for thumbs, original size for `Lightbox`.
- [ ] **B4.3** `MentionInput` pending chips also prefer `remoteUrl` once available — but they show the local thumbnail immediately on drop so the user has no perceived latency.
- [ ] **B4.4** IPC `attachments:changed` (already exists for tree refresh) now also fires when `uploadStatus` flips, so any open chat view re-renders with the URL.

### B5. Verification

- [ ] **B5.1** Unit test `AttachmentUploader.test.ts`: triggers on `attachment-added`, skips small/non-media files, retries are NOT performed (failure persists), respects feature flag.
- [ ] **B5.2** Integration test (real COS, gated `if (process.env.RUN_COS_E2E)`): drop a 2 MB JPEG → wait for `attachment-uploaded` → fetch `remoteUrl?imageView2/2/w/256` and assert HTTP 200 + content-type `image/jpeg`.
- [ ] **B5.3** Verify renderer code path: when `remoteUrl` is set, the renderer issues exactly one HTTPS GET (no IPC) for the thumbnail. Network panel screenshot in the test report.
- [ ] **B5.4** Offline rollback: set `CATIMATION_ATTACHMENT_REMOTE_UPLOAD=0`, drop image, verify uploader never runs and renderer uses local fallback.

## PR-C — Pre-send client-side resize (≈80 lines)

### C1. `resizeForVision` helper

- [ ] **C1.1** Create `src/main/agent/resizeForVision.ts` exporting `resizeForVision(srcPath: string): Promise<string>` that returns either `srcPath` (no change needed) or a new path inside the same uploads dir suffixed `.resized.<ext>`.
- [ ] **C1.2** Rules: only apply when mime is in `['image/png','image/jpeg','image/webp','image/gif']`. Skip non-image, animated GIFs (sharp's `pages: -1` detection), and SVG.
- [ ] **C1.3** Trigger: image's longest edge > 8000 px OR filesize > 5 MB.
- [ ] **C1.4** Output: `sharp(src).resize({ width: 8000, height: 8000, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 90, mozjpeg: true }).toFile(dest)` for non-PNG. PNG stays PNG (preserve transparency) but with `.png({ compressionLevel: 9 })`.
- [ ] **C1.5** Cache: skip the resize if `dest` already exists and is newer than `src` (idempotent across resends).

### C2. Wire into agent send

- [ ] **C2.1** In the `agent:send-message` IPC handler (locate via `grep send-message` in `main/agent/`), after `AttachmentService.ingest` returns the saved rows, call `resizeForVision` for each image and substitute the path before building the Codex JSON-RPC payload.
- [ ] **C2.2** Persist the chosen path in the message item (so resends use the same resized file).
- [ ] **C2.3** Feature flag `CATIMATION_ATTACHMENT_RESIZE=0` disables the whole step (rollback).

### C3. Verification

- [ ] **C3.1** Unit test with a real 10000×8000 PNG fixture: resize completes < 500 ms, output is 8000×6400 (aspect preserved), output filesize < 5 MB.
- [ ] **C3.2** Anthropic / OpenAI vision endpoint smoke test (gated): send a 12 MP iPhone JPEG → no 400 error from provider → resized path is what was uploaded.
- [ ] **C3.3** Regression: a 1024×1024 small image is passed through unchanged (path identity check).

## Cross-PR

- [ ] **X1** Update `openspec/specs/codex-chat-attachments/spec.md` with the merged delta after each PR lands.
- [ ] **X2** Move this change folder to `openspec/changes/archive/2026-MM-DD-fix-codex-chat-image-attachment-lag/` once all three PRs land.
- [ ] **X3** Cross-link the merged design doc into `docs/superpowers/specs/2026-05-28-codex-chat-image-lag-design.md` and the three plan files under `docs/superpowers/plans/`.
