# Codex-Native Workspace UI Design

## Summary

Build a Codex-native workspace UI that exposes the capabilities already present in Codex CLI through the Electron app. Codex remains the execution engine for shell commands, MCP, web search, file changes, subagents, and non-interactive jobs; the app adds the missing UI layer for references, previews, permissions, and persistent workspace context.

This design intentionally avoids reimplementing a command runner, MCP registry, or agent runtime. The app should compose Codex `app-server`, Codex configuration, and Codex event streams into an IDE-like experience similar to VS Code, Cursor, and Codex.

## Problem Frame

The current app already starts `codex app-server`, sends turns, and renders some streamed items such as shell executions, file edits, MCP calls, web search, and generic activity. However, the UI treats most context as plain chat text or isolated timeline cards. Users cannot reliably click a referenced file, URL, command, GitHub resource, MCP result, or generated output and open it in a workspace-style preview surface.

The app also currently hardcodes a very permissive execution posture (`danger-full-access` and no approval prompts). Official Codex guidance supports safer sandbox and approval modes, project/user configuration, MCP management, skills, slash commands, subagents, image inputs, image generation, `exec --json`, and automated workflows. The product should surface those capabilities rather than leaving them hidden behind the CLI.

## Scope

### In Scope

- Add a first-class reference model for file, selection, URL, command output, MCP/GitHub resource, image, artifact, and Codex activity references.
- Let references open in the existing file display area or a new workspace preview pane.
- Keep Codex CLI as the execution engine for commands, MCP calls, web search, file changes, and subagent work.
- Add UI for Codex execution posture: model, sandbox, approval policy, writable roots, web search mode, and MCP status.
- Map workspace folders to Codex working roots using Codex-native concepts such as primary `cwd` and additional writable/readable roots.
- Add a GitHub Actions workflow design for checking the latest `openai/codex` release and opening an update PR.
- Treat credentials as secrets only. Any previously pasted token must be revoked and replaced with a repository secret.

### Out of Scope

- Replacing Codex `app-server` with a custom agent runtime.
- Building a separate MCP registry that diverges from Codex `config.toml`.
- Automatically executing arbitrary user-provided commands without an approval layer.
- Storing raw credentials in the repository, workflow YAML, app logs, or chat transcripts.
- Fully cloning every Codex TUI feature in one release. The UI should expose high-value capabilities incrementally.

## Key Decisions

### Codex Owns Execution

Codex CLI remains responsible for command execution, file edits, tool calls, MCP, web search, subagents, image operations, and non-interactive jobs. The Electron app should send richer inputs and render richer outputs, but not bypass Codex with a parallel shell runner.

### UI Owns Reference Orchestration

The app introduces a persistent `Reference` model that normalizes user-provided context and Codex-generated outputs. References are clickable, previewable, reusable, and serializable with chat history.

### Security Uses Codex Concepts

The UI should expose Codex sandbox and approval modes instead of inventing new permission semantics. Default local work should prefer `workspace-write` with `on-request` approvals. `danger-full-access` should be an explicit advanced choice with clear warning copy.

### MCP Configuration Is Codex-Native

MCP servers should be read from Codex configuration where possible. The app can add a friendlier management surface, but the source of truth should remain `~/.codex/config.toml` and trusted project `.codex/config.toml` layers so CLI, IDE, and Electron behavior stay aligned.

### GitHub Automation Uses Secrets

The update workflow must never embed a token directly. Prefer the default `GITHUB_TOKEN` for creating update PRs. If a PAT is required, it must be stored as a repository secret such as `CODEX_UPDATE_TOKEN`. Any token exposed in chat or local config should be revoked immediately.

## Architecture

### Reference Model

Create a shared reference shape used by chat input, timeline cards, preview panes, persisted messages, and drag/drop.

Reference fields:

- `id`: stable identifier.
- `type`: `file`, `selection`, `url`, `command`, `mcp`, `github`, `image`, `artifact`, `activity`.
- `label`: human-readable chip label.
- `source`: local path, URL, command id, MCP server/tool, GitHub owner/repo/resource, or Codex item id.
- `preview`: optional summary, mime type, language, line range, thumbnail URI, output text, or render mode.
- `status`: `idle`, `loading`, `ready`, `running`, `success`, `error`, `stale`.
- `openBehavior`: preview target such as code editor, markdown renderer, image viewer, iframe, shell output, diff viewer, or activity inspector.
- `executionPolicy`: optional metadata for command-like references that require approval before re-run.

The model should support both user-created references and references derived from Codex events.

### Workspace Preview Pane

Reuse the current file explorer and file display area as the target surface. Add preview modes rather than separate one-off cards:

- Code and text: CodeMirror with existing language detection.
- Markdown: rendered markdown with source toggle.
- Images and PDFs: local-file protocol preview.
- URLs: sandboxed iframe/webview-style preview with external-open fallback.
- Shell output: terminal-output tab with command, cwd, exit code, stdout, and stderr.
- MCP/GitHub resources: structured JSON/details view with links to open related files, URLs, issues, PRs, or workflow logs.
- File changes: existing diff view or file edit card can open as a diff preview.

Timeline cards should gain an `Open` action that creates or focuses the matching preview tab.

### Codex Session Controls

Add a compact status/control surface equivalent to useful Codex slash commands:

- `/status`: model, sandbox, approval policy, writable roots, MCP availability, token usage.
- `/permissions`: choose read-only, workspace auto, or full access modes.
- `/model`: switch active model and reasoning effort where supported.
- `/mcp`: list configured MCP servers/tools and initialization status.
- `/review` and `/diff`: expose review/diff workflows as actions.
- `/agent`: later surface subagent threads and active worker status.

The UI should show unsafe modes clearly and prefer safe defaults.

### Codex Configuration Integration

Configuration integration should respect Codex precedence:

1. Runtime overrides from the app.
2. Selected profile.
3. Trusted project `.codex/config.toml`.
4. User `~/.codex/config.toml`.
5. System defaults and built-in defaults.

The first implementation can read and display effective values from app-side settings and known launch parameters. Later iterations can parse Codex config directly or ask Codex for effective configuration through app-server/debug APIs if available.

### App-Server and Exec Integration

Continue using `codex app-server` for interactive chat. Add `codex exec --json` as a separate background-job path for automation-style tasks:

- CI/log summarization.
- Repository audits.
- Codex update checks.
- Long-running batch jobs.
- Structured output with `--output-schema`.

`exec --json` events can be normalized into the same timeline/reference model because Codex emits item events for agent messages, reasoning, command executions, file changes, MCP tool calls, web searches, and plan updates.

### GitHub Workflow: Update Codex

Add a workflow that can run on schedule and `workflow_dispatch`:

- Query `openai/codex` latest release.
- Compare against the version or vendored binary currently used by this app.
- If different, update the version pin, download metadata, or update the packaging script.
- Run lightweight verification.
- Open a PR with the change summary.

Security rules:

- Use `permissions: contents: write, pull-requests: write`.
- Prefer `GITHUB_TOKEN`.
- Use `${{ secrets.CODEX_UPDATE_TOKEN }}` only if `GITHUB_TOKEN` cannot open the required PR.
- Never read credentials from `mcp.json`.
- Never write secrets into logs.

## UI/UX Design

### Reference Chips

References in chat should look and behave like interactive workspace objects, not raw placeholder text. A chip should show an icon, label, type, and status. Examples:

- `file src/main/agent/CodexLocalBackend.ts`
- `selection FileViewer.tsx:28-36`
- `url developers.openai.com/codex/mcp`
- `cmd npm run dev`
- `mcp github/get_file_contents`
- `github openai/codex release 0.129.0`

Dragging or inserting code selections into chat should remain pure markdown text when the user asks for content, but attached references should remain structured objects internally.

### Preview Tabs

The file display area should support tabs for files, markdown previews, URLs, command outputs, MCP results, and diffs. Dirty file tabs keep the existing save/discard/cancel behavior.

Preview tabs should show:

- Title and source.
- Type-specific toolbar actions.
- Refresh/re-run when safe.
- Copy source/copy content.
- Open externally when applicable.
- Error state with retry.

### Permissions UX

Before a command-like reference is re-run, the user sees:

- Full command.
- Working directory.
- Writable roots.
- Sandbox mode.
- Approval policy.
- Risk label.

The default action is safe. Destructive or broad access modes require explicit confirmation.

### MCP UX

The MCP panel should separate:

- Configured servers.
- Connected servers.
- Available tools.
- Auth-required servers.
- Disabled or failed servers.

GitHub MCP should surface repositories, issues, PRs, actions, and code contents as references that can be opened in preview tabs.

## Data Flow

### User Adds Context

1. User types text, drags a file, picks from file explorer, pastes a URL, or selects a command output.
2. UI creates a `Reference` plus optional markdown/plain text insertion.
3. Chat send payload includes user text, attachments, and serialized references.
4. Main process converts references into Codex-compatible input text and local image inputs where needed.
5. Codex executes through app-server.

### Codex Emits Events

1. `CodexNotificationRouter` maps app-server notifications into timeline items.
2. Timeline items create derived references for shell, file change, MCP, web search, image, and artifact outputs.
3. Renderer stores references with the message.
4. User clicks a card/chip.
5. Preview pane opens the normalized reference.

### Background Job Runs

1. User or workflow starts an automation-style task.
2. App runs `codex exec --json` with a safe sandbox.
3. JSONL events stream into a job timeline.
4. Final output and artifacts become references.

## Error Handling

- Missing file: show stale reference state with option to locate or remove.
- Permission denied: show the attempted operation and required sandbox/approval change.
- MCP auth needed: show auth-required state and link to configuration/login flow.
- URL cannot be embedded: offer external open.
- Command failed: preserve stdout/stderr and exit code; allow copy and rerun with confirmation.
- Codex unavailable: show reconnect/start-server action and recent startup log tail.
- Secret detected in input: warn, redact display, and tell user to rotate the token.

## Testing Strategy

### Unit Tests

- Reference parsing and serialization.
- Mapping timeline items to references.
- Safe markdown insertion for selected code.
- Permission-mode mapping to Codex launch/session options.
- GitHub update workflow helper scripts, if scripts are added.

### Component Tests

- Reference chips render correct labels and statuses.
- Clicking timeline card opens a preview tab.
- Shell output preview shows command, cwd, stdout, stderr, and exit code.
- MCP/GitHub result preview handles success, loading, auth-required, and error states.
- Permission confirmation dialog blocks unsafe reruns by default.

### Integration Tests

- Drag file into chat, send message, reopen thread, click file reference.
- Select code, send as markdown, confirm no placeholder syntax appears.
- Codex command event appears as shell card and opens output preview.
- Multiple workspace folders map into safe Codex roots.
- Workflow update dry-run detects no-op and update cases.

### Manual Verification

- Run Electron dev app.
- Confirm status panel shows model/sandbox/approval/MCP.
- Open local code, markdown, image, PDF, URL, shell output, and MCP result references.
- Verify unsafe modes and reruns require explicit confirmation.
- Confirm no secret values are printed in UI or logs.

## Phased Delivery

### Phase 1: Safe Codex-Native Workspace

- Introduce `Reference` type and renderer primitives.
- Add reference chips and preview tab routing.
- Add code/markdown/file/URL/shell-output preview modes.
- Add status display for model, sandbox, approval, and roots.
- Change default execution posture away from hardcoded full access.

### Phase 2: Codex Controls and Background Jobs

- Add MCP status panel.
- Add UI actions for review, diff, model, permissions, and status.
- Add `codex exec --json` background job runner.
- Normalize exec JSONL events into timeline/reference items.
- Add GitHub Actions workflow to detect and PR Codex updates.

### Phase 3: Advanced Codex Capabilities

- Surface subagents and custom agents.
- Surface skills/plugins.
- Add image input and image generation UI.
- Add richer GitHub MCP resource previews.
- Add resume/fork/side-conversation affordances if app-server support is stable enough.

## Security Notes

- Revoke any PAT that has been pasted into chat or committed into local config visible to tools.
- Store replacement credentials only as GitHub Secrets or local secret storage.
- Prefer `GITHUB_TOKEN` for workflow PR creation.
- Use least-privilege workflow permissions.
- Do not log secret-bearing environment variables.
- Avoid `danger-full-access` except in explicit trusted contexts.
- Use `--add-dir` or workspace roots instead of broad machine access.

## Open Questions

- Should the app parse Codex `config.toml` directly, or should it rely on app-server/debug APIs when possible?
- Which preview modes should ship first if Phase 1 needs to be cut smaller: Markdown/URL/shell output or MCP/GitHub resources?
- Should GitHub workflow update the packaged Codex binary, an npm package version, or an internal metadata file? This depends on how Codex is currently vendored in the app build.
- Should unsafe command rerun be allowed at all in Phase 1, or only after the permissions UI is complete?

## Approval Gate

This design is ready for review. Implementation should not start until the user approves the written spec and a follow-up implementation plan is created.
