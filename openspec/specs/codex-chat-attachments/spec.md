# Capability: codex-chat-attachments

## Purpose

Let users attach files (images / video / docs) to a Codex turn via drag-drop, file-picker, or `@` mention, and have those files reach the Rust Codex CLI as path-based attachments without freezing the renderer or the main-process event loop.

## Boundaries

- **In**: file-picker (`<input type=file>`), external OS drag-drop, internal file-explorer drag-drop, `@` mention from workspace tree, preview of pending attachments inside `MentionInput`, persistence of saved attachments in `AgentAttachment` table, ingestion of bytes into `<userData>/agent/uploads/<sha>.<ext>`.
- **Out**: clipboard-paste of images (planned, separate capability), rendering of attachments inside historical messages (covered by `codex-chat-evidence`), the Codex Rust CLI's own attachment handling.

## Current behavior (live, as of 2026-05-28)

### Requirement: The system SHALL accept external OS drag-drop into `MentionInput` as path-only attachments.

When the user drops files from Windows Explorer / macOS Finder / GNOME Files, each `File` object is resolved to an absolute OS path via `webUtils.getPathForFile` (Electron ≥ 32) and stored as `{ name, mime, size, path }` in the Zustand `attachments` array. The renderer never reads file bytes; size/mime come from the `File` object directly. Mirrors the contract Codex landed in `openai/codex#21108`.

#### Scenario: External drop of a 5 MB JPEG from Finder

- **WHEN** the user drags `~/Desktop/photo.jpg` into the chat composer
- **THEN** the store gains one entry `{ name: 'photo.jpg', mime: 'image/jpeg', size: 5_242_880, path: '/Users/.../photo.jpg' }`
- **AND** no `arrayBuffer()` / `readAsDataURL` is called on the `File`
- **AND** the attachment counter chip updates to `1/20`

### Requirement: The system SHALL accept internal file-explorer drag-drop and surface a `ReferenceChip` per file.

When the user drags entries from the in-app file-explorer panel, the drop payload carries the custom MIME `application/x-catimation-file-paths` plus the workspace-relative paths. These resolve to absolute paths via the workspace root, are size/mime-probed via the `fs:stat` IPC, and result in both an `attachment` entry **and** a `pendingReference` entry that renders a text-only `ReferenceChip` in the composer (no inline thumbnail — see the dedicated "no inline thumbnail" requirement below).

#### Scenario: Internal drop of three workspace PNGs

- **WHEN** the user multi-selects three PNGs in the file-explorer panel and drags them onto the composer
- **THEN** the store has three new attachments and three new pending references
- **AND** three `ReferenceChip` elements render (filename + type label + remove `×`); zero `[data-media-kind]` wrappers exist in the composer
- **AND** the failure mode for any single file (e.g. size > 100 MB) only skips that file, surfacing a `setError` message that lists the skipped path and reason

### Requirement: The system SHALL enforce attachment quotas client-side before any disk read.

Quotas: 20 files per turn, 100 MB per file, 250 MB total per turn. A drop that would push past any of these stops accepting at the offending file; subsequent files in the drop are skipped with a per-file reason.

#### Scenario: Drop list exceeds total bytes

- **WHEN** the user drops four 80 MB videos in a single drop
- **THEN** the first three attach (240 MB total) and the fourth is skipped with reason `超过总量 250MB`
- **AND** no fs.read happens for the rejected file

### Requirement: The system SHALL ingest attachments to a content-addressed uploads directory without blocking the event loop.

`AttachmentService.ingest()` processes attachments sequentially. Each file is streamed `createReadStream(path, { highWaterMark: 64 * 1024 })` into a temp `_tmp_<uuid>.<ext>`, hashing per chunk; on success the temp file is renamed to `<sha256>.<ext>` (content-addressed dedup). Between files, `setImmediate` is awaited so the in-process PGLite socket server and Codex backend get a turn at the event loop. Per-file failures emit `attachment-error` and **do not** abort the rest of the ingestion. Reference: `docs/superpowers/specs/2026-05-11-attachment-streaming-design.md`.

#### Scenario: Ingesting three 80 MB files

- **WHEN** `AttachmentService.ingest()` is called with three 80 MB files
- **THEN** event-loop p99 latency stays under 50 ms during ingestion
- **AND** the resulting files exist at `<userData>/agent/uploads/<sha>.<ext>` and are referenced by `AgentAttachment` rows
- **AND** `PrismaClient` does not raise `Server has closed the connection`

### Requirement: The system SHALL display each pending reference as a text-only `ReferenceChip` inside `MentionInput`, with no inline thumbnail.

For every entry in `pendingReferences` — image, video, or other — the composer renders exactly one `ReferenceChip` (type label + filename + remove `×`). No `MediaThumbnail` mounts in the composer's `<form>`, and no `media:thumb` / `attachments:read-thumb` IPC fires on drop. This is the trade chosen by [PR #23](https://github.com/2799662352/ai-image-master/pull/23) to eliminate per-drop renderer lag without needing remote-CDN acceleration: chip ≪ thumbnail in IPC cost, and click-to-open via `openReference` covers the "I want to verify what I attached" case.

#### Scenario: User drops five 10 MB images into the composer

- **WHEN** the user multi-drops five 10 MB JPEGs from Finder / Explorer
- **THEN** the composer renders five `ReferenceChip` elements within one paint frame (≤ 16 ms p99)
- **AND** zero `[data-media-kind]` wrappers exist in the `<form>` subtree
- **AND** zero `media:thumb` and zero `attachments:read-thumb` IPC invocations occur for those drops
- **AND** the renderer main thread does not block for more than 50 ms p99 in the 2 s following the drop

#### Scenario: Click on a queued image chip opens a preview

- **WHEN** the user clicks any chip in the composer
- **THEN** `openReference(reference)` is invoked
- **AND** for image / video references this opens the Lightbox / file-explorer preview pane

### Requirement: The system SHALL expose two distinct IPC channels for media bytes — a fast downscaled-thumbnail path and a slow full-fidelity path — and renderer code SHALL route requests to the right channel by explicit opt-in.

A new main-process IPC handler `media:thumb` accepts an absolute OS path and returns a downscaled JPEG produced by `nativeImage.createThumbnailFromPath(path, { width: 256, height: 256 })`. When NativeImage returns an empty result (no OS thumbnail backend, SVG input, animated frame), the handler falls back to `sharp(path).resize(...).jpeg({ quality: 78 }).toBuffer()`. SVG inputs are passed through as inline UTF-8 to avoid rasterization. The handler enforces the same path-validation rules as `attachments:read-thumb` (no traversal, mime whitelist, ≤ 100 MB source size cap, video MIMEs explicitly rejected).

The pre-existing `attachments:read-thumb` IPC (a misnomer kept for backward compat) reads the full file's bytes and returns them as base64. Only `Lightbox`, the file-explorer `ReferencePreview` in "full view" mode, and any opt-in consumer that passes `{ fullFidelity: true }` to `useResolvedMediaSrc` may invoke it. The default `MediaThumbnail` codepath consumed by `AttachmentCard`, `EvidenceStack`, and file-tree previews routes through `media:thumb` instead. (The composer itself no longer mounts `MediaThumbnail` at all — see the previous requirement.)

#### Scenario: Successful native thumbnail

- **WHEN** the renderer invokes `electronAPI.attachments.readMediaThumb('/abs/path/photo.jpg')` for a valid 5 MB JPEG
- **THEN** the response is `{ ok: true, base64, mime: 'image/jpeg' }` and the base64 length is ≤ 100 KB

#### Scenario: SVG triggers sharp fallback

- **WHEN** the renderer requests a thumbnail for a valid SVG file
- **THEN** the handler returns the SVG bytes inline (no rasterization) and the renderer mounts it directly

#### Scenario: Traversal segment rejected

- **WHEN** the renderer requests `'/abs/../etc/passwd'`
- **THEN** the response is `{ ok: false, reason: 'traversal segment in path' }`

#### Scenario: Lightbox opens a local image at full fidelity

- **WHEN** the user clicks a sent-message attachment and the Lightbox mounts with `useResolvedMediaSrc(src, { fullFidelity: true })`
- **THEN** `attachments:read-thumb` is invoked and the full image renders
- **AND** the corresponding timeline `MediaThumbnail` on the same path did not invoke `attachments:read-thumb` (it used `media:thumb`)

### Requirement: The system SHALL send attachments to the Codex CLI as on-disk paths.

The agent's `send-message` IPC maps each `attachment` to `{ kind: 'attachment', path: '<userData>/agent/uploads/<sha>.<ext>', mime, name }` after `AttachmentService.ingest` resolves. The Codex Rust CLI reads bytes from those paths itself; the renderer / main process do not stream bytes to the CLI.

#### Scenario: Sending a turn with two image attachments

- **WHEN** the user sends a turn with two ingested image attachments
- **THEN** the Codex JSON-RPC payload contains two `attachment` items each with a `path` inside `<userData>/agent/uploads/`
- **AND** the Codex CLI reads those paths via its own filesystem access
