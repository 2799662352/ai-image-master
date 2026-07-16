import type { CodexWorkspacePaths } from '../../types/agent'
import type { CodexProviderConfig } from './codexLaunch'
import type { ProviderPreset } from './codexProviders'
import { resolveProviderChannel } from './gatewayModelRouting'

export interface ProviderChannelTransition {
  changed: boolean
  previousChannelId: string
  channelId: string
  backendEpoch?: number
}

export interface ProviderChannelBackend {
  setProvider?: (provider: CodexProviderConfig | undefined) => void
  restartCodex?: (paths: CodexWorkspacePaths) => Promise<void>
  currentEpoch?: () => number
}

export interface ProviderChannelControllerOptions {
  backend: ProviderChannelBackend
  paths: CodexWorkspacePaths
  initialChannelId: string
  getCustomProviders: () => readonly ProviderPreset[]
}

/** Applies internal Provider Channels to the Codex backend. */
export class ProviderChannelController {
  private activeChannelId: string

  constructor(private readonly options: ProviderChannelControllerOptions) {
    this.activeChannelId = options.initialChannelId
  }

  currentChannelId(): string {
    return this.activeChannelId
  }

  async apply(
    channelId: string,
    rollbackProvider?: CodexProviderConfig,
  ): Promise<ProviderChannelTransition> {
    const previousChannelId = this.activeChannelId
    if (channelId === previousChannelId) {
      return {
        changed: false,
        previousChannelId,
        channelId,
        backendEpoch: this.options.backend.currentEpoch?.(),
      }
    }

    const previousProvider = rollbackProvider
      ?? resolveProviderChannel(
        previousChannelId,
        this.options.getCustomProviders(),
      )
    const provider = resolveProviderChannel(
      channelId,
      this.options.getCustomProviders(),
    )
    try {
      this.options.backend.setProvider?.(provider)
      await this.options.backend.restartCodex?.(this.options.paths)
      this.activeChannelId = channelId
    } catch (error) {
      this.options.backend.setProvider?.(previousProvider)
      try {
        await this.options.backend.restartCodex?.(this.options.paths)
      } catch (rollbackRestartError) {
        const message = error instanceof Error ? error.message : String(error)
        const rollbackMessage = rollbackRestartError instanceof Error
          ? rollbackRestartError.message
          : String(rollbackRestartError)
        throw new Error(
          `${message}; Provider recovery failed: restart: ${rollbackMessage}`,
        )
      }
      throw error
    }
    return {
      changed: true,
      previousChannelId,
      channelId,
      backendEpoch: this.options.backend.currentEpoch?.(),
    }
  }

  async restore(
    channelId: string,
    providerOverride?: CodexProviderConfig,
  ): Promise<void> {
    if (channelId === this.activeChannelId) return
    const provider = providerOverride
      ?? resolveProviderChannel(
        channelId,
        this.options.getCustomProviders(),
      )
    this.options.backend.setProvider?.(provider)
    await this.options.backend.restartCodex?.(this.options.paths)
    this.activeChannelId = channelId
  }
}
