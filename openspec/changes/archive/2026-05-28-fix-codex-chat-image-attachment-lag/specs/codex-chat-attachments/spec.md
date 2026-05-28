# Delta: codex-chat-attachments

Apply on top of `openspec/specs/codex-chat-attachments/spec.md`. After this change merges, the deltas below become the new current truth and this file is moved into `openspec/changes/archive/`.

## MODIFIED Requirements

### Requirement: The system SHALL render thumbnails of pending image/video references inside `MentionInput`.

For each `pendingReference` whose kind classifies as `image` or `video`, a 64×64 px `MediaThumbnail` renders beside the `ReferenceChip`. The thumbnail source resolution priority is:

1. The reference's `remoteUrl` field, if present (a `https://<bucket>.cos.<region>.myqcloud.com/<key>` URL produced by `AttachmentUploader`). For image MIMEs the URL has `?imageView2/2/w/<n>` appended where `<n>` is the rendered pixel width on the highest-DPR display (typically 128).
2. The reference's `localPath` rendered via `local-file:///<percent-encoded-abs-path>` directly through `<img>` — only when `CATIMATION_LOCAL_FILE_DIRECT=1` (default after the soak period) AND `toRenderableUri()` produced a parseable URI.
3. A downscaled PNG fetched via the `media:thumb` IPC. The IPC reads the source from disk in the main process and returns a `nativeImage`-thumbnailed PNG (≤ 512×512). Response payload is ≤ 64 KB after base64 for 99 % of real-world inputs.

In no case does the renderer read or decode the full-resolution source for a thumbnail.

#### Scenario: Reference renders before remote upload finishes

- **WHEN** the user has just dropped `photo.jpg` (3 MB) and `remoteUrl` is not yet set
- **THEN** the chip renders within 200 ms via `media:thumb` IPC
- **AND** no `attachments:read-thumb` invocation occurs

#### Scenario: Reference renders after remote upload completes

- **WHEN** `AttachmentUploader` has set `remoteUrl` on the row and the renderer re-renders
- **THEN** the chip's `<img>` source is `<remoteUrl>?imageView2/2/w/128`
- **AND** no IPC roundtrip occurs for the thumbnail
- **AND** Chromium issues exactly one HTTPS GET to the COS CDN edge

#### Scenario: `media:thumb` IPC stays under the size cap

- **WHEN** the renderer requests a thumbnail for a 80 MB DSLR RAW
- **THEN** the IPC returns either `{ ok: true, base64, mime: 'image/png' }` whose base64 length is ≤ 100 KB
- **OR** `{ ok: false, reason: 'size whitelist: ... exceeds ...' }` when the source itself exceeds the 100 MB cap

### Requirement: The system MAY display thumbnail bytes via a base64-over-IPC fallback when `local-file://` is unreliable.

> Replaced by the new "media:thumb" IPC. The old `attachments:read-thumb` channel remains for `Lightbox` only (full-fidelity image preview), gated by an explicit `{ fullFidelity: true }` flag passed by the calling component.

This requirement is **renamed and tightened** to:

#### Requirement (replacement): The system SHALL provide a full-fidelity byte-read IPC for explicit consumers only.

`attachments:read-thumb` (a misnomer kept for backward compat) reads the full file's bytes and returns them as base64. Only `Lightbox`, the file-explorer `ReferencePreview` in "full view" mode, and any opt-in consumer that passes `{ fullFidelity: true }` to `useResolvedMediaSrc` may invoke it. The `MediaThumbnail` default codepath SHALL NOT invoke it.

##### Scenario: Lightbox opens a local image

- **WHEN** the user clicks a chip and the Lightbox mounts with `fullFidelity: true`
- **THEN** `attachments:read-thumb` is invoked and the full image renders
- **AND** the corresponding `MediaThumbnail` mount on the same path did not invoke `attachments:read-thumb`

## ADDED Requirements

### Requirement: The system SHALL provide a downscaled-thumbnail IPC for renderer chip display.

A new main-process IPC handler `media:thumb` accepts an absolute OS path and returns a downscaled PNG produced by `nativeImage.createThumbnailFromPath(path, { width: 512, height: 512 })`. When NativeImage returns an empty result (no OS thumbnail backend, SVG input, animated frame), the handler falls back to `sharp(path).resize(...).toBuffer()`. The handler enforces the same path-validation rules as `attachments:read-thumb` (no traversal, mime whitelist, 100 MB source size cap).

#### Scenario: Successful native thumbnail

- **WHEN** the renderer invokes `electronAPI.attachments.readMediaThumb('/abs/path/photo.jpg')` for a valid 5 MB JPEG
- **THEN** the response is `{ ok: true, base64, mime: 'image/png' }` and the base64 length is ≤ 100 KB

#### Scenario: SVG triggers sharp fallback

- **WHEN** the renderer requests a thumbnail for a valid SVG file
- **THEN** the handler invokes `sharp` to rasterize and returns a PNG thumbnail

#### Scenario: Traversal segment rejected

- **WHEN** the renderer requests `'/abs/../etc/passwd'`
- **THEN** the response is `{ ok: false, reason: 'traversal segment in path' }`

### Requirement: The system SHALL asynchronously upload eligible attachments to Tencent COS in the main process.

After `AttachmentService` emits `attachment-added`, a new `AttachmentUploader` consumer evaluates the saved row against the policy: mime starts with `image/` or `video/`, size > 256 KB, env `CATIMATION_ATTACHMENT_REMOTE_UPLOAD` not `0`. Eligible rows are queued (max concurrency 2) and uploaded to bucket key `agent-attachments/<threadId>/<sha>.<ext>` via `uploadBufferToBucket` (< 5 MB) or `uploadStream` (≥ 5 MB). On success the row is updated with `remoteUrl` and `uploadStatus = 'done'` and an `attachment-uploaded` event broadcasts to the renderer. On failure the row is marked `uploadStatus = 'failed'` and no exception propagates.

#### Scenario: Eligible image uploaded successfully

- **WHEN** the user attaches a 3 MB JPEG and `AttachmentService` finishes ingesting
- **THEN** within 10 s on a 100 Mbps link the row has `uploadStatus = 'done'` and `remoteUrl` set to `https://<bucket>.cos.<region>.myqcloud.com/agent-attachments/<threadId>/<sha>.jpg`
- **AND** the renderer receives `attachment-uploaded` and re-renders chips with the URL

#### Scenario: Small or non-media file skipped

- **WHEN** the user attaches a 50 KB JSON file
- **THEN** `uploadStatus` stays `pending` and no upload is attempted

#### Scenario: Network failure keeps agent turn alive

- **WHEN** upload fails because of network timeout
- **THEN** `uploadStatus = 'failed'` and the agent turn proceeds using `localPath` exactly as it would have without the upload pipeline

#### Scenario: Feature flag disables the pipeline

- **WHEN** `CATIMATION_ATTACHMENT_REMOTE_UPLOAD=0` is set
- **THEN** no upload is attempted for any attachment regardless of mime / size
- **AND** the renderer falls back to local `media:thumb` rendering

### Requirement: The system SHALL keep Tencent COS SecretKey strictly inside the main process.

No renderer-process code reads, transmits, or persists `secretId` / `secretKey`. Renderer access to COS is mediated exclusively via main-process-minted presigned URLs (when direct upload from renderer is ever needed). The `CosCredentialProvider` interface exposes only abstract `getCredentials({ keyPrefix })` to call sites in `cosClient.ts`; no renderer code can reach it through the contextBridge.

#### Scenario: Static check catches SecretKey leak

- **WHEN** a code review tool greps for `secretKey` under `src/renderer/`
- **THEN** zero matches are returned
- **AND** the CI lint job fails any PR that adds a renderer-side reference

#### Scenario: STS provider can be swapped without renderer changes

- **WHEN** the env flag `CATIMATION_COS_USE_STS=1` is set
- **THEN** `cosClient.ts` obtains a `securityToken`-bearing credential set from `StsCredentialProvider` for each upload
- **AND** every cos SDK call carries `XCosSecurityToken`
- **AND** renderer code is unchanged

### Requirement: The system SHALL pre-resize images that exceed vision-API limits before sending to Codex.

When an image attachment is to be sent to Codex and its longest edge > 8000 px OR its filesize > 5 MB, the main process produces a resized copy at `<uploads-dir>/<sha>.resized.<ext>` using `sharp`. The resized path is the one passed to Codex; the original is preserved. Non-image, non-static-image (animated GIF), and SVG attachments are not resized.

#### Scenario: 12 MP iPhone JPEG is resized before send

- **WHEN** the user attaches a 4032×3024 / 4.2 MB JPEG and sends the turn
- **THEN** `<sha>.resized.jpg` exists at ≤ 8000×6000 with quality 90
- **AND** the Codex JSON-RPC payload references the resized path, not the original
- **AND** the original file remains on disk

#### Scenario: Small image passes through unchanged

- **WHEN** the user attaches a 1024×1024 / 800 KB PNG
- **THEN** no resize is performed and the original path is sent

#### Scenario: Resize cache hits on resend

- **WHEN** the user resends a turn whose image has previously been resized
- **THEN** the existing `<sha>.resized.ext` is reused without invoking `sharp`

## REMOVED Requirements

(none — all existing requirements are retained, two are modified in place)
