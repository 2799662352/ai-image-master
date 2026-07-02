import { CATIMATION_MCP_HOST, CATIMATION_MCP_TOKEN_HEADER } from '../mcp/config'
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  CodexSessionConfig,
  CodexWebSearchMode,
} from '../../types/agent'

export const DEFAULT_LISTEN_URL = 'ws://127.0.0.1:7345'

export const DEFAULT_CODEX_SESSION_CONFIG: CodexSessionConfig = {
  approvalPolicy: 'never',
  sandboxMode: 'danger-full-access',
  webSearch: 'live',
  writableRoots: [],
}

/**
 * Custom Codex model_provider config. When passed, we wire it through the
 * `app-server`'s `-c` overrides so the spawned Codex talks to a third-party
 * OpenAI-compatible gateway (e.g. API易, Right.Codes) instead of
 * `api.openai.com`.
 *
 * We MUST pin `wire_api="responses"` for custom OpenAI-compatible gateways:
 * after openai/codex#13592 (shipped in 0.128) Codex *prefers* websocket
 * transport (`responses_websocket`) when `wire_api` is unset, and it falls
 * through to the hard-coded `wss://api.openai.com/v1/responses` endpoint —
 * NOT the gateway's `base_url`. With an apiyi/openrouter/etc. key that hits
 * `wss://api.openai.com` it loops on `401 Unauthorized` and surfaces as
 * "Reconnecting...N/5" warnings in the UI.
 *
 * Apiyi documents the plain HTTP `/v1/responses` endpoint
 * (https://docs.apiyi.com/api-capabilities/openai-responses), so `wire_api =
 * "responses"` is the correct value.
 *
 * The legacy `supports_websockets` field was removed by openai/codex#13592 —
 * we never set it.
 *
 * Optional fields (`model`, `reasoningEffort`, `verbosity`, `requiresOpenaiAuth`,
 * `extraTopLevelConfig`) let presets carry their own opinionated config so a
 * provider like Right.Codes — which requires `model="gpt-5.2"`,
 * `model_reasoning_effort="xhigh"`, `disable_response_storage=true`, and
 * `windows_wsl_setup_acknowledged=true` per its docs
 * (https://docs.right.codes/docs/rc_cli_config/codex.html) — works out of the
 * box without forcing the user to hand-edit `~/.codex/config.toml`.
 */
export interface CodexProviderConfig {
  id: string
  name: string
  baseUrl: string
  envKey: string
  /** Optional. When set, becomes `-c model="..."`. */
  model?: string
  /** Optional. When set, becomes `-c model_reasoning_effort="..."`. */
  reasoningEffort?: string
  /** Optional. When set, becomes `-c model_verbosity="..."`. */
  verbosity?: string
  /** Optional. When true, becomes `-c model_providers.<id>.requires_openai_auth=true`. */
  requiresOpenaiAuth?: boolean
  /**
   * Optional wire protocol. Only `"responses"` is valid: Codex **removed**
   * `wire_api = "chat"` support (deprecated in openai/codex#7782, hard error
   * since ~Feb 2026 — a `chat` value makes `codex app-server` exit code 1 at
   * config load, which previously bricked the entire backend). The ACTIVE
   * provider always pins `"responses"`; EXTRA providers must too. A chat-only
   * gateway therefore CANNOT be registered as a Codex model_provider anymore —
   * route it through the MCP/renderer layer (`/v1/chat/completions`) instead.
   */
  wireApi?: 'responses'
  /**
   * Optional. Each entry becomes `-c <key>=<value>`. Use for top-level
   * scalar overrides not modelled above (e.g. `disable_response_storage`,
   * `windows_wsl_setup_acknowledged`). Booleans/numbers serialize bare;
   * strings serialize as `key="value"`.
   */
  extraTopLevelConfig?: Readonly<Record<string, string | boolean | number>>
}

/**
 * Coordinates of the in-app catimation MCP server, with two possible codex
 * transports:
 *
 *  - `stdio` present (preferred): codex spawns the vendored bridge script
 *    (`resources/catimation-bridge/index.js`) as a plain stdio MCP server;
 *    the bridge pipes bytes to the Electron main process over loopback TCP.
 *    This removes codex's rmcp streamable-HTTP client — whose keep-alive /
 *    session-404 failure modes repeatedly wedged long `generate_image`
 *    turns — from the critical path entirely.
 *
 *  - `stdio` absent (fallback): the original streamable-HTTP entry
 *    (`url` + token header) pointing at the in-process Express listener.
 */
export interface CatimationMcpLaunchInfo {
  /** HTTP listener port — fallback transport + external clients. */
  port: number
  /** HTTP listener auth token (x-catimation-token header). */
  token: string
  /** When set, register the stdio bridge instead of the HTTP url. */
  stdio?: {
    command: string
    args: string[]
    env: Record<string, string>
  }
}

export interface CodexLaunchOptions {
  listenUrl?: string
  provider?: CodexProviderConfig
  /**
   * Additional provider tables to REGISTER (but not activate). Each becomes a
   * `[model_providers.<id>]` entry so a subagent can select it via
   * `modelProvider="<id>"` (Path B: a qwen3.7-max-dashscope understanding
   * subagent alongside the main agent's active provider). Unlike
   * {@link provider}, these never set the top-level `model_provider`/`model`,
   * so the main agent's provider is untouched.
   */
  extraProviders?: readonly CodexProviderConfig[]
  sessionConfig?: Partial<CodexSessionConfig>
  /**
   * Local in-process catimation MCP server coordinates. When present we
   * inject an ephemeral `[mcp_servers.catimation]` entry via `-c` so the
   * Codex subprocess can actually reach our `generate_image` /
   * `query_history` / UI tools. Injecting via `-c` (instead of writing the
   * user's `~/.codex/config.toml`) keeps the entry in lockstep with the
   * current session's dynamic port/token and never leaves stale config behind.
   */
  catimationMcp?: CatimationMcpLaunchInfo
  /**
   * The user's apiyi-mcp API key (the single key saved in 设置 → API易). When
   * present we overlay it onto the seeded `[mcp_servers.apiyi].env` table via
   * `-c mcp_servers.apiyi.env.APIYI_API_KEY=...` at spawn — the SAME
   * runtime-injection model as {@link catimationMcp}: the secret stays in
   * lockstep with 设置, is NEVER written to `~/.codex/config.toml`, and so the
   * MCP JSON editor never shows it or asks the user to re-paste it.
   *
   * The boot seed (`seedApiyiMcpEntry`) supplies command/args/base_url/model/
   * timeouts for the entry; this `-c` only overlays the leaf secret (dotted
   * `-c` merges, so the seeded siblings survive). We deliberately do NOT inject
   * `GEMINI_MODEL` here so a user's manual editor switch to
   * `gemini-3.1-pro-preview-thinking` (deep reasoning) is respected — the
   * sanctioned default (`gemini-3.5-flash`) lives in the seeded config instead.
   */
  apiyiKey?: string
  /**
   * True when `~/.codex/config.toml` already carries a non-empty
   * `mcp_servers.apiyi.env.APIYI_API_KEY` — i.e. the user hand-edited the MCP
   * JSON editor (the SECOND supported key source besides {@link apiyiKey} /
   * 设置 → API易, and the one the empty-tools card hint instructs). The backend
   * resolves it at spawn via `readApiyiConfigKey`.
   *
   * Lets the no-key launch guard tell "keyless" (must stay dormant) apart from
   * "key lives in config" (must run normally), so we never disable an apiyi the
   * user configured by hand. The secret itself is NOT forwarded here (codex
   * reads it straight from config.toml) — only the boolean fact that it exists.
   */
  apiyiHasConfigKey?: boolean
  /**
   * The user's cinematography-kb-mcp key (设置 → 运镜知识库 → the Alibaba Bailian
   * `DASHSCOPE_API_KEY`). When present we overlay it onto the seeded
   * `[mcp_servers.cinematography_kb].env` table via
   * `-c mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY=...` at spawn — the
   * SAME runtime-injection model as {@link apiyiKey}: the secret stays in
   * lockstep with 设置, is NEVER written to `~/.codex/config.toml`, and so the
   * MCP JSON editor never shows it or asks the user to re-paste it.
   *
   * The boot seed (`seedCinematographyKbMcpEntry`) supplies command/args for the
   * entry; this `-c` only overlays the leaf secret (dotted `-c` merges over the
   * seeded — possibly empty — env, so any siblings survive). Tools always list
   * regardless (the server's `tools/list` is static); only the tool CALL needs
   * the key, so a keyless launch stays enabled and simply reports the missing
   * key on first use.
   */
  cinematographyKbKey?: string
}

function quote(value: string): string {
  return JSON.stringify(value)
}

export function resolveCodexSessionConfig(input?: Partial<CodexSessionConfig>): CodexSessionConfig {
  return {
    approvalPolicy: (input?.approvalPolicy ?? DEFAULT_CODEX_SESSION_CONFIG.approvalPolicy) as CodexApprovalPolicy,
    sandboxMode: (input?.sandboxMode ?? DEFAULT_CODEX_SESSION_CONFIG.sandboxMode) as CodexSandboxMode,
    webSearch: (input?.webSearch ?? DEFAULT_CODEX_SESSION_CONFIG.webSearch) as CodexWebSearchMode,
    writableRoots: [...(input?.writableRoots ?? DEFAULT_CODEX_SESSION_CONFIG.writableRoots)],
  }
}

function serializeScalar(value: string | boolean | number): string {
  if (typeof value === 'string') return `"${value}"`
  return String(value)
}

export function appendProviderArgs(
  args: string[],
  provider?: CodexProviderConfig,
): string[] {
  if (!provider) return args
  const id = provider.id
  args.push(
    '-c', `model_provider="${id}"`,
    '-c', `model_providers.${id}.name="${provider.name}"`,
    '-c', `model_providers.${id}.base_url="${provider.baseUrl}"`,
    '-c', `model_providers.${id}.env_key="${provider.envKey}"`,
    // See `CodexProviderConfig` above for why this is mandatory.
    '-c', `model_providers.${id}.wire_api="responses"`,
    // FLATTEN MCP tools into plain `function` specs (openai/codex#26234, shipped
    // in 0.142.x via the `namespace_tools` provider capability). Codex normally
    // serializes each MCP server's tools inside a proprietary
    // `{"type":"namespace","name":"mcp__<server>__","tools":[…]}` wrapper that
    // ONLY real OpenAI / Azure expand. Every provider WE ship is an
    // OpenAI-COMPATIBLE GATEWAY (apiyi / right.codes / user-custom), not the
    // genuine OpenAI endpoint — those relays pass the wrapper through
    // unexpanded, so the model sees a single non-callable `mcp__catimation__`
    // entry and emits flattened / separator-dropped names
    // (`mcp__catimationask_user` → even `mcp__catimationaskuser`), which Codex's
    // strict-match router rejects as `unsupported call` (the ask_user popup
    // failure; also #20652/#22970/#24297). With `namespace_tools=false` Codex
    // emits each tool as a flat `function` named `mcp__<server>__<tool>` AND its
    // registry resolves flat / proxy-mangled names back to the namespaced
    // runtime — deterministically across ALL our gateways. The capability
    // otherwise defaults to `requires_openai_auth` (false for apiyi, but TRUE
    // for the Right.Codes presets), so pinning it false here is what makes the
    // fix uniform instead of provider-dependent.
    '-c', `model_providers.${id}.namespace_tools=false`,
  )
  if (provider.requiresOpenaiAuth) {
    args.push('-c', `model_providers.${id}.requires_openai_auth=true`)
  }
  if (provider.model) {
    args.push('-c', `model="${provider.model}"`)
  }
  if (provider.reasoningEffort) {
    args.push('-c', `model_reasoning_effort="${provider.reasoningEffort}"`)
  }
  if (provider.verbosity) {
    args.push('-c', `model_verbosity="${provider.verbosity}"`)
  }
  if (provider.extraTopLevelConfig) {
    for (const [key, value] of Object.entries(provider.extraTopLevelConfig)) {
      args.push('-c', `${key}=${serializeScalar(value)}`)
    }
  }
  return args
}

/**
 * Register EXTRA provider tables for per-subagent selection (Path B). Unlike
 * {@link appendProviderArgs}, this NEVER emits the top-level `model_provider`
 * or `model` — it only defines `[model_providers.<id>]` so a subagent started
 * with `modelProvider="<id>"` resolves to this gateway/model. wire_api always
 * resolves to `"responses"` — Codex removed `"chat"` (openai/codex#7782), and
 * emitting it makes the whole `app-server` exit code 1 at config load.
 */
export function appendExtraProviders(
  args: string[],
  extras?: readonly CodexProviderConfig[],
): string[] {
  if (!extras || extras.length === 0) return args
  for (const p of extras) {
    const id = p.id
    args.push(
      '-c', `model_providers.${id}.name="${p.name}"`,
      '-c', `model_providers.${id}.base_url="${p.baseUrl}"`,
      '-c', `model_providers.${id}.env_key="${p.envKey}"`,
      '-c', `model_providers.${id}.wire_api="${p.wireApi ?? 'responses'}"`,
      // Flatten MCP tools for extra (subagent) gateways too — see the detailed
      // rationale in appendProviderArgs (openai/codex#26234).
      '-c', `model_providers.${id}.namespace_tools=false`,
    )
    if (p.requiresOpenaiAuth) {
      args.push('-c', `model_providers.${id}.requires_openai_auth=true`)
    }
  }
  return args
}

export function buildCodexLaunchArgs(options?: CodexLaunchOptions): string[] {
  const url = options?.listenUrl ?? DEFAULT_LISTEN_URL
  const sessionConfig = resolveCodexSessionConfig(options?.sessionConfig)
  const args: string[] = [
    'app-server',
    '--listen', url,
    '-c', `approval_policy=${quote(sessionConfig.approvalPolicy)}`,
    '-c', `sandbox_mode=${quote(sessionConfig.sandboxMode)}`,
    '-c', `web_search=${quote(sessionConfig.webSearch)}`,
    // Surface chain-of-thought to the chat panel. Codex 0.128's defaults
    // are tuned for `codex exec` / CI logs (raw reasoning hidden, summaries
    // optional), which leaves our "Thought" card permanently empty even
    // when `tokenUsage.reasoningOutputTokens > 0`. Both flags are documented
    // at https://developers.openai.com/codex/config-advanced — we accept the
    // tradeoff that raw reasoning may include sensitive scratchpad content
    // since this is a local dev/agent surface.
    '-c', 'show_raw_agent_reasoning=true',
    '-c', 'model_reasoning_summary="auto"',
    // Tell Codex the model's hard context limit so its tokenUsage
    // notifications carry `contextWindow`, and so it auto-compacts before
    // running into a wall. 272K matches Codex's official gpt-5.5 / gpt-5.4
    // model catalog; use the real catalog value so the UI meter and compaction
    // heuristics line up with upstream.
    //
    // auto_compact at 220k (~81%), not the stock 90% ratio: stateless relay
    // gateways (apiyi) replay the FULL history per request and enforce a
    // request-BODY-BYTE cap ("request_too_large") that text+image-heavy
    // threads can hit before the official 90% token trigger. 220k gives the
    // user much more long-thread runway than the earlier conservative 100k,
    // while still leaving ~52k tokens of headroom before the declared window.
    '-c', 'model_context_window=272000',
    '-c', 'model_auto_compact_token_limit=220000',
    // Official per-tool-call output budget. codex-rs/models-manager/
    // models.json pins truncation at 10_000 tokens for gpt-5.5/5.4/5.3
    // (10_000 bytes for 5.2 and unknown slugs). Without this pin a
    // user-level ~/.codex/config.toml (observed in the wild with
    // `tool_output_token_limit = 64_000`) multiplies every large file read
    // by 6.4x the official budget, ballooning replayed history straight
    // into the gateway byte cap. `-c` outranks config.toml.
    '-c', 'tool_output_token_limit=10000',
    // Enable rmcp transport so URL-based MCP servers (e.g.
    // `[mcp_servers.context7] url = "https://mcp.context7.com/mcp"`) are
    // actually started. With Codex 0.128, omitting this flag silently skips
    // streamable-HTTP servers without surfacing an error. See
    // openai/codex#4707 — every workaround in that thread sets it at the top
    // of `config.toml`. We pin it via `-c` instead so users don't have to
    // edit any file by hand. OAuth login and tool-call surfaces both require
    // this client on the server side.
    '-c', 'experimental_use_rmcp_client=true',
    // Subagents (parallel delegation). Codex can spawn specialized worker
    // agents that explore/analyze/tackle work concurrently — but it only does
    // so when explicitly asked, and the concurrency ceiling lives under the
    // `[agents]` table (`agents.max_threads`, default 6). We bump it to 8 so a
    // "spawn one agent per point" / `spawn_agents_on_csv` fan-out isn't
    // bottlenecked, and pin `max_depth=1` (the default — a direct child may
    // spawn, but no deeper recursion, which keeps token/latency cost
    // predictable). Pairs with the shipped `catimation-subagents` skill that
    // teaches the agent WHEN to delegate. Docs: https://developers.openai.com/codex/subagents
    '-c', 'agents.max_threads=8',
    '-c', 'agents.max_depth=1',
    // Expose MCP tools to the model under their BARE names (`ask_user`,
    // `generate_image`, `canvas_snapshot`) instead of the legacy
    // `mcp__catimation__<tool>` prefix (openai/codex feature
    // `non_prefixed_mcp_tool_names`, PR #21576). Codex still maps the bare
    // model-visible name back to the raw server/tool via McpConnectionManager,
    // so OUR handlers receive the identical raw name. This also makes each
    // tool's canonical namespace the bare server name `catimation` (no `mcp__`
    // prefix), which the deferral escape-hatch below keys off.
    '-c', 'features.non_prefixed_mcp_tool_names=true',
    // ─────────────────────────────────────────────────────────────────────────
    // ROOT-CAUSE FIX for the `ask_user` "unsupported call: catimationaskuser"
    // popup failure. Verified against codex rust-v0.142.2 source — NOT a
    // name-mangling bug in our bridge (the server tool IS literally `ask_user`):
    //
    //   • PR #29486 ("Use tool search for MCP tools by default") makes Codex
    //     DEFER every MCP tool behind `tool_search` whenever
    //     `model.supports_search_tool && provider.capabilities().namespace_tools`
    //     (codex-rs/core/src/tools/spec_plan.rs::search_tool_enabled +
    //     mcp_tool_exposure.rs). A deferred tool stays in the registry but is
    //     NOT directly model-visible — it must be found via `tool_search`.
    //   • `ProviderCapabilities::default().namespace_tools` is HARDCODED `true`
    //     for ALL configured/custom providers (codex-rs/model-provider/src/
    //     provider.rs — the base `capabilities()` returns the default; the test
    //     `configured_provider_uses_default_capabilities` pins this). So our
    //     per-provider `-c model_providers.<id>.namespace_tools=false` is
    //     SILENTLY IGNORED (it was never a real, config-readable capability key),
    //     and `supports_search_tool` is not config-overridable
    //     (model_info::with_config_overrides does not list it).
    //   • Result: `ask_user` is deferred → invisible → the model reconstructs the
    //     name from skill-doc memory ("ask_user"), glues on the server namespace
    //     and drops the underscore → `catimationaskuser` → Codex's strict matcher
    //     returns `unsupported call`. (generate_image/canvas_snapshot survive
    //     because the model discovered them via tool_search and copies the exact
    //     name; a never-typed tool like `ask_user` does not.)
    //
    // The ONLY config escape in 0.142.2 — `tool_search` is a removed no-op
    // (always on) and the two deferral inputs above are unconfigurable — is
    // `code_mode.direct_only_tool_namespaces`: any runtime whose CANONICAL
    // namespace is listed is promoted from `Deferred` to `DirectModelOnly` in
    // `apply_direct_model_only_namespace_overrides` (runs unconditionally, not
    // gated on the code-mode feature), i.e. it stays DIRECTLY model-visible and
    // is never deferred. Proven by codex's own
    // `code_mode_only_exposes_direct_model_only_mcp_namespaces` test. Our MCP
    // tools' canonical namespace == the sanitized server name `catimation`
    // (McpHandler::tool_name → ToolInfo::canonical_tool_name → callable_namespace;
    // with non_prefixed names there's no `mcp__` prefix). We list the prefixed
    // form too as a belt-and-suspenders guard if a provider ever keeps the
    // legacy prefix. `enabled=false` keeps the experimental code-mode EXEC
    // routing OFF — we only want the exposure override (read regardless of
    // enablement), not nested code-mode tool calling.
    //
    // `apiyi` is listed for the EXACT same reason: the bundled apiyi-mcp server
    // (understand_video / generate_content / 音频·PDF 理解 …) is a first-party
    // tool path we want ALWAYS directly model-visible. Without this it gets
    // deferred behind `tool_search` just like ask_user did, which is why apiyi
    // tools "sometimes don't come back" — the model has to re-discover them via
    // search and intermittently fails. Listing the namespace here promotes them
    // to DirectModelOnly so they're never deferred. (This is a top-level
    // features array — NOT under `mcp_servers.apiyi` — so it never synthesizes a
    // transport-less entry even if apiyi isn't installed.)
    '-c', 'features.code_mode.enabled=false',
    '-c', 'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi"]',
    // ─────────────────────────────────────────────────────────────────────────
    // Native AGENTS.md (project-doc) alignment. The engine already loads
    // AGENTS.md by walking from the `.git` project root down to the thread cwd
    // and concatenating every file found (codex-rs/core/src/agents_md.rs); the
    // thread cwd is `sessionConfig.writableRoots[0]` (the picked workspace
    // folder), so dropping an AGENTS.md / AGENTS.override.md there Just Works.
    // These three knobs make the app's project-doc behavior explicit and richer
    // than the stock defaults:
    //
    //   • project_doc_max_bytes — stock default is ~32 KiB, which silently
    //     truncates larger project constitutions. Pin 64 KiB so a sizable
    //     AGENTS.md is included in full (0 would DISABLE loading entirely).
    //   • project_root_markers — pin the native default (`.git`) explicitly so a
    //     stray `~/.codex/config.toml` can't move the root-detection goalposts;
    //     when no marker is found the engine considers only the cwd.
    //   • project_doc_fallback_filenames — ALSO treat CLAUDE.md / GEMINI.md as
    //     project docs (candidate order: AGENTS.override.md → AGENTS.md →
    //     fallbacks), so cross-tool repos with a Claude/Gemini constitution but
    //     no AGENTS.md still feed their instructions to Codex.
    '-c', 'project_doc_max_bytes=65536',
    '-c', 'project_root_markers=[".git"]',
    '-c', 'project_doc_fallback_filenames=["CLAUDE.md", "GEMINI.md"]',
    // ─────────────────────────────────────────────────────────────────────────
    // Native cross-session MEMORY. Codex ships a first-party memory subsystem
    // (codex-rs/memories/) gated behind the `memories` feature flag — verified
    // against the shipped 0.142.2 binary via `experimentalFeature/list`
    // (`memories`, stage=beta, default_enabled=false; NOT the docs-implied
    // `memory`). Enabling it makes the engine, on every NON-ephemeral root
    // session start, run a background two-phase pipeline that distills prior
    // rollouts into `$CODEX_HOME/memories/` — `MEMORY.md` (searchable registry),
    // `memory_summary.md` (injected into context at session start), and
    // `rollout_summaries/` (per-session recaps + evidence). So the agent
    // "remembers" the user's preferences/decisions across chats without us
    // hand-rolling any persistence.
    //
    // Safe to pin here: `-c` lands on the config.toml layer (below `--enable`
    // and cloud gates, above code-default per the documented precedence), and
    // `$CODEX_HOME/memories` is already inside Codex's writable roots — doubly
    // so for us since we run `sandbox_mode="danger-full-access"`, so memory
    // maintenance never triggers an approval. Per-thread eligibility can still
    // be toggled later via the experimental `thread/memoryMode/set` /
    // `memory/reset` RPCs (exposed on the protocol client) without a relaunch.
    '-c', 'features.memories=true',
  ]

  // Register the local in-process catimation MCP server so the Codex
  // subprocess can call our `generate_image` (vip channel) and other renderer
  // tools. Without this, Codex has no image tool and confabulates with its own
  // internal `image_gen` — which never produces a real image in the app.
  //
  // The transport enum in codex (`McpServerTransportConfig`) is
  // `#[serde(deny_unknown_fields)]`, so we must NOT emit a `transport` key.
  // Streamable-HTTP is selected purely by the presence of `url`. The custom
  // auth header goes through `http_headers` (a TOML inline table). `-c` values
  // are parsed as TOML, so the quoted string and inline table below are valid.
  if (options?.catimationMcp) {
    const { port, token, stdio } = options.catimationMcp
    if (stdio) {
      // Preferred transport: stdio bridge subprocess. Codex selects stdio
      // purely by the presence of `command` (its transport enum is
      // deny_unknown_fields — never emit a `transport` key). `quote()` is
      // JSON.stringify, whose escaping (`\\` for Windows paths) is valid
      // TOML basic-string escaping, so absolute paths survive `-c` parsing.
      args.push(
        '-c', `mcp_servers.catimation.command=${quote(stdio.command)}`,
        '-c', `mcp_servers.catimation.args=[${stdio.args.map(quote).join(', ')}]`,
      )
      const envEntries = Object.entries(stdio.env)
      if (envEntries.length > 0) {
        args.push(
          '-c',
          `mcp_servers.catimation.env={ ${envEntries.map(([k, v]) => `${quote(k)} = ${quote(v)}`).join(', ')} }`,
        )
      }
    } else {
      args.push(
        '-c', `mcp_servers.catimation.url="http://${CATIMATION_MCP_HOST}:${port}/mcp"`,
        '-c', `mcp_servers.catimation.http_headers={ "${CATIMATION_MCP_TOKEN_HEADER}" = "${token}" }`,
      )
    }
    args.push(
      // Give `generate_image` room to finish. Codex 0.141 raised the default
      // per-tool timeout to 300s (openai/codex#28234), but a real image render
      // on the vip channel — at 2K/4K high quality a single call can run for
      // minutes — still blows past it. When Codex aborts first, the agent narrates a
      // "tool timed out" and retries, even though the renderer kept going and
      // the image actually completed + saved. ~2000s makes Codex wait for the
      // real result (or an explicit error) instead of inventing a timeout. The
      // value is plain seconds (codex deserializes it via `option_duration_secs`).
      '-c', 'mcp_servers.catimation.tool_timeout_sec=2000',
      // Let the agent fire several `generate_image` calls in ONE turn without the
      // turn blocking on each render serially. Codex gates MCP parallelism per
      // server: `ToolRouter::tool_supports_parallel` only returns true when the
      // server name is in `parallel_mcp_server_names`, which is populated from
      // each server's `supports_parallel_tool_calls` config flag (see
      // codex-rs/core/src/tools/router.rs + config/src/mcp_types.rs). With this
      // on, concurrent `generate_image` calls each take a read-lock (instead of
      // the exclusive write-lock), so "一次生成多张图" runs concurrently and each
      // call returns its own saved `paths` / `file://` resource_links the moment
      // that image finishes — no per-call wait stalls the others.
      '-c', 'mcp_servers.catimation.supports_parallel_tool_calls=true',
    )
    // Make our `generate_image` the FIRST (and only) image path. Codex 0.137
    // ships a built-in `imagegen` system skill (installed to
    // `$CODEX_HOME/skills/.system/imagegen`) whose great description out-competes
    // our MCP tool: the agent reads that SKILL.md, looks for the built-in
    // `image_gen` tool — which is NOT exposed over app-server — wastes a turn,
    // and only then falls back to `generate_image`. Disabling it by name removes
    // it from the advertised skills so the agent reaches for `generate_image`
    // straight away (it renders in chat + saves to history; the built-in cannot).
    //
    // `-c` lands on the SessionFlags config layer, which `skill_config_rules_from_stack`
    // honors; the name selector matches the skill's `name: "imagegen"` frontmatter.
    // We only disable it when our tool is actually wired, so a failed MCP bind
    // still leaves the built-in as a fallback ("use whatever works").
    args.push('-c', 'skills.config=[{ name = "imagegen", enabled = false }]')
  }

  // apiyi-mcp launch policy. Three mutually-exclusive outcomes driven by where
  // (if anywhere) the user's APIYI_API_KEY lives:
  //
  //   A) key in 设置 → API易 (localStorage → `apiyiKey`): overlay the secret at
  //      runtime via a dotted `-c` (mirrors the catimation pattern) — never
  //      touches config.toml, so the JSON editor entry stays key-less. + run
  //      the reliability timeouts below.
  //   B) key hand-typed into config.toml (`apiyiHasConfigKey`, resolved by the
  //      backend via `readApiyiConfigKey`): codex reads the secret straight off
  //      disk, so we do NOT re-inject it via `-c` (that would leak it onto the
  //      spawn command line / diagnostic log). We DO still apply the timeouts.
  //   C) NO key anywhere: keep apiyi DORMANT at launch (`enabled=false`). A
  //      keyless apiyi-mcp registers its tool handlers then dies at
  //      `initializeGenAI()`, and codex's `run_turn` awaits `list_all_tools()`
  //      where ONE stalled server gates the whole map until startup_timeout —
  //      so a keyless+enabled apiyi would hang the agent's FIRST TURN for the
  //      full 60s window (openai/codex#19556, #21318; #29321 "skip not-ready
  //      optional servers" is still only a proposal). The boot seed keeps
  //      enabled:true so the card shows apiyi ready-to-go; this `-c` override
  //      keeps it from actually spawning until a key exists. The moment the
  //      user adds a key (设置 or JSON editor) + restarts, A/B re-enable it.
  //
  // The seed (`seedApiyiMcpEntry`) guarantees the entry's transport
  // (`command`/`args`) at boot, so every `-c` below only sets a leaf onto an
  // existing entry — we never synthesize a command-less `[mcp_servers.apiyi]`
  // that codex would reject as "invalid transport".
  const apiyiKey = options?.apiyiKey?.trim()
  const apiyiHasConfigKey = options?.apiyiHasConfigKey === true
  const apiyiHasAnyKey = !!apiyiKey || apiyiHasConfigKey
  if (apiyiKey) {
    // (A) Overlay the leaf secret; dotted `-c` merges over the boot-seeded env
    // (base_url / model / other timeouts survive).
    args.push('-c', `mcp_servers.apiyi.env.APIYI_API_KEY=${quote(apiyiKey)}`)
  }
  if (apiyiHasAnyKey) {
    // (A+B) Reliability timeouts — the OTHER half of "why catimation always
    // returns tools and apiyi sometimes doesn't". apiyi-mcp is a real external
    // `node index.js` process (not catimation's in-process bridge), so:
    //   • startup_timeout_sec=60 — a cold node boot + MCP `initialize`
    //     handshake can intermittently blow codex's default startup window
    //     (DEFAULT_STARTUP_TIMEOUT, ~10s), leaving the server in the "异"
    //     (errored) state with ZERO tools listed. 60s of slack makes the
    //     listing reliable. This deliberately does NOT shrink to fit the
    //     tool-list RPC budget — a single slow server must never dictate
    //     apiyi's startup window. Instead the LIST side is made resilient:
    //     `CodexProtocolClient.listMcpServers` runs on its own 90s budget
    //     (> this 60s, see MCP_LIST_TIMEOUT_MS) and a list timeout degrades
    //     SILENTLY (status keeps arriving via `mcp_status_updated`
    //     notifications), so one slow server can't blank the whole panel.
    //   • tool_timeout_sec=2000 — per tool CALL (not startup); understanding
    //     jobs (video/音频/PDF via Gemini) routinely run minutes; apiyi-mcp's
    //     own GEMINI_TIMEOUT is 1800000ms (30min), so codex must wait at least
    //     that long or it aborts mid-flight. 2000s > 1800s, matching
    //     catimation. (Safe — does not affect the startup/list path above.)
    args.push(
      '-c', 'mcp_servers.apiyi.startup_timeout_sec=60',
      '-c', 'mcp_servers.apiyi.tool_timeout_sec=2000',
    )
  } else {
    // (C) No key from EITHER source → dormant, see rationale above.
    args.push('-c', 'mcp_servers.apiyi.enabled=false')
  }

  // cinematography-kb-mcp key overlay (设置 → 运镜知识库). Dotted `-c` merges the
  // leaf secret over the boot-seeded (possibly empty) env. Unlike apiyi we do
  // NOT gate the server on the key: `tools/list` is static so the tool always
  // appears; a keyless CALL just returns a "DASHSCOPE_API_KEY is not set"
  // message. So we only overlay when a key exists and never disable otherwise.
  const cinematographyKbKey = options?.cinematographyKbKey?.trim()
  if (cinematographyKbKey) {
    args.push(
      '-c',
      `mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY=${quote(cinematographyKbKey)}`,
    )
  }

  for (const root of sessionConfig.writableRoots) {
    args.push('--add-dir', root)
  }

  const withActive = appendProviderArgs(args, options?.provider)
  return appendExtraProviders(withActive, options?.extraProviders)
}
