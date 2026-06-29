# Agent eval harness (codex skills + catimation MCP)

An **agent test loop** for the things plain unit tests can't cover: *does the
agent actually decide to call the right tool, with the right args, in the right
order, and does the skill trigger at all?*

It drives the **bundled** `codex.exe exec --json` (the same binary the app
ships, `resources/codex/<platform>-<arch>/codex.exe`) against a **stub MCP
server**, captures the JSONL event stream, and runs deterministic trajectory
assertions on it. This is the pattern OpenAI documents in
[Testing Agent Skills Systematically with Evals](https://developers.openai.com/blog/eval-skills).

## Why a stub MCP (and not the real one)

Most catimation tools (`ask_user`, `generate_image`, `canvas_*`) are
**renderer-backed**: `ToolRouter.call()` forwards them to the Electron window
over IPC, so they *cannot* run headless. The eval loop only cares whether the
**agent makes the right decision** — so we expose a stub MCP with the *same tool
names + schemas* that returns canned JSON. Real execution (the UI card, the
actual render) is covered by Vitest unit tests (L0) and Playwright (L2).

## The 3-layer pyramid

| Layer | Tests | Tool | Needs API key? |
|------|-------|------|----------------|
| **L0 contract** | tool name/schema/registry, routing | Vitest (`src/**`, e.g. `askTools.test.ts`) | no — fast, deterministic |
| **L1 agent loop** *(this dir)* | skill triggers, tool chosen, args correct, call order, output shape | `codex exec --json` + stub MCP | **yes** (live) — but trajectory asserts are deterministic |
| **L2 end-to-end** | card actually renders, image actually saves | Playwright (`e2e/`) | no (uses app) |

## Layout

```
evals/
  harness/
    types.ts         shared event/tool types
    jsonl.ts         parse `codex exec --json` JSONL -> ThreadEvent[]   (pure, unit-tested)
    trajectory.ts    assertions over events (toolCalls/order/args/...)  (pure, unit-tested)
    codexArgs.ts     build the `codex exec` argv (mirrors prod -c flags) (pure, unit-tested)
    env.ts           resolve bundled codex binary + eval creds
    runCodex.ts      spawn codex exec, collect parsed events            (live)
    stub/
      stubRpc.mjs    pure MCP JSON-RPC handler (initialize/tools.*)     (unit-tested)
      stub.mjs       stdio entry: NDJSON <-> stubRpc, toolset from env  (codex spawns this)
  scenarios/
    ask_user.eval.ts first live scenario                                (skips w/o creds)
  schemas/
    decision.schema.json  example --output-schema for rubric scoring
```

`*.test.ts` = deterministic unit tests (always run). `*.eval.ts` = live agent
loops (skip without creds). Both run under `vitest.evals.config.ts`, which is
SEPARATE from the app's `vitest.config.ts` so `npm test` stays fast and offline.

## Running

```powershell
# Deterministic core only (no key, instant) — good for CI:
npm run test:evals:unit

# Full loop incl. live agent scenarios:
npm run test:evals
```

### Credentials — reuses the app's own settings

The live runner reads the SAME provider + API key the desktop app saved, from
`codex-providers.json` in the Electron `userData` dir (e.g.
`%APPDATA%/catimation-cyberpunk-master/`). So if you're already signed in to the
app (apiyi by default), `npm run test:evals` just works — no env setup. It also
spawns the **bundled** `resources/codex/<platform>-<arch>/codex.exe` and mirrors
the production `-c` flags, so the run matches the app end to end.

Env overrides (optional, take precedence over the saved settings):

| Var | Effect |
|-----|--------|
| `CODEX_EVAL_API_KEY` | use this key instead of the saved one (e.g. a cheap CI key) |
| `CODEX_EVAL_BASE_URL` | point at a different OpenAI-compatible gateway |
| `CODEX_EVAL_MODEL` | override the model (defaults to the provider preset / `gpt-5.5`) |
| `CODEX_EVAL_USER_DATA_DIR` | look for `codex-providers.json` in a custom dir |

When neither a saved key nor `CODEX_EVAL_API_KEY` is available, live `*.eval.ts`
scenarios self-skip; the deterministic `*.test.ts` still run and must stay green.

## Scenarios

| File | Asserts |
|------|---------|
| `ask_user.eval.ts` | deciding a shot size pops the `ask_user` card with ≥3 options |
| `generate_image.eval.ts` | a concrete "draw me X" routes to `generate_image`, NOT `ask_user` |
| `brainstorm.eval.ts` | an open-ended creative ask offers a multi-option `ask_user` card before rendering |

## Authoring a scenario

```ts
import { describe, it, expect } from 'vitest'
import { runCodex } from '../harness/runCodex'
import { hasEvalCreds } from '../harness/env'
import { mcpToolCalls, assertToolUsed } from '../harness/trajectory'

describe.skipIf(!hasEvalCreds())('景别决策', () => {
  it('给 2+ 选项时触发 ask_user 卡片', async () => {
    const { events } = await runCodex({
      prompt: '帮我决定这条片子的景别：近景 / 中景 / 远景',
      tools: [{ name: 'ask_user', cannedResult: { selected: [{ id: 'mid' }] } }],
    })
    assertToolUsed(events, 'ask_user')                  // trajectory assert (deterministic)
    const [call] = mcpToolCalls(events).filter((c) => c.tool === 'ask_user')
    expect((call.arguments as { options?: unknown[] }).options?.length ?? 0).toBeGreaterThanOrEqual(3)
  })
})
```

## CI guidance

- Run **`test:evals:unit`** on every PR (deterministic, free).
- Run **`test:evals`** (live) nightly / on a label, with a cheap model
  (`gpt-5.4-mini`) and retry tolerance — LLM decisions are non-deterministic,
  so gate hard on *trajectory* asserts and treat rubric/`--output-schema`
  scores as soft signals.
