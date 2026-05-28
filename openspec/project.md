# Project: Catimation Director (Electron Codex Workbench)

## Purpose

Electron desktop app that wraps the OpenAI Codex CLI (Rust binary) plus a renderer that re-implements the Codex chat experience with first-class image/video attachments, MCP, slash skills, and a file-explorer workspace. Targets Windows / macOS / Linux. Same binary doubles as a director tool for AI image-master pipelines (storyboard, smart-erase, etc.); both surfaces share infra.

## Stack

| Layer | Tech |
|---|---|
| Shell | Electron 38 (Chromium 142), packaged via electron-builder |
| Renderer | React 18 + Zustand + Tailwind, Vite via `electron.vite.config.ts` |
| Main process | Node 22, TypeScript, IPC over `contextBridge` |
| Persistence | PGlite (embedded Postgres) over Prisma in main process |
| Codex backend | Rust `codex` CLI spawned as child process, JSON-RPC over stdio |
| Storage / CDN | Tencent COS (`cos-nodejs-sdk-v5`); `safeStorage`-encrypted SecretKey on disk |
| Image ops | `sharp` 0.34.x available in main process, Electron `nativeImage` built-in |
| Tests | Vitest (`*.test.ts(x)`), Playwright (`e2e/`) |

## Conventions

- **Spec-first.** Long-lived design docs live under `docs/superpowers/specs/<date>-<slug>-design.md`; PR-level plans under `docs/superpowers/plans/<date>-<slug>-pr<N>-<tag>.md`. This `openspec/` folder is the AI-tool-consumable mirror.
- **Path-only attachments** for anything bigger than UI metadata. Renderer never holds file bytes if a real on-disk path exists (`webUtils.getPathForFile` + `local-file://` protocol). Mirrors `openai/codex#21108` (path-based attachment contract).
- **Main thread is sacred.** No synchronous base64 / structured-clone of >256 KB payloads over IPC. Streaming preferred (`fs/createReadStream`, `pipeline`). Background work via `utilityProcess` when CPU-bound.
- **Security: SecretKey never leaves main process.** Renderer only sees presigned URLs or transient base64 thumbnails capped at ~64 KB. `cos-credentials.json` in repo root is **dev fallback only** and must not ship in packaged builds.
- **TDD where the surface is contract-shaped** (IPC, DB schema, agent protocol). Snapshot tests for UI cards. Smoke tests for Codex launch.

## Domain capabilities (top-level)

| Capability | Owner files | Status |
|---|---|---|
| `codex-chat-attachments` | `src/main/agent/AttachmentService.ts`, `src/renderer/src/features/agent-chat/MentionInput.tsx`, `src/main/file-explorer/attachmentsIpc.ts` | Live; subject to this change |
| `codex-chat-runtime` | `src/main/agent/Codex{Local,Protocol,Provider}*.ts`, `src/renderer/src/features/agent-chat/store.ts` | Live |
| `codex-chat-evidence` | `src/renderer/src/features/agent-chat/evidence/*` | Live |
| `media-rendering` | `src/renderer/src/components/shared/media/*`, `src/main/file-explorer/protocolHandler.ts` | Live; subject to this change |
| `cos-uploads` | `src/main/services/tencent/cosClient.ts`, `credentials.ts` | Live, currently only used by storyboard/smart-erase |
| `file-explorer` | `src/main/file-explorer/*`, `src/renderer/src/features/file-explorer/*` | Live |

## Out of scope for this project

- Web/SaaS deployment of the Codex workbench (Electron-only)
- Mobile / iPad clients
- Vendor lock-in to any single LLM provider (multi-provider already shipped, see `codexProviders.ts`)
