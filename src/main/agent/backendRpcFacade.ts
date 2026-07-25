// 后端直通 RPC 门面。
//
// 这一批方法在 AgentManager 里逐字重复过同一段 try/catch：「后端没有这个可选方法
// 就报 X API unavailable，成功包 {ok:true,data}，抛错包 {ok:false,error}」。它们不
// 读 AgentManager 的任何状态、不含任何策略，纯粹是把 IAgentBackend 的可选能力翻译
// 成渲染层要的信封 —— 所以搬到这里，让 AgentManager 只留真正需要它状态的东西。
//
// 三条刻意保留的原有契约（都有用例钉着）：
//   1. 每个方法的 "unavailable" 文案逐字沿用，渲染层可能在匹配它；
//   2. 无返回值的方法**不带 data 键**，别给消费方塞 data: undefined；
//   3. readConfig 用 `config` 键、mcpOAuthLogin 用 `authorization_url` 键。

import os from 'node:os'
import path from 'node:path'

import { readRawCodexConfig } from './codexConfigDiscovery'
import type { IAgentBackend } from './types'
import type {
  AppsListParams,
  AppsListResponse,
  ExternalAgentConfigDetectParams,
  ExternalAgentConfigDetectResponse,
  ExternalAgentConfigImportResponse,
  ExternalAgentConfigMigrationItem,
  MarketplaceAddParams,
  MarketplaceAddResponse,
  MarketplaceRemoveResponse,
  MarketplaceUpgradeResponse,
  PluginInstallParams,
  PluginInstallResponse,
  PluginInstalledParams,
  PluginInstalledResponse,
  PluginListParams,
  PluginListResponse,
  PluginReadParams,
  PluginReadResponse,
} from '../../types/codexPlugins'

export interface RpcEnvelope<T> {
  ok: boolean
  error?: string
  data?: T
}

/** 无返回值的 RPC —— 与原实现的 `{ ok, error? }` 签名逐字一致。 */
export interface RpcResult {
  ok: boolean
  error?: string
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * `call` 为 undefined 表示后端不支持该能力（IAgentBackend 上是可选方法）。
 * 返回值为 undefined 时省略 data 键，保持无返回值方法的原有形状。
 */
async function envelope<T>(
  label: string,
  call: (() => Promise<T>) | undefined,
): Promise<RpcEnvelope<T>> {
  try {
    if (!call) throw new Error(`${label} API unavailable`)
    const data = await call()
    return data === undefined ? { ok: true } : { ok: true, data }
  } catch (err) {
    return { ok: false, error: errorMessage(err) }
  }
}

/**
 * `getBackend` 是惰性的：AgentManager 的 backend 字段并非 readonly，将来若在重启
 * 时换实例，门面不应该攥着旧的那个。
 */
export function createBackendRpcFacade(getBackend: () => IAgentBackend) {
  return {
    // ─── config / MCP ───────────────────────────────────────────────────────
    listMcpServers: (params?: unknown): Promise<RpcEnvelope<unknown>> => {
      const b = getBackend()
      return envelope('MCP list', b.listMcpServers && (() => b.listMcpServers!(params)))
    },

    batchWriteConfig: (edits: unknown[], reload?: boolean): Promise<RpcResult> => {
      const b = getBackend()
      return envelope('MCP batch write', b.batchWriteConfig && (() => b.batchWriteConfig!(edits, reload)))
    },

    writeConfigValue: (keyPath: string, value: unknown): Promise<RpcResult> => {
      const b = getBackend()
      return envelope('MCP write value', b.writeConfigValue && (() => b.writeConfigValue!(keyPath, value)))
    },

    readConfig: async (): Promise<{ ok: boolean; error?: string; config?: unknown }> => {
      const b = getBackend()
      const res = await envelope('MCP read config', b.readConfig && (() => b.readConfig!()))
      if (!res.ok) return { ok: false, error: res.error }
      return { ok: true, config: (res.data as { config?: unknown } | undefined)?.config }
    },

    /**
     * 直接读 `~/.codex/config.toml`（绕开 codex 的严格 schema）。
     *
     * 为什么与 readConfig 分开：Rust 侧的 `config/read` 只要有一个
     * `[mcp_servers.X]` 段校验失败就整体拒绝，而渲染层必须仍能枚举并**编辑**那个
     * 坏掉的段来修它 —— 否则 codex 的解析器一收紧，MCP 页就变成死路。这里刻意把
     * 用户磁盘上的 TOML 原样交出去，即使 codex 会拒绝它。
     */
    readRawConfig: async (): Promise<{
      ok: boolean
      error?: string
      config?: Record<string, unknown> | null
      raw?: string | null
      parseError?: string
    }> => {
      try {
        const configPath = path.join(os.homedir(), '.codex', 'config.toml')
        const result = await readRawCodexConfig(configPath)
        return { ok: true, config: result.config, raw: result.raw, parseError: result.parseError }
      } catch (err) {
        return { ok: false, error: errorMessage(err) }
      }
    },

    reloadMcpServers: (): Promise<RpcResult> => {
      const b = getBackend()
      return envelope('MCP reload', b.reloadMcpServers && (() => b.reloadMcpServers!()))
    },

    mcpOAuthLogin: async (
      name: string,
    ): Promise<{ ok: boolean; error?: string; authorization_url?: string }> => {
      const b = getBackend()
      const res = await envelope('MCP OAuth', b.mcpOAuthLogin && (() => b.mcpOAuthLogin!(name)))
      if (!res.ok) return { ok: false, error: res.error }
      return {
        ok: true,
        authorization_url: (res.data as { authorization_url?: string } | undefined)?.authorization_url,
      }
    },

    // ─── plugins / marketplaces / apps ──────────────────────────────────────
    listPlugins: (params?: PluginListParams): Promise<RpcEnvelope<PluginListResponse>> => {
      const b = getBackend()
      return envelope('Plugin list', b.listPlugins && (() => b.listPlugins!(params)))
    },

    listInstalledPlugins: (
      params?: PluginInstalledParams,
    ): Promise<RpcEnvelope<PluginInstalledResponse>> => {
      const b = getBackend()
      return envelope('Installed plugins', b.listInstalledPlugins && (() => b.listInstalledPlugins!(params)))
    },

    readPlugin: (params: PluginReadParams): Promise<RpcEnvelope<PluginReadResponse>> => {
      const b = getBackend()
      return envelope('Plugin read', b.readPlugin && (() => b.readPlugin!(params)))
    },

    installPlugin: (params: PluginInstallParams): Promise<RpcEnvelope<PluginInstallResponse>> => {
      const b = getBackend()
      return envelope('Plugin install', b.installPlugin && (() => b.installPlugin!(params)))
    },

    uninstallPlugin: (pluginId: string): Promise<RpcResult> => {
      const b = getBackend()
      return envelope('Plugin uninstall', b.uninstallPlugin && (() => b.uninstallPlugin!(pluginId)))
    },

    addMarketplace: (params: MarketplaceAddParams): Promise<RpcEnvelope<MarketplaceAddResponse>> => {
      const b = getBackend()
      return envelope('Marketplace add', b.addMarketplace && (() => b.addMarketplace!(params)))
    },

    removeMarketplace: (marketplaceName: string): Promise<RpcEnvelope<MarketplaceRemoveResponse>> => {
      const b = getBackend()
      return envelope('Marketplace remove', b.removeMarketplace && (() => b.removeMarketplace!(marketplaceName)))
    },

    upgradeMarketplaces: (marketplaceName?: string): Promise<RpcEnvelope<MarketplaceUpgradeResponse>> => {
      const b = getBackend()
      return envelope('Marketplace upgrade', b.upgradeMarketplaces && (() => b.upgradeMarketplaces!(marketplaceName)))
    },

    listApps: (params?: AppsListParams): Promise<RpcEnvelope<AppsListResponse>> => {
      const b = getBackend()
      return envelope('Apps list', b.listApps && (() => b.listApps!(params)))
    },

    detectExternalAgentConfig: (
      params?: ExternalAgentConfigDetectParams,
    ): Promise<RpcEnvelope<ExternalAgentConfigDetectResponse>> => {
      const b = getBackend()
      return envelope(
        'External agent config detect',
        b.detectExternalAgentConfig && (() => b.detectExternalAgentConfig!(params)),
      )
    },

    importExternalAgentConfig: (
      items: ExternalAgentConfigMigrationItem[],
    ): Promise<RpcEnvelope<ExternalAgentConfigImportResponse>> => {
      const b = getBackend()
      return envelope(
        'External agent config import',
        b.importExternalAgentConfig && (() => b.importExternalAgentConfig!(items)),
      )
    },
  }
}

export type BackendRpcFacade = ReturnType<typeof createBackendRpcFacade>
