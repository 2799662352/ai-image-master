/**
 * IntroVideoController - Cyberpunk 2077 风格视频加载控制器
 * V16.1.2 - 从 index.html 内联脚本迁移
 * 
 * 功能:
 * - 控制 Cyberpunk 风格的启动视频
 * - 显示循环加载消息
 * - 处理视频事件（播放、进度、结束、错误）
 * - 管理跳过/进入按钮交互
 * - 协调应用初始化事件
 * - 提供备用加载 UI
 */

export interface IntroVideoConfig {
  /** 视频元素 ID */
  videoId?: string
  /** 页面加载器容器 ID */
  loaderId?: string
  /** 主内容容器 ID */
  mainContentId?: string
  /** 跳过按钮 ID */
  skipButtonId?: string
  /** 进入按钮 ID */
  enterButtonId?: string
  /** 加载文字元素 ID */
  loadingTextId?: string
  /** 进度条元素 ID */
  progressBarId?: string
  /** 备用加载器 ID */
  fallbackLoaderId?: string
  /** 视频容器 ID */
  videoContainerId?: string
  /** 加载消息列表 */
  loadingMessages?: string[]
  /** 消息切换间隔 (ms) */
  messageInterval?: number
  /** 视频超时时间 (ms) */
  videoTimeout?: number
  /** 应用初始化超时 (ms) */
  appInitTimeout?: number
  /** 加载完成后过渡时间 (ms) */
  transitionDuration?: number
}

export interface IntroVideoState {
  appInitialized: boolean
  videoEnded: boolean
  videoLoaded: boolean
  skipped: boolean
  entered: boolean
}

const DEFAULT_CONFIG: Required<IntroVideoConfig> = {
  videoId: 'introVideo',
  loaderId: 'pageLoader',
  mainContentId: 'mainContent',
  skipButtonId: 'skipIntroBtn',
  enterButtonId: 'enterBtn',
  loadingTextId: 'introLoadingText',
  progressBarId: 'introProgress',
  fallbackLoaderId: 'fallbackLoader',
  videoContainerId: 'introVideoContainer',
  loadingMessages: [
    'INITIALIZING NEURAL LINK...',
    'CONNECTING TO NIGHT CITY...',
    'LOADING CYBERWARE...',
    'SYNCING WITH ARASAKA NETWORK...',
    'BYPASSING ICE PROTOCOLS...',
    'ESTABLISHING SECURE CONNECTION...',
    'CALIBRATING OPTICS...',
    'READY TO JACK IN...'
  ],
  messageInterval: 2000,
  videoTimeout: 120000, // 2 分钟
  appInitTimeout: 10000, // 10 秒
  transitionDuration: 800
}

/**
 * IntroVideoController 类
 * 管理 Cyberpunk 2077 风格的启动视频体验
 */
export class IntroVideoController {
  private config: Required<IntroVideoConfig>
  private state: IntroVideoState
  private messageIndex: number = 0
  private messageIntervalId: number | null = null
  private elements: {
    video: HTMLVideoElement | null
    loader: HTMLElement | null
    mainContent: HTMLElement | null
    skipButton: HTMLElement | null
    enterButton: HTMLElement | null
    loadingText: HTMLElement | null
    progressBar: HTMLElement | null
    fallbackLoader: HTMLElement | null
    videoContainer: HTMLElement | null
  }

  constructor(config: IntroVideoConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
    this.state = {
      appInitialized: false,
      videoEnded: false,
      videoLoaded: false,
      skipped: false,
      entered: false
    }
    this.elements = {
      video: null,
      loader: null,
      mainContent: null,
      skipButton: null,
      enterButton: null,
      loadingText: null,
      progressBar: null,
      fallbackLoader: null,
      videoContainer: null
    }
  }

  /**
   * 初始化控制器
   */
  init(): void {
    console.log('🎬 [IntroVideoController] 初始化 Cyberpunk Intro...')

    this.cacheElements()
    this.startMessageCycle()
    this.bindEvents()
    this.setupTimeouts()

    // 尝试播放视频
    if (this.elements.video) {
      this.initVideo()
    } else {
      // 没有视频元素，使用备用加载器
      this.state.videoEnded = true
      this.showFallbackLoader()
    }
  }

  /**
   * 缓存 DOM 元素
   */
  private cacheElements(): void {
    this.elements = {
      video: document.getElementById(this.config.videoId) as HTMLVideoElement | null,
      loader: document.getElementById(this.config.loaderId),
      mainContent: document.getElementById(this.config.mainContentId),
      skipButton: document.getElementById(this.config.skipButtonId),
      enterButton: document.getElementById(this.config.enterButtonId),
      loadingText: document.getElementById(this.config.loadingTextId),
      progressBar: document.getElementById(this.config.progressBarId),
      fallbackLoader: document.getElementById(this.config.fallbackLoaderId),
      videoContainer: document.getElementById(this.config.videoContainerId)
    }
  }

  /**
   * 初始化视频
   */
  private initVideo(): void {
    const { video } = this.elements

    if (!video) return

    // 视频加载完成
    video.addEventListener('canplaythrough', () => {
      console.log('🎬 [IntroVideoController] 视频加载完成，开始播放')
      this.state.videoLoaded = true
      this.playVideo()
    })

    // 视频播放进度
    video.addEventListener('timeupdate', () => {
      this.updateProgress()
    })

    // 视频播放结束
    video.addEventListener('ended', () => {
      console.log('🎬 [IntroVideoController] 视频播放完成')
      this.state.videoEnded = true
      this.checkReadyToEnter()
    })

    // 视频加载错误
    video.addEventListener('error', () => {
      console.warn('⚠️ [IntroVideoController] 视频加载失败，使用备用加载器')
      this.state.videoEnded = true
      this.showFallbackLoader()
      this.checkReadyToEnter()
    })
  }

  /**
   * 播放视频
   */
  private playVideo(): void {
    const { video, fallbackLoader, videoContainer } = this.elements

    if (!video) return

    video.play().catch((err) => {
      console.warn('⚠️ [IntroVideoController] 带声音自动播放被阻止，尝试静音播放:', err)
      
      // 尝试静音播放
      video.muted = true
      video.play().then(() => {
        console.log('🔇 [IntroVideoController] 静音播放成功')
      }).catch((err2) => {
        console.warn('⚠️ [IntroVideoController] 静音播放也失败:', err2)
        // 显示备用加载器
        if (fallbackLoader) fallbackLoader.classList.add('active')
        if (videoContainer) videoContainer.style.opacity = '0.3'
      })
    })
  }

  /**
   * 更新视频进度
   */
  private updateProgress(): void {
    const { video } = this.elements
    const { progressBar } = this.elements

    if (!video || !progressBar || !video.duration) return

    const progress = (video.currentTime / video.duration) * 100
    progressBar.style.width = `${progress}%`
  }

  /**
   * 开始消息循环
   */
  private startMessageCycle(): void {
    this.cycleLoadingMessage()
    this.messageIntervalId = window.setInterval(() => {
      this.cycleLoadingMessage()
    }, this.config.messageInterval)
  }

  /**
   * 停止消息循环
   */
  private stopMessageCycle(): void {
    if (this.messageIntervalId) {
      clearInterval(this.messageIntervalId)
      this.messageIntervalId = null
    }
  }

  /**
   * 切换加载消息
   */
  private cycleLoadingMessage(): void {
    const { loadingText } = this.elements

    if (loadingText) {
      loadingText.textContent = this.config.loadingMessages[this.messageIndex]
      this.messageIndex = (this.messageIndex + 1) % this.config.loadingMessages.length
    }
  }

  /**
   * 绑定事件
   */
  private bindEvents(): void {
    // 跳过按钮
    this.elements.skipButton?.addEventListener('click', () => this.skipIntro())

    // 进入按钮
    this.elements.enterButton?.addEventListener('click', () => this.enterApp())

    // 键盘快捷键
    document.addEventListener('keydown', (e) => this.handleKeydown(e))

    // 监听应用初始化完成事件
    window.addEventListener('appReady', () => {
      console.log('✅ [IntroVideoController] 应用初始化完成')
      this.state.appInitialized = true
      this.checkReadyToEnter()
    })
  }

  /**
   * 处理键盘事件
   */
  private handleKeydown(e: KeyboardEvent): void {
    if ((e.key === 'Escape' || e.key === ' ') && !this.state.videoEnded && !this.state.skipped) {
      e.preventDefault()
      this.skipIntro()
    }
  }

  /**
   * 设置超时处理
   */
  private setupTimeouts(): void {
    // 视频超时：显示进入按钮
    setTimeout(() => {
      if (!this.state.videoEnded) {
        console.log('⏰ [IntroVideoController] 视频播放超时，显示进入按钮')
        this.state.videoEnded = true
        this.checkReadyToEnter()
      }
    }, this.config.videoTimeout)

    // 应用初始化超时：强制标记为已初始化
    setTimeout(() => {
      if (!this.state.appInitialized) {
        console.warn('⚠️ [IntroVideoController] 应用初始化超时，强制标记为已初始化')
        this.state.appInitialized = true
        if (this.state.videoEnded) {
          this.showEnterButton()
        }
      }
    }, this.config.appInitTimeout)
  }

  /**
   * 跳过视频
   */
  skipIntro(): void {
    if (this.state.skipped) return

    console.log('⏭️ [IntroVideoController] 跳过 Intro 视频')
    this.state.skipped = true
    this.state.videoEnded = true

    // 停止视频
    if (this.elements.video) {
      this.elements.video.pause()
    }

    // 如果应用已初始化，直接进入
    if (this.state.appInitialized) {
      this.hideLoader()
    } else {
      // 显示备用加载器
      this.showFallbackLoader()
      console.log('⏳ [IntroVideoController] 等待应用初始化...')
    }
  }

  /**
   * 进入应用
   */
  enterApp(): void {
    if (this.state.entered) return

    console.log('🚀 [IntroVideoController] 进入夜之城！')
    this.state.entered = true
    this.hideLoader()
  }

  /**
   * 检查是否可以显示进入按钮
   */
  private checkReadyToEnter(): void {
    if (this.state.appInitialized && this.state.videoEnded) {
      console.log('✅ [IntroVideoController] 视频播放完成 + 应用初始化完成，显示进入按钮')
      this.showEnterButton()
    }
  }

  /**
   * 显示进入按钮
   */
  private showEnterButton(): void {
    const { enterButton, skipButton, loadingText, fallbackLoader, progressBar } = this.elements

    // 显示进入按钮
    if (enterButton) {
      enterButton.style.display = 'block'
    }

    // 隐藏跳过按钮
    if (skipButton) {
      skipButton.style.display = 'none'
    }

    // 隐藏加载文字
    if (loadingText) {
      loadingText.style.display = 'none'
    }

    // 隐藏备用加载器
    if (fallbackLoader) {
      fallbackLoader.classList.remove('active')
      fallbackLoader.style.display = 'none'
    }

    // 隐藏进度条
    if (progressBar) {
      progressBar.style.display = 'none'
    }

    // 停止消息循环
    this.stopMessageCycle()
  }

  /**
   * 显示备用加载器
   */
  private showFallbackLoader(): void {
    const { fallbackLoader, videoContainer } = this.elements

    if (fallbackLoader) {
      fallbackLoader.classList.add('active')
    }

    if (videoContainer) {
      videoContainer.style.display = 'none'
    }
  }

  /**
   * 隐藏加载器并显示主内容
   */
  private hideLoader(): void {
    const { loader, mainContent } = this.elements

    // 停止消息循环
    this.stopMessageCycle()

    if (loader && mainContent) {
      loader.classList.add('loaded')
      mainContent.classList.add('loaded')

      // 完全移除加载器
      setTimeout(() => {
        if (loader.parentNode) {
          loader.parentNode.removeChild(loader)
        }
      }, this.config.transitionDuration)
    }
  }

  /**
   * 获取当前状态
   */
  getState(): Readonly<IntroVideoState> {
    return { ...this.state }
  }

  /**
   * 销毁控制器
   */
  destroy(): void {
    this.stopMessageCycle()

    // 移除事件监听器
    document.removeEventListener('keydown', (e) => this.handleKeydown(e))

    // 清理元素引用
    this.elements = {
      video: null,
      loader: null,
      mainContent: null,
      skipButton: null,
      enterButton: null,
      loadingText: null,
      progressBar: null,
      fallbackLoader: null,
      videoContainer: null
    }
  }
}

// 单例实例
let introVideoInstance: IntroVideoController | null = null

/**
 * 获取 IntroVideoController 单例
 */
export function getIntroVideoController(config?: IntroVideoConfig): IntroVideoController {
  if (!introVideoInstance) {
    introVideoInstance = new IntroVideoController(config)
  }
  return introVideoInstance
}

/**
 * 初始化 Intro 视频控制器
 * 应在 DOMContentLoaded 事件后调用
 */
export function initIntroVideo(config?: IntroVideoConfig): IntroVideoController {
  const controller = getIntroVideoController(config)
  controller.init()
  return controller
}

/**
 * 重置单例 (仅用于测试)
 */
export function resetIntroVideoController(): void {
  if (introVideoInstance) {
    introVideoInstance.destroy()
    introVideoInstance = null
  }
}
