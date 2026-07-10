// App-server v2 plugin / marketplace / apps / external-agent-import DTOs.
//
// Mirrors the generated TypeScript schema under openai/codex
// `codex-rs/app-server-protocol/schema/typescript/v2/*`; originally pinned at
// rust-v0.141.0 and compatibility-checked through rust-v0.144.1.
// `AbsolutePathBuf` is a plain string on the wire. Fields that reference deep,
// rarely-needed subtrees (share principals, migration item variants, app info
// internals) are kept loose (`unknown` / index signatures) on purpose — the
// protocol layer only needs faithful top-level shapes; the Connectors UI can
// tighten them later as it actually consumes those branches.

export type AbsolutePathBuf = string

// ─── Plugins ────────────────────────────────────────────────────────────────

export type PluginListMarketplaceKind =
  | 'local'
  | 'vertical'
  | 'workspace-directory'
  | 'shared-with-me'
  | 'created-by-me-remote'

export type PluginInstallPolicy = 'NOT_AVAILABLE' | 'AVAILABLE' | 'INSTALLED_BY_DEFAULT'
export type PluginAuthPolicy = 'ON_INSTALL' | 'ON_USE'
export type PluginAvailability = 'AVAILABLE' | 'DISABLED_BY_ADMIN'

export type PluginSource =
  | { type: 'local'; path: AbsolutePathBuf }
  | { type: 'git'; url: string; path: string | null; refName: string | null; sha: string | null }
  | { type: 'remote' }

export interface PluginInterface {
  displayName: string | null
  shortDescription: string | null
  longDescription: string | null
  developerName: string | null
  category: string | null
  capabilities: string[]
  websiteUrl: string | null
  privacyPolicyUrl: string | null
  termsOfServiceUrl: string | null
  defaultPrompt: string[] | null
  brandColor: string | null
  composerIcon: AbsolutePathBuf | null
  composerIconUrl: string | null
  logo: AbsolutePathBuf | null
  logoUrl: string | null
  screenshots: AbsolutePathBuf[]
  screenshotUrls: string[]
}

export interface PluginShareContext {
  remotePluginId: string
  remoteVersion: string | null
  discoverability: unknown | null
  shareUrl: string | null
  creatorAccountUserId: string | null
  creatorName: string | null
  sharePrincipals: unknown[] | null
}

export interface PluginSummary {
  id: string
  remotePluginId: string | null
  localVersion: string | null
  name: string
  shareContext: PluginShareContext | null
  source: PluginSource
  installed: boolean
  enabled: boolean
  installPolicy: PluginInstallPolicy
  authPolicy: PluginAuthPolicy
  availability: PluginAvailability
  interface: PluginInterface | null
  keywords: string[]
}

export interface PluginHookSummary {
  key: string
  eventName: string
}

export interface SkillSummary {
  name: string
  description: string
  shortDescription: string | null
  interface: unknown | null
  path: AbsolutePathBuf | null
  enabled: boolean
}

export interface AppSummary {
  id: string
  name: string
  description: string | null
  installUrl: string | null
  category: string | null
}

export interface AppTemplateSummary {
  templateId: string
  name: string
  description: string | null
  category: string | null
  canonicalConnectorId: string | null
  logoUrl: string | null
  logoUrlDark: string | null
  materializedAppIds: string[]
  reason: unknown | null
}

export interface PluginDetail {
  marketplaceName: string
  marketplacePath: AbsolutePathBuf | null
  summary: PluginSummary
  shareUrl: string | null
  description: string | null
  skills: SkillSummary[]
  hooks: PluginHookSummary[]
  apps: AppSummary[]
  appTemplates: AppTemplateSummary[]
  mcpServers: string[]
}

// ─── Marketplace sources ──────────────────────────────────────────────────────

export interface MarketplaceInterface {
  displayName: string | null
}

export interface MarketplaceLoadErrorInfo {
  marketplacePath: AbsolutePathBuf
  message: string
}

export interface MarketplaceUpgradeErrorInfo {
  marketplaceName?: string
  message?: string
}

export interface PluginMarketplaceEntry {
  name: string
  path: AbsolutePathBuf | null
  interface: MarketplaceInterface | null
  plugins: PluginSummary[]
}

// ─── Request params / responses ───────────────────────────────────────────────

export interface PluginListParams {
  cwds?: AbsolutePathBuf[] | null
  marketplaceKinds?: PluginListMarketplaceKind[] | null
}

export interface PluginListResponse {
  marketplaces: PluginMarketplaceEntry[]
  marketplaceLoadErrors: MarketplaceLoadErrorInfo[]
  featuredPluginIds: string[]
}

export interface PluginInstalledParams {
  cwds?: AbsolutePathBuf[] | null
  installSuggestionPluginNames?: string[] | null
}

export interface PluginInstalledResponse {
  marketplaces: PluginMarketplaceEntry[]
  marketplaceLoadErrors: MarketplaceLoadErrorInfo[]
}

export interface PluginReadParams {
  marketplacePath?: AbsolutePathBuf | null
  remoteMarketplaceName?: string | null
  pluginName: string
}

export interface PluginReadResponse {
  plugin: PluginDetail
}

export interface PluginInstallParams {
  marketplacePath?: AbsolutePathBuf | null
  remoteMarketplaceName?: string | null
  pluginName: string
}

export interface PluginInstallResponse {
  authPolicy: PluginAuthPolicy
  appsNeedingAuth: AppSummary[]
}

export interface MarketplaceAddParams {
  source: string
  refName?: string | null
  sparsePaths?: string[] | null
}

export interface MarketplaceAddResponse {
  marketplaceName: string
  installedRoot: AbsolutePathBuf
  alreadyAdded: boolean
}

export interface MarketplaceRemoveResponse {
  marketplaceName: string
  installedRoot: AbsolutePathBuf | null
}

export interface MarketplaceUpgradeResponse {
  selectedMarketplaces: string[]
  upgradedRoots: AbsolutePathBuf[]
  errors: MarketplaceUpgradeErrorInfo[]
}

// ─── Apps / connectors (EXPERIMENTAL) ─────────────────────────────────────────

export interface AppInfo {
  id: string
  name: string
  [key: string]: unknown
}

export interface AppsListParams {
  cursor?: string | null
  limit?: number | null
  threadId?: string | null
  forceRefetch?: boolean
}

export interface AppsListResponse {
  data: AppInfo[]
  nextCursor: string | null
}

// ─── External agent config import ─────────────────────────────────────────────

export interface ExternalAgentConfigMigrationItem {
  [key: string]: unknown
}

export interface ExternalAgentConfigDetectParams {
  includeHome?: boolean
  cwds?: string[] | null
}

export interface ExternalAgentConfigDetectResponse {
  items: ExternalAgentConfigMigrationItem[]
}

export interface ExternalAgentConfigImportResponse {
  importId: string
}
