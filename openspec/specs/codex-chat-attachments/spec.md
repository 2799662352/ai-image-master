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

### Requirement: The system SHALL accept internal file-explorer drag-drop and surface a preview chip.

When the user drags entries from the in-app file-explorer panel, the drop payload carries the custom MIME `application/x-catimation-file-paths` plus the workspace-relative paths. These resolve to absolute paths via the workspace root, are size/mime-probed via the `fs:stat` IPC, and result in both an `attachment` entry **and** a `pendingReference` entry that renders a `MediaThumbnail` chip in the composer.

#### Scenario: Internal drop of three workspace PNGs

- **WHEN** the user multi-selects three PNGs in the file-explorer panel and drags them onto the composer
- **THEN** the store has three new attachments and three new pending references
- **AND** three `MediaThumbnail` chips render with thumbnails sourced from `local-file:///<encoded-abs-path>`
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

### Requirement: The system SHALL render thumbnails of pending image/video references inside `MentionInput`.

For each `pendingReference` whose kind classifies as `image` or `video`, a 64×64 px `MediaThumbnail` renders beside the `ReferenceChip`. The thumbnail source is the reference's `localPath`, transformed to a renderable URI via `toRenderableUri()` (yields `local-file:///<percent-encoded>`).

#### Scenario: Reference list contains an image and a doc

- **WHEN** `pendingReferences` is `[image.png, README.md]`
- **THEN** `image.png` renders a `MediaThumbnail` chip; `README.md` renders a `ReferenceChip` only

### Requirement: The system MAY display thumbnail bytes via a base64-over-IPC fallback when `local-file://` is unreliable.

In Electron 38 dev mode, `local-file://` URLs with Windows drive letters can fail to parse in the renderer (`electron/electron#49073`). The `useResolvedMediaSrc` hook accepts a raw `local-file://`-shaped URL **or** absolute OS path; for both it invokes `attachments:read-thumb` IPC to read the whole file (≤ 100 MB), base64-encodes it, IPC-clones the string to the renderer, decodes to `ArrayBuffer`, builds a `Blob`, and yields a `blob:` URL.

#### Scenario: Renderer mounts a `MediaThumbnail` with a `local-file://` src

- **WHEN** `MediaThumbnail` mounts with `src = 'local-file:///D%3A/photos/big.jpg'`
- **THEN** `attachments:read-thumb` is invoked with the resolved OS path
- **AND** the renderer eventually sets `<img src="blob:...">` and renders the image
- **NOTE** this path is the dominant lag source for files > 1 MB and is replaced by the change `fix-codex-chat-image-attachment-lag`

### Requirement: The system SHALL send attachments to the Codex CLI as on-disk paths.

The agent's `send-message` IPC maps each `attachment` to `{ kind: 'attachment', path: '<userData>/agent/uploads/<sha>.<ext>', mime, name }` after `AttachmentService.ingest` resolves. The Codex Rust CLI reads bytes from those paths itself; the renderer / main process do not stream bytes to the CLI.

#### Scenario: Sending a turn with two image attachments

- **WHEN** the user sends a turn with two ingested image attachments
- **THEN** the Codex JSON-RPC payload contains two `attachment` items each with a `path` inside `<userData>/agent/uploads/`
- **AND** the Codex CLI reads those paths via its own filesystem access
