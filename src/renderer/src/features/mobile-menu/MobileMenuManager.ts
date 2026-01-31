// src/renderer/src/features/mobile-menu/MobileMenuManager.ts
// 移动端菜单管理器 - 从 app.js 提取

export interface MobileMenuConfig {
  menuId?: string
  menuBtnId?: string
  menuLineIds?: {
    line1: string
    line2: string
    line3: string
  }
  breakpoint?: number
  onOpen?: () => void
  onClose?: () => void
}

const DEFAULT_CONFIG: Required<MobileMenuConfig> = {
  menuId: 'mobileMenu',
  menuBtnId: 'mobileMenuBtn',
  menuLineIds: {
    line1: 'menuLine1',
    line2: 'menuLine2',
    line3: 'menuLine3'
  },
  breakpoint: 768,
  onOpen: () => {},
  onClose: () => {}
}

export class MobileMenuManager {
  private config: Required<MobileMenuConfig>
  private isMenuOpen: boolean = false
  private resizeHandler: (() => void) | null = null

  constructor(config: MobileMenuConfig = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  /**
   * 初始化移动端菜单
   */
  init(): void {
    this.bindEvents()
    this.initResizeHandler()
  }

  /**
   * 绑定事件
   */
  private bindEvents(): void {
    const menuBtn = document.getElementById(this.config.menuBtnId)
    if (menuBtn) {
      menuBtn.addEventListener('click', () => this.toggle())
    }
  }

  /**
   * 初始化窗口大小变化处理
   */
  private initResizeHandler(): void {
    this.resizeHandler = () => {
      if (window.innerWidth >= this.config.breakpoint) {
        this.close()
      }
    }
    window.addEventListener('resize', this.resizeHandler)
  }

  /**
   * 切换菜单状态
   */
  toggle(): void {
    if (this.isMenuOpen) {
      this.close()
    } else {
      this.open()
    }
  }

  /**
   * 打开移动端菜单
   */
  open(): void {
    const menu = document.getElementById(this.config.menuId)
    if (!menu) return

    // 显示菜单
    menu.classList.remove('hidden')
    this.isMenuOpen = true

    // 汉堡菜单变成X的动画
    this.animateToX()

    this.config.onOpen()
  }

  /**
   * 关闭移动端菜单
   */
  close(): void {
    const menu = document.getElementById(this.config.menuId)
    if (!menu) return

    // 隐藏菜单
    menu.classList.add('hidden')
    this.isMenuOpen = false

    // 重置汉堡菜单动画
    this.animateToHamburger()

    this.config.onClose()
  }

  /**
   * 汉堡菜单变成X的动画
   */
  private animateToX(): void {
    const { line1, line2, line3 } = this.config.menuLineIds
    const lineEl1 = document.getElementById(line1)
    const lineEl2 = document.getElementById(line2)
    const lineEl3 = document.getElementById(line3)

    if (lineEl1 && lineEl2 && lineEl3) {
      lineEl1.style.transform = 'rotate(45deg) translate(5px, 5px)'
      lineEl2.style.opacity = '0'
      lineEl3.style.transform = 'rotate(-45deg) translate(7px, -6px)'
    }
  }

  /**
   * X变回汉堡菜单的动画
   */
  private animateToHamburger(): void {
    const { line1, line2, line3 } = this.config.menuLineIds
    const lineEl1 = document.getElementById(line1)
    const lineEl2 = document.getElementById(line2)
    const lineEl3 = document.getElementById(line3)

    if (lineEl1 && lineEl2 && lineEl3) {
      lineEl1.style.transform = ''
      lineEl2.style.opacity = ''
      lineEl3.style.transform = ''
    }
  }

  /**
   * 检查菜单是否打开
   */
  isOpen(): boolean {
    return this.isMenuOpen
  }

  /**
   * 检查是否为移动端视口
   */
  isMobileViewport(): boolean {
    return window.innerWidth < this.config.breakpoint
  }

  /**
   * 清理资源
   */
  destroy(): void {
    if (this.resizeHandler) {
      window.removeEventListener('resize', this.resizeHandler)
      this.resizeHandler = null
    }
    this.close()
  }
}

// 单例实例
let mobileMenuInstance: MobileMenuManager | null = null

/**
 * 获取 MobileMenuManager 单例
 */
export function getMobileMenuManager(config?: MobileMenuConfig): MobileMenuManager {
  if (!mobileMenuInstance) {
    mobileMenuInstance = new MobileMenuManager(config)
  }
  return mobileMenuInstance
}

/**
 * 创建新的 MobileMenuManager 实例
 */
export function createMobileMenuManager(config?: MobileMenuConfig): MobileMenuManager {
  return new MobileMenuManager(config)
}
