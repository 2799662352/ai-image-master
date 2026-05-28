# OpenSpec Guide for AI Agents

This folder is the **single source of truth for what is built and what is changing**. AI tools consume it; humans cross-reference `docs/superpowers/specs/` for the design narrative.

## Folder layout

```
openspec/
├── project.md                     ← project context (stack, conventions, capabilities)
├── AGENTS.md                      ← this file
├── specs/<capability>/spec.md     ← CURRENT TRUTH: what the system does today
└── changes/<change-id>/
    ├── proposal.md                ← Why + What Changes + Impact
    ├── tasks.md                   ← numbered tasks with [ ] checkboxes
    ├── design.md                  ← Context + Goals + Decisions + Risks (optional but recommended for >1 PR)
    └── specs/<capability>/spec.md ← DELTA: ADDED / MODIFIED / REMOVED requirements vs current truth
```

## Requirement / Scenario format

Every requirement is a single sentence with **SHALL** / **MUST** / **MAY**, followed by at least one `#### Scenario:` block in WHEN/THEN form.

```markdown
### Requirement: The system SHALL accept image drops without blocking the main thread for more than 50 ms.

#### Scenario: User drops a 5 MB JPEG

- **WHEN** the user drags a 5 MB JPEG into the chat composer
- **THEN** `pendingReferences` is updated within one paint frame (≤ 16 ms p99)
- **AND** the rendered thumbnail appears within 200 ms p99 without the renderer event loop blocking for more than 50 ms p99
```

## Delta semantics (under `changes/<id>/specs/`)

- `## ADDED Requirements` — new behavior not present in current truth
- `## MODIFIED Requirements` — replace an existing requirement (include full new text + scenarios)
- `## REMOVED Requirements` — name the requirement to delete and a one-line reason

When a change is merged, the delta is applied to `openspec/specs/<capability>/spec.md` and the change folder is archived under `openspec/changes/archive/<YYYY-MM-DD>-<id>/`.

## How to consume

1. Reading a change: open `proposal.md` first, then `tasks.md`, then `design.md` for rationale, then the spec deltas for the contract.
2. Implementing a change: follow `tasks.md` in order; each task should map to one commit or one small PR. Tick `- [x]` as you finish.
3. Reviewing a change: confirm every `MODIFIED`/`ADDED` requirement has a scenario, every scenario is observable from outside the system, and `tasks.md` covers all of them.

## Cross-reference with Superpowers docs

- `docs/superpowers/specs/<date>-<slug>-design.md` ↔ this change's `design.md` (1:1)
- `docs/superpowers/plans/<date>-<slug>-pr<N>-*.md` ↔ chunks of this change's `tasks.md` (1:N)

Use whichever format your tool reads — both stay in sync.
