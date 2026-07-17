import type { CodexWorkspacePaths } from '../../types/agent'
import type { CodexProviderConfig } from './codexLaunch'
import type { ProviderPreset } from './codexProviders'
import { resolveProviderChannel } from './gatewayModelRouting'

/** Result of applying a Provider Channel to the backend runtime. */
export interface ProviderChannelTransition {
  changed: boolean
  previousChannelId: string
  channelId: string
  backendEpoch?: number
}

/** Minimal backend contract required for atomic Channel replacement. */
export interface ProviderChannelBackend {
  setProvider?: (provider: CodexProviderConfig | undefined) => void
  isHealthy?: () => boolean
  restartCodex?: (paths: CodexWorkspacePaths) => Promise<void>
  currentEpoch?: () => number
}

/** Dependencies and initial identity for a Provider Channel controller. */
export interface ProviderChannelControllerOptions {
  backend: ProviderChannelBackend
  paths: CodexWorkspacePaths
  initialChannelId: string
  getCustomProviders: () => readonly ProviderPreset[]
}

/** Error raised when both Channel apply and old-Channel recovery fail. */
export class ProviderChannelRecoveryError extends Error {
  constructor(
    readonly applyError: unknown,
    readonly recoveryError: unknown,
  ) {
    const applyMessage = applyError instanceof Error
      ? applyError.message
      : String(applyError)
    const recoveryMessage = recoveryError instanceof Error
      ? recoveryError.message
      : String(recoveryError)
    super(
      `${applyMessage}; Provider recovery failed: restart: ${recoveryMessage}`,
      { cause: applyError },
    )
    this.name = 'ProviderChannelRecoveryError'
  }
}

/** Applies internal Provider Channels to the Codex backend. */
export class ProviderChannelController {
  private activeChannelId: string

  constructor(private readonly options: ProviderChannelControllerOptions) {
    this.activeChannelId = options.initialChannelId
  }

  /** Returns the Channel identity proven active by the backend contract. */
  currentChannelId(): string {
    return this.activeChannelId
  }

  /**
   * Applies a Channel and commits its identity only after atomic restart success.
   * `rollbackProvider` preserves the old config when persistence already changed.
   */
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
    const restartRequired = this.options.backend.isHealthy?.() ?? true
    try {
      this.options.backend.setProvider?.(provider)
      if (restartRequired) {
        await this.options.backend.restartCodex?.(this.options.paths)
      }
      this.activeChannelId = channelId
    } catch (error) {
      this.options.backend.setProvider?.(previousProvider)
      try {
        if (restartRequired) {
          await this.options.backend.restartCodex?.(this.options.paths)
        }
      } catch (rollbackRestartError) {
        throw new ProviderChannelRecoveryError(error, rollbackRestartError)
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

  /**
   * Restores a prior Channel, optionally using its pre-mutation Provider snapshot.
   */
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
    if (this.options.backend.isHealthy?.() ?? true) {
      await this.options.backend.restartCodex?.(this.options.paths)
    }
    this.activeChannelId = channelId
  }

  /**
   * Force-applies and restarts a Channel even when its recorded id is current.
   * Used only to explicitly recover an unprovable runtime after apply and
   * automatic recovery both failed.
   */
  async recover(channelId: string): Promise<void> {
    const provider = resolveProviderChannel(
      channelId,
      this.options.getCustomProviders(),
    )
    const restart = this.options.backend.restartCodex
    if (!restart) {
      throw new Error('Provider Channel recovery requires restart capability')
    }
    this.options.backend.setProvider?.(provider)
    await restart(this.options.paths)
    this.activeChannelId = channelId
  }
}
