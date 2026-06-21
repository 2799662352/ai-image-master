import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ConnectorsSection } from '../ConnectorsSection'
import type {
  AppsListResponse,
  ExternalAgentConfigDetectResponse,
  PluginListResponse,
} from '../../../../../types/codexPlugins'

const PLUGINS: PluginListResponse = {
  marketplaces: [
    {
      name: 'curated',
      path: '/m/curated',
      interface: { displayName: 'Curated' },
      plugins: [
        {
          id: 'p1',
          remotePluginId: null,
          localVersion: '1.2.0',
          name: 'context7',
          shareContext: null,
          source: { type: 'local', path: '/m/curated/context7' },
          installed: true,
          enabled: true,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_USE',
          availability: 'AVAILABLE',
          interface: {
            displayName: 'Context7 Docs',
            shortDescription: 'Fetch live library docs',
            longDescription: null,
            developerName: null,
            category: null,
            capabilities: [],
            websiteUrl: null,
            privacyPolicyUrl: null,
            termsOfServiceUrl: null,
            defaultPrompt: null,
            brandColor: null,
            composerIcon: null,
            composerIconUrl: null,
            logo: null,
            logoUrl: null,
            screenshots: [],
            screenshotUrls: [],
          },
          keywords: ['docs', 'mcp'],
        },
        {
          id: 'p2',
          remotePluginId: null,
          localVersion: null,
          name: 'weather',
          shareContext: null,
          source: { type: 'local', path: '/m/curated/weather' },
          installed: false,
          enabled: false,
          installPolicy: 'AVAILABLE',
          authPolicy: 'ON_INSTALL',
          availability: 'AVAILABLE',
          interface: {
            displayName: 'Weather',
            shortDescription: 'Forecasts',
            longDescription: null,
            developerName: null,
            category: null,
            capabilities: [],
            websiteUrl: null,
            privacyPolicyUrl: null,
            termsOfServiceUrl: null,
            defaultPrompt: null,
            brandColor: null,
            composerIcon: null,
            composerIconUrl: null,
            logo: null,
            logoUrl: null,
            screenshots: [],
            screenshotUrls: [],
          },
          keywords: [],
        },
      ],
    },
  ],
  marketplaceLoadErrors: [],
  featuredPluginIds: ['p1'],
}

const APPS: AppsListResponse = {
  data: [{ id: 'app-1', name: 'Linear', description: 'Issue tracker', category: 'productivity' }],
  nextCursor: null,
}

const IMPORT: ExternalAgentConfigDetectResponse = {
  items: [{ kind: 'mcp', name: 'ctx7' }],
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'electronAPI')
  vi.restoreAllMocks()
})

function installApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      agent: {
        listPlugins: vi.fn().mockResolvedValue({ ok: true, data: PLUGINS }),
        listApps: vi.fn().mockResolvedValue({ ok: true, data: APPS }),
        detectExternalAgentConfig: vi.fn().mockResolvedValue({ ok: true, data: IMPORT }),
        installPlugin: vi.fn().mockResolvedValue({ ok: true, data: { authPolicy: 'ON_USE', appsNeedingAuth: [] } }),
        uninstallPlugin: vi.fn().mockResolvedValue({ ok: true }),
        addMarketplace: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { marketplaceName: 'mp', installedRoot: '/r', alreadyAdded: false } }),
        removeMarketplace: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { marketplaceName: 'curated', installedRoot: '/m/curated' } }),
        upgradeMarketplaces: vi
          .fn()
          .mockResolvedValue({ ok: true, data: { selectedMarketplaces: ['curated'], upgradedRoots: ['/m/curated'], errors: [] } }),
        importExternalAgentConfig: vi.fn().mockResolvedValue({ ok: true, data: { importId: 'imp-1' } }),
        ...overrides,
      },
    },
  })
}

describe('ConnectorsSection', () => {
  it('loads plugins on mount and renders cards + featured badge', async () => {
    installApi()
    render(<ConnectorsSection />)

    expect(await screen.findByText('Context7 Docs')).toBeTruthy()
    expect(screen.getByText('Fetch live library docs')).toBeTruthy()
    expect(screen.getByText('Featured')).toBeTruthy()
    expect(screen.getByText('Installed')).toBeTruthy()
  })

  it('switches to Apps sub-tab and lists apps', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')

    fireEvent.click(screen.getByRole('button', { name: 'Apps' }))

    expect(await screen.findByText('Linear')).toBeTruthy()
    expect(screen.getByText('Issue tracker')).toBeTruthy()
  })

  it('switches to Import sub-tab and shows detected items', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')

    fireEvent.click(screen.getByRole('button', { name: 'Import' }))

    expect(await screen.findByText(/ctx7/)).toBeTruthy()
  })

  it('surfaces an error when the plugin call fails', async () => {
    installApi({ listPlugins: vi.fn().mockResolvedValue({ ok: false, error: 'binary too old' }) })
    render(<ConnectorsSection />)

    expect(await screen.findByText(/binary too old/)).toBeTruthy()
  })

  it('shows an empty state when no apps are available (flag/auth gated)', async () => {
    installApi({ listApps: vi.fn().mockResolvedValue({ ok: true, data: { data: [], nextCursor: null } }) })
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')

    fireEvent.click(screen.getByRole('button', { name: 'Apps' }))

    expect(await screen.findByText(/No apps available/)).toBeTruthy()
  })

  it('handles a missing agent API without crashing', async () => {
    Object.defineProperty(window, 'electronAPI', { configurable: true, value: {} })
    render(<ConnectorsSection />)

    expect(await screen.findByText(/Plugin API is unavailable/)).toBeTruthy()
  })

  it('installs an available plugin with its marketplace path and reloads', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Weather')
    const api = (window as unknown as { electronAPI: { agent: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.agent

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    await waitFor(() =>
      expect(api.installPlugin).toHaveBeenCalledWith({ marketplacePath: '/m/curated', pluginName: 'weather' }),
    )
    await waitFor(() => expect(api.listPlugins).toHaveBeenCalledTimes(2))
  })

  it('shows an auth notice when install reports apps needing sign-in', async () => {
    installApi({
      installPlugin: vi.fn().mockResolvedValue({
        ok: true,
        data: {
          authPolicy: 'ON_INSTALL',
          appsNeedingAuth: [{ id: 'app-1', name: 'Linear', description: null, installUrl: null, category: null }],
        },
      }),
    })
    render(<ConnectorsSection />)
    await screen.findByText('Weather')

    fireEvent.click(screen.getByRole('button', { name: 'Install' }))

    expect(await screen.findByText(/Linear/)).toBeTruthy()
    expect(screen.getByText(/sign-in/i)).toBeTruthy()
  })

  it('uninstalls an installed plugin after an inline confirm', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')
    const api = (window as unknown as { electronAPI: { agent: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.agent

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }))

    await waitFor(() => expect(api.uninstallPlugin).toHaveBeenCalledWith('p1'))
  })

  it('adds a marketplace from the source input and reloads', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')
    const api = (window as unknown as { electronAPI: { agent: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.agent

    fireEvent.change(screen.getByPlaceholderText(/Marketplace source/i), {
      target: { value: 'https://github.com/me/mp' },
    })
    fireEvent.click(screen.getByRole('button', { name: 'Add' }))

    await waitFor(() => expect(api.addMarketplace).toHaveBeenCalledWith({ source: 'https://github.com/me/mp' }))
    await waitFor(() => expect(api.listPlugins).toHaveBeenCalledTimes(2))
  })

  it('upgrades all marketplaces', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')
    const api = (window as unknown as { electronAPI: { agent: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.agent

    fireEvent.click(screen.getByRole('button', { name: 'Upgrade all' }))

    await waitFor(() => expect(api.upgradeMarketplaces).toHaveBeenCalledTimes(1))
  })

  it('surfaces a write error without reloading', async () => {
    installApi({ uninstallPlugin: vi.fn().mockResolvedValue({ ok: false, error: 'uninstall blocked' }) })
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')

    fireEvent.click(screen.getByRole('button', { name: 'Uninstall' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm uninstall' }))

    expect(await screen.findByText(/uninstall blocked/)).toBeTruthy()
  })

  it('applies a detected import after confirm', async () => {
    installApi()
    render(<ConnectorsSection />)
    await screen.findByText('Context7 Docs')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    await screen.findByText(/ctx7/)
    const api = (window as unknown as { electronAPI: { agent: Record<string, ReturnType<typeof vi.fn>> } }).electronAPI.agent

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }))
    fireEvent.click(screen.getByRole('button', { name: 'Confirm import' }))

    await waitFor(() =>
      expect(api.importExternalAgentConfig).toHaveBeenCalledWith([{ kind: 'mcp', name: 'ctx7' }]),
    )
  })
})
