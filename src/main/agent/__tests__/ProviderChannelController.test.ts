import { describe, expect, it, vi } from 'vitest'
import type { CodexWorkspacePaths } from '../../../types/agent'
import {
  ProviderChannelController,
  type ProviderChannelBackend,
} from '../ProviderChannelController'

const paths: CodexWorkspacePaths = {
  personalConfigToml: 'personal-config.toml',
  personalSkillsRoot: 'personal-skills',
  workspaceConfigToml: 'workspace-config.toml',
  workspaceSkillsRoot: 'workspace-skills',
  runtimeConfigToml: 'runtime-config.toml',
  auditLogPath: 'audit.log',
}

function createBackend(): ProviderChannelBackend {
  return {
    setProvider: vi.fn(),
    restartCodex: vi.fn(async () => undefined),
    currentEpoch: vi.fn(() => 2),
  }
}

function createController(
  backend: ProviderChannelBackend,
  initialChannelId: string,
): ProviderChannelController {
  return new ProviderChannelController({
    backend,
    paths,
    initialChannelId,
    getCustomProviders: () => [],
  })
}

describe('ProviderChannelController', () => {
  it('does not restart when the target channel is already active', async () => {
    const backend = createBackend()
    const controller = createController(backend, 'apiyi-standard')

    const result = await controller.apply('apiyi-standard')

    expect(result.changed).toBe(false)
    expect(backend.restartCodex).not.toHaveBeenCalled()
  })

  it('switches Right.Codes Grok through the Grok endpoint', async () => {
    const backend = createBackend()
    const controller = createController(backend, 'rightcode-standard')

    const result = await controller.apply('rightcode-grok')

    expect(result.changed).toBe(true)
    expect(backend.setProvider).toHaveBeenCalledWith(
      expect.objectContaining({ baseUrl: 'https://right.codes/grok/v1' }),
    )
    expect(backend.restartCodex).toHaveBeenCalledTimes(1)
  })

  it('restores the previous provider when a channel restart fails', async () => {
    const backend = createBackend()
    vi.mocked(backend.restartCodex!)
      .mockRejectedValueOnce(new Error('spawn failed'))
      .mockResolvedValueOnce(undefined)
    const controller = createController(backend, 'rightcode-standard')

    await expect(controller.apply('rightcode-grok')).rejects.toThrow(
      'spawn failed',
    )

    expect(backend.setProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({
        id: 'rightcode-standard',
        baseUrl: 'https://right.codes/codex/v1',
      }),
    )
    expect(controller.currentChannelId()).toBe('rightcode-standard')
  })

  it('combines apply and recovery failures without committing the new identity', async () => {
    const backend = createBackend()
    vi.mocked(backend.restartCodex!)
      .mockRejectedValueOnce(new Error('replacement unhealthy'))
      .mockRejectedValueOnce(new Error('recovery unhealthy'))
    const controller = createController(backend, 'rightcode-standard')

    await expect(controller.apply('rightcode-grok')).rejects.toThrow(
      /replacement unhealthy.*recovery unhealthy/i,
    )

    expect(backend.setProvider).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: 'rightcode-standard' }),
    )
    expect(controller.currentChannelId()).toBe('rightcode-standard')
  })

  it('force-verifies the current Channel during explicit recovery', async () => {
    const backend = createBackend()
    const controller = createController(backend, 'rightcode-standard')

    await controller.recover('rightcode-standard')

    expect(backend.setProvider).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'rightcode-standard' }),
    )
    expect(backend.restartCodex).toHaveBeenCalledTimes(1)
    expect(controller.currentChannelId()).toBe('rightcode-standard')
  })
})
