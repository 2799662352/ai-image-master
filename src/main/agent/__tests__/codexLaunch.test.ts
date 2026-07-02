import { describe, expect, it } from 'vitest'
import {
  buildCodexLaunchArgs,
  DEFAULT_CODEX_SESSION_CONFIG,
  DEFAULT_LISTEN_URL,
  resolveCodexSessionConfig,
} from '../codexLaunch'

describe('buildCodexLaunchArgs', () => {
  it('uses app-server with the default listen URL and maximum-permission defaults', () => {
    const args = buildCodexLaunchArgs()
    expect(DEFAULT_LISTEN_URL).toBe('ws://127.0.0.1:7345')
    expect(args).toEqual([
      'app-server',
      '--listen', DEFAULT_LISTEN_URL,
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'web_search="live"',
      // Codex defaults to suppressing raw reasoning ("show_raw_agent_reasoning=false")
      // and only emits a summary when the model returns one. For our local
      // chat panel we WANT to surface reasoning so the "Thought" card has
      // something to show — without these two knobs the card stays empty
      // even when reasoningOutputTokens > 0.
      '-c', 'show_raw_agent_reasoning=true',
      '-c', 'model_reasoning_summary="auto"',
      '-c', 'model_context_window=272000',
      '-c', 'model_auto_compact_token_limit=220000',
      '-c', 'tool_output_token_limit=10000',
      '-c', 'experimental_use_rmcp_client=true',
      '-c', 'agents.max_threads=8',
      '-c', 'agents.max_depth=1',
      // Bare MCP tool names (openai/codex#21576) so the model calls `ask_user`
      // / `generate_image` exactly as the skills document them, and so the
      // canonical namespace is the bare `catimation` the escape-hatch keys off.
      '-c', 'features.non_prefixed_mcp_tool_names=true',
      // Force our MCP tools to stay DIRECTLY model-visible instead of being
      // deferred behind tool_search (codex 0.142.2 PR #29486) — the verified
      // root cause of the `ask_user` "unsupported call: catimationaskuser"
      // failure. See codexLaunch.ts for the full source-level rationale.
      '-c', 'features.code_mode.enabled=false',
      '-c', 'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi"]',
      // Native AGENTS.md (project-doc) alignment: bigger budget, pinned .git
      // root marker, and CLAUDE.md/GEMINI.md fallbacks. See codexLaunch.ts.
      '-c', 'project_doc_max_bytes=65536',
      '-c', 'project_root_markers=[".git"]',
      '-c', 'project_doc_fallback_filenames=["CLAUDE.md", "GEMINI.md"]',
      // Native cross-session memory (feature key `memories`, verified beta on
      // the 0.142.2 binary). See codexLaunch.ts for the full rationale.
      '-c', 'features.memories=true',
      // No apiyi key configured (neither 设置/localStorage nor config.toml) →
      // keep apiyi dormant so a keyless apiyi-mcp can't hang the first turn.
      '-c', 'mcp_servers.apiyi.enabled=false',
    ])
  })

  it('respects a custom listen URL while keeping the config overrides after --listen', () => {
    const args = buildCodexLaunchArgs({ listenUrl: 'ws://127.0.0.1:9999' })
    expect(args).toEqual([
      'app-server',
      '--listen', 'ws://127.0.0.1:9999',
      '-c', 'approval_policy="never"',
      '-c', 'sandbox_mode="danger-full-access"',
      '-c', 'web_search="live"',
      '-c', 'show_raw_agent_reasoning=true',
      '-c', 'model_reasoning_summary="auto"',
      '-c', 'model_context_window=272000',
      '-c', 'model_auto_compact_token_limit=220000',
      '-c', 'tool_output_token_limit=10000',
      '-c', 'experimental_use_rmcp_client=true',
      '-c', 'agents.max_threads=8',
      '-c', 'agents.max_depth=1',
      '-c', 'features.non_prefixed_mcp_tool_names=true',
      '-c', 'features.code_mode.enabled=false',
      '-c', 'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi"]',
      '-c', 'project_doc_max_bytes=65536',
      '-c', 'project_root_markers=[".git"]',
      '-c', 'project_doc_fallback_filenames=["CLAUDE.md", "GEMINI.md"]',
      '-c', 'features.memories=true',
      '-c', 'mcp_servers.apiyi.enabled=false',
    ])
    const listenIdx = args.indexOf('--listen')
    const firstConfigIdx = args.indexOf('-c')
    expect(firstConfigIdx).toBeGreaterThan(listenIdx)
  })

  it('does not include the legacy `serve` subcommand', () => {
    const args = buildCodexLaunchArgs()
    expect(args).not.toContain('serve')
  })

  it('keeps catimation MCP tools directly model-visible (ask_user popup root-cause fix)', () => {
    // Codex 0.142.2 (PR #29486) defers ALL MCP tools behind tool_search by
    // default, which hides `ask_user` so the model fabricates an unregistered
    // name (`catimationaskuser`) → `unsupported call`. The only escape hatch is
    // `code_mode.direct_only_tool_namespaces`, which promotes our namespace to
    // DirectModelOnly so the tools stay directly callable. `enabled=false` keeps
    // the experimental code-mode exec routing off.
    const args = buildCodexLaunchArgs()
    expect(args).toContain('features.code_mode.enabled=false')
    expect(args).toContain(
      'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi"]',
    )
    // It must be unconditional — present even with a custom provider/MCP wired.
    const withMcp = buildCodexLaunchArgs({
      provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
      catimationMcp: { port: 7842, token: 'deadbeef' },
    })
    expect(withMcp).toContain(
      'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi"]',
    )
  })

  it('aligns native AGENTS.md project-doc loading (budget, .git root, CLAUDE/GEMINI fallbacks)', () => {
    // The engine loads AGENTS.md from the .git root down to the thread cwd
    // (agents_md.rs); we make the behavior explicit + richer than stock defaults.
    const args = buildCodexLaunchArgs()
    // 64 KiB budget so a sizable AGENTS.md is not truncated (0 would disable it).
    expect(args).toContain('project_doc_max_bytes=65536')
    // Pinned native root marker so a stray user config.toml can't move it.
    expect(args).toContain('project_root_markers=[".git"]')
    // Cross-tool: CLAUDE.md / GEMINI.md also count as project docs.
    expect(args).toContain('project_doc_fallback_filenames=["CLAUDE.md", "GEMINI.md"]')
    // Unconditional — present even with a custom provider/MCP wired.
    const withMcp = buildCodexLaunchArgs({
      provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
      catimationMcp: { port: 7842, token: 'deadbeef' },
    })
    expect(withMcp).toContain('project_doc_fallback_filenames=["CLAUDE.md", "GEMINI.md"]')
  })

  it('enables native cross-session memory via the verified `memories` feature key', () => {
    // Feature key confirmed against the shipped 0.142.2 binary
    // (experimentalFeature/list → `memories`, stage=beta, default off). The
    // docs-implied `memory` key does NOT exist; using it would silently no-op.
    const args = buildCodexLaunchArgs()
    expect(args).toContain('features.memories=true')
    // Must NOT use the wrong (non-existent) key.
    expect(args).not.toContain('features.memory=true')
    // Unconditional — present even with a custom provider/MCP wired.
    const withMcp = buildCodexLaunchArgs({
      provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
      catimationMcp: { port: 7842, token: 'deadbeef' },
    })
    expect(withMcp).toContain('features.memories=true')
  })

  it('configures the active provider via -c overrides when provider config is given', () => {
    const args = buildCodexLaunchArgs({
      provider: {
        id: 'apiyi',
        name: 'API Yi',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    })

    // Top-level model_provider must point to our custom id
    expect(pairs(args)).toContainEqual(['-c', 'model_provider="apiyi"'])
    // Provider table must carry name, base_url, env_key
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.name="API Yi"'])
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.base_url="https://api.apiyi.com/v1"'])
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.env_key="OPENAI_API_KEY"'])
    // CRITICAL: must explicitly pin `wire_api="responses"`. Codex 0.128 (after
    // openai/codex#13592) prefers `responses_websocket` for custom providers
    // and falls through to `wss://api.openai.com/v1/responses`, returning
    // 401 + a "Reconnecting...N/5" warning loop. We need plain HTTP Responses
    // API which apiyi actually proxies (https://docs.apiyi.com/api-capabilities/openai-responses).
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.wire_api="responses"'])
    // Legacy `namespace_tools=false` (openai/codex#26234). NOTE: as of codex
    // 0.142.2 this per-provider key is a no-op — `ProviderCapabilities` is a
    // hardcoded trait default (namespace_tools=true) for configured providers,
    // not config-readable. We keep emitting it as a harmless forward-compat
    // hint; the ACTUAL ask_user deferral fix is
    // `features.code_mode.direct_only_tool_namespaces` in the base args.
    expect(pairs(args)).toContainEqual(['-c', 'model_providers.apiyi.namespace_tools=false'])
    // The deprecated `supports_websockets` field was removed in 0.128 — never
    // set it; passing it would just be noise.
    const flat = args.join(' ')
    expect(flat).not.toContain('supports_websockets')
  })

  it('keeps reasoning visibility enabled for custom providers', () => {
    const args = buildCodexLaunchArgs({
      provider: {
        id: 'apiyi',
        name: 'API Yi',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    })

    expect(args).toContain('show_raw_agent_reasoning=true')
    expect(args).toContain('model_reasoning_summary="auto"')
    expect(args).not.toContain('model_reasoning_summary="none"')
    expect(args).not.toContain('model_supports_reasoning_summaries=false')
  })

  it('omits provider overrides when no provider config is supplied', () => {
    const args = buildCodexLaunchArgs()
    const flat = args.join(' ')
    expect(flat).not.toContain('model_provider')
    expect(flat).not.toContain('model_providers.')
  })

  it('passes model_context_window and model_auto_compact_token_limit so Codex auto-compacts', () => {
    // 272k is the official gpt-5.5 / gpt-5.4 model catalog context window.
    // 220k (~81%) gives long-thread runway while still compacting earlier than
    // the stock 90% ratio, leaving headroom for apiyi's request-BODY-BYTE cap.
    const args = buildCodexLaunchArgs()
    expect(args).toContain('model_context_window=272000')
    expect(args).toContain('model_auto_compact_token_limit=220000')
  })

  it('pins tool_output_token_limit to the official catalog value (10k)', () => {
    // codex-rs/models-manager/models.json caps per-tool-call output at
    // 10_000 tokens for gpt-5.5/5.4/5.3 (bytes for 5.2). A user-level
    // ~/.codex/config.toml carrying e.g. `tool_output_token_limit = 64_000`
    // makes every big file read inject 6.4x the official budget into
    // history — ballooning replayed requests straight into the gateway's
    // request_too_large wall. `-c` outranks config.toml, restoring the
    // official truncation for our sessions.
    const args = buildCodexLaunchArgs()
    expect(args).toContain('tool_output_token_limit=10000')
  })

  it('enables rmcp client so URL-based MCP servers actually start', () => {
    // Without `experimental_use_rmcp_client=true`, Codex 0.128 silently skips
    // streamable-HTTP MCP servers (e.g. context7 / huggingface MCP). See
    // openai/codex#4707 — pinned via `-c` so users do not have to edit
    // ~/.codex/config.toml by hand.
    const args = buildCodexLaunchArgs()
    expect(args).toContain('experimental_use_rmcp_client=true')
  })

  it('does NOT inject a catimation MCP entry when no runtime is provided', () => {
    const args = buildCodexLaunchArgs()
    expect(args.some((a) => a.includes('mcp_servers.catimation'))).toBe(false)
  })

  it('does NOT disable the built-in imagegen skill when our tool is unavailable', () => {
    // Fallback safety: with no catimation MCP wired, the built-in `imagegen`
    // skill is the only image path, so we must leave it enabled.
    const args = buildCodexLaunchArgs()
    expect(args.some((a) => a.includes('imagegen'))).toBe(false)
  })

  it('disables the built-in imagegen skill when catimation is wired (first choice)', () => {
    // Codex 0.137 ships a built-in `imagegen` system skill that out-competes our
    // MCP tool. Disabling it by name (SessionFlags layer via `-c`) makes
    // `generate_image` the first/only image path.
    const args = buildCodexLaunchArgs({ catimationMcp: { port: 7842, token: 'deadbeef' } })
    expect(args).toContain('skills.config=[{ name = "imagegen", enabled = false }]')
  })

  it('injects the local catimation MCP server (url + token header) when provided', () => {
    // This is THE wiring that lets the spawned Codex subprocess call our
    // in-app `generate_image` tool. Without it Codex has no image tool and
    // confabulates with its own internal `image_gen`.
    const args = buildCodexLaunchArgs({ catimationMcp: { port: 7842, token: 'deadbeef' } })

    // Streamable-HTTP is selected by `url` alone; codex's transport enum is
    // deny_unknown_fields, so we must NEVER emit a `transport` key.
    expect(args).toContain('mcp_servers.catimation.url="http://127.0.0.1:7842/mcp"')
    expect(args.some((a) => a.includes('transport'))).toBe(false)

    // Custom auth header via TOML inline table (the `-c` value is TOML-parsed).
    expect(args).toContain('mcp_servers.catimation.http_headers={ "x-catimation-token" = "deadbeef" }')

    // Generous per-tool timeout so Codex waits for a real image render (minutes
    // at 2K/4K high) instead of aborting + retrying mid-generation.
    expect(args).toContain('mcp_servers.catimation.tool_timeout_sec=2000')
  })

  it('uses the ephemeral port when the OS reassigned it', () => {
    const args = buildCodexLaunchArgs({ catimationMcp: { port: 51234, token: 'abc' } })
    expect(args).toContain('mcp_servers.catimation.url="http://127.0.0.1:51234/mcp"')
  })

  it('prefers the stdio bridge (command/args/env) over the HTTP url when stdio info is present', () => {
    // Plan-B cutover for the "生成成功但 codex 没收到响应" incident: even the
    // hardened streamable-HTTP transport dropped a completed generate_image
    // result. With stdio info present we register the bridge subprocess and
    // must NOT emit a url — codex picks its transport by which keys exist
    // (deny_unknown_fields enum, url ⇒ HTTP / command ⇒ stdio).
    const args = buildCodexLaunchArgs({
      catimationMcp: {
        port: 7842,
        token: 'deadbeef',
        stdio: {
          command: 'C:\\Program Files\\nodejs\\node.exe',
          args: ['C:\\app\\resources\\catimation-bridge\\index.js'],
          env: { CATIMATION_BRIDGE_PORT: '51234', CATIMATION_BRIDGE_TOKEN: 'cafebabe' },
        },
      },
    })

    // JSON.stringify escaping doubles backslashes — valid TOML basic strings,
    // so Windows paths survive `-c` TOML parsing.
    expect(args).toContain('mcp_servers.catimation.command="C:\\\\Program Files\\\\nodejs\\\\node.exe"')
    expect(args).toContain('mcp_servers.catimation.args=["C:\\\\app\\\\resources\\\\catimation-bridge\\\\index.js"]')
    expect(args).toContain(
      'mcp_servers.catimation.env={ "CATIMATION_BRIDGE_PORT" = "51234", "CATIMATION_BRIDGE_TOKEN" = "cafebabe" }',
    )

    // No HTTP-transport keys and still no `transport` key.
    expect(args.some((a) => a.includes('mcp_servers.catimation.url'))).toBe(false)
    expect(args.some((a) => a.includes('http_headers'))).toBe(false)
    expect(args.some((a) => a.includes('transport'))).toBe(false)

    // Transport-agnostic knobs still apply on the stdio path.
    expect(args).toContain('mcp_servers.catimation.tool_timeout_sec=2000')
    expect(args).toContain('mcp_servers.catimation.supports_parallel_tool_calls=true')
    expect(args).toContain('skills.config=[{ name = "imagegen", enabled = false }]')
  })

  it('carries ELECTRON_RUN_AS_NODE through stdio env for the packaged-app fallback', () => {
    // When no system node exists, resolveApiyiCommand falls back to our own
    // Electron binary + ELECTRON_RUN_AS_NODE=1; that env must reach codex's
    // spawn config or electron.exe boots in GUI mode and trashes stdio.
    const args = buildCodexLaunchArgs({
      catimationMcp: {
        port: 7842,
        token: 't',
        stdio: {
          command: 'C:\\app\\catimation.exe',
          args: ['C:\\app\\resources\\catimation-bridge\\index.js'],
          env: { ELECTRON_RUN_AS_NODE: '1', CATIMATION_BRIDGE_PORT: '1', CATIMATION_BRIDGE_TOKEN: 't' },
        },
      },
    })
    const envArg = args.find((a) => a.startsWith('mcp_servers.catimation.env='))
    expect(envArg).toContain('"ELECTRON_RUN_AS_NODE" = "1"')
  })

  it('accepts explicit safer overrides via sessionConfig', () => {
    const args = buildCodexLaunchArgs({
      listenUrl: 'ws://127.0.0.1:1234',
      sessionConfig: { approvalPolicy: 'on-request', sandboxMode: 'workspace-write', webSearch: 'disabled' },
    })

    expect(args).toContain('approval_policy="on-request"')
    expect(args).toContain('sandbox_mode="workspace-write"')
    expect(args).toContain('web_search="disabled"')
  })

  it('forwards writableRoots as --add-dir flags', () => {
    const args = buildCodexLaunchArgs({
      listenUrl: 'ws://127.0.0.1:1234',
      sessionConfig: { writableRoots: ['D:/repo/sub'] },
    })
    const idx = args.indexOf('--add-dir')
    expect(idx).toBeGreaterThanOrEqual(0)
    expect(args[idx + 1]).toBe('D:/repo/sub')
  })

  it('resolves default writableRoots without sharing the default array', () => {
    const resolved = resolveCodexSessionConfig()

    DEFAULT_CODEX_SESSION_CONFIG.writableRoots.push('D:/later-default-root')
    try {
      expect(resolved.writableRoots).toEqual([])
    } finally {
      DEFAULT_CODEX_SESSION_CONFIG.writableRoots.pop()
    }
  })

  it('resolves custom writableRoots without sharing the caller array', () => {
    const writableRoots = ['D:/repo/sub']
    const resolved = resolveCodexSessionConfig({ writableRoots })

    writableRoots.push('D:/later-caller-root')

    expect(resolved.writableRoots).toEqual(['D:/repo/sub'])
  })

  it('uses appendProviderArgs to attach provider config when supplied', () => {
    const args = buildCodexLaunchArgs({
      listenUrl: 'ws://127.0.0.1:1234',
      provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
    })

    expect(args).toContain('model_provider="apiyi"')
    expect(args).toContain('model_providers.apiyi.base_url="https://api.apiyi.com/v1"')
    expect(args).toContain('model_providers.apiyi.wire_api="responses"')
  })

  // The right.codes preset (https://docs.right.codes/docs/rc_cli_config/codex.html)
  // requires several top-level overrides Codex normally leaves at default:
  //   - model="gpt-5.2"
  //   - model_reasoning_effort="xhigh"
  //   - model_verbosity="high"
  //   - disable_response_storage=true
  //   - windows_wsl_setup_acknowledged=true
  // and a per-provider `requires_openai_auth=true`. We model these as optional
  // fields on the provider record so each preset can carry its own opinionated
  // defaults, and so the user can still customize via the Settings page when
  // they add a custom provider.
  it('injects per-provider model / reasoning_effort / verbosity when supplied', () => {
    const args = buildCodexLaunchArgs({
      provider: {
        id: 'rightcode',
        name: 'Right.Codes',
        baseUrl: 'https://right.codes/codex/v1',
        envKey: 'OPENAI_API_KEY',
        model: 'gpt-5.2',
        reasoningEffort: 'xhigh',
        verbosity: 'high',
        requiresOpenaiAuth: true,
      },
    })

    expect(args).toContain('model="gpt-5.2"')
    expect(args).toContain('model_reasoning_effort="xhigh"')
    expect(args).toContain('model_verbosity="high"')
    expect(args).toContain('model_providers.rightcode.requires_openai_auth=true')
  })

  it('forwards extraTopLevelConfig as raw -c key=value entries', () => {
    const args = buildCodexLaunchArgs({
      provider: {
        id: 'rightcode',
        name: 'Right.Codes',
        baseUrl: 'https://right.codes/codex/v1',
        envKey: 'OPENAI_API_KEY',
        extraTopLevelConfig: {
          disable_response_storage: true,
          windows_wsl_setup_acknowledged: true,
        },
      },
    })

    expect(args).toContain('disable_response_storage=true')
    expect(args).toContain('windows_wsl_setup_acknowledged=true')
  })

  // apiyiKey is the catimation-style runtime secret injection: the single key
  // the user saved in 设置 → API易 is overlaid onto the boot-seeded
  // [mcp_servers.apiyi].env table via `-c` at spawn, NEVER written to
  // config.toml. We only overlay the KEY (not the model) so a user's manual
  // editor switch to a thinking model is respected.
  it('overlays the apiyi-mcp APIYI_API_KEY via -c when apiyiKey is supplied', () => {
    const args = buildCodexLaunchArgs({ apiyiKey: 'sk-apiyi-runtime' })
    expect(args).toContain('mcp_servers.apiyi.env.APIYI_API_KEY="sk-apiyi-runtime"')
    // The model must NOT be force-injected (the seed/editor owns it).
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.env.GEMINI_MODEL'))).toBe(false)
  })

  // Reliability timeouts ride alongside the key (guarded so the seeded
  // transport-carrying entry exists), mirroring catimation's tool_timeout_sec.
  it('injects apiyi startup/tool timeouts when apiyiKey is supplied', () => {
    const args = buildCodexLaunchArgs({ apiyiKey: 'sk-apiyi-runtime' })
    // Generous 60s startup slack — the list side (90s budget + silent timeout
    // degrade) is what keeps one slow server from blanking the whole panel, so
    // apiyi's startup window need NOT be artificially shrunk.
    expect(args).toContain('mcp_servers.apiyi.startup_timeout_sec=60')
    expect(args).toContain('mcp_servers.apiyi.tool_timeout_sec=2000')
  })

  // apiyi tools must be promoted to DirectModelOnly so they're never deferred
  // behind tool_search — this is why catimation always returns tools and apiyi
  // (previously) sometimes did not. Unconditional (no key needed).
  it('lists apiyi in direct_only_tool_namespaces unconditionally', () => {
    expect(buildCodexLaunchArgs()).toContain(
      'features.code_mode.direct_only_tool_namespaces=["catimation", "mcp__catimation", "apiyi", "mcp__apiyi"]',
    )
  })

  // No key from EITHER source (设置/localStorage `apiyiKey` nor a hand-edited
  // config.toml `apiyiHasConfigKey`) → keep apiyi DORMANT at launch so a
  // keyless apiyi-mcp can't hang the agent's first turn (openai/codex#19556 —
  // run_turn awaits list_all_tools, one stalled server gates the whole map up
  // to startup_timeout). We emit EXACTLY `enabled=false` and nothing else.
  it('keeps apiyi dormant (enabled=false, no env/timeout) when NO key is configured', () => {
    const args = buildCodexLaunchArgs()
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.env.'))).toBe(false)
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.startup_timeout_sec'))).toBe(false)
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.tool_timeout_sec'))).toBe(false)
    expect(args).toContain('mcp_servers.apiyi.enabled=false')
  })

  // A blank/whitespace key must be treated as "no key" — same dormant guard,
  // never an env/timeout override.
  it('treats a whitespace-only apiyiKey as no key → dormant guard', () => {
    const args = buildCodexLaunchArgs({ apiyiKey: '   ' })
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.env.'))).toBe(false)
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.startup_timeout_sec'))).toBe(false)
    expect(args).toContain('mcp_servers.apiyi.enabled=false')
  })

  // SECOND key source: the user hand-typed APIYI_API_KEY into config.toml (the
  // empty-tools card hint instructs this). `apiyiHasConfigKey=true` means codex
  // reads the secret straight off disk — we must NOT disable apiyi, and must NOT
  // re-inject the secret via `-c` (that would leak it to the spawn log), but we
  // DO still apply the reliability timeouts.
  it('runs apiyi (timeouts, no disable, no -c secret) when key lives in config.toml', () => {
    const args = buildCodexLaunchArgs({ apiyiHasConfigKey: true })
    expect(args).not.toContain('mcp_servers.apiyi.enabled=false')
    expect(args.some((a) => a.startsWith('mcp_servers.apiyi.env.APIYI_API_KEY'))).toBe(false)
    expect(args).toContain('mcp_servers.apiyi.startup_timeout_sec=60')
    expect(args).toContain('mcp_servers.apiyi.tool_timeout_sec=2000')
  })

  // localStorage key present → inject the secret via `-c`, apply timeouts, and
  // never emit the dormant guard.
  it('does not emit the dormant guard when apiyiKey is supplied', () => {
    const args = buildCodexLaunchArgs({ apiyiKey: 'sk-apiyi-runtime' })
    expect(args).not.toContain('mcp_servers.apiyi.enabled=false')
    expect(args).toContain('mcp_servers.apiyi.env.APIYI_API_KEY="sk-apiyi-runtime"')
  })

  // cinematography-kb-mcp key: same catimation-style runtime injection as apiyi —
  // the 设置 → 运镜知识库 key is overlaid onto the boot-seeded
  // [mcp_servers.cinematography_kb].env table via `-c` at spawn, NEVER written to
  // config.toml.
  it('overlays cinematography_kb DASHSCOPE_API_KEY via -c when cinematographyKbKey is supplied', () => {
    const args = buildCodexLaunchArgs({ cinematographyKbKey: 'sk-dashscope-runtime' })
    expect(args).toContain(
      'mcp_servers.cinematography_kb.env.DASHSCOPE_API_KEY="sk-dashscope-runtime"',
    )
  })

  // Unlike apiyi, the KB server is NEVER disabled when keyless: `tools/list` is
  // static so the tool always appears; only the CALL reports the missing key. So
  // with no key we emit NO cinematography_kb `-c` at all (and no enabled=false).
  it('emits no cinematography_kb -c when no key is configured (never disabled)', () => {
    const args = buildCodexLaunchArgs()
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.'))).toBe(false)
  })

  it('treats a whitespace-only cinematographyKbKey as no key → no injection', () => {
    const args = buildCodexLaunchArgs({ cinematographyKbKey: '   ' })
    expect(args.some((a) => a.startsWith('mcp_servers.cinematography_kb.'))).toBe(false)
  })

  it('registers extraProviders WITHOUT changing the active model_provider or top-level model', () => {
    const args = buildCodexLaunchArgs({
      provider: { id: 'apiyi', name: 'API Yi', baseUrl: 'https://api.apiyi.com/v1', envKey: 'OPENAI_API_KEY' },
      extraProviders: [
        {
          id: 'qwen',
          name: 'Qwen (DashScope via new-api)',
          baseUrl: 'http://175.178.198.17:3000/v1',
          envKey: 'MIAU_API_KEY',
          model: 'qwen3.7-max-dashscope',
          wireApi: 'responses',
        },
      ],
    })

    // Active provider stays apiyi; the extra provider must NOT seize model_provider.
    expect(args).toContain('model_provider="apiyi"')
    expect(args).not.toContain('model_provider="qwen"')
    // Extra provider table is registered (name / base_url / env_key / wire_api).
    expect(args).toContain('model_providers.qwen.name="Qwen (DashScope via new-api)"')
    expect(args).toContain('model_providers.qwen.base_url="http://175.178.198.17:3000/v1"')
    expect(args).toContain('model_providers.qwen.env_key="MIAU_API_KEY"')
    // Codex removed wire_api="chat" (#7782) — only "responses" is ever emitted.
    expect(args).toContain('model_providers.qwen.wire_api="responses"')
    expect(args).not.toContain('model_providers.qwen.wire_api="chat"')
    // Extra gateways flatten MCP tools too (openai/codex#26234).
    expect(args).toContain('model_providers.qwen.namespace_tools=false')
    // The extra provider's model must NOT become the global top-level model
    // (it is only used when a subagent selects modelProvider="qwen").
    expect(args).not.toContain('model="qwen3.7-max-dashscope"')
  })

  it('registers extraProviders even when there is no active provider, defaulting wire_api to responses', () => {
    const args = buildCodexLaunchArgs({
      extraProviders: [
        { id: 'qwen', name: 'Qwen', baseUrl: 'http://175.178.198.17:3000/v1', envKey: 'MIAU_API_KEY' },
      ],
    })
    // No active provider selected.
    expect(args.join(' ')).not.toContain('model_provider="')
    // Extra provider registered with the responses wire_api default (Codex
    // removed "chat" — #7782 — so chat must never be the fallback).
    expect(args).toContain('model_providers.qwen.wire_api="responses"')
    expect(args).not.toContain('model_providers.qwen.wire_api="chat"')
    expect(args).toContain('model_providers.qwen.env_key="MIAU_API_KEY"')
  })

  it('does not inject model overrides when provider does not specify them', () => {
    const args = buildCodexLaunchArgs({
      provider: {
        id: 'apiyi',
        name: 'API Yi',
        baseUrl: 'https://api.apiyi.com/v1',
        envKey: 'OPENAI_API_KEY',
      },
    })
    const flat = args.join(' ')
    // Top-level "model=" must not appear when the preset omits it; otherwise
    // we'd silently override whatever the user set in their config.toml.
    expect(flat).not.toMatch(/(?<!model_providers\.\w+\.)\bmodel="/)
    expect(flat).not.toContain('model_reasoning_effort=')
    expect(flat).not.toContain('model_verbosity=')
  })
})

// ts-ignore-next: helper for config pair assertions
function pairs(args: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = []
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '-c') out.push(['-c', args[i + 1]])
  }
  return out
}
