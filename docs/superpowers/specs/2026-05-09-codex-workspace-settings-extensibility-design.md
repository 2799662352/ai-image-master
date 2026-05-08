# Codex Agent Workspace Settings & Extensibility Design

## Summary

Move the Codex permissions, MCP servers, and skills surfaces out of the cramped agent chat header into a dedicated `Agent Workspace` page modeled after Cursor's settings layout, and let users freely create, edit, and delete their own MCP server entries and skills from inside the app. Add a top-level `Agent Workspace` tab to the existing `TabBar` and a compact Codex status button on the top-right that opens the agent chat. Keep all existing generation-related tabs (`生成 / 批量 / 对比 / 历史 / 理解 / 导演 / 拆图 / 去字幕 / 模板 / 设置`) untouched in order and behavior.

This is Phase 3 work that follows directly on Phase 2 (`2026-05-08-codex-native-workspace-ui-phase2`), which intentionally kept MCPs and skills read-only. Phase 3 lifts that read-only restriction with a `trust on add` policy chosen explicitly by the user, while preserving Phase 2's per-tool-call approval flow as the last line of defense.

## Problem Frame

Phase 2 surfaced Codex permissions, MCP servers, and skills as three stacked panels inside `AgentChatPanel`'s header. The result is visually cramped, hard to scan, and offers no way for the user to add or edit a new MCP server or skill. Users who want to extend Codex with custom tooling (their own MCP servers, their own skill files) currently have to leave the app, hand-edit `~/.codex/config.toml` or files under `.agents/skills/`, and rely on Phase 2's discovery to surface the change. The product wants a first-class extensibility surface, similar to Cursor's `Tools & MCPs` and `Rules / Skills / Subagents` settings sections, accessible from the app's top-level navigation.

The existing `pages-react/SettingsPage.tsx` is already in use for API keys, sites, and Tencent Cloud credentials, so the new Codex extensibility surface needs its own page rather than being grafted onto an unrelated settings page. The existing `TabBar` already uses emoji icons that violate the project's UI guidelines (`no-emoji-icons` rule), but the user has explicitly scoped this Phase 3 work to *not* renumber, reorder, or rebrand the existing generation tabs; only the new `Agent Workspace` tab and the new top-right `Agent` status button need to follow the SVG-icon, JetBrains-Mono, dark-developer-tools direction recommended by `ui-ux-pro-max`.

## Scope

### In Scope

- New top-level tab `Agent Workspace` in `TabBar`, added after `模板`, before `设置`.
- New top-right compact `Agent` status button (separate from the tab) that shows the current Codex session summary and opens the agent chat panel.
- New `AgentWorkspacePage` rendered through `AppLayout`'s existing `PageMap` and lazy import pattern.
- Migrate `CodexPermissionsPanel`, `CodexMcpPanel`, `CodexSkillsPanel`, and the Codex thread list out of `AgentChatPanel`'s header into `AgentWorkspacePage`. Leave behind a much lighter status strip in the chat panel.
- MCP server CRUD with form mode, raw-TOML mode, dual scope (`Personal` = `~/.codex/config.toml`, `Workspace` = `<projectRoot>/.codex/workspace-mcp.toml`).
- Skill CRUD with form mode, raw-Markdown mode, dual scope (`Personal` = `~/.agents/skills/<name>/SKILL.md`, `Workspace` = `<projectRoot>/.agents/skills/<name>/SKILL.md`).
- Codex runtime config merge that combines personal and workspace MCP configs into a generated `config.toml` under `app.getPath('userData')/codex-runtime/` and launches `codex app-server` with `CODEX_HOME` pointing at that directory.
- Trust-on-add lifecycle: save writes immediately, restart Codex backend on user action, no approval gate.
- Non-blocking risk hints (inline command preview, yellow-stripe heuristic for risky args, audit log).
- Atomic writes for config and skill files.
- IPC additions for list, get-detail, save, delete, set-enabled, restart, and audit-log read.
- Tests at the same level Phase 2 used (vitest unit tests for main and renderer, IPC integration tests; no e2e additions).

### Out of Scope

- Renaming, reordering, or rebranding the existing `生成 / 批量 / 对比 / 历史 / 理解 / 导演 / 拆图 / 去字幕 / 模板 / 设置` tabs or their icons.
- Replacing the existing custom OS chrome / title bar; current native frame stays.
- Adding a global command palette (Cmd/Ctrl+K) or VS-Code-style activity bar. Both are deferred to a later phase.
- Approval gate for newly added MCP servers. The user explicitly opted into trust-on-add; risk mitigation is hint-only.
- Automatic `.gitignore` management for workspace MCP / skill files. The user explicitly declined any `.gitignore` prompt; whether or not to commit `<projectRoot>/.codex/workspace-mcp.toml` is the user's responsibility.
- Sandboxed first-launch probe of newly added MCP servers.
- Editing or removing existing API key / site management on `SettingsPage`.
- Slash command parser changes beyond the existing `/insert` skill button.
- Migrating Phase 2's `pendingServerRequests` / per-tool-call approval flow.

## Key Decisions

### Trust on Add for MCP and Skill Saves

The user explicitly chose zero friction for adding MCP servers and skills: save writes the file, the next Codex restart picks it up, no approval dialog. Implications and accepted residual risk are documented under `Security` below. Phase 2's per-tool-call approval policy (`untrusted` / `on-request` / `never`) remains the user's authoritative defense against an MCP server actually invoking tools.

### No `.gitignore` Automation

Workspace MCP files are written to `<projectRoot>/.codex/workspace-mcp.toml` as-is. The app does not modify `.gitignore`, does not warn that env values may end up in version control, and does not differentiate workspace MCP files from workspace skill files in this regard. Users who want to ignore the workspace MCP file are responsible for doing so themselves.

### Dual Scope With Sensible Defaults

When the user creates a new MCP server, the scope picker defaults to `Personal` (because MCP env values often contain credentials and personal scope keeps them out of the project). When the user creates a new skill, the scope picker defaults to `Workspace` (because skills typically describe project-specific behavior worth sharing with the team). Both choices are user-overridable per item.

### Codex Runtime Merge Lives in Main Process

Codex CLI natively reads only `~/.codex/config.toml`. To support workspace-scope MCPs without forking Codex, the Electron main process generates a merged `config.toml` at Codex launch and points Codex at it via `CODEX_HOME`. Workspace entries shadow personal entries by `name`. The merged file is rebuilt on every save / delete / scope change.

### Form + Raw Editing for Both MCP and Skill

Both editors share the same shape: a form view for the common case and a raw view backed by Monaco / CodeMirror with schema-aware lint. Save is identical between modes; the active view at save time only determines which presentation is being persisted, not the underlying file.

### Existing Generation Tabs Are Untouched

`useTabStore.VALID_TABS` is extended with one entry, not reordered. `TabBar` adds one button before `设置`. No emoji is removed, no icon is replaced, no label is changed for any existing tab. Visual fixes for those tabs are explicitly deferred to a later phase.

## Architecture

### Top-Level Navigation Changes

```text
AppLayout
└── TabBar
    ├── 生成 (unchanged)
    ├── 批量 (unchanged)
    ├── 对比 (unchanged)
    ├── 历史 (unchanged)
    ├── 理解 (unchanged)
    ├── 导演 (unchanged)
    ├── 拆图 (unchanged)
    ├── 去字幕 (unchanged)
    ├── 模板 (unchanged)
    ├── Agent Workspace ← new, SVG icon, label `Agent Workspace`
    └── 设置 (unchanged)
└── TopRightActions ← new region, right-aligned within TabBar
    └── AgentStatusButton
        ├── compact pill: `Codex · <sandbox> · <approval>`
        ├── click default: open AgentChatPanel
        └── secondary "Open Workspace" link: switch to `agentWorkspace` tab
└── main / ActivePage
    └── AgentWorkspacePage when activeTab === 'agentWorkspace'
└── AgentChatPanel
```

`useTabStore` adds `agentWorkspace` to `VALID_TABS`. `AppLayout`'s `PAGE_MAP` adds `agentWorkspace: AgentWorkspacePage`. `pages-react/index.ts` exports a lazy `AgentWorkspacePage`.

`TabBar` is updated minimally to render the new tab and to host a right-aligned `TopRightActions` slot for `AgentStatusButton`. Existing tabs render the same way they do today; their emoji icons are intentionally preserved.

### Agent Workspace Page Layout

```text
AgentWorkspacePage
├── header
│   └── title `Agent Workspace`
│   └── codex runtime status (sandbox, approval, web search, writable roots count)
├── grid: nav | content
│   └── AgentWorkspaceNav (left)
│       ├── Overview
│       ├── Permissions
│       ├── MCP Servers
│       ├── Skills
│       ├── Threads
│       └── Logs
│   └── AgentWorkspaceContent (right)
│       └── one section component per nav item
└── floating "Restart Codex" prompt when config is dirty
```

Routing inside the page uses internal section state (`useAgentWorkspaceStore`) rather than route hash, since the page sits behind a single tab. Section state is preserved when the user leaves and returns to the tab.

### AgentChatPanel Slim-Down

`AgentChatPanel` no longer renders `CodexPermissionsPanel`, `CodexMcpPanel`, `CodexSkillsPanel`, or the Codex thread sidebar's full management UI. Instead it shows:

- A 1-line status strip: model name, sandbox, approval, web search, writable roots count.
- The existing pending approval prompts (`CodexApprovalPrompt`).
- Messages, attachments, and `MentionInput` (unchanged).
- A small `Open Agent Workspace` button that switches to the new tab.

The Codex thread sidebar continues to show the recent threads list as a quick switcher; full thread management (read, fork, archive) lives in the `Threads` section of `AgentWorkspacePage`.

### File Targets

```text
Personal scope (跟人走):
  ~/.codex/config.toml
  ~/.agents/skills/<name>/SKILL.md

Workspace scope (跟项目走):
  <projectRoot>/.codex/workspace-mcp.toml
  <projectRoot>/.agents/skills/<name>/SKILL.md
```

`<projectRoot>` is the Electron app's `process.cwd()` at launch, normalized via `fs.realpath` (Phase 2 mechanism). The path is captured once at startup and exposed to the renderer through an existing IPC bridge so the renderer can render absolute paths in scope pickers.

`workspace-mcp.toml` follows the same `[mcp_servers.<name>]` section structure as `~/.codex/config.toml`. The file is owned by Phase 3; Phase 2 readers must be extended to also parse it.

### Codex Runtime Merge

Before each `codex app-server` spawn, `CodexLocalBackend` builds a runtime config:

1. Read `~/.codex/config.toml` into an in-memory document. Missing file is treated as an empty document.
2. Read `<projectRoot>/.codex/workspace-mcp.toml` into a second in-memory document. Missing file is treated as empty.
3. For each `[mcp_servers.<name>]` section: workspace overrides personal by name; otherwise personal entries are kept as-is.
4. Drop entries with `enabled = false`.
5. Serialize to `<userData>/codex-runtime/config.toml` via atomic write.
6. Spawn Codex with `env.CODEX_HOME = <userData>/codex-runtime` and `cwd = <projectRoot>`.

Skills do not need a merge step because Phase 2's `discoverCodexSkills({ cwd, home })` already reads from both `<projectRoot>/.agents/skills/` and `~/.agents/skills/`. The new home location for personal skills is `~/.agents/skills/`, which matches the existing discovery path.

### IPC Surface Additions

All IPC handlers live in `src/main/agent/ipc.ts`. Renderer wraps them through `src/preload/index.ts`.

```text
agent:list-mcp
  Returns array of { id, name, scope, enabled, command, argsSummary, envKeysRedacted, lastModifiedIso, provenance, warnings }.
  Replaces / extends Phase 2's agent:get-mcp-summary.

agent:get-mcp-detail { id }
  Returns full editable record including env values in clear text.
  Only called when the user explicitly opens the editor.

agent:save-mcp { input }
  Validates, writes, rebuilds merged runtime config, returns the new id and any warnings.

agent:delete-mcp { id }
agent:set-mcp-enabled { id, enabled }

agent:list-skills
  Returns array of skill summaries (name, scope, path, description, warnings).
  Replaces / extends Phase 2's agent:get-skills-summary.

agent:get-skill-detail { id }
  Returns full SKILL.md text plus parsed frontmatter for the editor.

agent:save-skill { input }
agent:delete-skill { id }

agent:get-workspace-logs { limit?, sinceIso? }
  Returns recent audit-log entries.

agent:restart-codex
  Triggers the backend to swap to the latest merged config. Existing in-flight tool calls finish on the old config; new threads start on the new config.

agent:list-codex-threads, agent:read-codex-thread, agent:fork-codex-thread
  Phase 2 handlers, reused from AgentWorkspacePage's Threads section.
```

### Data Flow for Saves

```text
Renderer (AgentWorkspacePage editor)
  → preload.agent.saveMcp(input) | preload.agent.saveSkill(input)
     ↓
Main IPC handler
  ↓ validate (form fields and raw text)
  ↓ canonicalize target path via fs.realpath
  ↓ atomic write (.tmp + fsync + rename)
  ↓ append audit-log entry
  ↓ if MCP: rebuild merged runtime config and mark backend as "config dirty"
  ↓ broadcast 'agent:workspace-changed' to renderer
Renderer
  ↓ refresh list view
  ↓ if MCP changed: show "Restart Codex" toast / banner
  ↓ user explicitly clicks "Restart Codex" → preload.agent.restartCodex()
```

### Form ↔ Raw Editing

Each editor type has two views backed by the same in-memory model.

For MCP:

- Form fields: `name`, `scope`, `enabled`, `command`, `args[]`, `env` key/value pairs, `description`, `tags?`.
- Raw view: the TOML fragment for the single MCP entry. Parsed into the form model on view-switch. Save serializes the form model back to TOML.
- Switching from raw to form fails closed when the raw text does not parse: the form view shows a parse error and refuses to switch until the raw text is valid.

For Skill:

- Form fields: `name`, `scope`, `description`, `whenToUse`, `instructions` (markdown body).
- Raw view: the full `SKILL.md` text with YAML frontmatter and markdown body. Switching from raw to form parses the frontmatter and body into the form model.

Both editors follow the developer-tools direction from `ui-ux-pro-max`: dark JetBrains-Mono / IBM-Plex stack, SVG icons (Lucide), 150-300 ms transitions, visible focus rings, secret-typed inputs for env values.

### Security

Trust on add. The risk window is the time between save and the user noticing a hostile MCP entry has appeared.

Non-blocking mitigations:

- **Inline preview** in form mode shows the resolved `<command> <args...> env=<keys redacted>` line at the bottom of the editor before save.
- **Risky-arg yellow stripe** on top of the editor when args contain any of: `--privileged`, `--network=host`, `--cap-add`, `-v /:`, `--mount type=bind,src=/`, `sudo`, `rm -rf /`, plain `bash -c`, `sh -c`, `eval`. Hint only; does not block save.
- **Audit log** appended on every save / delete with `{ tsIso, actor: 'user', action, scope, name, provenance: 'manual' | 'clipboard' | 'imported' }`. Visible in the `Logs` section.
- **Path containment** reuses Phase 2's `fs.realpath` based canonical containment for the four allowed write roots. Writes outside those roots are rejected before any disk write.
- **Atomic write** prevents half-written files from breaking the next Codex launch.
- **Name validation** rejects `name` values that contain NUL, path separators, `.`, `..`, or are empty.
- **Secret handling** routes env values through password-typed inputs, redacts them in `agent:list-mcp` and audit-log entries, and only returns clear text from `agent:get-mcp-detail` when an editor is explicitly opened.
- **Phase 2 per-tool-call approval** still fires on any tool call from any MCP server when the approval policy is `untrusted` or `on-request`. This is the user's authoritative defense.

Accepted residual risk:

- A hostile config pasted by the user is live as soon as Codex restarts. The product knowingly accepts this in exchange for zero-friction extensibility.
- Workspace MCP files containing env secrets may end up in version control if the user commits them. The app does not warn or modify `.gitignore`.

## Components

### Main Process

`src/main/agent/codexConfigStore.ts` (new)

- Owns reads and writes of `~/.codex/config.toml`, `<projectRoot>/.codex/workspace-mcp.toml`, personal and workspace `SKILL.md` files.
- Exposes `listMcp()`, `getMcpDetail(id)`, `saveMcp(input)`, `deleteMcp(id)`, `setMcpEnabled(id, enabled)`, `listSkills()`, `getSkillDetail(id)`, `saveSkill(input)`, `deleteSkill(id)`.
- Owns the audit-log file under `<userData>/codex-runtime/audit.log`.

`src/main/agent/codexConfigMerge.ts` (new)

- Pure function: takes `{ personal, workspace }` TOML documents, returns merged TOML serializable string.
- Used by `CodexLocalBackend` before spawn and by `agent:restart-codex`.

`src/main/agent/CodexLocalBackend.ts` (extended)

- Reads `CODEX_HOME` override path from `codexConfigStore`.
- New `applyConfigChange()` method that rebuilds the merged runtime config and either marks itself dirty or restarts gracefully.

`src/main/agent/ipc.ts` (extended)

- Wires the new IPC handlers listed above.

`src/preload/index.ts` (extended)

- Exposes the new methods on `window.electronAPI.agent`.

### Renderer

`src/renderer/src/pages-react/AgentWorkspacePage.tsx` (new)

- Page shell with header, left nav, content router.

`src/renderer/src/features/agent-workspace/` (new module)

- `useAgentWorkspaceStore.ts`: Zustand store for active section, draft editor state, dirty markers, Restart-Codex banner.
- `OverviewSection.tsx`: read-only snapshot of Codex runtime status plus quick links.
- `PermissionsSection.tsx`: re-mounts Phase 2's `CodexPermissionsPanel` content here.
- `McpSection.tsx`: list view, scope grouping, `+ New MCP Server`.
- `McpEditor.tsx`: form / raw tabs, inline preview, risky-arg stripe.
- `SkillsSection.tsx`: list view, scope grouping, `+ New Skill`, insert-into-chat action.
- `SkillEditor.tsx`: form / raw tabs.
- `ThreadsSection.tsx`: full thread management UI.
- `LogsSection.tsx`: audit-log + recent Codex launch errors.

`src/renderer/src/features/agent-chat/AgentChatPanel.tsx` (extended)

- Removes the three Codex panels from the header.
- Adds a single status strip and an `Open Agent Workspace` link.

`src/renderer/src/components/TabBar/TabBar.tsx` (extended)

- Adds the `agentWorkspace` tab and the `TopRightActions` slot.

`src/renderer/src/components/AgentStatusButton.tsx` (new)

- Compact pill component used in `TopRightActions`.

`src/renderer/src/stores/useTabStore.ts` (extended)

- Adds `agentWorkspace` to `VALID_TABS`.

`src/renderer/src/pages-react/index.ts` (extended)

- Adds the lazy `AgentWorkspacePage` export.

`src/renderer/src/layouts/AppLayout.tsx` (extended)

- Adds `agentWorkspace` to `PAGE_MAP`.

## Errors and Lifecycle

- **TOML parse error in raw view**: the editor shows the parse error inline, save is disabled until the text parses, switching back to form is blocked.
- **Frontmatter parse error in skill raw view**: same pattern. Empty frontmatter is allowed and emits a warning but does not block save.
- **Path containment rejection**: IPC handler returns `{ ok: false, code: 'path-out-of-root' }`. Renderer surfaces a toast and refuses to clear the dirty marker.
- **Disk write failure** (no permission, no space): atomic write fails before rename, no destructive change. Error surfaces as toast.
- **Codex backend already running**: save succeeds, runtime config rebuilds, the renderer banner shows "Restart Codex to apply". User decides when to restart.
- **Codex backend launch failure after restart**: the `Logs` section captures the launch error; the runtime falls back to the previous merged config snapshot stored under `<userData>/codex-runtime/config.previous.toml`.
- **`workspace-mcp.toml` malformed on disk** (manually corrupted): merge skips the workspace document, surfaces a warning in `Logs`, and the personal config still loads.

## Testing

Vitest unit tests for the main process:

- `codexConfigStore.test.ts`: TOML round-trip; scope routing; audit log append; atomic write under failure; name validation; secret redaction in list responses.
- `codexConfigMerge.test.ts`: precedence rules (workspace overrides personal by name); disabled entries are dropped; missing files are treated as empty; merged output is deterministic.
- `CodexLocalBackend.applyConfigChange.test.ts`: dirty marker behavior; restart path; previous-config fallback on launch failure.

Vitest IPC integration tests:

- `ipc.agent-workspace.test.ts`: save / delete / enable / restart paths end-to-end with a temp `<userData>` and a stub Codex backend.

Vitest renderer tests:

- `McpEditor.test.tsx`: form ↔ raw round-trip; risky-arg stripe trigger conditions; secret input redaction; save calls IPC with the expected payload.
- `SkillEditor.test.tsx`: form ↔ raw round-trip; frontmatter validation.
- `AgentWorkspacePage.nav.test.tsx`: section state preserved across tab leave / return; restart banner appears after MCP save.
- `AgentChatPanel.slim.test.tsx`: header no longer renders the three Codex panels; status strip and open-workspace link are present.

Security regression:

- Reuse Phase 2's path-containment fixtures, extended to cover the new write paths and the symlink/junction escape scenarios for `<projectRoot>/.codex/` and `<projectRoot>/.agents/skills/`.
- Audit-log entry assertions on every save / delete path.

No e2e tests are added in this phase. Existing Playwright suites are not affected by the new tab.

## Open Questions

- None remaining as of spec self-review. The user has answered scope, file targets, edit surface, security model, and entry placement. Any future questions are deferred to the implementation plan.

## Out of Phase 3

These items are recognized but deliberately deferred:

- Custom OS chrome / title bar takeover.
- Global command palette (Cmd/Ctrl+K).
- Left-side activity bar.
- SVG-icon migration for the existing generation tabs.
- Approval gate for new MCP servers.
- Sandboxed first-launch probe of MCP servers.
- `.gitignore` automation for workspace MCP files.
- Cross-machine sync of personal scope.
- Marketplace / import-from-URL for community MCP servers and skills.
