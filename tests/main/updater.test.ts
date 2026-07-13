// tests/main/updater.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// Use vi.hoisted to create mocks that are hoisted along with vi.mock
const { mockAutoUpdater, mockIpcMain, mockApp, mockBrowserWindow } = vi.hoisted(() => {
  let currentChannel = 'latest'
  const mockAutoUpdater = {
    autoDownload: false,
    autoInstallOnAppQuit: false,
    autoRunAppAfterInstall: false,
    allowPrerelease: false,
    allowDowngrade: false,
    setFeedURL: vi.fn(),
    checkForUpdates: vi.fn().mockResolvedValue({
      updateInfo: { version: '2.0.0' }
    }),
    downloadUpdate: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
    on: vi.fn()
  }
  Object.defineProperty(mockAutoUpdater, 'channel', {
    configurable: true,
    get: () => currentChannel,
    set: (value: string) => {
      currentChannel = value
      // electron-updater's channel setter may re-enable downgrade when
      // generateUpdatesFilesForAllChannels is active.
      mockAutoUpdater.allowDowngrade = true
    }
  })

  const mockIpcMain = {
    handle: vi.fn()
  }

  const mockApp = {
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }

  const mockBrowserWindow = {
    webContents: {
      send: vi.fn()
    },
    isDestroyed: vi.fn().mockReturnValue(false)
  }

  return { mockAutoUpdater, mockIpcMain, mockApp, mockBrowserWindow }
})

// Mock electron-updater
vi.mock('electron-updater', () => ({
  autoUpdater: mockAutoUpdater,
  default: mockAutoUpdater
}))

// Mock electron
vi.mock('electron', () => ({
  ipcMain: mockIpcMain,
  app: mockApp,
  BrowserWindow: vi.fn().mockImplementation(() => mockBrowserWindow)
}))

// Import after mocking
import {
  AutoUpdater,
  createAutoUpdater,
  getAutoUpdaterInstance,
  normalizeReleaseChannel,
  releaseChannelForVersion
} from '../../src/main/updater'

describe('AutoUpdater', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    
    // Reset autoUpdater mock state
    mockAutoUpdater.autoDownload = false
    mockAutoUpdater.autoInstallOnAppQuit = false
    mockAutoUpdater.allowPrerelease = false
    mockAutoUpdater.channel = 'latest'
    mockAutoUpdater.allowDowngrade = false
    mockApp.getVersion.mockReturnValue('1.0.0')
    mockAutoUpdater.checkForUpdates.mockResolvedValue({
      updateInfo: { version: '2.0.0' }
    })
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  describe('constructor', () => {
    it('should create instance with default config', () => {
      const updater = createAutoUpdater()
      expect(updater).toBeInstanceOf(AutoUpdater)
    })

    it('should configure autoUpdater with defaults', () => {
      createAutoUpdater()
      
      expect(mockAutoUpdater.autoDownload).toBe(true)
      expect(mockAutoUpdater.autoInstallOnAppQuit).toBe(false)
      expect(mockAutoUpdater.autoRunAppAfterInstall).toBe(true)
    })

    it('should accept custom config', () => {
      createAutoUpdater({
        autoDownload: true,
        allowPrerelease: true
      })
      
      expect(mockAutoUpdater.autoDownload).toBe(true)
      expect(mockAutoUpdater.allowPrerelease).toBe(true)
    })

    it('should setup event listeners', () => {
      createAutoUpdater()
      
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('error', expect.any(Function))
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('checking-for-update', expect.any(Function))
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-available', expect.any(Function))
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-not-available', expect.any(Function))
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('download-progress', expect.any(Function))
      expect(mockAutoUpdater.on).toHaveBeenCalledWith('update-downloaded', expect.any(Function))
    })

    it('should setup IPC handlers', () => {
      createAutoUpdater()
      
      expect(mockIpcMain.handle).toHaveBeenCalledWith('updater:check', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('updater:download', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('updater:install', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('updater:getVersion', expect.any(Function))
      expect(mockIpcMain.handle).toHaveBeenCalledWith('updater:getStatus', expect.any(Function))
    })
  })

  describe('provider configuration', () => {
    it('should configure GitHub provider', () => {
      createAutoUpdater({
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo'
      })
      
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo',
        private: false,
        token: undefined
      })
    })

    it('should configure GitHub provider with token for private repo', () => {
      createAutoUpdater({
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo',
        token: 'ghp_xxx'
      })
      
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'github',
        owner: 'test-owner',
        repo: 'test-repo',
        private: true,
        token: 'ghp_xxx'
      })
    })

    it('should configure generic provider', () => {
      createAutoUpdater({
        provider: 'generic',
        url: 'https://updates.example.com'
      })
      
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 'generic',
        url: 'https://updates.example.com'
      })
    })

    it('should configure S3 provider', () => {
      createAutoUpdater({
        provider: 's3',
        bucket: 'my-bucket',
        region: 'us-east-1'
      })
      
      expect(mockAutoUpdater.setFeedURL).toHaveBeenCalledWith({
        provider: 's3',
        bucket: 'my-bucket',
        region: 'us-east-1'
      })
    })
  })

  describe('setMainWindow', () => {
    it('should set main window reference', () => {
      const updater = createAutoUpdater()
      const mockWindow = mockBrowserWindow as any
      
      updater.setMainWindow(mockWindow)
      
      // No direct way to verify, but should not throw
      expect(true).toBe(true)
    })
  })

  describe('updateConfig', () => {
    it('should update configuration', () => {
      const updater = createAutoUpdater({ provider: 'github' })
      
      updater.updateConfig({ allowPrerelease: true })
      
      expect(mockAutoUpdater.allowPrerelease).toBe(true)
    })

    it.each([
      ['1.2.3', 'latest', false],
      ['1.2.3-beta.1', 'beta', true],
      ['1.2.3-alpha.1', 'alpha', true]
    ] as const)(
      'should derive the %s app version as the %s channel',
      (version, expectedChannel, expectedPrerelease) => {
        mockApp.getVersion.mockReturnValue(version)

        createAutoUpdater()

        expect(mockAutoUpdater.channel).toBe(expectedChannel)
        expect(mockAutoUpdater.allowPrerelease).toBe(expectedPrerelease)
        expect(mockAutoUpdater.allowDowngrade).toBe(false)
      }
    )

    it('should normalize stable to the electron-updater latest channel', () => {
      createAutoUpdater({ channel: 'stable', allowDowngrade: true })

      expect(mockAutoUpdater.channel).toBe('latest')
      expect(mockAutoUpdater.allowDowngrade).toBe(false)
    })
  })

  describe('release channel helpers', () => {
    it.each([
      ['1.2.3', 'latest'],
      ['1.2.3-beta.1', 'beta'],
      ['1.2.3-alpha.1', 'alpha'],
      ['1.2.3-rc.1', 'latest']
    ] as const)('maps %s to %s', (version, channel) => {
      expect(releaseChannelForVersion(version)).toBe(channel)
    })

    it.each([
      ['stable', 'latest'],
      ['latest', 'latest'],
      ['beta', 'beta'],
      ['alpha', 'alpha']
    ] as const)('normalizes %s to %s', (channel, normalized) => {
      expect(normalizeReleaseChannel(channel)).toBe(normalized)
    })
  })

  describe('checkForUpdates', () => {
    it('should return success when update available', async () => {
      const updater = createAutoUpdater()
      
      const result = await updater.checkForUpdates()
      
      expect(result.success).toBe(true)
      expect(result.version).toBe('2.0.0')
    })

    it('should return error when check fails', async () => {
      mockAutoUpdater.checkForUpdates.mockRejectedValueOnce(new Error('Network error'))
      
      const updater = createAutoUpdater()
      const result = await updater.checkForUpdates()
      
      expect(result.success).toBe(false)
      expect(result.error).toBe('Network error')
    })
  })

  describe('getConfig', () => {
    it('should return copy of config', () => {
      const updater = createAutoUpdater({
        provider: 'github',
        owner: 'test'
      })
      
      const config1 = updater.getConfig()
      const config2 = updater.getConfig()
      
      expect(config1).not.toBe(config2)
      expect(config1.provider).toBe('github')
      expect(config1.owner).toBe('test')
    })
  })

  describe('isChecking', () => {
    it('should return false initially', () => {
      const updater = createAutoUpdater()
      expect(updater.isChecking()).toBe(false)
    })
  })

  describe('isDownloadingUpdate', () => {
    it('should return false initially', () => {
      const updater = createAutoUpdater()
      expect(updater.isDownloadingUpdate()).toBe(false)
    })
  })

  describe('getAutoUpdater', () => {
    it('should return autoUpdater instance', () => {
      const updater = createAutoUpdater()
      const autoUpdaterInstance = updater.getAutoUpdater()
      
      expect(autoUpdaterInstance).toBeDefined()
    })
  })

  describe('checkForUpdatesOnStartup', () => {
    it('should delay check for updates', async () => {
      vi.useFakeTimers()
      
      const updater = createAutoUpdater()
      updater.checkForUpdatesOnStartup(1000)
      
      expect(mockAutoUpdater.checkForUpdates).not.toHaveBeenCalled()
      
      vi.advanceTimersByTime(1000)
      
      // Need to wait for promise
      await vi.runAllTimersAsync()
      
      expect(mockAutoUpdater.checkForUpdates).toHaveBeenCalled()
      
      vi.useRealTimers()
    })
  })
})

describe('getAutoUpdaterInstance', () => {
  it('should create singleton instance', () => {
    // Note: This test may be affected by other tests
    const instance = getAutoUpdaterInstance()
    expect(instance).toBeInstanceOf(AutoUpdater)
  })
})
