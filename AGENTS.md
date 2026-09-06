# AGENTS

## Design System

This project has a `DESIGN.md` at the repo root that defines the visual design language (sourced from [VoltAgent/awesome-design-md](https://github.com/VoltAgent/awesome-design-md), Cursor profile).

When building, modifying, or styling any UI (React components, pages, HTML/CSS, Tailwind), you MUST read and follow `DESIGN.md`:

- Use the color, typography, spacing, radius, and component tokens defined there — never inline arbitrary hex values when a token exists.
- Follow the "Do's and Don'ts" and "Iteration Guide" sections.
- Respect the responsive breakpoints and touch-target sizes.

`DESIGN.md` answers *how the project should look and feel*. This `AGENTS.md` answers *how to build it*.

## Skills, hooks and the embedded Codex agent (edit sources, never mirrors)

The creative agent's behaviour lives in Markdown skills, not in a system prompt. Three layers,
each with one authoritative source:

- **Plugin skills** — `resources/plugins/<plugin>/skills/<name>/SKILL.md` (+ `references/`). Authoritative.
- **App-only skills** — `resources/first-party-skills/<name>/SKILL.md`. Authoritative.
- **Generated mirrors — do not edit by hand**: `src/main/agent/generated/firstPartySkills.generated.ts`,
  `resources/codex-skills/**` (standalone marketplace), top-level `skills/**` (renderer pipeline).

After editing a skill, regenerate and verify — in this order:

```bash
pnpm skills:gen                                   # firstPartySkills.generated.ts + top-level skills/ mirrors
node scripts/sync-plugin-skills-to-codex.mjs      # dry-run; add --apply --only=<name,...> to refresh codex-skills + bump versions
npm run audit:skill-arch                          # 0 violations required (fanout budgets, DAG, hook size, body ≤ 20k chars, mirror drift)
npm run test:skill-arch                           # validator + repository contract tests
npx vitest run src/main/mcp/tools/__tests__ src/main/agent/__tests__/firstPartySkills.test.ts
```

Rules the audit enforces (so you don't discover them from a red run):

- One SKILL.md body ≤ **20,000 chars**; task-specific sections go to `references/*.md` loaded on demand.
  Existing giants are pinned in `SKILL_BODY_DEBT` (shrink-only) — do not add to that list.
- Backticked skill names in a body are dependency edges (fanout budget by `<!-- skill-budget -->`);
  plain-text mentions are not. Leaves must never force-load an orchestrator/router or an entry.
- Session-start hooks stay short pointers (≤ 2000 chars, never `cat` a SKILL.md).
- `catimation-image` / `catimation-video` are the only generation entries; everything else is a leaf.
- Prompts are sent to Seedance **verbatim**: the runtime keeps `@图片N`, does not reflow layout
  (`src/main/services/seedance/promptReferences.ts` only unwraps the workbench chip `【@图片N】`).
  Formatting and reference-syntax discipline belong in the skills, not in the runtime.

Where instructions enter the embedded Codex (see `src/main/agent/codexLaunch.ts`): the model's own
built-in prompt (untouched), project `AGENTS.md` via `project_doc_*` config, extra workspace roots'
AGENTS.md via `developer_instructions` (`projectDocs.ts`), plugin session-start hooks, then skills on
demand. Do not add creative rules to `developer_instructions` or `model_instructions_file`; put them in
the entry skill or a leaf skill.

Verification before claiming done: `npm run build:vite`, `pnpm typecheck` (baseline-gated, see
`tests/ci-cd/typecheck-baseline.json`), and the targeted vitest suites for what you touched.

## graphify

This project has a knowledge graph at graphify-out/ with god nodes, community structure, and cross-file relationships.

When the user types `/graphify`, use the installed graphify skill or instructions before doing anything else.

Rules:
- For codebase questions, first run `graphify query "<question>"` when graphify-out/graph.json exists. Use `graphify path "<A>" "<B>"` for relationships and `graphify explain "<concept>"` for focused concepts. These return a scoped subgraph, usually much smaller than GRAPH_REPORT.md or raw grep output.
- Dirty graphify-out/ files are expected after hooks or incremental updates; dirty graph files are not a reason to skip graphify. Only skip graphify if the task is about stale or incorrect graph output, or the user explicitly says not to use it.
- If graphify-out/wiki/index.md exists, use it for broad navigation instead of raw source browsing.
- Read graphify-out/GRAPH_REPORT.md only for broad architecture review or when query/path/explain do not surface enough context.
- After modifying code, run `graphify update .` to keep the graph current (AST-only, no API cost).

## Knowledge graph bootstrap (repo conventions for graphify)

The `## graphify` section above is owned by `graphify install` and gets rewritten on upgrade; this section is ours.

- `graphify-out/` is **git-ignored** (graph.json is ~20 MB and changes on every commit). If `graphify-out/graph.json` is missing, build it first — it is pure tree-sitter AST plus a markdown heading/link scan, no LLM, no API key, ~2–3 min on this repo:
  ```bash
  uv tool install --python 3.13 "graphifyy[sql]"   # once per machine (pinned: networkx breaks on Python 3.14.1)
  pnpm graph:build                                  # = graphify update . --force  (same code path as the hooks and `graph:update`)
  ```
  Deliberately **not** `graphify extract --code-only`: that variant skips the free markdown layer, so a graph built with it changes shape on the first hook-triggered `graphify update`.
- Day-to-day: `pnpm graph:update` after edits; `pnpm graph:query "<question>"`, `pnpm graph:explain "<Symbol>"`, `pnpm graph:path "<A>" "<B>"`.
- Auto-refresh on commit / branch switch: `pnpm graph:hooks` (once per worktree, per machine). Do **not** run bare `graphify hook install` here — our checkouts are linked worktrees sharing `temp-ai-image-master-source/.git`, its hooks would land in the shared `.git/hooks` and its script deliberately exits inside linked worktrees. `scripts/graphify-hooks.mjs` scopes the hooks to this worktree via `core.hooksPath` (worktree config), strips that guard, and keeps `.gitattributes` untouched. `--status` / `--uninstall` to inspect or remove; `GRAPHIFY_SKIP_HOOK=1 git commit …` to skip once; log at `~/.cache/graphify-rebuild.log`.
- The embedded Codex agent ships a compact `graphify` first-party skill (`resources/first-party-skills/graphify/SKILL.md` → `~/.agents/skills/graphify`). It is code-only by default, asks before installing the CLI or spending model tokens on docs, and yields to a user-installed official copy of the same name. Edit the Markdown source, then `pnpm skills:gen`.
- Scope is controlled by `.graphifyignore` (merged on top of `.gitignore`). It drops generated mirrors (`skills/`, `resources/codex-skills/`, `src/main/agent/generated/`), vendored bundles (`25/`, `lib/`, `cdn/`, `src/renderer/public/`, `*.min.js`), media, locale JSON and third-party skill bundles under `.cursor/` / `.agents/`. Add to it rather than to `.gitignore` when something pollutes the graph.
- Markdown (`docs/`, `resources/plugins/**/SKILL.md`, …) enters the graph as **structure only** (headings + links, free). Concept/relationship extraction from docs, PDFs or images needs an LLM pass and is deliberately not part of the default build — run `/graphify . --update` from the skill if you want it, knowing it spends model tokens.
- Community names are `Community N` placeholders because no LLM backend is configured. To name them once: `OPENAI_BASE_URL=<gateway> OPENAI_API_KEY=<key> graphify label . --backend openai`.
- Skill copies live at `.agents/skills/graphify/` (read by Cursor, Codex and any Agent-Skills-compliant harness). The `.codex/hooks.json` that `graphify install --platform codex` writes was removed on purpose: graphify documents it as an intentional no-op, and `AGENTS.md` is the always-on mechanism for Codex.
